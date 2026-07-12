import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectChords } from '@/project/command/chords';
import { generateTracksBatchCommand, partForTrackName } from '@/project/command/generate-batch';
import { clearHistory, redo, undo } from '@/project/command/history';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const FOUR_CHORDS = [
  { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
  { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
  { startPpq: 8, endPpq: 12, rootPc: 9, quality: 0 },
  { startPpq: 12, endPpq: 16, rootPc: 5, quality: 0 },
];

describe('generateTracksBatchCommand', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('generates multiple parts in a single undoable transaction', () => {
    setProjectChords(FOUR_CHORDS);
    const trackCount = store.tracks.length;
    const written = generateTracksBatchCommand([
      { part: 'drums', params: { bars: 4 }, target: { kind: 'new' } },
      { part: 'bass', params: {}, target: { kind: 'new' } },
      { part: 'backing', params: {}, target: { kind: 'new' } },
    ]);
    expect(written).toBe(3);
    expect(store.tracks.length).toBe(trackCount + 3);
    for (const name of ['Drums', 'Bass', 'Backing']) {
      expect(store.tracks.some((track) => track.name === name)).toBe(true);
    }
    // One undo removes every generated part at once.
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount);
    expect(redo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount + 3);
  });

  it('skips empty generations', () => {
    // No chords: bass and backing are no-ops; only drums lands.
    const trackCount = store.tracks.length;
    const written = generateTracksBatchCommand([
      { part: 'drums', params: { bars: 2 }, target: { kind: 'new' } },
      { part: 'bass', params: {}, target: { kind: 'new' } },
    ]);
    expect(written).toBe(1);
    expect(store.tracks.length).toBe(trackCount + 1);
  });

  it('replaces an existing generated track in the same undo step', () => {
    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    expect(drums).toBeDefined();
    const trackCount = store.tracks.length;

    const written = generateTracksBatchCommand([
      {
        part: 'drums',
        params: { bars: 2, style: 'funk' },
        target: { kind: 'replaceTrack', trackId: drums?.id ?? -1 },
      },
    ]);
    expect(written).toBe(1);
    // Replace nets zero: the old Drums track is gone, one new Drums took its slot.
    expect(store.tracks.length).toBe(trackCount);
    const drumTracks = store.tracks.filter((track) => track.name === 'Drums');
    expect(drumTracks).toHaveLength(1);
    expect(drumTracks[0]?.id).not.toBe(drums?.id);

    // The replacement reverts in one undo, restoring the original track id.
    expect(undo()).toBe(true);
    expect(store.tracks.filter((track) => track.name === 'Drums')[0]?.id).toBe(drums?.id);
  });

  it('classifies generated track names', () => {
    expect(partForTrackName('Drums')).toBe('drums');
    expect(partForTrackName('bass')).toBe('bass');
    expect(partForTrackName('Counter melody')).toBe('counter');
    expect(partForTrackName('Lead synth')).toBeNull();
  });
});
