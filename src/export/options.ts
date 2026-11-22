/**
 * Pure option model for the audio export dialog: defaults, validation,
 * filename derivation, encoder/render option mapping and stems zip
 * composition. No DOM, store or wasm access, so the whole module is
 * unit-testable in isolation; the dialog component is a thin view over it.
 */

import { MAX_RELEASE_TAIL_SECONDS } from '@/export/engine-render-types';
import { DEFAULT_EXPORT_MEMORY_BUDGET_BYTES } from '@/export/memory-budget';
import type { MixdownRangePpq, MixdownReport } from '@/export/mixdown';
import { MEBIBYTE } from '@/lib/bytes';
import { dbToLinear } from '@/lib/db';
import { ensureFileExtension, sanitizeFilenameBase } from '@/lib/filename';
import { PayloadMemoryMeter, type PayloadMemorySample } from '@/lib/payload-memory';
import { createStreamingZipWriter, DETERMINISTIC_ZIP_MTIME } from '@/lib/streaming-zip';
import type { ExportRenderOptions } from '@/workers/export.worker';
import { isBrowserMediaEncoderId } from './browser-media';
import { type AudioEncoder, WAV_ENCODER_ID } from './codecs';
import { FLAC_ENCODER_ID, type FlacBitDepth } from './flac';
import {
  DEFAULT_MP3_BITRATE,
  isMp3Bitrate,
  isMp3SampleRate,
  MP3_ENCODER_ID,
  type Mp3Bitrate,
} from './mp3';
import type { WavBitDepth } from './wav';

/** Selectable output sample rates in Hz. */
export const EXPORT_SAMPLE_RATES = [44100, 48000, 96000] as const;

/** One of the selectable output sample rates. */
export type ExportSampleRate = (typeof EXPORT_SAMPLE_RATES)[number];

/** Render range choice: the whole project or the transport loop region. */
export type ExportRangeChoice = 'project' | 'loop';

/** Export mode: one stereo mixdown file, or stems zipped. */
export type ExportMode = 'mixdown' | 'stems';

/** Explicit user-selectable caps for retained render/encode payloads. */
export const EXPORT_MEMORY_BUDGET_MIB = [512, 1024, 2048, 4096] as const;
export type ExportMemoryBudgetMiB = (typeof EXPORT_MEMORY_BUDGET_MIB)[number];

function isExportMemoryBudgetMiB(value: number): value is ExportMemoryBudgetMiB {
  return (EXPORT_MEMORY_BUDGET_MIB as ReadonlyArray<number>).includes(value);
}

/** Selectable compressed browser-encoder bitrates in kbps. */
export const COMPRESSED_EXPORT_BITRATES = [128, 192, 256, 320] as const;

/** One of the selectable compressed browser-encoder bitrates. */
export type CompressedExportBitrate = (typeof COMPRESSED_EXPORT_BITRATES)[number];

/** Returns whether a value is one of the selectable compressed export bitrates. */
function isCompressedExportBitrate(value: number): value is CompressedExportBitrate {
  return (COMPRESSED_EXPORT_BITRATES as ReadonlyArray<number>).includes(value);
}

/** Everything the export dialog edits. */
export interface ExportOptionsModel {
  /** Codec registry id of the chosen format. */
  encoderId: string;
  /** Extra codec registry ids to encode from the same rendered PCM. */
  additionalEncoderIds?: string[];
  /** Output sample rate in Hz. */
  sampleRate: ExportSampleRate;
  /** Render range choice. */
  range: ExportRangeChoice;
  /** Mixdown vs stems mode. */
  mode: ExportMode;
  /** In stems mode, include one extra stem for each mixer bus/return. */
  includeBusStems: boolean;
  /** In stems mode, include the final stereo master in the stems archive. */
  includeMasterStem: boolean;
  /** Apply master inserts/EQ and the project mastering chain. */
  includeMasterChain: boolean;
  /** Apply a final gain trim so the mixdown reaches the app loudness target. */
  normalizeLoudness: boolean;
  /** Release tail appended after the final project clip, in seconds. */
  releaseTailSeconds: number;
  /** Output file base name (extension is derived from the format). */
  baseName: string;
  /** WAV: output sample format. */
  wavBitDepth: WavBitDepth;
  /** WAV: apply TPDF dither before 16-bit quantization. */
  wavDither: boolean;
  /** FLAC: output integer PCM sample depth. */
  flacBitDepth: FlacBitDepth;
  /** FLAC: apply TPDF dither before 16-bit quantization. */
  flacDither: boolean;
  /** MP3: constant bitrate in kbps. */
  mp3Bitrate: Mp3Bitrate;
  /** Browser AAC/Opus: requested MediaRecorder audio bitrate in kbps. */
  compressedBitrateKbps: CompressedExportBitrate;
  /** Cap for all retained render and encode payloads, in MiB. */
  memoryBudgetMiB: ExportMemoryBudgetMiB;
}

/** Fallback base name when the project name sanitizes to nothing. */
const FALLBACK_BASE_NAME = 'project';

/**
 * Creates the dialog defaults: 24-bit WAV mixdown of the whole project, at the
 * project's sample rate when it is selectable and 48 kHz otherwise.
 */
export function createDefaultExportOptions(
  projectName = FALLBACK_BASE_NAME,
  projectSampleRate = 48000,
): ExportOptionsModel {
  return {
    encoderId: WAV_ENCODER_ID,
    additionalEncoderIds: [],
    sampleRate: (EXPORT_SAMPLE_RATES as ReadonlyArray<number>).includes(projectSampleRate)
      ? (projectSampleRate as ExportSampleRate)
      : 48000,
    range: 'project',
    mode: 'mixdown',
    includeBusStems: true,
    includeMasterStem: true,
    includeMasterChain: true,
    normalizeLoudness: false,
    releaseTailSeconds: 2,
    baseName: projectName,
    wavBitDepth: 24,
    wavDither: false,
    flacBitDepth: 24,
    flacDither: false,
    mp3Bitrate: DEFAULT_MP3_BITRATE,
    compressedBitrateKbps: 256,
    memoryBudgetMiB: (DEFAULT_EXPORT_MEMORY_BUDGET_BYTES / MEBIBYTE) as ExportMemoryBudgetMiB,
  };
}

/**
 * Applies final stereo gain to reach a LUFS target and returns the adjusted report.
 * Mutates the channel buffers in place so callers can encode the normalized audio.
 *
 * When the integrated loudness is unmeasured the loudness term is skipped, but
 * the true-peak ceiling is still enforced (attenuation only) so requesting
 * normalization is never a silent no-op that leaves an over-ceiling crest for
 * the integer encoders to clip. If the true peak is unmeasured the sample peak
 * is used as the ceiling reference instead of leaving it uncapped.
 */
export function normalizeMixdownLoudness(
  channels: readonly [Float32Array, Float32Array],
  report: MixdownReport,
  targetLufs: number,
  truePeakCeilingDb = -1,
): MixdownReport {
  // Loudness normalization needs both a measured loudness and a finite target;
  // without them the loudness term contributes no gain (0 dB), leaving only the
  // peak ceiling to act.
  const loudnessGainDb =
    Number.isFinite(report.lufs) && Number.isFinite(targetLufs)
      ? targetLufs - (report.lufs as number)
      : 0;
  // Prefer the measured true peak; fall back to the always-present sample peak
  // so an unmeasured true peak never leaves the ceiling uncapped.
  const peakReferenceDb =
    report.truePeakDbtp !== undefined && Number.isFinite(report.truePeakDbtp)
      ? report.truePeakDbtp
      : Number.isFinite(report.peakDb)
        ? report.peakDb
        : undefined;
  const peakGainDb =
    peakReferenceDb !== undefined ? truePeakCeilingDb - peakReferenceDb : Number.POSITIVE_INFINITY;
  // Normalization is a gain-only operation. Cap the loudness gain at the peak
  // ceiling so integer encoders never have to hard-clip a crest.
  const gainDb = Math.min(loudnessGainDb, peakGainDb);
  if (gainDb === 0) return { ...report };
  const gain = dbToLinear(gainDb);
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) channel[i] *= gain;
  }
  // A clipped-sample census cannot be rescaled: the counts come from samples
  // crossing a fixed threshold. It is also moot here, because the gain is
  // capped at the peak ceiling and so the normalized deliverable sits below
  // the clipping threshold by construction.
  const { clipping: _preNormalizationClipping, ...carried } = report;
  return {
    ...carried,
    peakDb: report.peakDb + gainDb,
    ...(report.truePeakDbtp !== undefined ? { truePeakDbtp: report.truePeakDbtp + gainDb } : {}),
    ...(Number.isFinite(report.lufs) ? { lufs: (report.lufs as number) + gainDb } : {}),
    ...(report.momentaryLufs !== undefined ? { momentaryLufs: report.momentaryLufs + gainDb } : {}),
    ...(report.shortTermLufs !== undefined ? { shortTermLufs: report.shortTermLufs + gainDb } : {}),
  };
}

/** Facts about the environment the options are validated against. */
export interface ExportValidationContext {
  /** Whether a transport loop region exists (enables range 'loop'). */
  hasLoop: boolean;
  /** Registry ids of the available encoders. */
  encoderIds: ReadonlyArray<string>;
  /** Encoder ids backed by browser/runtime codecs that accept a bitrate hint. */
  compressedEncoderIds?: ReadonlyArray<string>;
}

/** Context used when deriving encoder option bags. */
export interface ExportEncodeOptionsContext {
  /** Encoder ids backed by browser/runtime codecs that accept a bitrate hint. */
  compressedEncoderIds?: ReadonlyArray<string>;
}

function isCompressedEncoderId(encoderId: string, context?: ExportEncodeOptionsContext): boolean {
  return (
    isBrowserMediaEncoderId(encoderId) || (context?.compressedEncoderIds ?? []).includes(encoderId)
  );
}

/**
 * Validates an option model against the available encoders and transport
 * state.
 *
 * @returns Human-readable error messages; empty when the model is exportable.
 */
export function validateExportOptions(
  model: ExportOptionsModel,
  context: ExportValidationContext,
): string[] {
  const errors: string[] = [];
  for (const encoderId of selectedEncoderIds(model)) {
    if (!context.encoderIds.includes(encoderId)) {
      errors.push(`Unknown export format: ${encoderId}`);
    }
  }
  if (!(EXPORT_SAMPLE_RATES as ReadonlyArray<number>).includes(model.sampleRate)) {
    errors.push(`Unsupported sample rate: ${model.sampleRate} Hz`);
  }
  if (model.range === 'loop' && !context.hasLoop) {
    errors.push('Loop range requires an active loop region');
  }
  if (model.baseName.trim().length === 0) {
    errors.push('Filename must not be empty');
  }
  if (
    !Number.isFinite(model.releaseTailSeconds) ||
    model.releaseTailSeconds < 0 ||
    model.releaseTailSeconds > MAX_RELEASE_TAIL_SECONDS
  ) {
    errors.push(`Release tail must be between 0 and ${MAX_RELEASE_TAIL_SECONDS} seconds`);
  }
  if (!isExportMemoryBudgetMiB(model.memoryBudgetMiB)) {
    errors.push(`Unsupported export memory budget: ${String(model.memoryBudgetMiB)} MiB`);
  }
  if (selectedEncoderIds(model).includes(MP3_ENCODER_ID)) {
    if (!isMp3SampleRate(model.sampleRate)) {
      errors.push('MP3 supports 44.1 kHz and 48 kHz only');
    }
    if (!isMp3Bitrate(model.mp3Bitrate)) {
      errors.push(`Unsupported MP3 bitrate: ${String(model.mp3Bitrate)} kbps`);
    }
  }
  if (selectedEncoderIds(model).includes(FLAC_ENCODER_ID)) {
    if (model.flacBitDepth !== 16 && model.flacBitDepth !== 24) {
      errors.push(`Unsupported FLAC bit depth: ${String(model.flacBitDepth)}`);
    }
  }
  if (
    selectedEncoderIds(model).some((encoderId) => isCompressedEncoderId(encoderId, context)) &&
    !isCompressedExportBitrate(model.compressedBitrateKbps)
  ) {
    errors.push(`Unsupported compressed bitrate: ${String(model.compressedBitrateKbps)} kbps`);
  }
  return errors;
}

/**
 * Returns the selected codecs in stable user order, with the primary format
 * first and duplicate/blank supplemental selections removed.
 */
export function selectedEncoderIds(model: ExportOptionsModel): string[] {
  const ids = [model.encoderId, ...(model.additionalEncoderIds ?? [])];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** Maps the model to the encoder-specific option bag for `encoder.encode`. */
export function encodeOptionsForModel(
  model: ExportOptionsModel,
  context?: ExportEncodeOptionsContext,
): Record<string, unknown> {
  if (model.encoderId === WAV_ENCODER_ID) {
    return { bitDepth: model.wavBitDepth, dither: model.wavDither };
  }
  if (model.encoderId === MP3_ENCODER_ID) {
    return { bitrate: model.mp3Bitrate };
  }
  if (model.encoderId === FLAC_ENCODER_ID) {
    return { bitDepth: model.flacBitDepth, dither: model.flacDither };
  }
  if (isCompressedEncoderId(model.encoderId, context)) {
    return { bitrate: model.compressedBitrateKbps };
  }
  return {};
}

/**
 * Maps the model to worker render options.
 *
 * @param loopRegion Transport loop window; required when range is 'loop'.
 * @throws RangeError when range is 'loop' but no loop region is given.
 */
export function toRenderOptions(
  model: ExportOptionsModel,
  loopRegion?: MixdownRangePpq | null,
): ExportRenderOptions {
  const options: ExportRenderOptions = {
    sampleRate: model.sampleRate,
    range: 'project',
    includeMasterChain: model.includeMasterChain,
    stems: model.mode === 'stems',
    busStems: model.mode === 'stems' && model.includeBusStems,
    masterStem: model.mode === 'stems' && model.includeMasterStem,
    releaseTailSeconds: model.releaseTailSeconds,
    memoryBudgetBytes: model.memoryBudgetMiB * MEBIBYTE,
  };
  if (model.range === 'loop') {
    if (!loopRegion) {
      throw new RangeError("Range 'loop' requires a loop region");
    }
    options.range = 'loop';
    options.loopRegion = { startPpq: loopRegion.startPpq, endPpq: loopRegion.endPpq };
  }
  return options;
}

/** Replaces characters that are unsafe in filenames and trims whitespace. */
export function sanitizeFileBaseName(name: string, fallback = FALLBACK_BASE_NAME): string {
  return sanitizeFilenameBase(name, fallback);
}

/** Derives the mixdown download filename (sanitized base + extension). */
export function exportFileName(baseName: string, extension: string): string {
  return ensureFileExtension(sanitizeFileBaseName(baseName), extension);
}

/** Derives the stems archive filename: '<base> stems.zip'. */
export function stemsZipFileName(baseName: string): string {
  return `${sanitizeFileBaseName(baseName)} stems.zip`;
}

export function stemsZipFileNameForEncoder(
  baseName: string,
  encoder: AudioEncoder,
  selectedCount: number,
): string {
  return selectedCount === 1
    ? stemsZipFileName(baseName)
    : `${stemsZipFileName(baseName).slice(0, -4)} ${encoder.id}.zip`;
}

/**
 * Derives one deterministic zip entry name: a 1-based zero-padded index prefix
 * keeps entries ordered and unique even when track names collide
 * (e.g. '01 Drums.wav').
 */
export function stemEntryName(
  stemName: string,
  index: number,
  total: number,
  extension: string,
): string {
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total <= index) {
    throw new RangeError(`Invalid stem ordinal ${index + 1}/${total}`);
  }
  const width = Math.max(2, String(total).length);
  const ordinal = String(index + 1).padStart(width, '0');
  return ensureFileExtension(`${ordinal} ${sanitizeFileBaseName(stemName, 'Track')}`, extension);
}

/** One file inside the stems archive. */
export interface StemsZipEntry {
  /** Zip entry name (see {@link stemEntryName}). */
  name: string;
  /** Encoded file bytes. */
  bytes: Uint8Array;
}

/** Incremental ZIP sink: each encoded stem is compressed and released before the next. */
export interface StemsZipWriter {
  /** Resolves only after this entry has been compressed and emitted. */
  add(entry: StemsZipEntry): Promise<void>;
  close(): Promise<Blob>;
}

export function createStemsZipWriter(
  signal?: AbortSignal,
  memory: {
    budgetBytes?: number;
    onSample?: (sample: PayloadMemorySample) => void;
    meter?: PayloadMemoryMeter;
  } = {},
): StemsZipWriter {
  const meter =
    memory.meter ??
    new PayloadMemoryMeter({
      operation: 'audio-export',
      label: 'Stems ZIP',
      budgetBytes: memory.budgetBytes ?? DEFAULT_EXPORT_MEMORY_BUDGET_BYTES,
      onSample: memory.onSample,
    });
  const writer = createStreamingZipWriter({
    mtime: DETERMINISTIC_ZIP_MTIME,
    signal,
    meter,
  });
  return {
    add(entry): Promise<void> {
      return writer.add(entry.name, entry.bytes);
    },
    async close(): Promise<Blob> {
      if (writer.stats().entries === 0) {
        writer.abort(new RangeError('Stems zip requires at least one entry'));
      }
      const bytes = await writer.close();
      const releasePublishPeak = meter.retain(bytes.byteLength, 'ZIP Blob publish');
      const blob = new Blob([bytes], { type: 'application/zip' });
      releasePublishPeak();
      return blob;
    },
  };
}
