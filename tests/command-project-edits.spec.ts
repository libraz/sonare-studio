import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAudioClip,
  addMidiClip,
  clearHistory,
  duplicateClip,
  redo,
  splitClip,
  undo,
} from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/**
 * Locks the hard-coded `projectEdits` counts each command passes to the
 * history layer against the binding's undo granularity. A command declares how
 * many wasm Project history entries it pushes; if that number is wrong, a
 * single app-level undo() under-/over-replays Project.undo() and the document
 * fails to round-trip. These tests assert the raw Project JSON returns to its
 * pre-command state on undo and back on redo, so any drift between a command's
 * declared edit count and the binding is caught here rather than as a silent
 * undo corruption.
 */
describe('command projectEdits / undo granularity', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
  });

  /** Runs `make`, then asserts one undo restores the Project and redo reapplies. */
  function expectSingleUndoRoundTrip(make: () => void): void {
    const before = getProject().toJson();
    make();
    const after = getProject().toJson();
    expect(after).not.toBe(before);
    undo();
    expect(getProject().toJson()).toBe(before);
    redo();
    expect(getProject().toJson()).toBe(after);
  }

  it('addMidiClip (source + clip = 2 edits) undoes in one step', () => {
    expectSingleUndoRoundTrip(() => {
      addMidiClip({ trackId, lengthPpq: 8 });
    });
  });

  it('addAudioClip registering a new source (2 edits) undoes in one step', () => {
    expectSingleUndoRoundTrip(() => {
      void addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    });
  });

  it('addAudioClip rebinding a known source (3 edits) undoes in one step', async () => {
    // First clip registers the source; the second rebinds it (the asymmetric
    // edit count the command encodes).
    await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    clearHistory();
    expectSingleUndoRoundTrip(() => {
      void addAudioClip({ trackId, assetId: 'asset-x', startPpq: 16, lengthPpq: 8 });
    });
  });

  it('duplicateClip (1 edit) undoes in one step', () => {
    const clipId = addMidiClip({ trackId, startPpq: 0, lengthPpq: 8 });
    clearHistory();
    expectSingleUndoRoundTrip(() => {
      duplicateClip(clipId, 16);
    });
  });

  it('splitClip (1 edit) undoes in one step', () => {
    const clipId = addMidiClip({ trackId, startPpq: 0, lengthPpq: 8 });
    clearHistory();
    expectSingleUndoRoundTrip(() => {
      splitClip(clipId, 4);
    });
  });
});
