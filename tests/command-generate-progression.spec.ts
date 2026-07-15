import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectChords } from '@/project/command/chords';
import { generateProgressionCommand } from '@/project/command/generate-progression';
import { clearHistory, redo, undo } from '@/project/command/history';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('generateProgressionCommand', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('writes a diatonic progression to the chord track, one chord per bar', () => {
    const count = generateProgressionCommand({ bars: 4, style: 'minimal', seed: 1 });
    expect(count).toBe(4);
    expect(store.chords).toHaveLength(4);
    // One chord per 4-beat bar, placed from the project start, contiguous.
    expect(store.chords.map((c) => [c.startPpq, c.endPpq])).toEqual([
      [0, 4],
      [4, 8],
      [8, 12],
      [12, 16],
    ]);
    // Roots are valid pitch classes (the generator may include borrowed chords).
    for (const chord of store.chords) {
      expect(chord.rootPc).toBeGreaterThanOrEqual(0);
      expect(chord.rootPc).toBeLessThanOrEqual(11);
    }
  });

  it('is deterministic in its seed', () => {
    generateProgressionCommand({ bars: 4, style: 'dance', seed: 7 });
    const first = JSON.stringify(store.chords);
    generateProgressionCommand({ bars: 4, style: 'dance', seed: 7 });
    expect(JSON.stringify(store.chords)).toBe(first);
  });

  it('reverts fully on undo (single history entry)', () => {
    generateProgressionCommand({ bars: 8, style: 'rock', seed: 2 });
    expect(store.chords).toHaveLength(8);
    expect(undo()).toBe(true);
    expect(store.chords).toEqual([]);
    expect(redo()).toBe(true);
    expect(store.chords).toHaveLength(8);
  });

  it('replaces the existing chord track by default', () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 5, quality: 0 }]);
    generateProgressionCommand({ bars: 2, seed: 0 });
    expect(store.chords).toHaveLength(2);
    expect(store.chords[0].startPpq).toBe(0);
  });

  it('appends after the existing chords in append mode', () => {
    setProjectChords([{ startPpq: 0, endPpq: 8, rootPc: 5, quality: 0 }]);
    generateProgressionCommand({ bars: 2, seed: 0, mode: 'append' });
    expect(store.chords).toHaveLength(3);
    expect(store.chords[1].startPpq).toBe(8);
  });

  it('rejects a non-positive bar count', () => {
    expect(() => generateProgressionCommand({ bars: 0 })).toThrow(RangeError);
  });

  it('blocks the 4/4-only generator when the requested bars cross another meter', () => {
    store.timeSignatures = [{ startPpq: 0, numerator: 3, denominator: 4 }];
    expect(() => generateProgressionCommand({ bars: 1 })).toThrow(/supports 4\/4 bars only/);
    expect(store.chords).toEqual([]);
  });

  describe('range mode', () => {
    it('keeps chords entirely outside the range and replaces the rest', () => {
      setProjectChords([
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }, // before the range: kept
        { startPpq: 4, endPpq: 8, rootPc: 2, quality: 0 }, // inside the range: replaced
        { startPpq: 8, endPpq: 12, rootPc: 4, quality: 0 }, // after the range: kept
      ]);

      generateProgressionCommand({ bars: 1, seed: 0, mode: 'range', startPpq: 4 });

      expect(store.chords).toHaveLength(3);
      expect(store.chords[0]).toMatchObject({ startPpq: 0, endPpq: 4, rootPc: 0 });
      expect(store.chords[1].startPpq).toBe(4);
      expect(store.chords[1].endPpq).toBe(8);
      expect(store.chords[2]).toMatchObject({ startPpq: 8, endPpq: 12, rootPc: 4 });
    });

    it('drops a chord that only partially overlaps the range', () => {
      setProjectChords([
        { startPpq: 0, endPpq: 6, rootPc: 0, quality: 0 }, // overlaps [4, 8): dropped
        { startPpq: 8, endPpq: 12, rootPc: 4, quality: 0 }, // outside: kept
      ]);

      generateProgressionCommand({ bars: 1, seed: 0, mode: 'range', startPpq: 4 });

      expect(store.chords).toHaveLength(2);
      expect(store.chords[0].startPpq).toBe(4);
      expect(store.chords[1]).toMatchObject({ startPpq: 8, endPpq: 12, rootPc: 4 });
    });

    it('is a single undoable edit', () => {
      setProjectChords([{ startPpq: 4, endPpq: 8, rootPc: 2, quality: 0 }]);
      generateProgressionCommand({ bars: 1, seed: 0, mode: 'range', startPpq: 4 });
      expect(store.chords).toHaveLength(1);
      expect(undo()).toBe(true);
      expect(store.chords).toEqual([{ startPpq: 4, endPpq: 8, rootPc: 2, quality: 0 }]);
    });
  });
});
