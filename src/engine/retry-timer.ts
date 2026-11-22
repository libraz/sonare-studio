/** Delay before a refused engine command is re-sent. */
const COMMAND_RETRY_MS = 50;

/** Queue of re-sends for commands the engine's command ring refused. */
export interface RetryTimer {
  /**
   * Queues `run` under `key` unless that key is already queued or the engine
   * is closed. A run that is refused again queues itself once more.
   */
  schedule(key: string, run: () => void): void;
}

/**
 * Creates a retry queue. Queued re-sends are dropped once the engine's context
 * is closed; an error thrown by one is left to the next regular sync to report.
 *
 * @param isClosed Whether the engine has been torn down.
 * @returns The retry queue.
 */
export function createRetryTimer(isClosed: () => boolean): RetryTimer {
  const queued = new Map<string, () => void>();
  let armed = false;
  const flush = (): void => {
    armed = false;
    const runs = [...queued.values()];
    queued.clear();
    if (isClosed()) return;
    for (const run of runs) {
      try {
        run();
      } catch {
        // The next regular sync re-sends and surfaces the failure.
      }
    }
  };
  return {
    schedule: (key, run) => {
      if (isClosed() || queued.has(key)) return;
      queued.set(key, run);
      if (armed) return;
      armed = true;
      setTimeout(flush, COMMAND_RETRY_MS);
    },
  };
}
