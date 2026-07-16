/** Origin-wide lock name shared by every OPFS mutation and garbage collection pass. */
export const PERSISTENCE_MUTATION_LOCK = 'sonare-studio:persistence-mutation:v1';

export interface PersistenceMutationLockOptions {
  signal?: AbortSignal;
}

let fallbackTail: Promise<void> = Promise.resolve();

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/**
 * Serializes persistence mutations across every tab/window through Web Locks.
 * The promise queue is a deterministic same-realm fallback for browsers and
 * test environments that do not expose the Web Locks API.
 */
export function withPersistenceMutationLock<T>(
  operation: () => Promise<T>,
  options: PersistenceMutationLockOptions = {},
): Promise<T> {
  const manager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (manager && typeof manager.request === 'function') {
    const lockOptions: LockOptions = { mode: 'exclusive' };
    if (options.signal) lockOptions.signal = options.signal;
    return manager.request(PERSISTENCE_MUTATION_LOCK, lockOptions, operation);
  }

  const run = fallbackTail.then(async () => {
    if (options.signal?.aborted) throw abortError(options.signal);
    return operation();
  });
  fallbackTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test-only reset for the same-realm fallback queue. */
export function resetPersistenceMutationLockForTests(): void {
  fallbackTail = Promise.resolve();
}
