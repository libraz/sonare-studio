/** Disposable-worker client for `decomposeStemsLinked` (component stem split). */

import type {
  DecomposeStemsWorkerRequest,
  DecomposeStemsWorkerResponse,
} from '@/workers/decompose-stems.worker';
import { workerEventError } from './worker-client-errors';

export type DecomposeStemsWorkerFactory = () => Worker;

export interface DecomposeStemsWorkerOptions {
  /** Aborts and terminates the worker before the factorisation finishes. */
  signal?: AbortSignal;
  /** Optional worker factory used by tests or an embedding environment. */
  workerFactory?: DecomposeStemsWorkerFactory;
}

function createWorker(): Worker {
  return new Worker(new URL('../workers/decompose-stems.worker.ts', import.meta.url), {
    type: 'module',
  });
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Component split was aborted', 'AbortError');
  }
  const error = new Error('Component split was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Runs `decomposeStemsLinked` on a copy of `channels` in a disposable worker,
 * so the ~1x-realtime factorisation never blocks the main thread. Copies the
 * input in and transfers the result out; terminates the worker on completion,
 * error, or abort. There is no timeout: the work legitimately takes as long as
 * the clip.
 */
export function decomposeStemsInWorker(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  nComponents: number,
  options: DecomposeStemsWorkerOptions = {},
): Promise<Float32Array[][]> {
  const { signal, workerFactory } = options;
  const create = workerFactory ?? createWorker;

  return new Promise<Float32Array[][]>((resolve, reject) => {
    let worker: Worker | null = null;
    let settled = false;
    let abortListener: (() => void) | undefined;

    const cleanup = (): void => {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      abortListener = undefined;
      if (worker) {
        worker.removeEventListener('message', onMessage as EventListener);
        worker.removeEventListener('error', onError as EventListener);
        try {
          worker.terminate();
        } catch {
          // Termination is best effort; preserve the operation's settled result.
        }
      }
      worker = null;
    };

    const settle = (result: { value: Float32Array[][] } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };

    const onMessage = (event: MessageEvent<DecomposeStemsWorkerResponse>): void => {
      const response = event.data;
      if (!response || (response.type !== 'done' && response.type !== 'error')) {
        settle({ error: new Error('Component split worker returned an invalid response') });
        return;
      }
      if (response.type === 'error') {
        settle({ error: new Error(response.error) });
        return;
      }
      settle({ value: response.components });
    };

    const onError = (event: ErrorEvent): void => {
      settle({ error: workerEventError(event, 'Component split worker failed') });
    };

    const onAbort = (): void => {
      settle({ error: abortError(signal?.reason) });
    };

    try {
      if (signal?.aborted) {
        settle({ error: abortError(signal.reason) });
        return;
      }
      worker = create();
      const copied = channels.map((channel) => new Float32Array(channel));
      worker.addEventListener('message', onMessage as EventListener);
      worker.addEventListener('error', onError as EventListener);
      abortListener = onAbort;
      signal?.addEventListener('abort', abortListener, { once: true });
      const request: DecomposeStemsWorkerRequest = { channels: copied, sampleRate, nComponents };
      worker.postMessage(
        request,
        copied.map((channel) => channel.buffer),
      );
    } catch (error) {
      settle({ error });
    }
  });
}
