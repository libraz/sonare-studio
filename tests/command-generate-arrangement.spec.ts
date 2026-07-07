import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectChords } from '@/project/command/chords';
import { generateArrangementCommand } from '@/project/command/generate-arrangement';
import { generateBackingCommand } from '@/project/command/generate-backing';
import { clearHistory, redo, undo } from '@/project/command/history';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const TWO_CHORDS = [
  { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
  { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
];

describe('generateBackingCommand', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('voices the chord track onto a new backing track and reverts on undo', () => {
    setProjectChords(TWO_CHORDS);
    const trackCount = store.tracks.length;
    const count = generateBackingCommand({ style: 'smooth' });
    expect(count).toBeGreaterThan(0);
    expect(store.tracks.length).toBe(trackCount + 1);
    expect(store.tracks.some((t) => t.name === 'Backing')).toBe(true);
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount);
  });

  it('supports a fixed tertian style', () => {
    setProjectChords(TWO_CHORDS);
    const count = generateBackingCommand({ style: 'shell' });
    expect(count).toBeGreaterThan(0);
  });

  it('is a no-op without a chord track', () => {
    const trackCount = store.tracks.length;
    expect(generateBackingCommand()).toBe(0);
    expect(store.tracks.length).toBe(trackCount);
  });
});

describe('generateArrangementCommand', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('lays down chords, drums, bass, and backing in a single undoable edit', () => {
    const trackCount = store.tracks.length;
    const parts = generateArrangementCommand({ bars: 4, seed: 0 });
    // Progression + three new tracks (drums, bass, backing).
    expect(parts).toBe(3);
    expect(store.tracks.length).toBe(trackCount + 3);
    expect(store.chords.length).toBeGreaterThan(0);
    for (const name of ['Drums', 'Bass', 'Backing']) {
      expect(store.tracks.some((t) => t.name === name)).toBe(true);
    }
    // One undo reverts the whole arrangement — tracks and chords together.
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount);
    expect(store.chords).toEqual([]);
    expect(redo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount + 3);
    expect(store.chords.length).toBeGreaterThan(0);
  });

  it('honors part selection', () => {
    const trackCount = store.tracks.length;
    const parts = generateArrangementCommand({ bars: 2, drums: true, bass: false, backing: false });
    expect(parts).toBe(1);
    expect(store.tracks.length).toBe(trackCount + 1);
    expect(store.tracks.some((t) => t.name === 'Drums')).toBe(true);
    expect(store.tracks.some((t) => t.name === 'Bass')).toBe(false);
  });

  it('is deterministic in its seed', () => {
    generateArrangementCommand({ bars: 4, seed: 9 });
    const first = JSON.stringify(store.chords);
    undo();
    generateArrangementCommand({ bars: 4, seed: 9 });
    expect(JSON.stringify(store.chords)).toBe(first);
  });

  it('rejects a non-positive bar count', () => {
    expect(() => generateArrangementCommand({ bars: 0 })).toThrow(RangeError);
  });
});
