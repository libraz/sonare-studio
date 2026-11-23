import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changedNoteUpdates } from '@/components/piano-roll/keyboard-note-updates';
import { addNotes, canRedo, clearHistory, undo, updateNotes } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { readSource, sourceWindow } from './helpers/source-text';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('keyboard note updates that change nothing', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('are filtered out so redo survives a boundary key press', () => {
    const store = useProjectStore();
    const [id] = addNotes([{ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 90, channel: 0 }]);
    updateNotes([{ id, pitch: 62 }]);
    expect(undo()).toBe(true);
    expect(canRedo()).toBe(true);

    const noop = changedNoteUpdates(store.notes, [
      { id, startPpq: 0 },
      { id, pitch: 60 },
    ]);
    expect(noop).toEqual([]);
    if (noop.length > 0) updateNotes(noop);
    expect(canRedo()).toBe(true);
  });

  it('keeps updates that alter a field', () => {
    const store = useProjectStore();
    const [id] = addNotes([{ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 90, channel: 0 }]);
    expect(changedNoteUpdates(store.notes, [{ id, startPpq: 0.25 }])).toEqual([
      { id, startPpq: 0.25 },
    ]);
  });

  it('routes every keyboard note edit through the no-op filter and skips zero-delta duplicates', () => {
    const body = sourceWindow(
      readSource('src/ui/piano-roll/use-note-keyboard-edits.ts'),
      'function onNoteKeyboardAction',
      '\n  return { onNoteKeyboardAction',
    );
    expect(body.replace('const changed', '')).not.toMatch(/[^.]\bupdateNotes\(/);
    expect(body).toMatch(/if \(delta === 0\) \{\s+event\.preventDefault\(\);\s+return true;/);
  });
});
