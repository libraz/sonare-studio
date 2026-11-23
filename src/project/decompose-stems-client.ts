/** Disposable-worker client for `decomposeStemsLinked` (component stem split). */

import { runDisposableWorker } from '@/lib/disposable-worker';
import type {
  DecomposeStemsWorkerRequest,
  DecomposeStemsWorkerResponse,
} from '@/workers/decompose-stems.worker';

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

  return runDisposableWorker<DecomposeStemsWorkerResponse, Float32Array[][]>({
    create,
    signal,
    abortMessage: 'Component split was aborted',
    failMessage: 'Component split worker failed',
    post(worker) {
      const copied = channels.map((channel) => new Float32Array(channel));
      const request: DecomposeStemsWorkerRequest = { channels: copied, sampleRate, nComponents };
      worker.postMessage(
        request,
        copied.map((channel) => channel.buffer),
      );
    },
    receive(response, settle) {
      if (!response || (response.type !== 'done' && response.type !== 'error')) {
        settle({ error: new Error('Component split worker returned an invalid response') });
        return;
      }
      if (response.type === 'error') {
        settle({ error: new Error(response.error) });
        return;
      }
      settle({ value: response.components });
    },
  });
}
