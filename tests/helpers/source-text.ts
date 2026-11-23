import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Helpers for specs that assert on source text instead of running the code.
 * Every such spec reads files through {@link readSource}, which is how
 * `yarn test:source-text` finds them: a moved or renamed file fails here at
 * once instead of leaving a window that silently matches nothing.
 */

const ROOT = resolve(import.meta.dirname, '../..');

/** Reads a repository file as UTF-8 text; `path` is relative to the repo root. */
export function readSource(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

/** Repo-relative paths of files under `dir` ending in one of `extensions` (e.g. `.ts`), recursively, sorted. */
export function listSourceFiles(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? listSourceFiles(`${dir}/${e.name}`, extensions)
        : extensions.some((ext) => e.name.endsWith(ext))
          ? [`${dir}/${e.name}`]
          : [],
    )
    .sort();
}

/**
 * The text from the first `start` up to the first `end` after it (`end`
 * excluded). Throws unless both markers occur, in that order.
 */
export function sourceWindow(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`source window start marker not found: ${start}`);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`source window end marker not found after start: ${end}`);
  return source.slice(from, to);
}
