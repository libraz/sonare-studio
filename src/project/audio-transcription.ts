/**
 * Canonical audio-to-MIDI adapter.
 *
 * The detector runs in a worker on a constant grid at the project tempo where
 * the clip starts, so note values mean what they do in the project. This module owns the project-side coordinate transform and note
 * pairing, so monophonic and polyphonic transcription share one placement
 * contract and one set of memory guards.
 */

import { PayloadMemoryLimitError } from '@/lib/payload-memory';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import type { ProjectMidiEvent, TranscribeResult } from '@/wasm/index.js';
import { mixdownToMono } from './audio-import';
import { audioClipSegments } from './comping';
import { pairEventsIntoNotes, type RawNote, type SerializedMidiEvent } from './midi-events';
import { renderAudibleAudioClipWindow } from './scheduling';
import { normalizeTempoMap, ppqToSeconds, secondsToPpq, tempoAtPpq } from './tempo-map';
import type { TranscribeWorkerOptions } from './transcribe-client';
import type { ClipCompSegment, ClipTake, ClipWarp, TempoSegment } from './types';
import type { WarpRenderFn } from './warp';

/** Polyphonic transcription's maximum source duration; working memory grows about 3 MB per second. */
export const MAX_POLYPHONIC_SECONDS = 120;
/** Polyphonic transcription's maximum detector input size at 48 kHz. */
export const MAX_POLYPHONIC_SAMPLES = 5_760_000;
/** The detector receives at most this sample rate. */
export const MAX_TRANSCRIPTION_SAMPLE_RATE = 48_000;
/** Conservative preparation budget for decoded/rendered/transferred PCM. */
export const DEFAULT_TRANSCRIPTION_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

export interface AudioTranscriptionClip {
  id?: number;
  assetId?: string;
  startPpq: number;
  lengthPpq: number;
  sourceOffsetPpq: number;
  loopEnabled?: boolean;
  loopLengthPpq?: number;
  fadeInPpq?: number;
  fadeOutPpq?: number;
  takes?: ReadonlyArray<ClipTake>;
  compSegments?: ReadonlyArray<ClipCompSegment>;
  warp?: ClipWarp;
}

/** The worker-facing transcription function, injectable for adapter tests. */
export type AudioTranscriber = (
  samples: Float32Array,
  sampleRate: number,
  polyphonic: boolean,
  options?: TranscribeWorkerOptions,
) => Promise<TranscribeResult>;

/** Injectable dependencies for {@link transcribeAudioClip}. */
export interface AudioTranscriptionDeps {
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Metadata-only loader used to preflight bounds before decoding PCM. */
  loadAudioAssetMeta?: (assetId: string) => Promise<AudioAssetMeta>;
  transcribe: AudioTranscriber;
  /** Warped-window renderer override used by deterministic adapter tests. */
  renderWarp?: WarpRenderFn;
}

/** Options controlling one audio-to-MIDI analysis. */
export interface AudioTranscriptionOptions {
  polyphonic?: boolean;
  signal?: AbortSignal;
  /** Clip-relative rhythm grid; omitted preserves detector timing. */
  rhythmQuantizePpq?: number;
  /** Tuning reference in Hz, or `'auto'` to measure it; omitted means 440 Hz. */
  referenceHz?: number | 'auto';
  /** Shortest note kept, as a `1/n` note at the clip's tempo; omitted keeps the library default. */
  minNoteDivision?: number;
  /** Receives the tuning the notes were measured against, in fractions of a semitone. */
  onTuning?: (tuning: number) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  if (typeof DOMException !== 'undefined') {
    throw new DOMException('Transcription was aborted', 'AbortError');
  }
  const error = new Error('Transcription was aborted');
  error.name = 'AbortError';
  throw error;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validProjectMidiEvent(value: unknown): value is ProjectMidiEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  const data0 = event.data0;
  return (
    finite(event.ppq) &&
    event.ppq >= 0 &&
    finite(data0) &&
    Number.isInteger(data0) &&
    data0 >= 0 &&
    data0 <= 0xffffffff
  );
}

function validateResult(result: TranscribeResult): void {
  if (
    !result ||
    !Array.isArray(result.events) ||
    !result.events.every(validProjectMidiEvent) ||
    !Number.isInteger(result.noteCount) ||
    result.noteCount < 0 ||
    result.noteCount * 2 !== result.events.length ||
    !finite(result.tempoBpm) ||
    result.tempoBpm <= 0
  ) {
    throw new Error('Transcription returned an invalid result');
  }
}

function snapToGrid(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

function quantizeNotes(
  notes: ReadonlyArray<RawNote>,
  grid: number | undefined,
  clipLengthPpq: number,
): RawNote[] {
  if (!(grid !== undefined && Number.isFinite(grid) && grid > 0)) {
    return notes.map((note) => ({ ...note }));
  }
  return notes.flatMap((note) => {
    const start = Math.max(0, Math.min(clipLengthPpq, snapToGrid(note.startPpq, grid)));
    let end = Math.max(start + grid, snapToGrid(note.startPpq + note.durationPpq, grid));
    end = Math.min(clipLengthPpq, end);
    if (!(end > start)) return [];
    return [{ ...note, startPpq: start, durationPpq: end - start }];
  });
}

function eventNotes(events: ReadonlyArray<ProjectMidiEvent>): RawNote[] {
  const serialized: SerializedMidiEvent[] = events.map((event) => ({
    ppq: event.ppq,
    data0: event.data0,
    data1: event.data1 ?? 0,
  }));
  return pairEventsIntoNotes(serialized);
}

function safePcmBytes(frames: number, channels: number): number {
  if (
    !Number.isSafeInteger(frames) ||
    !Number.isSafeInteger(channels) ||
    frames < 0 ||
    channels < 0
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  const bytes = frames * channels * Float32Array.BYTES_PER_ELEMENT;
  return Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER;
}

function addSafeBytes(parts: ReadonlyArray<number>): number {
  let total = 0;
  for (const bytes of parts) {
    total += bytes;
    if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

function validateAudioAssetMeta(meta: AudioAssetMeta): void {
  if (
    !Number.isFinite(meta.sampleRate) ||
    meta.sampleRate <= 0 ||
    !Number.isSafeInteger(meta.numFrames) ||
    meta.numFrames < 0 ||
    !Number.isSafeInteger(meta.numChannels) ||
    meta.numChannels <= 0
  ) {
    throw new Error('Transcription received invalid audio asset metadata');
  }
}

async function preflightTranscription(
  clip: AudioTranscriptionClip,
  map: ReturnType<typeof normalizeTempoMap>,
  polyphonic: boolean,
  loadMeta: (assetId: string) => Promise<AudioAssetMeta>,
  signal?: AbortSignal,
): Promise<{
  segments: ReturnType<typeof audioClipSegments>;
  metadata: Map<string, AudioAssetMeta>;
}> {
  const segments = audioClipSegments(clip, { tempoMap: map, clipStartPpq: clip.startPpq });
  if (segments.length === 0) return { segments, metadata: new Map() };
  const startSeconds = ppqToSeconds(map, clip.startPpq);
  const endSeconds = ppqToSeconds(map, clip.startPpq + clip.lengthPpq);
  const audibleSeconds = Math.max(0, endSeconds - startSeconds);
  if (polyphonic && audibleSeconds > MAX_POLYPHONIC_SECONDS) {
    throw new RangeError(
      `Polyphonic transcription is limited to ${MAX_POLYPHONIC_SECONDS} seconds at ${MAX_TRANSCRIPTION_SAMPLE_RATE} Hz`,
    );
  }

  const assetIds = [...new Set(segments.map((segment) => segment.assetId))];
  const metadata = new Map<string, AudioAssetMeta>();
  for (const assetId of assetIds) {
    throwIfAborted(signal);
    const meta = await loadMeta(assetId);
    throwIfAborted(signal);
    validateAudioAssetMeta(meta);
    metadata.set(assetId, meta);
  }
  const firstMeta = metadata.get(segments[0]?.assetId ?? '');
  if (!firstMeta) return { segments, metadata };
  const renderRate = firstMeta.sampleRate;
  const targetRate = Math.min(renderRate, MAX_TRANSCRIPTION_SAMPLE_RATE);
  const renderedFrames = Math.max(0, Math.round(audibleSeconds * renderRate));
  const targetFrames = Math.max(0, Math.round(audibleSeconds * targetRate));
  if (polyphonic && targetFrames > MAX_POLYPHONIC_SAMPLES) {
    throw new RangeError(
      `Polyphonic transcription is limited to ${MAX_POLYPHONIC_SECONDS} seconds at ${MAX_TRANSCRIPTION_SAMPLE_RATE} Hz`,
    );
  }
  const sourceBytes = addSafeBytes(
    assetIds.map((assetId) => {
      const meta = metadata.get(assetId);
      return meta ? safePcmBytes(meta.numFrames, meta.numChannels) : Number.MAX_SAFE_INTEGER;
    }),
  );
  const renderedChannels = Math.max(
    1,
    ...assetIds.map((assetId) => metadata.get(assetId)?.numChannels ?? 0),
  );
  const renderedBytes = safePcmBytes(renderedFrames, renderedChannels);
  const monoBytes = safePcmBytes(renderedFrames, 1);
  const workerResampledBytes = safePcmBytes(targetFrames, 1);
  const requiredBytes = addSafeBytes([
    sourceBytes,
    renderedBytes,
    monoBytes,
    // transcribe-client copies the mono buffer before transferring it.
    monoBytes,
    workerResampledBytes,
    // The warp renderer may retain both its source and output while rendering.
    clip.warp?.enabled === true ? renderedBytes : 0,
  ]);
  if (requiredBytes > DEFAULT_TRANSCRIPTION_MEMORY_BUDGET_BYTES) {
    throw new PayloadMemoryLimitError(
      'Audio transcription',
      requiredBytes,
      DEFAULT_TRANSCRIPTION_MEMORY_BUDGET_BYTES,
    );
  }
  return { segments, metadata };
}

/**
 * Transcribes one audio clip into clip-relative editor notes.
 *
 * `tempoBpm` is the fallback project tempo used when no tempo segments are
 * available. `tempoSegments` maps returned detector seconds to the real
 * project timeline. No project mutation happens here.
 */
export async function transcribeAudioClip(
  clip: AudioTranscriptionClip,
  tempoBpm: number,
  deps: AudioTranscriptionDeps,
  options: AudioTranscriptionOptions = {},
  tempoSegments: ReadonlyArray<TempoSegment> = [],
): Promise<RawNote[]> {
  if ((clip.assetId === undefined && (clip.takes?.length ?? 0) === 0) || !(tempoBpm > 0)) return [];
  throwIfAborted(options.signal);
  const map = normalizeTempoMap(tempoSegments, tempoBpm);
  const polyphonic = options.polyphonic === true;
  const loadedAssets = new Map<string, Promise<LoadedAudioAsset>>();
  const loadAudioAsset = async (assetId: string): Promise<LoadedAudioAsset> => {
    throwIfAborted(options.signal);
    let pending = loadedAssets.get(assetId);
    if (!pending) {
      pending = deps.loadAudioAsset(assetId);
      loadedAssets.set(assetId, pending);
    }
    const asset = await pending;
    throwIfAborted(options.signal);
    return asset;
  };
  const loadMeta =
    deps.loadAudioAssetMeta ??
    (async (assetId: string): Promise<AudioAssetMeta> => (await loadAudioAsset(assetId)).meta);
  await preflightTranscription(clip, map, polyphonic, loadMeta, options.signal);
  throwIfAborted(options.signal);
  const renderWarp = deps.renderWarp
    ? async (...args: Parameters<WarpRenderFn>): ReturnType<WarpRenderFn> => {
        throwIfAborted(options.signal);
        const rendered = await deps.renderWarp?.(...args);
        throwIfAborted(options.signal);
        return rendered ?? [];
      }
    : undefined;
  const window = await renderAudibleAudioClipWindow(clip, map, loadAudioAsset, {
    renderWarp,
  });
  throwIfAborted(options.signal);
  if (!window) return [];
  const { channels, sampleRate: sourceRate } = window;
  const mono = mixdownToMono(channels);
  const windowFrames = channels[0]?.length ?? 0;
  if (windowFrames === 0) return [];
  const targetRate = Math.min(sourceRate, MAX_TRANSCRIPTION_SAMPLE_RATE);
  if (mono.length === 0) return [];
  throwIfAborted(options.signal);
  const gridTempoBpm = tempoAtPpq(map, clip.startPpq);
  const result = await deps.transcribe(mono, targetRate, polyphonic, {
    signal: options.signal,
    tempoBpm: gridTempoBpm,
    ...(sourceRate !== targetRate ? { sourceSampleRate: sourceRate } : {}),
    ...(options.referenceHz !== undefined ? { referenceHz: options.referenceHz } : {}),
    ...(options.minNoteDivision !== undefined ? { minNoteDivision: options.minNoteDivision } : {}),
  });
  throwIfAborted(options.signal);
  validateResult(result);
  if (finite(result.tuning)) options.onTuning?.(result.tuning);

  // Detector PPQ sits on a constant grid at the reported tempo; take it to
  // elapsed seconds, through the project's map and back to the clip's origin.
  const secondsPerBeat = 60 / result.tempoBpm;
  const clipStartSeconds = ppqToSeconds(map, clip.startPpq);
  const beatsToClipPpq = (beats: number): number =>
    secondsToPpq(map, clipStartSeconds + Math.max(0, beats) * secondsPerBeat) - clip.startPpq;
  const notes = eventNotes(result.events).flatMap((note) => {
    const startPpq = Math.max(0, Math.min(clip.lengthPpq, beatsToClipPpq(note.startPpq)));
    const endPpq = Math.min(clip.lengthPpq, beatsToClipPpq(note.startPpq + note.durationPpq));
    if (!(endPpq > startPpq)) return [];
    return [{ ...note, startPpq, durationPpq: endPpq - startPpq }];
  });
  return quantizeNotes(notes, options.rhythmQuantizePpq, clip.lengthPpq);
}
