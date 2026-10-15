/**
 * Canonical audio-to-MIDI adapter.
 *
 * The detector runs in a worker on a constant grid at the project tempo where
 * the clip starts, so note values mean what they do in the project. This module owns the project-side coordinate transform and note
 * pairing, so monophonic and polyphonic transcription share one placement
 * contract and one set of memory guards.
 */

import { downmixToMono } from '@/lib/audio-channels';
import { PayloadMemoryLimitError } from '@/lib/payload-memory';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import type { ProjectMidiEvent, TranscribeResult } from '@/wasm/index.js';
import { audioClipSegments } from './comping';
import { pairEventsIntoNotes, type RawNote, type SerializedMidiEvent } from './midi-events';
import { renderAudibleAudioClipWindow } from './scheduling';
import { normalizeTempoMap, ppqToSeconds, secondsToPpq, tempoAtPpq } from './tempo-map';
import type { TranscribeWorkerOptions } from './transcribe-client';
import type { ClipCompSegment, ClipTake, ClipWarp, TempoSegment } from './types';
import type { WarpRenderFn } from './warp';

/** Longest span one polyphonic detector request reads; working memory grows about 1.1 MB per second. */
export const MAX_POLYPHONIC_SECONDS = 300;
/** A polyphonic chunk reads this far past each cut, so a note crossing it keeps its onset and length. */
const POLYPHONIC_CHUNK_OVERLAP_SECONDS = 2;
/** Shortest chunk worth reading; a budget that cannot hold one refuses the clip. */
const MIN_POLYPHONIC_CHUNK_SECONDS = 30;
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

/** Notes read from one clip, with the level of the input they were read from. */
export interface AudioTranscription {
  notes: RawNote[];
  /** Largest absolute sample of the mono input the detector received; 0 when nothing rendered. */
  peak: number;
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
  /** Polyphonic only: most notes one frame may hold, `1..64`; omitted keeps the library default. */
  maxPolyphony?: number;
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

/**
 * Snaps clip-relative notes to a rhythm grid whose lines fall on `originPpq`
 * (clip-relative) and every grid step from it, keeping every note inside the clip.
 */
export function quantizeNotes(
  notes: ReadonlyArray<RawNote>,
  grid: number | undefined,
  clipLengthPpq: number,
  originPpq = 0,
): RawNote[] {
  if (!(grid !== undefined && Number.isFinite(grid) && grid > 0)) {
    return notes.map((note) => ({ ...note }));
  }
  const snap = (ppq: number): number => originPpq + snapToGrid(ppq - originPpq, grid);
  return notes.flatMap((note) => {
    const start = Math.max(0, Math.min(clipLengthPpq, snap(note.startPpq)));
    let end = Math.max(start + grid, snap(note.startPpq + note.durationPpq));
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
  /** Sample rate the clip window renders at; 0 when nothing is audible. */
  renderRate: number;
  /** Longest window one detector request may read. */
  requestSeconds: number;
  audibleSeconds: number;
}> {
  const segments = audioClipSegments(clip, { tempoMap: map, clipStartPpq: clip.startPpq });
  const empty = {
    segments,
    metadata: new Map(),
    renderRate: 0,
    requestSeconds: 0,
    audibleSeconds: 0,
  };
  if (segments.length === 0) return empty;
  const startSeconds = ppqToSeconds(map, clip.startPpq);
  const endSeconds = ppqToSeconds(map, clip.startPpq + clip.lengthPpq);
  const audibleSeconds = Math.max(0, endSeconds - startSeconds);

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
  if (!firstMeta) return { ...empty, metadata };
  const renderRate = firstMeta.sampleRate;
  const targetRate = Math.min(renderRate, MAX_TRANSCRIPTION_SAMPLE_RATE);
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
  const framesOf = (seconds: number, rate: number): number =>
    Math.max(0, Math.round(seconds * rate));
  const fixedBytes = addSafeBytes([
    sourceBytes,
    // The warp renderer produces each warped segment whole, whatever the window.
    clip.warp?.enabled === true
      ? safePcmBytes(framesOf(audibleSeconds, renderRate), renderedChannels)
      : 0,
  ]);
  // One request holds its rendered window, the mono mixdown, the copy
  // transcribe-client transfers, and the worker's resampled input.
  const requestBytes = (seconds: number): number =>
    addSafeBytes([
      safePcmBytes(framesOf(seconds, renderRate), renderedChannels),
      safePcmBytes(framesOf(seconds, renderRate), 1),
      safePcmBytes(framesOf(seconds, renderRate), 1),
      safePcmBytes(framesOf(seconds, targetRate), 1),
    ]);
  const fits = (seconds: number): boolean =>
    addSafeBytes([fixedBytes, requestBytes(seconds)]) <= DEFAULT_TRANSCRIPTION_MEMORY_BUDGET_BYTES;
  let requestSeconds = audibleSeconds;
  if (polyphonic) {
    const perSecond = requestBytes(1);
    const budgetSeconds =
      perSecond > 0
        ? (DEFAULT_TRANSCRIPTION_MEMORY_BUDGET_BYTES - fixedBytes) / perSecond
        : Number.POSITIVE_INFINITY;
    requestSeconds = Math.min(audibleSeconds, MAX_POLYPHONIC_SECONDS, Math.floor(budgetSeconds));
    if (requestSeconds < audibleSeconds) {
      requestSeconds = Math.max(requestSeconds, MIN_POLYPHONIC_CHUNK_SECONDS);
    }
  }
  if (!fits(requestSeconds)) {
    throw new PayloadMemoryLimitError(
      'transcription',
      addSafeBytes([fixedBytes, requestBytes(requestSeconds)]),
      DEFAULT_TRANSCRIPTION_MEMORY_BUDGET_BYTES,
    );
  }
  return { segments, metadata, renderRate, requestSeconds, audibleSeconds };
}

/** One detector request: the seconds it reads, and the onsets it is the authority for. */
interface DetectorSpan {
  readFrom: number;
  readTo: number;
  ownFrom: number;
  ownTo: number;
}

/**
 * Cuts a window into detector requests no longer than `requestSeconds`. A
 * longer window is split into equal chunks that each read past their cuts, and
 * keep only the onsets inside their own span.
 */
function detectorSpans(seconds: number, requestSeconds: number): DetectorSpan[] {
  const whole = [
    {
      readFrom: 0,
      readTo: seconds,
      ownFrom: Number.NEGATIVE_INFINITY,
      ownTo: Number.POSITIVE_INFINITY,
    },
  ];
  if (seconds <= requestSeconds) return whole;
  const owned = requestSeconds - 2 * POLYPHONIC_CHUNK_OVERLAP_SECONDS;
  const count = Math.ceil(seconds / owned);
  const length = seconds / count;
  return Array.from({ length: count }, (_, index) => {
    const ownFrom = index * length;
    const ownTo = index === count - 1 ? seconds : (index + 1) * length;
    return {
      readFrom: Math.max(0, ownFrom - POLYPHONIC_CHUNK_OVERLAP_SECONDS),
      readTo: Math.min(seconds, ownTo + POLYPHONIC_CHUNK_OVERLAP_SECONDS),
      ownFrom: index === 0 ? Number.NEGATIVE_INFINITY : ownFrom,
      ownTo: index === count - 1 ? Number.POSITIVE_INFINITY : ownTo,
    };
  });
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
): Promise<AudioTranscription> {
  if ((clip.assetId === undefined && (clip.takes?.length ?? 0) === 0) || !(tempoBpm > 0)) {
    return { notes: [], peak: 0 };
  }
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
  const plan = await preflightTranscription(clip, map, polyphonic, loadMeta, options.signal);
  throwIfAborted(options.signal);
  const renderWarp = deps.renderWarp
    ? async (...args: Parameters<WarpRenderFn>): ReturnType<WarpRenderFn> => {
        throwIfAborted(options.signal);
        const rendered = await deps.renderWarp?.(...args);
        throwIfAborted(options.signal);
        return rendered ?? [];
      }
    : undefined;
  const gridTempoBpm = tempoAtPpq(map, clip.startPpq);
  const clipStartSeconds = ppqToSeconds(map, clip.startPpq);
  const secondsToClipPpq = (seconds: number): number =>
    secondsToPpq(map, clipStartSeconds + Math.max(0, seconds)) - clip.startPpq;
  const spans = detectorSpans(plan.audibleSeconds, plan.requestSeconds);
  const notes: RawNote[] = [];
  let peak = 0;
  let referenceHz = options.referenceHz;
  let tuningReported = false;
  for (const span of spans) {
    // Each request renders only its own window, so a long clip never holds
    // more than one request's PCM at a time.
    const startFrame = Math.round(span.readFrom * plan.renderRate);
    const window = await renderAudibleAudioClipWindow(clip, map, loadAudioAsset, {
      renderWarp,
      ...(spans.length > 1
        ? {
            window: {
              startFrame,
              frameCount: Math.round(span.readTo * plan.renderRate) - startFrame,
            },
          }
        : {}),
    });
    throwIfAborted(options.signal);
    if (!window) continue;
    const samples = downmixToMono(window.channels, { copy: true });
    if (samples.length === 0) continue;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const sourceRate = window.sampleRate;
    const targetRate = Math.min(sourceRate, MAX_TRANSCRIPTION_SAMPLE_RATE);
    const result = await deps.transcribe(samples, targetRate, polyphonic, {
      signal: options.signal,
      tempoBpm: gridTempoBpm,
      ...(sourceRate !== targetRate ? { sourceSampleRate: sourceRate } : {}),
      ...(referenceHz !== undefined ? { referenceHz } : {}),
      ...(options.minNoteDivision !== undefined
        ? { minNoteDivision: options.minNoteDivision }
        : {}),
      ...(polyphonic && options.maxPolyphony !== undefined
        ? { maxPolyphony: options.maxPolyphony }
        : {}),
    });
    throwIfAborted(options.signal);
    validateResult(result);
    if (!tuningReported && finite(result.tuning)) {
      tuningReported = true;
      options.onTuning?.(result.tuning);
      // Later chunks reuse the first chunk's measurement, so one take keeps one pitch grid.
      if (referenceHz === 'auto') referenceHz = 440 * 2 ** (result.tuning / 12);
    }

    // Detector PPQ sits on a constant grid at the reported tempo; take it to
    // elapsed seconds, through the project's map and back to the clip's origin.
    const secondsPerBeat = 60 / result.tempoBpm;
    for (const note of eventNotes(result.events)) {
      const onsetSeconds = span.readFrom + Math.max(0, note.startPpq) * secondsPerBeat;
      if (onsetSeconds < span.ownFrom || onsetSeconds >= span.ownTo) continue;
      const releaseSeconds = span.readFrom + (note.startPpq + note.durationPpq) * secondsPerBeat;
      const startPpq = Math.max(0, Math.min(clip.lengthPpq, secondsToClipPpq(onsetSeconds)));
      const endPpq = Math.min(clip.lengthPpq, secondsToClipPpq(releaseSeconds));
      if (endPpq > startPpq) notes.push({ ...note, startPpq, durationPpq: endPpq - startPpq });
    }
  }
  return { notes: quantizeNotes(notes, options.rhythmQuantizePpq, clip.lengthPpq), peak };
}
