import type { AudioAssetTags } from '@/persistence/assets';
import type {
  AudioAnalysisWorkerRequest,
  AudioAnalysisWorkerResponse,
} from '@/workers/audio-analysis.worker';
import type { AnalysisProgress } from './audio-tags';

/** Factory override used by tests and non-browser embeddings. */
export type AudioAnalysisWorkerFactory = () => Worker;

export interface AudioAnalysisWorkerOptions {
  /** Receives the share of the analysis done so far, in [0, 1]. */
  onProgress?: AnalysisProgress;
  /** Aborts the request and terminates its disposable worker. */
  signal?: AbortSignal;
  workerFactory?: AudioAnalysisWorkerFactory;
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
 * Reads an asset's tags in a disposable worker, so a long recording's
 * analysis never blocks the page.
 *
 * @param mono Mono samples; the buffer is transferred to the worker and
 *   detached here, so pass one the caller does not keep (a fresh mixdown).
 * @param sampleRate Sample rate in Hz.
 * @returns The detected tags (possibly empty).
 */
export function analyzeAudioTagsInWorker(
  mono: Float32Array,
  sampleRate: number,
  options: AudioAnalysisWorkerOptions = {},
): Promise<AudioAssetTags> {
  const { onProgress, signal } = options;
  const create = options.workerFactory ?? createWorker;
  return new Promise<AudioAssetTags>((resolve, reject) => {
    let worker: Worker | null = null;
    let settled = false;
    const settle = (result: { tags: AudioAssetTags } | { error: unknown }): void => {
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
      else resolve(result.tags);
    };
    const onMessage = (event: MessageEvent<AudioAnalysisWorkerResponse>): void => {
      const response = event.data;
      if (response?.type === 'progress') {
        if (Number.isFinite(response.fraction)) onProgress?.(response.fraction);
      } else if (response?.type === 'done' && typeof response.tags === 'object') {
        settle({ tags: response.tags ?? {} });
      } else if (response?.type === 'error') {
        settle({ error: new Error(response.error) });
      } else {
        settle({ error: new Error('Audio analysis worker returned an invalid response') });
      }
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
        settle({ tags: {} });
        return;
      }
      worker = create();
      worker.addEventListener('message', onMessage as EventListener);
      worker.addEventListener('error', onError as EventListener);
      signal?.addEventListener('abort', onAbort, { once: true });
      const request: AudioAnalysisWorkerRequest = { samples: mono, sampleRate };
      worker.postMessage(request, [mono.buffer]);
    } catch (error) {
      settle({ error });
    }
  });
}
