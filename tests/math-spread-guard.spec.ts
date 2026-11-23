import { describe, expect, it } from 'vitest';
import { listSourceFiles, readSource } from './helpers/source-text';

describe('Math.min/max spread guard', () => {
  const files = listSourceFiles('src', ['.ts', '.vue']);

  it('scans source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never spreads an array into Math.min/Math.max (use minOf/maxOf)', () => {
    const offenders = files.filter((f) => /Math\.(min|max)\(\s*\.\.\./.test(readSource(f)));
    expect(offenders).toEqual([]);
  });
});
