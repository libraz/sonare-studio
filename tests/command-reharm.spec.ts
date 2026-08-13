import { chordPitchClasses } from '@libraz/libcantus';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editorChordToChord } from '@/compose/chord-io';
import { reharmCandidatesFor } from '@/compose/reharm';
import { arrangementMelodyPitchClasses, setProjectChords } from '@/project/command/chords';
import { moveClip, trimClip } from '@/project/command/clips-editing';
import { clearHistory, undo } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { reharmonizeChord } from '@/project/command/reharm';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const C_MAJOR = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

describe('reharmonizeChord', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('replaces one chord with a substitute over the same region', () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 4 },
    ]);
    const [candidate] = reharmCandidatesFor(store.chords[1], C_MAJOR);
    expect(candidate).toBeDefined();

    reharmonizeChord(1, candidate);

    expect(store.chords).toHaveLength(2);
    // The first chord is untouched; the second becomes the candidate, region kept.
    expect(store.chords[0]).toMatchObject({ rootPc: 0, quality: 0 });
    expect(store.chords[1].startPpq).toBe(4);
    expect(store.chords[1].endPpq).toBe(8);
    expect(store.chords[1].rootPc).toBe(candidate.symbol.rootPc);
    expect(store.chords[1].quality).toBe(candidate.symbol.quality);
  });

  it('is a single undoable edit', () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 7, quality: 4 }]);
    const before = { ...store.chords[0] };
    const [candidate] = reharmCandidatesFor(store.chords[0], C_MAJOR);

    reharmonizeChord(0, candidate);
    expect(store.chords[0].rootPc).toBe(candidate.symbol.rootPc);

    undo();
    expect(store.chords[0]).toMatchObject({ rootPc: before.rootPc, quality: before.quality });
  });

  it('ignores an out-of-range index', () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 7, quality: 4 }]);
    const [candidate] = reharmCandidatesFor(store.chords[0], C_MAJOR);
    reharmonizeChord(5, candidate);
    expect(store.chords[0]).toMatchObject({ rootPc: 7, quality: 4 });
  });

  it('uses absolute projection for a moved and trimmed sustained melody note', () => {
    addNote({ pitch: 61, startPpq: 0, durationPpq: 8 });
    moveClip(store.clipId, 32);
    trimClip(store.clipId, 34, 6);

    const melodyPcs = arrangementMelodyPitchClasses(34, 40);
    expect(melodyPcs).toEqual([1]);

    const source = { startPpq: 34, endPpq: 40, rootPc: 0, quality: 0 };
    const candidates = reharmCandidatesFor(source, C_MAJOR, melodyPcs);
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.every((candidate) =>
        chordPitchClasses(editorChordToChord(candidate.symbol)).includes(1),
      ),
    ).toBe(true);
  });
});
