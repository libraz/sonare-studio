import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPersistenceMutationLockForTests } from '@/persistence/mutation-lock';
import {
  listProjectRevisions,
  loadProjectRevision,
  MAX_REVISIONS_PER_PROJECT,
  sanitizeRevisionLabel,
  saveProjectRevision,
} from '@/persistence/revisions';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

describe('revision pruning', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

  beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    resetPersistenceMutationLockForTests();
    installMockOpfs();
  });

  afterEach(() => {
    resetPersistenceMutationLockForTests();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    uninstallMockOpfs();
  });

  it('keeps the revision just saved even when its timestamp is the oldest', async () => {
    for (let i = 1; i <= MAX_REVISIONS_PER_PROJECT; i++) {
      await saveProjectRevision('Song', `rev ${i}`, new Uint8Array([i]), i * 1000);
    }

    const fresh = await saveProjectRevision('Song', 'backdated', new Uint8Array([99]), 1);

    const listed = await listProjectRevisions('Song');
    expect(listed).toHaveLength(MAX_REVISIONS_PER_PROJECT);
    expect(listed.map((entry) => entry.slot)).toContain(fresh.slot);
    expect([...(await loadProjectRevision(fresh.slot))]).toEqual([99]);
    // The oldest of the others is the one pruned.
    expect(listed.map((entry) => entry.label)).not.toContain('rev 1');
  });
});

describe('sanitizeRevisionLabel', () => {
  it('does not cut a surrogate pair when bounding the length', () => {
    const label = `${'a'.repeat(59)}😀tail`;
    const cleaned = sanitizeRevisionLabel(label);
    expect(cleaned).toBe(`${'a'.repeat(59)}😀`);
    expect(cleaned.isWellFormed()).toBe(true);
  });
});
