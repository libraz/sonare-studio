import { describe, expect, it } from 'vitest';
import { listSourceFiles, readSource } from './helpers/source-text';

describe('worker client messageerror guard', () => {
  const creators = listSourceFiles('src', ['.ts', '.vue']).filter((f) =>
    /new Worker\(/.test(readSource(f)),
  );

  it('finds the worker clients', () => {
    expect(creators.length).toBeGreaterThanOrEqual(8);
  });

  it('every worker client runs through runDisposableWorker or listens for messageerror', () => {
    const offenders = creators.filter((f) => {
      const text = readSource(f);
      return !text.includes('runDisposableWorker') && !text.includes("'messageerror'");
    });
    expect(offenders).toEqual([]);
  });
});
