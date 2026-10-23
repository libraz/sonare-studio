import { spelledKeyOf } from '@libraz/libcantus';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harmonize = vi.hoisted(() => vi.fn());

// Only the harmonizer is stubbed; the rest of the library stays real, so
// modules that read a constant off it at import time still load.
vi.mock('@libraz/libcantus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@libraz/libcantus')>()),
  harmonizeMelody: harmonize,
}));
vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

import { setProjectChords } from '@/project/command/chords';
import { addMidiClip } from '@/project/command/clips';
import { harmonizeFromMelodyCommand } from '@/project/command/generate-harmonize';
import { clearHistory } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

const key = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

function result(rootPc: number) {
  return {
    transposeSemitones: 0,
    key: spelledKeyOf(key),
    chords: [{ rootPc, quality: 'maj' as const, startBeat: 0 }],
    melodyRoles: [],
  };
}

describe('harmonizeFromMelodyCommand chord track outside the clip', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    harmonize.mockReset();
    harmonize.mockImplementation(() => result(7));
  });

  it('keeps the portions of chords that straddle either clip edge', () => {
    store.clipId = addMidiClip({ trackId: store.activeTrackId, startPpq: 2, lengthPpq: 6 });
    store.refresh();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 6, endPpq: 12, rootPc: 5, quality: 0 },
    ]);

    harmonizeFromMelodyCommand();

    const outside = store.chords
      .filter((chord) => chord.startPpq < 2 || chord.endPpq > 8)
      .map((chord) => [chord.startPpq, chord.endPpq, chord.rootPc]);
    expect(outside).toEqual([
      [0, 2, 0],
      [8, 12, 5],
    ]);
    expect(store.chords.some((chord) => chord.rootPc === 7)).toBe(true);
  });
});
