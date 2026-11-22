/**
 * Best-effort localStorage access for preferences the app can live without.
 * Storage can be missing, denied (privacy mode, sandboxed frames) or full; a
 * read then sees no entry and a write leaves the value in memory only.
 * Callers parse outside these helpers, so a corrupt value is the caller's case.
 */

/** Stored text for `key`; null when the entry is absent or storage access throws. */
export function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value` under `key`; a refused write (quota, denied access) is ignored. */
export function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The value stays in memory for the session.
  }
}
