/**
 * Audio-driven tempo detection: a clip's beat grid (tempo and first downbeat,
 * see {@link fitBeatGrid}) tracked in the analysis worker, or a variable tempo
 * map from libsonare's beat tracker, which also runs in the worker.
 *
 * The constant tempo is the beat grid's fitted line rather than a one-shot
 * estimate, which drifts most of a beat over a long piece. The tempo-map
 * editor offers it as a draft; the variable result is a constant-per-beat
 * tempo map (see {@link beatTimesToTempoSegments}). The same beat tracker
 * also drives a meter map from `detectDownbeats` (see
 * {@link beatsToTimeSignatures}). The pure cores are dependency-injected for
 * testing; the {@link detectActiveAudioClipTempo},
 * {@link detectActiveAudioClipTempoMap} and
 * {@link detectActiveAudioClipTimeSignatures} resolvers wire the wasm detectors
 * and asset loader from the running app.
 */

import { downmixToMono } from '@/lib/audio-channels';
import { ensureWasm } from '@/lib/wasm';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { renderAudibleClipMono } from './audible-clip-window';
import {
  analyzeBeatAccentsInWorker,
  type DetectedBeatAccents,
  type DetectedBeats,
  detectBeatsInWorker,
} from './audio-analysis-client';
import { type BeatGrid, fitBeatGrid } from './beat-grid';
import { type AudibleAudioClipFields, renderAudibleAudioClipWindow } from './scheduling';
import { useProjectStore } from './store';
import { normalizeTempoMap } from './tempo-map';
import { meterBarLengthPpq, timeSignatureAt } from './time-signature';
import { isAudioClip, type TempoSegment, type TimeSignatureSegment } from './types';

/**
 * Tracks beats and downbeats (seconds) in a mono buffer off the main thread;
 * the signal aborts the analysis.
 */
export type AudioBeatDetector = (
  mono: Float32Array,
  sampleRate: number,
  signal?: AbortSignal,
) => Promise<DetectedBeats>;

/** The analysis-worker beat detector. */
const workerBeatDetector: AudioBeatDetector = (mono, sampleRate, signal) =>
  detectBeatsInWorker(mono, sampleRate, { signal });

/** Injectable dependencies for {@link detectAudioClipBeatGrid}. */
export interface AudioBeatGridDeps {
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Tracks beats and downbeats in a mono buffer (the analysis worker by default). */
  detectBeats: AudioBeatDetector;
}

/**
 * Fits the beat grid of a clip's audible window, as it would sound at
 * `tempo` (comps, loops and fades included). Times are seconds from the
 * clip's start.
 *
 * @param clip Audio clip to analyze.
 * @param tempo The project tempo map the window is rendered under.
 * @param beatsPerBar Beats in one bar of the meter at the clip.
 * @param signal Aborts the analysis.
 * @returns The grid, or null when nothing is audible or too few beats are found.
 */
export async function detectAudioClipBeatGrid(
  clip: AudibleAudioClipFields,
  tempo: ReadonlyArray<TempoSegment>,
  beatsPerBar: number,
  deps: AudioBeatGridDeps,
  signal?: AbortSignal,
): Promise<BeatGrid | null> {
  const window = await renderAudibleAudioClipWindow(
    clip,
    normalizeTempoMap(tempo),
    deps.loadAudioAsset,
  );
  if (!window) return null;
  const mono = downmixToMono(window.channels, { copy: true });
  if (mono.length === 0) return null;
  const { beats, downbeats } = await deps.detectBeats(mono, window.sampleRate, signal);
  return fitBeatGrid(beats, downbeats, beatsPerBar);
}

/** Beats per bar of the project meter at a position, counted in quarter-note beats. */
export function quarterBeatsPerBar(
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
  ppq: number,
): number {
  return Math.max(1, Math.round(meterBarLengthPpq(timeSignatureAt(timeSignatures, ppq))));
}

/**
 * Detects the active clip's tempo from its beat grid, when it is an audio clip
 * carrying an asset. Returns null when no such clip is active or no grid is found.
 *
 * @param clipId Editor id of the clip to analyze.
 * @param signal Aborts the analysis.
 * @returns The fitted BPM, or null.
 */
export async function detectActiveAudioClipTempo(
  clipId: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const store = useProjectStore();
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip || !isAudioClip(clip) || clip.assetId === undefined) return null;
  const grid = await detectAudioClipBeatGrid(
    clip,
    store.tempoSegments.length > 0 ? store.tempoSegments : [{ startPpq: 0, bpm: store.tempoBpm }],
    quarterBeatsPerBar(store.timeSignatures, clip.startPpq),
    { loadAudioAsset: loadAsset, detectBeats: workerBeatDetector },
    signal,
  );
  return grid?.bpm ?? null;
}

/** Injectable dependencies for {@link detectAudioClipTempoMap}. */
export interface AudioTempoMapDeps {
  /** Loads an audio asset's PCM (defaults to the OPFS asset store). */
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** The beat detector. */
  detectBeats: AudioBeatDetector;
}

/** BPM clamp bounds for {@link beatTimesToTempoSegments}. */
export interface BeatTempoMapOptions {
  /** Lowest BPM to emit; tighter beat intervals clamp up to it (default 20). */
  minBpm?: number;
  /** Highest BPM to emit; wider beat intervals clamp down to it (default 400). */
  maxBpm?: number;
}

/** Fallback BPM clamp bounds when {@link BeatTempoMapOptions} omits them. */
const DEFAULT_MIN_BPM = 20;
const DEFAULT_MAX_BPM = 400;

/** Keeps only finite, strictly ascending times (drops noise and reversals). */
function ascendingTimes(times: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (!Number.isFinite(t)) continue;
    if (out.length > 0 && t <= out[out.length - 1]) continue;
    out.push(t);
  }
  return out;
}

/** Index of the beat whose time is closest to `target` (beats ascending, non-empty). */
function nearestBeatIndex(beats: ReadonlyArray<number>, target: number): number {
  let best = 0;
  let bestDistance = Math.abs(beats[0] - target);
  for (let i = 1; i < beats.length; i += 1) {
    const distance = Math.abs(beats[i] - target);
    // Beats ascend, so once the distance starts growing it only grows.
    if (distance > bestDistance) break;
    best = i;
    bestDistance = distance;
  }
  return best;
}

/**
 * Converts detected beat times (seconds, ascending) into a constant-per-beat
 * tempo map. Each beat is treated as one quarter note (1 PPQ), so the interval
 * between consecutive beats becomes a constant tempo segment whose BPM
 * reproduces that beat spacing (BPM = 60 / interval). The first beat is
 * anchored at PPQ 0 (song start), discarding any lead-in before it, so the map
 * satisfies the tempo editor's "first entry at 1.1" rule. Consecutive segments
 * with equal BPM are merged, BPM values are clamped into [minBpm, maxBpm] and
 * rounded to 1/1000 BPM.
 *
 * @param beatTimes Ascending beat times in seconds (needs at least two).
 * @param options BPM clamp bounds (default 20..400).
 * @returns Tempo segments anchored at PPQ 0, or an empty array when fewer than
 *   two usable beats are present.
 */
export function beatTimesToTempoSegments(
  beatTimes: ArrayLike<number>,
  options: BeatTempoMapOptions = {},
): TempoSegment[] {
  const minBpm =
    typeof options.minBpm === 'number' && Number.isFinite(options.minBpm) && options.minBpm > 0
      ? options.minBpm
      : DEFAULT_MIN_BPM;
  const maxBpm =
    typeof options.maxBpm === 'number' &&
    Number.isFinite(options.maxBpm) &&
    options.maxBpm >= minBpm
      ? options.maxBpm
      : Math.max(minBpm, DEFAULT_MAX_BPM);
  const times = ascendingTimes(beatTimes);
  if (times.length < 2) return [];
  const segments: TempoSegment[] = [];
  for (let i = 0; i + 1 < times.length; i += 1) {
    const dt = times[i + 1] - times[i];
    const bpm = Math.min(maxBpm, Math.max(minBpm, 60 / dt));
    const rounded = Math.round(bpm * 1000) / 1000;
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.bpm === rounded) continue;
    segments.push({ startPpq: i, bpm: rounded });
  }
  return segments;
}

/**
 * Detects a clip's variable tempo map from its audio: tracks beats over the
 * clip's audible window and converts them with {@link beatTimesToTempoSegments}.
 * Returns an empty array when the clip has no asset, the tempo is non-positive,
 * the source window is empty, or fewer than two beats are detected.
 *
 * @param clip Audio clip window to analyze (needs `assetId`).
 * @param tempoBpm Fallback tempo (> 0) when `tempoSegments` is empty.
 * @param deps Injected asset loader and beat detector.
 * @param options BPM clamp bounds forwarded to the conversion.
 * @param tempoSegments Project tempo map the window is rendered under.
 * @param signal Aborts the analysis.
 * @returns The detected tempo segments anchored at PPQ 0.
 */
export async function detectAudioClipTempoMap(
  clip: AudibleAudioClipFields,
  tempoBpm: number,
  deps: AudioTempoMapDeps,
  options?: BeatTempoMapOptions,
  tempoSegments: ReadonlyArray<TempoSegment> = [],
  signal?: AbortSignal,
): Promise<TempoSegment[]> {
  if (clip.assetId === undefined || !(tempoBpm > 0)) return [];
  const audible = await renderAudibleClipMono(clip, tempoBpm, tempoSegments, deps.loadAudioAsset);
  if (!audible) return [];
  const { beats } = await deps.detectBeats(audible.mono, audible.sampleRate, signal);
  return beatTimesToTempoSegments(beats, options);
}

/**
 * Detects a variable tempo map for the active clip in the analysis worker,
 * when it is an audio clip carrying an asset. Returns an empty array when no
 * such clip is active.
 *
 * @param clipId Editor id of the clip to analyze.
 * @param options BPM clamp bounds forwarded to the conversion.
 * @param signal Aborts the analysis.
 * @returns The detected tempo segments anchored at PPQ 0.
 */
export async function detectActiveAudioClipTempoMap(
  clipId: number,
  options?: BeatTempoMapOptions,
  signal?: AbortSignal,
): Promise<TempoSegment[]> {
  const store = useProjectStore();
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip || !isAudioClip(clip) || clip.assetId === undefined) return [];
  return detectAudioClipTempoMap(
    clip,
    store.tempoBpm,
    { loadAudioAsset: loadAsset, detectBeats: workerBeatDetector },
    options,
    store.tempoSegments,
    signal,
  );
}

/** Injectable dependencies for {@link detectAudioClipTimeSignatures}. */
export interface AudioTimeSignatureDeps {
  /** Loads an audio asset's PCM (defaults to the OPFS asset store). */
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** The beat and downbeat detector (beats define the quarter-note grid). */
  detectBeats: AudioBeatDetector;
}

/** Numerator bound for {@link beatsToTimeSignatures}. */
export interface BeatTimeSignatureOptions {
  /** Largest beats-per-bar to emit; longer bar spans clamp down (default 32). */
  maxNumerator?: number;
}

/** Fallback numerator bound when {@link BeatTimeSignatureOptions} omits it. */
const DEFAULT_MAX_NUMERATOR = 32;

/** Beat unit of derived meters: detected beats are treated as quarter notes. */
const TIME_SIGNATURE_DENOMINATOR = 4;

/**
 * Derives a time-signature map from tracked beats and downbeats. Each beat is
 * a quarter note (1 PPQ); the number of beats between consecutive downbeats is
 * the bar's numerator (denominator fixed at 4). The first downbeat is anchored
 * at PPQ 0 (song start), so the map satisfies the meter editor's "first entry
 * at 1.1" rule. Downbeats are matched to the nearest beat, the last (open) bar
 * is left out, numerators are clamped into [1, maxNumerator], and consecutive
 * equal meters are merged.
 *
 * @param beatTimes Ascending beat times in seconds (the quarter grid).
 * @param downbeatTimes Ascending downbeat (bar-start) times in seconds.
 * @param options Numerator bound (default max 32).
 * @returns Meter segments anchored at PPQ 0, or an empty array when fewer than
 *   two beats or two downbeats are present.
 */
export function beatsToTimeSignatures(
  beatTimes: ArrayLike<number>,
  downbeatTimes: ArrayLike<number>,
  options: BeatTimeSignatureOptions = {},
): TimeSignatureSegment[] {
  const maxNumerator =
    typeof options.maxNumerator === 'number' &&
    Number.isInteger(options.maxNumerator) &&
    options.maxNumerator >= 1
      ? options.maxNumerator
      : DEFAULT_MAX_NUMERATOR;
  const beats = ascendingTimes(beatTimes);
  const downbeats = ascendingTimes(downbeatTimes);
  if (beats.length < 2 || downbeats.length < 2) return [];
  // Map each downbeat onto its nearest beat to count beats per bar.
  const indices: number[] = [];
  for (const downbeat of downbeats) {
    const index = nearestBeatIndex(beats, downbeat);
    if (indices.length === 0 || index > indices[indices.length - 1]) indices.push(index);
  }
  if (indices.length < 2) return [];
  const origin = indices[0];
  const segments: TimeSignatureSegment[] = [];
  for (let i = 0; i + 1 < indices.length; i += 1) {
    const numerator = Math.min(maxNumerator, Math.max(1, indices[i + 1] - indices[i]));
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.numerator === numerator) continue;
    segments.push({
      startPpq: indices[i] - origin,
      numerator,
      denominator: TIME_SIGNATURE_DENOMINATOR,
    });
  }
  return segments;
}

/**
 * Detects a clip's time-signature map from its audio: tracks beats and
 * downbeats over the clip's audible window and converts them with
 * {@link beatsToTimeSignatures}. Returns an empty array when the clip has no
 * asset, the tempo is non-positive, the source window is empty, or too few
 * beats/downbeats are detected.
 *
 * @param clip Audio clip window to analyze (needs `assetId`).
 * @param tempoBpm Fallback tempo (> 0) when `tempoSegments` is empty.
 * @param deps Injected asset loader and beat/downbeat detectors.
 * @param options Numerator bound forwarded to the conversion.
 * @param tempoSegments Project tempo map the window is rendered under.
 * @param signal Aborts the analysis.
 * @returns The detected meter segments anchored at PPQ 0.
 */
export async function detectAudioClipTimeSignatures(
  clip: AudibleAudioClipFields,
  tempoBpm: number,
  deps: AudioTimeSignatureDeps,
  options?: BeatTimeSignatureOptions,
  tempoSegments: ReadonlyArray<TempoSegment> = [],
  signal?: AbortSignal,
): Promise<TimeSignatureSegment[]> {
  if (clip.assetId === undefined || !(tempoBpm > 0)) return [];
  const audible = await renderAudibleClipMono(clip, tempoBpm, tempoSegments, deps.loadAudioAsset);
  if (!audible) return [];
  const { beats, downbeats } = await deps.detectBeats(audible.mono, audible.sampleRate, signal);
  return beatsToTimeSignatures(beats, downbeats, options);
}

/**
 * Detects a time-signature map for the active clip in the analysis worker,
 * when it is an audio clip carrying an asset. Returns an empty array when no
 * such clip is active.
 *
 * @param clipId Editor id of the clip to analyze.
 * @param options Numerator bound forwarded to the conversion.
 * @param signal Aborts the analysis.
 * @returns The detected meter segments anchored at PPQ 0.
 */
export async function detectActiveAudioClipTimeSignatures(
  clipId: number,
  options?: BeatTimeSignatureOptions,
  signal?: AbortSignal,
): Promise<TimeSignatureSegment[]> {
  const store = useProjectStore();
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip || !isAudioClip(clip) || clip.assetId === undefined) return [];
  return detectAudioClipTimeSignatures(
    clip,
    store.tempoBpm,
    { loadAudioAsset: loadAsset, detectBeats: workerBeatDetector },
    options,
    store.tempoSegments,
    signal,
  );
}

/** Candidate numerators when odd meters are allowed (the library default is 3, 4, 6). */
export const ODD_METER_CANDIDATES: readonly number[] = [2, 3, 4, 5, 6, 7];

/** Injectable dependencies for {@link estimateAudioClipMeter}. */
export interface AudioMeterEstimateDeps {
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Full analysis off the main thread, read for its beats and their accents. */
  analyze: (
    mono: Float32Array,
    sampleRate: number,
    signal?: AbortSignal,
  ) => Promise<DetectedBeatAccents>;
  estimateMeter: (request: {
    beatTimes: number[];
    beatStrengths: number[];
    candidateNumerators?: number[];
  }) => {
    timeSignature: { numerator: number; denominator: number };
    grouping: number[];
    searched: boolean;
  };
}

/**
 * Reads one meter for a whole audio clip from its beat accents, including how
 * the bar divides (a seven as 3+2+2). Unlike {@link detectAudioClipTimeSignatures}
 * it does not follow meter changes; it is the path that can answer an odd
 * meter. Empty when the clip is too short to score a meter.
 *
 * @param candidates Numerators to consider; omitted keeps the library default.
 * @param tempoSegments Project tempo map the window is rendered under.
 * @param signal Aborts the analysis.
 */
export async function estimateAudioClipMeter(
  clip: AudibleAudioClipFields,
  tempoBpm: number,
  deps: AudioMeterEstimateDeps,
  candidates?: readonly number[],
  tempoSegments: ReadonlyArray<TempoSegment> = [],
  signal?: AbortSignal,
): Promise<TimeSignatureSegment[]> {
  if (clip.assetId === undefined || !(tempoBpm > 0)) return [];
  const audible = await renderAudibleClipMono(clip, tempoBpm, tempoSegments, deps.loadAudioAsset);
  if (!audible) return [];
  const { beatTimes, beatStrengths } = await deps.analyze(audible.mono, audible.sampleRate, signal);
  if (beatStrengths.length !== beatTimes.length) return [];
  const estimate = deps.estimateMeter({
    beatTimes,
    beatStrengths,
    ...(candidates ? { candidateNumerators: [...candidates] } : {}),
  });
  if (!estimate.searched) return [];
  const { numerator, denominator } = estimate.timeSignature;
  return [
    {
      startPpq: 0,
      numerator,
      denominator,
      ...(estimate.grouping.length > 1 ? { grouping: [...estimate.grouping] } : {}),
    },
  ];
}

/**
 * Reads one meter for the active audio clip, analysing in the worker and
 * scoring with the wasm meter estimator (see {@link estimateAudioClipMeter}).
 */
export async function estimateActiveAudioClipMeter(
  clipId: number,
  candidates?: readonly number[],
  signal?: AbortSignal,
): Promise<TimeSignatureSegment[]> {
  const store = useProjectStore();
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip || !isAudioClip(clip) || clip.assetId === undefined) return [];
  const wasm = await ensureWasm();
  return estimateAudioClipMeter(
    clip,
    store.tempoBpm,
    {
      loadAudioAsset: loadAsset,
      analyze: (mono, sampleRate, abort) =>
        analyzeBeatAccentsInWorker(mono, sampleRate, { signal: abort }),
      estimateMeter: (request) => wasm.estimateMeter(request),
    },
    candidates,
    store.tempoSegments,
    signal,
  );
}
