/** Per-target listener registry shared by the meter and scope bridges. */
export interface TargetListeners<T> {
  /** Registers a listener for one target; the returned unsubscribe is idempotent. */
  subscribe(targetId: number, listener: (value: T) => void): () => void;
  /** Calls every listener registered for the target. */
  emit(targetId: number, value: T): void;
  /** Whether the given target, or with no argument any target, has a listener. */
  hasListeners(targetId?: number): boolean;
  /** Targets with their listener sets, for pollers that visit watched targets. */
  entries(): IterableIterator<[number, ReadonlySet<(value: T) => void>]>;
  /** Drops every listener. */
  clear(): void;
}

/**
 * Creates a listener registry keyed by target id.
 *
 * @param isDisposed Returns true once the owner is disposed; later subscriptions are ignored.
 */
export function createTargetListeners<T>(isDisposed: () => boolean): TargetListeners<T> {
  const byTarget = new Map<number, Set<(value: T) => void>>();
  return {
    subscribe(targetId, listener) {
      let listeners = byTarget.get(targetId);
      if (!listeners) {
        listeners = new Set();
        byTarget.set(targetId, listeners);
      }
      if (!isDisposed()) listeners.add(listener);
      return () => {
        byTarget.get(targetId)?.delete(listener);
      };
    },
    emit(targetId, value) {
      const listeners = byTarget.get(targetId);
      if (!listeners) return;
      for (const listener of listeners) listener(value);
    },
    hasListeners(targetId) {
      if (targetId !== undefined) return (byTarget.get(targetId)?.size ?? 0) > 0;
      for (const listeners of byTarget.values()) if (listeners.size > 0) return true;
      return false;
    },
    entries() {
      return byTarget.entries();
    },
    clear() {
      for (const listeners of byTarget.values()) listeners.clear();
      byTarget.clear();
    },
  };
}
