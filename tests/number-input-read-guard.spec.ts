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

/** A number parsed straight from an event target's text, bypassing readInputNumber. */
const DIRECT_READ =
  /\b(?:Number(?:\.parse(?:Float|Int))?|parseFloat|parseInt)\(\s*\(?\s*\(?\$?(?:event|e)\.target\b/;

describe('number input read guard', () => {
  const files = sourceFiles('src');

  it('scans source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('reads numbers from input events only through readInputNumber', () => {
    const offenders = files.filter((f) => DIRECT_READ.test(readSource(f)));
    expect(offenders).toEqual([]);
  });
});
