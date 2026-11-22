/**
 * Recently-opened project tracker, persisted to localStorage. The shell records
 * a project name whenever it is opened or saved; the most recent name comes
 * first and the list is capped. The list-shaping helpers are pure (and
 * unit-tested); the localStorage glue never throws.
 */
import { readLocalStorage, writeLocalStorage } from '@/lib/local-storage';

/** localStorage key holding the recent-project name list. */
export const RECENT_PROJECTS_STORAGE_KEY = 'sonare-studio.recentProjects';

/** Most recent project names kept. */
export const MAX_RECENT_PROJECTS = 8;

/** True when a name can be passed to the OPFS project-name sanitizer safely. */
function isValidRecentProjectName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..';
}

/**
 * Returns the list with `name` moved to the front, de-duplicated and capped.
 *
 * @param existing Current recents (most-recent first).
 * @param name Name just opened or saved (blank names are ignored).
 * @param max Maximum kept (defaults to {@link MAX_RECENT_PROJECTS}).
 */
export function withRecent(
  existing: readonly string[],
  name: string,
  max = MAX_RECENT_PROJECTS,
): string[] {
  const trimmed = name.trim();
  if (!isValidRecentProjectName(trimmed)) return existing.slice(0, max);
  return [trimmed, ...existing.filter((entry) => entry !== trimmed)].slice(0, max);
}

/** Returns the list without `name` (e.g. when its project is deleted). */
export function withoutRecent(existing: readonly string[], name: string): string[] {
  return existing.filter((entry) => entry !== name);
}

/** Parses a stored payload into a clean, de-duplicated, capped name list. */
export function parseRecent(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (isValidRecentProjectName(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, MAX_RECENT_PROJECTS);
}

/** Reads the recent-project list from storage; failures yield an empty list. */
export function loadRecentProjects(): string[] {
  const text = readLocalStorage(RECENT_PROJECTS_STORAGE_KEY);
  if (text === null) return [];
  try {
    return parseRecent(JSON.parse(text));
  } catch {
    return [];
  }
}

/** Writes the recent-project list; recents stay in memory when storage refuses. */
export function saveRecentProjects(names: readonly string[]): void {
  writeLocalStorage(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(names));
}
