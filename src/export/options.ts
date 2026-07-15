/**
 * Pure option model for the audio export dialog: defaults, validation,
 * filename derivation, encoder/render option mapping and stems zip
 * composition. No DOM, store or wasm access, so the whole module is
 * unit-testable in isolation; the dialog component is a thin view over it.
 */

import { AsyncZipDeflate, Zip, zipSync } from 'fflate';
import { DEFAULT_EXPORT_MEMORY_BUDGET_BYTES } from '@/export/memory-budget';
import type { MixdownRangePpq, MixdownReport } from '@/export/mixdown';
import { dbToLinear } from '@/lib/db';
import { PayloadMemoryMeter, type PayloadMemorySample } from '@/lib/payload-memory';
import type { ExportRenderOptions } from '@/workers/export.worker';
import { isBrowserMediaEncoderId } from './browser-media';
import { WAV_ENCODER_ID } from './codecs';
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

/** Selectable compressed browser-encoder bitrates in kbps. */
export const COMPRESSED_EXPORT_BITRATES = [128, 192, 256, 320] as const;

/** One of the selectable compressed browser-encoder bitrates. */
export type CompressedExportBitrate = (typeof COMPRESSED_EXPORT_BITRATES)[number];

/** Returns whether a value is one of the selectable compressed export bitrates. */
export function isCompressedExportBitrate(value: number): value is CompressedExportBitrate {
  return (COMPRESSED_EXPORT_BITRATES as ReadonlyArray<number>).includes(value);
}

/** Everything the export dialog edits. */
export interface ExportOptionsModel {
  /** Codec registry id of the chosen format. */
  encoderId: string;
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
  /** MP3: constant bitrate in kbps. */
  mp3Bitrate: Mp3Bitrate;
  /** Browser AAC/Opus: requested MediaRecorder audio bitrate in kbps. */
  compressedBitrateKbps: CompressedExportBitrate;
}

/** Fallback base name when the project name sanitizes to nothing. */
const FALLBACK_BASE_NAME = 'project';

/** Fixed zip timestamp so identical inputs produce identical archives. */
const STEMS_ZIP_MTIME = '2000-01-01T12:00:00Z';

/** Creates the dialog defaults: 16-bit WAV mixdown of the whole project. */
export function createDefaultExportOptions(projectName = FALLBACK_BASE_NAME): ExportOptionsModel {
  return {
    encoderId: WAV_ENCODER_ID,
    sampleRate: 48000,
    range: 'project',
    mode: 'mixdown',
    includeBusStems: true,
    includeMasterStem: true,
    includeMasterChain: true,
    normalizeLoudness: false,
    releaseTailSeconds: 2,
    baseName: projectName,
    wavBitDepth: 16,
    wavDither: false,
    flacBitDepth: 24,
    mp3Bitrate: DEFAULT_MP3_BITRATE,
    compressedBitrateKbps: 256,
  };
}

/**
 * Applies final stereo gain to reach a LUFS target and returns the adjusted report.
 * Mutates the channel buffers in place so callers can encode the normalized audio.
 */
export function normalizeMixdownLoudness(
  channels: readonly [Float32Array, Float32Array],
  report: MixdownReport,
  targetLufs: number,
  truePeakCeilingDb = -1,
): MixdownReport {
  if (!Number.isFinite(report.lufs) || !Number.isFinite(targetLufs)) return { ...report };
  const loudnessGainDb = targetLufs - (report.lufs as number);
  const truePeakGainDb =
    report.truePeakDb !== undefined && Number.isFinite(report.truePeakDb)
      ? truePeakCeilingDb - report.truePeakDb
      : Number.POSITIVE_INFINITY;
  // Normalization is a gain-only operation. Cap that gain at the measured
  // true-peak ceiling so integer encoders never have to hard-clip a crest.
  const gainDb = Math.min(loudnessGainDb, truePeakGainDb);
  const gain = dbToLinear(gainDb);
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) channel[i] *= gain;
  }
  return {
    ...report,
    peakDb: report.peakDb + gainDb,
    ...(report.truePeakDb !== undefined ? { truePeakDb: report.truePeakDb + gainDb } : {}),
    lufs: (report.lufs as number) + gainDb,
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
  if (!context.encoderIds.includes(model.encoderId)) {
    errors.push(`Unknown export format: ${model.encoderId}`);
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
    model.releaseTailSeconds > 120
  ) {
    errors.push('Release tail must be between 0 and 120 seconds');
  }
  if (model.encoderId === MP3_ENCODER_ID) {
    if (!isMp3SampleRate(model.sampleRate)) {
      errors.push('MP3 supports 44.1 kHz and 48 kHz only');
    }
    if (!isMp3Bitrate(model.mp3Bitrate)) {
      errors.push(`Unsupported MP3 bitrate: ${String(model.mp3Bitrate)} kbps`);
    }
  }
  if (model.encoderId === FLAC_ENCODER_ID) {
    if (model.flacBitDepth !== 16 && model.flacBitDepth !== 24) {
      errors.push(`Unsupported FLAC bit depth: ${String(model.flacBitDepth)}`);
    }
  }
  if (
    isCompressedEncoderId(model.encoderId, context) &&
    !isCompressedExportBitrate(model.compressedBitrateKbps)
  ) {
    errors.push(`Unsupported compressed bitrate: ${String(model.compressedBitrateKbps)} kbps`);
  }
  return errors;
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
    return { bitDepth: model.flacBitDepth };
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
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Appends an extension unless the name already ends with it. */
function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(extension.toLowerCase()) ? name : `${name}${extension}`;
}

/** Derives the mixdown download filename (sanitized base + extension). */
export function exportFileName(baseName: string, extension: string): string {
  return withExtension(sanitizeFileBaseName(baseName), extension);
}

/** Derives the stems archive filename: '<base> stems.zip'. */
export function stemsZipFileName(baseName: string): string {
  return `${sanitizeFileBaseName(baseName)} stems.zip`;
}

/**
 * Derives the zip entry names for a list of stems: a 1-based zero-padded
 * index prefix keeps entries ordered and unique even when track names
 * collide (e.g. '01 Drums.wav').
 */
export function stemEntryNames(stemNames: ReadonlyArray<string>, extension: string): string[] {
  return stemNames.map((name, index) => stemEntryName(name, index, stemNames.length, extension));
}

/** Derives one deterministic entry name without retaining the other stem names. */
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
  return withExtension(`${ordinal} ${sanitizeFileBaseName(stemName, 'Track')}`, extension);
}

/** One file inside the stems archive. */
export interface StemsZipEntry {
  /** Zip entry name (see {@link stemEntryNames}). */
  name: string;
  /** Encoded file bytes. */
  bytes: Uint8Array;
}

/**
 * Packs encoded stem files into a zip archive (stored with a fixed
 * timestamp, so identical inputs produce byte-identical archives).
 *
 * @throws RangeError when no entries are given.
 */
export function buildStemsZip(entries: ReadonlyArray<StemsZipEntry>): Uint8Array {
  if (entries.length === 0) {
    throw new RangeError('Stems zip requires at least one entry');
  }
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.name] = entry.bytes;
  }
  return zipSync(files, { mtime: STEMS_ZIP_MTIME });
}

/** Incremental ZIP sink: each encoded stem is compressed and released before the next. */
export interface StemsZipWriter {
  add(entry: StemsZipEntry): void;
  close(): Promise<Blob>;
}

export function createStemsZipWriter(
  signal?: AbortSignal,
  memory: {
    budgetBytes?: number;
    onSample?: (sample: PayloadMemorySample) => void;
  } = {},
): StemsZipWriter {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const chunkReleases: Array<() => void> = [];
  const meter = new PayloadMemoryMeter({
    label: 'Stems ZIP',
    budgetBytes: memory.budgetBytes ?? DEFAULT_EXPORT_MEMORY_BUDGET_BYTES,
    onSample: memory.onSample,
  });
  const releaseChunks = () => {
    chunks.length = 0;
    while (chunkReleases.length > 0) chunkReleases.pop()?.();
  };
  const names = new Set<string>();
  let entryCount = 0;
  let closed = false;
  let resolveResult!: (blob: Blob) => void;
  let rejectResult!: (error: unknown) => void;
  let settled = false;
  const result = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Cancellation can arrive before the caller reaches close(); keep that
  // intentional early rejection from becoming an unhandled Promise.
  void result.catch(() => {});
  const zip = new Zip((error, chunk, final) => {
    if (settled) return;
    if (error) {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      releaseChunks();
      rejectResult(error);
      return;
    }
    try {
      const release = meter.retain(chunk.byteLength, `compressed chunk ${chunks.length + 1}`);
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      chunks.push(copy);
      chunkReleases.push(release);
    } catch (memoryError) {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      releaseChunks();
      rejectResult(memoryError);
      return;
    }
    if (final) {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      const blob = new Blob(chunks, { type: 'application/zip' });
      releaseChunks();
      resolveResult(blob);
    }
  });
  const abortError = (): unknown =>
    signal?.reason ?? new DOMException('Stems ZIP creation cancelled.', 'AbortError');
  function onAbort(): void {
    if (settled) return;
    settled = true;
    zip.terminate();
    releaseChunks();
    rejectResult(abortError());
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    add(entry): void {
      signal?.throwIfAborted();
      if (closed) throw new Error('Stems zip writer is closed');
      if (names.has(entry.name)) throw new Error(`Duplicate stems zip entry: ${entry.name}`);
      names.add(entry.name);
      entryCount += 1;
      const file = new AsyncZipDeflate(entry.name, { level: 6 });
      file.mtime = new Date(STEMS_ZIP_MTIME);
      zip.add(file);
      file.push(entry.bytes, true);
    },
    close(): Promise<Blob> {
      if (signal?.aborted) return Promise.reject(abortError());
      if (closed) return result;
      if (entryCount === 0) {
        closed = true;
        zip.terminate();
        releaseChunks();
        rejectResult(new RangeError('Stems zip requires at least one entry'));
        return result;
      }
      closed = true;
      zip.end();
      return result;
    },
  };
}
