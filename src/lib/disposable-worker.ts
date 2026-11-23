/** One-shot worker request: create, post, settle once, and always terminate the worker. */

export type WorkerSettle<T> = (result: { value: T } | { error: unknown }) => void;

export interface DisposableWorkerRequest<Res, T> {
  /** Creates the worker; called only when the signal has not already aborted. */
  create: () => Worker;
  /** Aborting rejects the run and terminates the worker. */
  signal?: AbortSignal;
  /** Message for the AbortError raised when the abort reason is not an Error. */
  abortMessage: string;
  /** Message for a worker `error` event that carries none of its own. */
  failMessage: string;
  /** Rejects with `error()` when no reply settles the run within `ms`. */
  timeout?: { ms: number; error: () => Error };
  /** Builds and posts the request; anything thrown rejects the run. */
  post(worker: Worker): void;
  /** Handles one reply: call `settle` to finish, or return to wait for the next one; a throw rejects the run. */
  receive(response: Res, settle: WorkerSettle<T>): void;
}

/** The abort reason when it is an Error, otherwise an `AbortError` carrying `message`. */
export function abortError(reason: unknown, message: string): Error {
  if (reason instanceof Error) return reason;
  if (typeof DOMException !== 'undefined') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Error for a worker `error` event, falling back to `fallback` when the event has no message. */
export function workerEventError(event: ErrorEvent, fallback: string): Error {
  return new Error(event.message || fallback);
}

/** Error for a `messageerror`: the worker replied, but the reply could not be deserialized. */
export function unreadableReplyError(fallback: string): Error {
  return new Error(`${fallback}: its reply could not be read`);
}

/** Runs one request in a fresh worker; the promise settles exactly once. */
export function runDisposableWorker<Res, T>(request: DisposableWorkerRequest<Res, T>): Promise<T> {
  const { signal, timeout } = request;
  return new Promise<T>((resolve, reject) => {
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
        worker.removeEventListener('messageerror', onMessageError);
        try {
          worker.terminate();
        } catch {
          // Termination is best effort; preserve the settled result.
        }
      }
      worker = null;
    };

    const settle: WorkerSettle<T> = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };

    const onMessage = (event: MessageEvent<Res>): void => {
      try {
        request.receive(event.data, settle);
      } catch (error) {
        settle({ error });
      }
    };

    const onError = (event: ErrorEvent): void => {
      settle({ error: workerEventError(event, request.failMessage) });
    };

    const onMessageError = (): void => {
      settle({ error: unreadableReplyError(request.failMessage) });
    };

    const onAbort = (): void => {
      settle({ error: abortError(signal?.reason, request.abortMessage) });
    };

    try {
      if (signal?.aborted) {
        settle({ error: abortError(signal.reason, request.abortMessage) });
        return;
      }
      worker = request.create();
      worker.addEventListener('message', onMessage as EventListener);
      worker.addEventListener('error', onError as EventListener);
      worker.addEventListener('messageerror', onMessageError);
      abortListener = onAbort;
      signal?.addEventListener('abort', abortListener, { once: true });
      if (timeout) {
        const { ms, error } = timeout;
        timer = setTimeout(() => settle({ error: error() }), ms);
      }
      request.post(worker);
    } catch (error) {
      settle({ error });
    }
  });
}
