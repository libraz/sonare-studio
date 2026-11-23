import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSource } from './helpers/source-text';

function sourceFiles(dir: string): string[] {
  return readdirSync(join(import.meta.dirname, '..', dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(`${dir}/${e.name}`)
      : e.name.endsWith('.ts') || e.name.endsWith('.vue')
        ? [`${dir}/${e.name}`]
        : [],
  );
}

describe('Math.min/max spread guard', () => {
  const files = sourceFiles('src');

  it('scans source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never spreads an array into Math.min/Math.max (use minOf/maxOf)', () => {
    const offenders = files.filter((f) => /Math\.(min|max)\(\s*\.\.\./.test(readSource(f)));
    expect(offenders).toEqual([]);
  });
});
