import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectChords } from '@/project/command/chords';
import { generateBassLineCommand } from '@/project/command/generate-bass';
import { generateCounterMelodyCommand } from '@/project/command/generate-counter-melody';
import { generateDrumsCommand } from '@/project/command/generate-drums';
import { harmonizeFromMelodyCommand } from '@/project/command/generate-harmonize';
import { generateMotifCommand } from '@/project/command/generate-motif';
import { clearHistory, redo, undo } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Lays a short diatonic C-major melody into the active clip. */
function addCMajorMelody(): void {
  const pitches = [60, 62, 64, 65, 67, 65, 64, 62];
  pitches.forEach((pitch, index) => {
    addNote({ pitch, startPpq: index, durationPpq: 1 });
  });
}

describe('generation command suite', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  describe('harmonizeFromMelodyCommand', () => {
    it('writes a progression for the active clip melody and reverts on undo', () => {
      addCMajorMelody();
      const count = harmonizeFromMelodyCommand({ harmonicRhythm: 4, seed: 0 });
      expect(count).toBeGreaterThanOrEqual(1);
      expect(store.chords.length).toBe(count);
      for (const chord of store.chords) {
        expect(chord.rootPc).toBeGreaterThanOrEqual(0);
        expect(chord.rootPc).toBeLessThanOrEqual(11);
      }
      // One undo reverts the whole harmonization (no transpose = single edit).
      expect(undo()).toBe(true);
      expect(store.chords).toEqual([]);
      expect(redo()).toBe(true);
      expect(store.chords.length).toBe(count);
    });

    it('leaves the melody pitches untouched without a transpose', () => {
      addCMajorMelody();
      const before = (store.activeClip?.notes ?? []).map((note) => note.pitch);
      harmonizeFromMelodyCommand({ seed: 0 });
      const after = (store.activeClip?.notes ?? []).map((note) => note.pitch);
      expect(after).toEqual(before);
    });

    it('returns 0 with an empty clip', () => {
      expect(harmonizeFromMelodyCommand()).toBe(0);
      expect(store.chords).toEqual([]);
    });
  });

  describe('generateMotifCommand', () => {
    it('appends notes to the active clip and reverts on undo', () => {
      const before = store.activeClip?.notes.length ?? 0;
      const count = generateMotifCommand({ bars: 1, seed: 0, develop: false });
      expect(count).toBeGreaterThan(0);
      expect(store.activeClip?.notes.length).toBe(before + count);
      expect(undo()).toBe(true);
      expect(store.activeClip?.notes.length).toBe(before);
    });

    it('is deterministic in its seed', () => {
      generateMotifCommand({ bars: 2, seed: 5, mode: 'replace', develop: false });
      const first = (store.activeClip?.notes ?? []).map((n) => [n.pitch, n.startPpq]);
      generateMotifCommand({ bars: 2, seed: 5, mode: 'replace', develop: false });
      const second = (store.activeClip?.notes ?? []).map((n) => [n.pitch, n.startPpq]);
      expect(second).toEqual(first);
    });
  });

  describe('generateDrumsCommand', () => {
    it('lays a drum track on the percussion channel and reverts on undo', () => {
      const trackCount = store.tracks.length;
      const count = generateDrumsCommand({ bars: 2, style: 'standard', seed: 0 });
      expect(count).toBeGreaterThan(0);
      expect(store.tracks.length).toBe(trackCount + 1);
      const drumTrack = store.tracks.find((t) => t.name === 'Drums');
      expect(drumTrack).toBeDefined();
      const drumClip = store.clips.find((c) => c.trackId === drumTrack?.id);
      expect(drumClip?.notes.every((note) => note.channel === 9)).toBe(true);
      // addTrack + addClip + setMidiEvents collapse to a single undo.
      expect(undo()).toBe(true);
      expect(store.tracks.length).toBe(trackCount);
    });
  });

  describe('generateBassLineCommand', () => {
    it('follows the chord track onto a new bass track and reverts on undo', () => {
      setProjectChords([
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
        { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
      ]);
      const trackCount = store.tracks.length;
      const count = generateBassLineCommand({ style: 'root', seed: 0 });
      expect(count).toBeGreaterThan(0);
      expect(store.tracks.length).toBe(trackCount + 1);
      expect(store.tracks.some((t) => t.name === 'Bass')).toBe(true);
      expect(undo()).toBe(true);
      expect(store.tracks.length).toBe(trackCount);
    });

    it('is a no-op without a chord track', () => {
      const trackCount = store.tracks.length;
      expect(generateBassLineCommand()).toBe(0);
      expect(store.tracks.length).toBe(trackCount);
    });
  });

  describe('generateCounterMelodyCommand', () => {
    it('writes a counter line against the melody and reverts on undo', () => {
      addCMajorMelody();
      setProjectChords([{ startPpq: 0, endPpq: 8, rootPc: 0, quality: 0 }]);
      const trackCount = store.tracks.length;
      const count = generateCounterMelodyCommand({ rhythm: 'follow', seed: 0 });
      expect(count).toBeGreaterThan(0);
      expect(store.tracks.length).toBe(trackCount + 1);
      expect(store.tracks.some((t) => t.name === 'Counter melody')).toBe(true);
      expect(undo()).toBe(true);
      expect(store.tracks.length).toBe(trackCount);
    });

    it('returns 0 with an empty melody', () => {
      expect(generateCounterMelodyCommand()).toBe(0);
    });
  });
});
