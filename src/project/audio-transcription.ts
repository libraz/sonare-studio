/**
 * Canonical audio-to-MIDI adapter.
 *
 * The detector runs in a worker on a constant grid at the project tempo where
 * the clip starts, so note values mean what they do in the project. This module owns the project-side coordinate transform and note
 * pairing, so monophonic and polyphonic transcription share one placement
 * contract and one set of memory guards.
 */

import type { ProjectMidiEvent, TranscribeResult } from '@libraz/libsonare';
import { downmixToMono } from '@/lib/audio-channels';
import { MEBIBYTE } from '@/lib/bytes';
import { isFiniteNumber } from '@/lib/math';
import { PayloadMemoryLimitError } from '@/lib/payload-memory';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import { renderAudibleAudioClipWindow } from './audio-clip-render';
import { audioClipSegments } from './comping';
import { pairEventsIntoNotes, type RawNote } from './midi-events';
import { normalizeTempoMap, ppqToSeconds, secondsToPpq, tempoAtPpq } from './tempo-map';
import { type MeterGridStep, measureRangeAt, snapClipPpqToMeterGrid } from './time-signature';
import type { TranscribeWorkerOptions } from './transcribe-client';
import type {
  ClipCompSegment,
  ClipTake,
  ClipWarp,
  TempoSegment,
  TimeSignatureSegment,
} from './types';
import type { WarpRenderFn } from './warp';

/** Longest span one polyphonic detector request reads; working memory grows about 1.1 MB per second. */
export const MAX_POLYPHONIC_SECONDS = 300;
/** A polyphonic chunk reads this far past each cut, so the next chunk can see a note crossing it. */
const POLYPHONIC_CHUNK_OVERLAP_SECONDS = 2;
/** A note ending this close to a chunk's read end was cut off by the buffer, not released. */
const CHUNK_END_TOLERANCE_SECONDS = 0.1;
/** Two chunks hearing the same note place its onset this close together. */
const CHUNK_ONSET_TOLERANCE_SECONDS = 0.25;
/** Shortest chunk worth reading; a budget that cannot hold one refuses the clip. */
const MIN_POLYPHONIC_CHUNK_SECONDS = 30;
/** The detector receives at most this sample rate. */
const MAX_TRANSCRIPTION_SAMPLE_RATE = 48_000;
/** Conservative preparation budget for decoded/rendered/transferred PCM. */
const DEFAULT_TRANSCRIPTION_MEMORY_BUDGET_BYTES = 256 * MEBIBYTE;

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
  /** Rhythm grid step on the project meter grid, or `'bar'`; omitted preserves detector timing. */
  rhythmQuantizePpq?: MeterGridStep;
  /** Project meter map the rhythm grid is anchored to; omitted means 4/4 from PPQ 0. */
  timeSignatures?: readonly TimeSignatureSegment[];
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

function validProjectMidiEvent(value: unknown): value is ProjectMidiEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  const word0 = event.word0;
  return (
    isFiniteNumber(event.ppq) &&
    event.ppq >= 0 &&
    isFiniteNumber(word0) &&
    Number.isInteger(word0) &&
    word0 >= 0 &&
    word0 <= 0xffffffff
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
    !isFiniteNumber(result.tempoBpm) ||
    result.tempoBpm <= 0
  ) {
    throw new Error('Transcription returned an invalid result');
  }
}

/**
 * Snaps clip-relative notes to the project's meter grid, keeping every note
 * inside the clip. Positions are snapped on the timeline through the clip
 * start, so a clip that does not start on a grid line gets no shifted grid.
 *
 * @param step Grid step in PPQ or `'bar'`; omitted or non-positive keeps the notes.
 * @param clipStartPpq Timeline position of clip-relative PPQ 0.
 * @param timeSignatures Project meter map.
 */
export function quantizeNotes<T extends { startPpq: number; durationPpq: number }>(
  notes: ReadonlyArray<T>,
  step: MeterGridStep | undefined,
  clipLengthPpq: number,
  clipStartPpq = 0,
  timeSignatures: readonly TimeSignatureSegment[] = [],
): T[] {
  if (step === undefined || (step !== 'bar' && !(Number.isFinite(step) && step > 0))) {
    return notes.map((note) => ({ ...note }));
  }
  const snap = (ppq: number): number =>
    snapClipPpqToMeterGrid(timeSignatures, clipStartPpq, ppq, step);
  return notes.flatMap((note) => {
    const start = Math.max(0, Math.min(clipLengthPpq, snap(note.startPpq)));
    const span =
      step === 'bar' ? measureRangeAt(timeSignatures, clipStartPpq + start).lengthPpq : step;
    let end = Math.max(snap(start + span), snap(note.startPpq + note.durationPpq));
    end = Math.min(clipLengthPpq, end);
    if (!(end > start)) return [];
    return [{ ...note, startPpq: start, durationPpq: end - start }];
  });
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

/** Clip segments, asset metadata and the PCM a render of the clip holds regardless of window. */
async function measureClipPcm(
  clip: AudioTranscriptionClip,
  map: ReturnType<typeof normalizeTempoMap>,
  loadMeta: (assetId: string) => Promise<AudioAssetMeta>,
  signal?: AbortSignal,
): Promise<{
  segments: ReturnType<typeof audioClipSegments>;
  metadata: Map<string, AudioAssetMeta>;
  /** Sample rate the clip window renders at; 0 when nothing is audible. */
  renderRate: number;
  renderedChannels: number;
  /** Source assets, plus the whole-segment warp render when the clip is warped. */
  fixedBytes: number;
  audibleSeconds: number;
}> {
  const segments = audioClipSegments(clip, { tempoMap: map, clipStartPpq: clip.startPpq });
  const empty = {
    segments,
    metadata: new Map<string, AudioAssetMeta>(),
    renderRate: 0,
    renderedChannels: 0,
    fixedBytes: 0,
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
  const fixedBytes = addSafeBytes([
    sourceBytes,
    // The warp renderer produces each warped segment whole, whatever the window.
    clip.warp?.enabled === true
      ? safePcmBytes(framesOf(audibleSeconds, renderRate), renderedChannels)
      : 0,
  ]);
  return { segments, metadata, renderRate, renderedChannels, fixedBytes, audibleSeconds };
}

function framesOf(seconds: number, rate: number): number {
  return Math.max(0, Math.round(seconds * rate));
}

/**
 * Refuses, before any render, a beat-grid detection whose whole-window render
 * and mono mixdown would not fit the transcription memory budget.
 *
 * @throws PayloadMemoryLimitError when the window cannot be held.
 */
export async function preflightBeatGridDetection(
  clip: AudioTranscriptionClip,
  tempoSegments: ReadonlyArray<TempoSegment>,
  loadMeta: (assetId: string) => Promise<AudioAssetMeta>,
  signal?: AbortSignal,
): Promise<void> {
  const plan = await measureClipPcm(clip, normalizeTempoMap(tempoSegments), loadMeta, signal);
  if (plan.renderRate === 0) return;
  const frames = framesOf(plan.audibleSeconds, plan.renderRate);
  const bytes = addSafeBytes([
    plan.fixedBytes,
    safePcmBytes(frames, plan.renderedChannels),
    safePcmBytes(frames, 1),
  ]);
  if (bytes > DEFAULT_TRANSCRIPTION_MEMORY_BUDGET_BYTES) {
    throw new PayloadMemoryLimitError(
      'transcription',
      bytes,
      DEFAULT_TRANSCRIPTION_MEMORY_BUDGET_BYTES,
    );
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
  const { segments, metadata, renderRate, renderedChannels, fixedBytes, audibleSeconds } =
    await measureClipPcm(clip, map, loadMeta, signal);
  if (renderRate === 0) {
    return { segments, metadata, renderRate: 0, requestSeconds: 0, audibleSeconds };
  }
  const targetRate = Math.min(renderRate, MAX_TRANSCRIPTION_SAMPLE_RATE);
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

/** An owned note the detector closed at its chunk's read end, open to its continuation in the next chunk. */
interface CutNote {
  note: RawNote;
  onsetSeconds: number;
  releaseSeconds: number;
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
  let cutNotes: CutNote[] = [];
  for (const span of spans) {
    const spanCutNotes: CutNote[] = [];
    const readsToEnd = span.readTo >= plan.audibleSeconds - CHUNK_END_TOLERANCE_SECONDS;
    const isCut = (releaseSeconds: number): boolean =>
      !readsToEnd && releaseSeconds >= span.readTo - CHUNK_END_TOLERANCE_SECONDS;
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
    if (!tuningReported && isFiniteNumber(result.tuningCents)) {
      tuningReported = true;
      options.onTuning?.(result.tuningCents / 100);
      // Later chunks reuse the first chunk's measurement, so one take keeps one pitch grid.
      if (referenceHz === 'auto') referenceHz = 440 * 2 ** (result.tuningCents / 1200);
    }

    // Detector PPQ sits on a constant grid at the reported tempo; take it to
    // elapsed seconds, through the project's map and back to the clip's origin.
    const secondsPerBeat = 60 / result.tempoBpm;
    for (const note of pairEventsIntoNotes(result.events)) {
      const onsetSeconds = span.readFrom + Math.max(0, note.startPpq) * secondsPerBeat;
      if (onsetSeconds >= span.ownTo) continue;
      const releaseSeconds = span.readFrom + (note.startPpq + note.durationPpq) * secondsPerBeat;
      const endPpq = Math.min(clip.lengthPpq, secondsToClipPpq(releaseSeconds));
      if (onsetSeconds < span.ownFrom) {
        // The previous chunk's cut-off note, heard again from the read start or from its own onset.
        const soundingAtStart = onsetSeconds <= span.readFrom + CHUNK_END_TOLERANCE_SECONDS;
        const cut = cutNotes.find(
          (entry) =>
            entry.note.pitch === note.pitch &&
            entry.note.channel === note.channel &&
            (soundingAtStart ||
              Math.abs(onsetSeconds - entry.onsetSeconds) <= CHUNK_ONSET_TOLERANCE_SECONDS),
        );
        if (!cut) continue;
        cutNotes.splice(cutNotes.indexOf(cut), 1);
        cut.note.durationPpq = Math.max(cut.note.durationPpq, endPpq - cut.note.startPpq);
        cut.releaseSeconds = releaseSeconds;
        if (isCut(releaseSeconds)) spanCutNotes.push(cut);
        continue;
      }
      const startPpq = Math.max(0, Math.min(clip.lengthPpq, secondsToClipPpq(onsetSeconds)));
      if (!(endPpq > startPpq)) continue;
      const owned = { ...note, startPpq, durationPpq: endPpq - startPpq };
      notes.push(owned);
      if (isCut(releaseSeconds)) {
        spanCutNotes.push({ note: owned, onsetSeconds, releaseSeconds });
      }
    }
    cutNotes = spanCutNotes;
  }
  return {
    notes: quantizeNotes(
      notes,
      options.rhythmQuantizePpq,
      clip.lengthPpq,
      clip.startPpq,
      options.timeSignatures,
    ),
    peak,
  };
}
