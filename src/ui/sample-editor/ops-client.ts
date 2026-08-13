/** Disposable-worker client for non-WASM offline sample operations. */

import type { SampleOperationRequest, SampleOperationResponse } from '@/workers/sample-ops.worker';
import type { SampleRange } from './ops';

type OmitFromUnion<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never;

export type SampleOperation = OmitFromUnion<SampleOperationRequest, 'channels' | 'range' | 'owned'>;
export type SampleOperationWorkerFactory = () => Worker;

/** Default upper bound for a worker that has stopped responding. */
export const SAMPLE_OPERATION_TIMEOUT_MS = 30_000;

/** Raised when a sample operation worker does not respond before its deadline. */
export class SampleOperationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Sample operation worker timed out after ${timeoutMs} ms`);
    this.name = 'SampleOperationTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface SampleOperationWorkerOptions {
  /** Aborts and terminates the worker when the owning operation is invalidated. */
  signal?: AbortSignal;
  /** Finite response deadline in milliseconds. */
  timeoutMs?: number;
  /** Optional worker factory used by tests or an embedding environment. */
  workerFactory?: SampleOperationWorkerFactory;
}

type SampleOperationWorkerArgument =
  | SampleOperationWorkerFactory
  | SampleOperationWorkerOptions
  | AbortSignal;

function createWorker(): Worker {
  return new Worker(new URL('../../workers/sample-ops.worker.ts', import.meta.url), {
    type: 'module',
  });
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Sample operation was aborted', 'AbortError');
  }
  return new Error('Sample operation was aborted');
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
  return new Error(event.message || 'Sample operation worker failed');
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `Sample operation timeout must be finite and greater than zero, got ${timeoutMs}`,
    );
  }
  return timeoutMs;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof (value as { aborted?: unknown }).aborted === 'boolean'
  );
}

function resolveWorkerOptions(
  workerArgument: SampleOperationWorkerArgument | undefined,
  secondaryArgument: SampleOperationWorkerArgument | undefined,
): { create: SampleOperationWorkerFactory; options: SampleOperationWorkerOptions } {
  let create = createWorker;
  let options: SampleOperationWorkerOptions = {};
  if (typeof workerArgument === 'function') {
    create = workerArgument;
  } else if (isAbortSignal(workerArgument)) {
    options = { signal: workerArgument };
  } else if (workerArgument !== undefined) {
    options = workerArgument;
  }
  if (typeof secondaryArgument === 'function') {
    create = secondaryArgument;
  } else if (isAbortSignal(secondaryArgument)) {
    options = { ...options, signal: secondaryArgument };
  } else if (secondaryArgument !== undefined) {
    options = { ...options, ...secondaryArgument };
  }
  if (options.workerFactory) create = options.workerFactory;
  return { create, options };
}

/**
 * Runs a copy of the source buffers in a disposable worker. The source asset
 * stays usable on the main thread; only the copied buffers are transferred.
 * Once transferred, the worker owns those buffers and performs the operation
 * in place, so it does not allocate a second full-size working copy.
 *
 * The fourth argument remains compatible with the original worker-factory API;
 * callers may instead pass options or an AbortSignal directly. A factory and
 * options/signal can be supplied as the fourth and fifth arguments together.
 */
export function runSampleOperationInWorker(
  operation: SampleOperation,
  source: ReadonlyArray<Float32Array>,
  range: SampleRange,
  workerArgument?: SampleOperationWorkerArgument,
  secondaryArgument?: SampleOperationWorkerArgument,
): Promise<Float32Array[]> {
  const { create, options } = resolveWorkerOptions(workerArgument, secondaryArgument);
  const timeoutMs = validateTimeout(
    options.timeoutMs === undefined ? SAMPLE_OPERATION_TIMEOUT_MS : options.timeoutMs,
  );
  const signal = options.signal;

  return new Promise<Float32Array[]>((resolve, reject) => {
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let abortListener: (() => void) | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
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

    const settle = (result: { value: Float32Array[] } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };

    const onMessage = (event: MessageEvent<SampleOperationResponse>): void => {
      const response = event.data;
      if (!response || (response.type !== 'done' && response.type !== 'error')) {
        settle({ error: new Error('Sample operation worker returned an invalid response') });
        return;
      }
      if (response.type === 'error') {
        settle({ error: new Error(response.error) });
        return;
      }
      if (
        !Array.isArray(response.channels) ||
        response.channels.some((channel) => !(channel instanceof Float32Array))
      ) {
        settle({ error: new Error('Sample operation worker returned invalid channel buffers') });
        return;
      }
      settle({ value: response.channels });
    };

    const onError = (event: ErrorEvent): void => {
      settle({ error: errorFromWorkerEvent(event) });
    };

    const onAbort = (): void => {
      settle({ error: abortError(signal?.reason) });
    };

    const onTimeout = (): void => {
      settle({ error: new SampleOperationTimeoutError(timeoutMs) });
    };

    try {
      if (signal?.aborted) {
        settle({ error: abortError(signal.reason) });
        return;
      }
      worker = create();
      const channels = source.map((channel) => new Float32Array(channel));
      worker.addEventListener('message', onMessage as EventListener);
      worker.addEventListener('error', onError as EventListener);
      abortListener = onAbort;
      signal?.addEventListener('abort', abortListener, { once: true });
      timer = setTimeout(onTimeout, timeoutMs);
      const request: SampleOperationRequest = { ...operation, channels, range, owned: true };
      worker.postMessage(
        request,
        channels.map((channel) => channel.buffer),
      );
    } catch (error) {
      settle({ error });
    }
  });
}
