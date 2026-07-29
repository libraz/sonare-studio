/** Disposable-worker client for non-WASM offline sample operations. */

import type { SampleOperationRequest, SampleOperationResponse } from '@/workers/sample-ops.worker';
import type { SampleRange } from './ops';

type OmitFromUnion<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never;

export type SampleOperation = OmitFromUnion<SampleOperationRequest, 'channels' | 'range'>;
export type SampleOperationWorkerFactory = () => Worker;

function createWorker(): Worker {
  return new Worker(new URL('../../workers/sample-ops.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/**
 * Runs a copy of the source buffers in a disposable worker. The source asset
 * stays usable on the main thread; only the copied buffers are transferred.
 */
export function runSampleOperationInWorker(
  operation: SampleOperation,
  source: ReadonlyArray<Float32Array>,
  range: SampleRange,
  workerFactory: SampleOperationWorkerFactory = createWorker,
): Promise<Float32Array[]> {
  const worker = workerFactory();
  const channels = source.map((channel) => new Float32Array(channel));
  return new Promise<Float32Array[]>((resolve, reject) => {
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError as EventListener);
      worker.terminate();
    };
    const onMessage = (event: MessageEvent<SampleOperationResponse>): void => {
      cleanup();
      if (event.data.type === 'done') resolve(event.data.channels);
      else reject(new Error(event.data.error));
    };
    const onError = (event: ErrorEvent): void => {
      cleanup();
      reject(new Error(event.message || 'Sample operation worker failed'));
    };
    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError as EventListener);
    const request: SampleOperationRequest = { ...operation, channels, range };
    worker.postMessage(
      request,
      channels.map((channel) => channel.buffer),
    );
  });
}
