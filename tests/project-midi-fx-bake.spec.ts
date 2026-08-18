import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addNotes, bakeClipMidiFx, clearHistory, setSelection, undo } from '@/project/commands';
import { DEFAULT_MIDI_FX_CONFIG, type MidiFxConfig } from '@/project/midi-fx';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** A transform config with only the named fields moved off their identity. */
function transform(overrides: Partial<MidiFxConfig>): MidiFxConfig {
  return {
    ...DEFAULT_MIDI_FX_CONFIG,
    chordIntervals: [],
    arpeggiatorIntervals: [],
    ...overrides,
  };
}

describe('MIDI-FX bake note identity', () => {
  let store: ReturnType<typeof useProjectStore>;
  let clipId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    clipId = store.clips[0].id;
    store.clipId = clipId;
    addNotes([
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 90, startPpq: 1, durationPpq: 1, channel: 0 },
      { pitch: 67, velocity: 80, startPpq: 2, durationPpq: 1, channel: 0 },
    ]);
    clearHistory();
  });

  it('keeps every note id, and the selection, across a transform that rewrites content', () => {
    const before = store.notes.map((note) => ({ id: note.id, pitch: note.pitch }));
    setSelection([before[0].id, before[2].id]);

    expect(bakeClipMidiFx(clipId, transform({ transposeSemitones: 2 }))).toBe(true);

    expect(store.notes.map((note) => note.pitch)).toEqual([62, 66, 69]);
    // Same ids on the same musical lines: content-key matching cannot do this,
    // because the transform changed the content the key is built from.
    expect(store.notes.map((note) => note.id)).toEqual(before.map((entry) => entry.id));
    expect([...store.selection].sort((a, b) => a - b)).toEqual(
      [before[0].id, before[2].id].sort((a, b) => a - b),
    );
  });

  it('gives one fan-out voice the original id and the rest fresh ids', () => {
    const before = store.notes.map((note) => note.id);
    setSelection([before[1]]);

    expect(bakeClipMidiFx(clipId, transform({ chordIntervals: [0, 4, 7] }))).toBe(true);

    expect(store.notes).toHaveLength(9);
    const ids = store.notes.map((note) => note.id);
    expect(new Set(ids).size).toBe(9);
    // Each input note survives exactly once; the added voices are new notes.
    for (const id of before) expect(ids).toContain(id);
    expect(store.selection).toEqual(new Set([before[1]]));
  });

  it('follows a note through a transform that reorders the clip', () => {
    // 84 sits just before the grid line and 83 just after it. Quantizing pulls
    // both onto it, where the mirror's start-then-pitch ordering swaps them.
    addNotes([
      { pitch: 84, velocity: 100, startPpq: 3.9, durationPpq: 0.5, channel: 0 },
      { pitch: 83, velocity: 100, startPpq: 4.1, durationPpq: 0.5, channel: 0 },
    ]);
    const idByPitch = new Map(store.notes.map((note) => [note.pitch, note.id]));
    const orderBefore = store.notes.map((note) => note.pitch);

    expect(bakeClipMidiFx(clipId, transform({ quantizeStrength: 1, quantizeGrid: 1 }))).toBe(true);

    expect(store.notes).toHaveLength(orderBefore.length);
    expect(store.notes.map((note) => note.pitch)).not.toEqual(orderBefore);
    for (const note of store.notes) {
      expect(note.id).toBe(idByPitch.get(note.pitch));
    }
  });

  it('restores the pre-bake notes as one undoable edit', () => {
    const before = store.notes.map((note) => ({ ...note }));

    bakeClipMidiFx(clipId, transform({ chordIntervals: [0, 4, 7] }));
    undo();

    expect(store.notes.map((note) => note.pitch)).toEqual(before.map((note) => note.pitch));
  });
});
