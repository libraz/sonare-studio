/**
 * The installed libsonare is the one the lockfile pins: same version, same
 * resolution, and an install archive whose digest is the lockfile checksum.
 * It never names a version, so a lockfile bump needs no edit here.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE_DIR } from './core-package';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGE = '@libraz/libsonare';

/** The lockfile block for the core: its version, resolution and checksum. */
function lockEntry(): { version: string; resolution: string; checksum: string } {
  const lock = readFileSync(path.join(ROOT, 'yarn.lock'), 'utf8');
  const blocks = lock.split(/\n(?=\S)/).filter((block) => block.startsWith(`"${PACKAGE}@`));
  expect(blocks).toHaveLength(1);
  const field = (name: string): string => {
    const match = blocks[0].match(new RegExp(`^  ${name}: "?([^"\\n]+)"?$`, 'm'));
    if (!match) throw new Error(`the ${PACKAGE} lockfile entry has no ${name}`);
    return match[1];
  };
  return {
    version: field('version'),
    resolution: field('resolution'),
    checksum: field('checksum'),
  };
}

describe('installed libsonare', () => {
  const entry = lockEntry();

  it('is the version the lockfile resolves', () => {
    const installed = JSON.parse(readFileSync(path.join(CORE_PACKAGE_DIR, 'package.json'), 'utf8'));
    expect(installed.version).toBe(entry.version);
  });

  it('was linked from the lockfile resolution', () => {
    const state = readFileSync(path.join(ROOT, 'node_modules', '.yarn-state.yml'), 'utf8');
    expect(state).toContain(
      `"${entry.resolution}":\n  locations:\n    - "node_modules/${PACKAGE}"`,
    );
  });

  it('was unpacked from an archive matching the lockfile checksum', () => {
    const digest = entry.checksum.slice(entry.checksum.indexOf('/') + 1);
    const cache = path.join(ROOT, '.yarn', 'cache');
    const archives = readdirSync(cache).filter(
      (name) => name.startsWith('@libraz-libsonare-') && name.includes(digest.slice(0, 10)),
    );
    expect(archives).toHaveLength(1);
    const bytes = readFileSync(path.join(cache, archives[0]));
    expect(createHash('sha512').update(bytes).digest('hex')).toBe(digest);
  });
});
