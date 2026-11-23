import { describe, expect, it } from 'vitest';
import { listSourceFiles, readSource } from './helpers/source-text';

/** A number parsed straight from an event target's text, bypassing readInputNumber. */
const DIRECT_READ =
  /\b(?:Number(?:\.parse(?:Float|Int))?|parseFloat|parseInt)\(\s*\(?\s*\(?\$?(?:event|e)\.target\b/;

describe('number input read guard', () => {
  const files = listSourceFiles('src', ['.ts', '.vue']);

  it('scans source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('reads numbers from input events only through readInputNumber', () => {
    const offenders = files.filter((f) => DIRECT_READ.test(readSource(f)));
    expect(offenders).toEqual([]);
  });
});
