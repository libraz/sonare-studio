import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harmonize = vi.hoisted(() => vi.fn());

vi.mock('@libraz/libcantus', () => ({ harmonizeMelody: harmonize }));
vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

import { harmonizeFromMelodyCommand } from '@/project/command/generate-harmonize';
import { clearHistory } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

const key = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

function result(shift: number) {
  return {
    transposeSemitones: shift,
    key,
    chords: [{ rootPc: 0, quality: 'maj' as const, startBeat: 0 }],
    melodyRoles: [],
  };
}

describe('harmonizeFromMelodyCommand transpose placement', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    harmonize.mockReset();
  });

  it('uses one global shift for every meter range and disables local searches', () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    addNote({ pitch: 64, startPpq: 4, durationPpq: 1 });
    store.timeSignatures = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 4, numerator: 3, denominator: 4 },
    ];
    harmonize.mockImplementation((input) =>
      input.placement.transposeSearch ? result(5) : result(0),
    );

    harmonizeFromMelodyCommand({ transpose: true });

    const segmentInputs = harmonize.mock.calls.slice(1).map(([input]) => input);
    expect(segmentInputs).toHaveLength(2);
    expect(segmentInputs.map((input) => input.placement)).toEqual([
      { transposeSearch: false, octaveSearch: false },
      { transposeSearch: false, octaveSearch: false },
    ]);
    expect(segmentInputs.map((input) => input.melody[0].pitch)).toEqual([65, 69]);
    expect(store.activeClip?.notes.map((note) => note.pitch)).toEqual([65, 69]);
  });

  it('rejects an out-of-range global shift instead of clamping notes', () => {
    addNote({ pitch: 126, startPpq: 0, durationPpq: 1 });
    harmonize.mockImplementation((input) =>
      input.placement.transposeSearch ? result(5) : result(0),
    );

    harmonizeFromMelodyCommand({ transpose: true, harmonicRhythm: 4 });

    expect(harmonize.mock.calls[1][0].melody[0].pitch).toBe(126);
    expect(store.activeClip?.notes[0]?.pitch).toBe(126);
  });
});
