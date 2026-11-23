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

describe('worker client messageerror guard', () => {
  const creators = sourceFiles('src').filter((f) => /new Worker\(/.test(readSource(f)));

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
