import type { AudioAssetTags } from '@/persistence/assets';
import type {
  AudioAnalysisWorkerRequest,
  AudioAnalysisWorkerResponse,
} from '@/workers/audio-analysis.worker';
import type { AnalysisProgress, LoudnessInput } from './audio-tags';

/** Factory override used by tests and non-browser embeddings. */
export type AudioAnalysisWorkerFactory = () => Worker;

export interface AudioAnalysisWorkerOptions {
  /** Receives the share of the analysis done so far, in [0, 1]. */
  onProgress?: AnalysisProgress;
  /** Aborts the request and terminates its disposable worker. */
  signal?: AbortSignal;
  workerFactory?: AudioAnalysisWorkerFactory;
  /** Stored channels for the loudness step; transferred like the mono buffer. */
  loudness?: LoudnessInput;
}

/** Beat and downbeat times, in seconds from the start of the analysed buffer. */
export interface DetectedBeats {
  beats: number[];
  downbeats: number[];
}

/** Beat times and the onset strength of each, for scoring a meter. */
export interface DetectedBeatAccents {
  beatTimes: number[];
  beatStrengths: number[];
}

function createWorker(): Worker {
  return new Worker(new URL('../workers/audio-analysis.worker.ts', import.meta.url), {
    type: 'module',
  });
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Audio analysis was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Runs one request in a disposable worker. `accept` turns the worker's final
 * message into the result, or returns undefined for one that is not.
 */
function runAnalysis<T>(
  kind: AudioAnalysisWorkerRequest['kind'],
  mono: Float32Array,
  sampleRate: number,
  empty: T,
  options: AudioAnalysisWorkerOptions,
  accept: (response: AudioAnalysisWorkerResponse) => T | undefined,
): Promise<T> {
  const { onProgress, signal } = options;
  const create = options.workerFactory ?? createWorker;
  return new Promise<T>((resolve, reject) => {
    let worker: Worker | null = null;
    let settled = false;
    const settle = (result: { value: T } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (worker) {
        worker.removeEventListener('message', onMessage as EventListener);
        worker.removeEventListener('error', onError as EventListener);
        worker.terminate();
      }
      worker = null;
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    const onMessage = (event: MessageEvent<AudioAnalysisWorkerResponse>): void => {
      const response = event.data;
      if (response?.type === 'progress') {
        if (Number.isFinite(response.fraction)) onProgress?.(response.fraction);
        return;
      }
      if (response?.type === 'error') {
        settle({ error: new Error(response.error) });
        return;
      }
      const value = response ? accept(response) : undefined;
      settle(
        value === undefined
          ? { error: new Error('Audio analysis worker returned an invalid response') }
          : { value },
      );
    };
    const onError = (event: ErrorEvent): void => {
      settle({ error: new Error(event.message || 'Audio analysis worker failed') });
    };
    function onAbort(): void {
      settle({ error: abortError(signal?.reason) });
    }
    try {
      if (signal?.aborted) {
        settle({ error: abortError(signal.reason) });
        return;
      }
      if (mono.length === 0) {
        settle({ value: empty });
        return;
      }
      worker = create();
      worker.addEventListener('message', onMessage as EventListener);
      worker.addEventListener('error', onError as EventListener);
      signal?.addEventListener('abort', onAbort, { once: true });
      const { loudness } = options;
      const request: AudioAnalysisWorkerRequest = {
        kind,
        samples: mono,
        sampleRate,
        ...(loudness !== undefined ? { loudness } : {}),
      };
      worker.postMessage(
        request,
        loudness !== undefined ? [mono.buffer, loudness.interleaved.buffer] : [mono.buffer],
      );
    } catch (error) {
      settle({ error });
    }
  });
}

/**
 * Reads an asset's tags in a disposable worker, so a long recording's
 * analysis never blocks the page.
 *
 * @param mono Mono samples; the buffer is transferred to the worker and
 *   detached here, so pass one the caller does not keep (a fresh mixdown).
 * @param sampleRate Sample rate in Hz.
 * @param options.loudness Stored channels measured for the loudness tag; detached
 *   like `mono`.
 * @returns The detected tags (possibly empty).
 */
export function analyzeAudioTagsInWorker(
  mono: Float32Array,
  sampleRate: number,
  options: AudioAnalysisWorkerOptions = {},
): Promise<AudioAssetTags> {
  return runAnalysis('tags', mono, sampleRate, {}, options, (response) =>
    response.type === 'done' && typeof response.tags === 'object'
      ? (response.tags ?? {})
      : undefined,
  );
}

/**
 * Tracks a buffer's beats and downbeats in a disposable worker.
 *
 * @param mono Mono samples; transferred and detached like {@link analyzeAudioTagsInWorker}.
 * @param sampleRate Sample rate in Hz.
 */
export function detectBeatsInWorker(
  mono: Float32Array,
  sampleRate: number,
  options: Omit<AudioAnalysisWorkerOptions, 'onProgress'> = {},
): Promise<DetectedBeats> {
  return runAnalysis(
    'beats',
    mono,
    sampleRate,
    { beats: [], downbeats: [] },
    options,
    (response) =>
      response.type === 'beats' && Array.isArray(response.beats)
        ? { beats: response.beats, downbeats: response.downbeats ?? [] }
        : undefined,
  );
}

/**
 * Tracks a buffer's beats and their onset-strength accents in a disposable
 * worker, for meter estimation.
 *
 * @param mono Mono samples; transferred and detached like {@link analyzeAudioTagsInWorker}.
 * @param sampleRate Sample rate in Hz.
 */
export function analyzeBeatAccentsInWorker(
  mono: Float32Array,
  sampleRate: number,
  options: Omit<AudioAnalysisWorkerOptions, 'onProgress'> = {},
): Promise<DetectedBeatAccents> {
  return runAnalysis(
    'meter',
    mono,
    sampleRate,
    { beatTimes: [], beatStrengths: [] },
    options,
    (response) =>
      response.type === 'meter' &&
      Array.isArray(response.beatTimes) &&
      Array.isArray(response.beatStrengths)
        ? { beatTimes: response.beatTimes, beatStrengths: response.beatStrengths }
        : undefined,
  );
}
