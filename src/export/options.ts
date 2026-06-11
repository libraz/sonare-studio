/**
 * Pure option model for the audio export dialog: defaults, validation,
 * filename derivation, encoder/render option mapping and stems zip
 * composition. No DOM, store or wasm access, so the whole module is
 * unit-testable in isolation; the dialog component is a thin view over it.
 */

import { zipSync } from 'fflate';
import type { MixdownRangePpq } from '@/export/mixdown';
import type { ExportRenderOptions } from '@/workers/export.worker';
import { WAV_ENCODER_ID } from './codecs';
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

/** Export mode: one stereo mixdown file, or one file per track zipped. */
export type ExportMode = 'mixdown' | 'stems';

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
  /** Apply master inserts/EQ and the project mastering chain. */
  includeMasterChain: boolean;
  /** Output file base name (extension is derived from the format). */
  baseName: string;
  /** WAV: output sample format. */
  wavBitDepth: WavBitDepth;
  /** WAV: apply TPDF dither before 16-bit quantization. */
  wavDither: boolean;
  /** MP3: constant bitrate in kbps. */
  mp3Bitrate: Mp3Bitrate;
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
    includeMasterChain: true,
    baseName: projectName,
    wavBitDepth: 16,
    wavDither: false,
    mp3Bitrate: DEFAULT_MP3_BITRATE,
  };
}

/** Facts about the environment the options are validated against. */
export interface ExportValidationContext {
  /** Whether a transport loop region exists (enables range 'loop'). */
  hasLoop: boolean;
  /** Registry ids of the available encoders. */
  encoderIds: ReadonlyArray<string>;
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
  if (model.encoderId === MP3_ENCODER_ID) {
    if (!isMp3SampleRate(model.sampleRate)) {
      errors.push('MP3 supports 44.1 kHz and 48 kHz only');
    }
    if (!isMp3Bitrate(model.mp3Bitrate)) {
      errors.push(`Unsupported MP3 bitrate: ${String(model.mp3Bitrate)} kbps`);
    }
  }
  return errors;
}

/** Maps the model to the encoder-specific option bag for `encoder.encode`. */
export function encodeOptionsForModel(model: ExportOptionsModel): Record<string, unknown> {
  if (model.encoderId === WAV_ENCODER_ID) {
    return { bitDepth: model.wavBitDepth, dither: model.wavDither };
  }
  if (model.encoderId === MP3_ENCODER_ID) {
    return { bitrate: model.mp3Bitrate };
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
  const width = Math.max(2, String(stemNames.length).length);
  return stemNames.map((name, index) => {
    const ordinal = String(index + 1).padStart(width, '0');
    return withExtension(`${ordinal} ${sanitizeFileBaseName(name, 'Track')}`, extension);
  });
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
