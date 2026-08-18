import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectChords } from '@/project/command/chords';
import { moveClip, trimClip } from '@/project/command/clips-editing';
import { setClipLoop, setTrackFrozen } from '@/project/command/clips-state';
import { generateBassLineCommand } from '@/project/command/generate-bass';
import { generateCounterMelodyCommand } from '@/project/command/generate-counter-melody';
import {
  generateDrumsCommand,
  MAX_DRUM_DIFFICULTY,
  MIN_DRUM_DIFFICULTY,
} from '@/project/command/generate-drums';
import { harmonizeFromMelodyCommand } from '@/project/command/generate-harmonize';
import { generateMotifCommand } from '@/project/command/generate-motif';
import { clearHistory, redo, undo } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { getProject, useProjectStore } from '@/project/store';
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

  it('rejects motif and harmonize writes on a frozen active track without partial changes', () => {
    addCMajorMelody();
    setProjectChords([{ startPpq: 0, endPpq: 8, rootPc: 0, quality: 0 }]);
    setTrackFrozen(store.activeTrackId, { assetId: 'frozen-melody' });
    clearHistory();
    const nativeBefore = getProject().toJson();
    const mirrorBefore = JSON.stringify({ clips: store.clips, chords: store.chords });

    expect(() => generateMotifCommand({ bars: 1, mode: 'replace', develop: false })).toThrow(
      /unfreeze/i,
    );
    expect(() => harmonizeFromMelodyCommand({ transpose: true, seed: 0 })).toThrow(/unfreeze/i);
    expect(getProject().toJson()).toBe(nativeBefore);
    expect(JSON.stringify({ clips: store.clips, chords: store.chords })).toBe(mirrorBefore);
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

    it('harmonizes a moved/trimmed clip locally and merges into its timeline range', () => {
      setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
      addCMajorMelody();
      const clipId = store.clipId;
      moveClip(clipId, 32);
      trimClip(clipId, 34, 6); // sourceOffsetPpq = 2; audible notes are source 2..8.
      clearHistory();

      const count = harmonizeFromMelodyCommand({ harmonicRhythm: 2, seed: 0 });

      expect(count).toBeGreaterThan(0);
      expect(store.chords[0]).toEqual({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 });
      const generated = store.chords.slice(1);
      expect(generated).toHaveLength(count);
      expect(generated.every((chord) => chord.startPpq >= 34 && chord.endPpq <= 40)).toBe(true);
      expect(store.chords.some((chord) => chord.startPpq > 0 && chord.startPpq < 34)).toBe(false);

      expect(undo()).toBe(true);
      expect(store.chords).toEqual([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
    });

    it('returns 0 with an empty clip', () => {
      expect(harmonizeFromMelodyCommand()).toBe(0);
      expect(store.chords).toEqual([]);
    });

    it('expands looped audible melody and derives the default rhythm from 3/4', () => {
      // Two 3/4 bars of source, so the loop alternates harmony bar by bar. A run
      // of the same chord is reported as one span, so a loop whose bars all
      // imply the same chord says nothing about the grid it was cut on.
      [60, 64, 67, 62, 65, 69].forEach((pitch, index) => {
        addNote({ pitch, startPpq: index, durationPpq: 1 });
      });
      setClipLoop(store.clipId, true, 6);
      store.timeSignatures = [{ startPpq: 0, numerator: 3, denominator: 4 }];

      const count = harmonizeFromMelodyCommand({ seed: 0 });

      expect(count).toBeGreaterThan(1);
      expect(store.chords[0]).toMatchObject({ startPpq: 0, endPpq: 3 });
      expect(store.chords.every((chord) => chord.startPpq % 3 === 0)).toBe(true);
      // The chords cover the looped clip, not just its six-beat source window.
      expect(store.chords.at(-1)?.endPpq).toBe(store.activeClip?.lengthPpq);
    });

    it('restarts the default harmonization grid at a meter change', () => {
      // C major, then a dominant bar and a closing bar of three beats each: the
      // 3/4 bar line is only visible in the output when the harmony moves
      // across it, since a run of the same chord is reported as one span.
      [60, 62, 64, 65, 67, 71, 62, 65, 69, 60].forEach((pitch, index) => {
        addNote({ pitch, startPpq: index, durationPpq: 1 });
      });
      store.timeSignatures = [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 4, numerator: 3, denominator: 4 },
      ];

      harmonizeFromMelodyCommand({ seed: 0 });

      expect(store.chords.some((chord) => chord.startPpq < 4 && chord.endPpq > 4)).toBe(false);
      expect(store.chords.some((chord) => chord.startPpq >= 4 && chord.endPpq <= 7)).toBe(true);
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

    it('develops against the absolute bar-9 chord context', () => {
      setProjectChords([
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
        { startPpq: 32, endPpq: 36, rootPc: 6, quality: 0 },
      ]);
      moveClip(store.clipId, 32);

      const count = generateMotifCommand({ bars: 1, seed: 2, mode: 'replace', develop: true });

      expect(count).toBeGreaterThan(0);
      // Development pulls the structural onsets — the bar lines — onto a chord
      // tone of the chord sounding there and keeps the notes between them in
      // the key. The clip starts at bar 9, so its bar line spells F# major
      // rather than the C major sounding at the song start.
      const fSharpMajorPitchClasses = new Set([6, 10, 1]);
      const cMajorScalePitchClasses = new Set([0, 2, 4, 5, 7, 9, 11]);
      const notes = store.activeClip?.notes ?? [];
      const onBarLine = notes.filter((note) => note.startPpq % 4 === 0);
      expect(onBarLine.length).toBeGreaterThan(0);
      expect(onBarLine.every((note) => fSharpMajorPitchClasses.has(note.pitch % 12))).toBe(true);
      expect(
        notes
          .filter((note) => note.startPpq % 4 !== 0)
          .every((note) => cMajorScalePitchClasses.has(note.pitch % 12)),
      ).toBe(true);
    });

    it('does not append hidden notes beyond a full loop source window', () => {
      [60, 64, 67, 72].forEach((pitch, index) => {
        addNote({ pitch, startPpq: index, durationPpq: 1 });
      });
      setClipLoop(store.clipId, true, 4);
      const before = store.activeClip?.notes.length;

      expect(generateMotifCommand({ bars: 1, mode: 'append', develop: false })).toBe(0);
      expect(store.activeClip?.notes.length).toBe(before);
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

    it('reports the unsupported meter instead of writing a 4/4 drum grid', () => {
      store.timeSignatures = [{ startPpq: 0, numerator: 3, denominator: 4 }];
      expect(() => generateDrumsCommand({ bars: 2 })).toThrow(/supports 4\/4 bars only/);
    });

    /**
     * The ceiling rejects what the density asked for rather than scaling it, and
     * it reads the tempo: what a beginner sustains at a walking tempo is not
     * what they sustain twice as fast. A ceiling that ignored the tempo would
     * make the two dials the same dial under different names.
     */
    it('thins a busy groove to what the difficulty ceiling sustains at the tempo', () => {
      const hits = (difficulty: number | undefined) => {
        const params = {
          bars: 2,
          style: 'funk' as const,
          section: 'chorus' as const,
          density: 0.9,
          seed: 3,
          ...(difficulty === undefined ? {} : { difficulty }),
        };
        const count = generateDrumsCommand(params);
        expect(undo()).toBe(true);
        return count;
      };

      store.tempoBpm = 200;
      const easy = hits(MIN_DRUM_DIFFICULTY);
      const hard = hits(MAX_DRUM_DIFFICULTY);
      expect(easy).toBeLessThan(hard);
      // No ceiling asked for leaves the groove as the density wrote it.
      expect(hits(undefined)).toBe(hard);

      // The same ceiling holds back less when there is more time between strokes.
      store.tempoBpm = 80;
      expect(hits(MIN_DRUM_DIFFICULTY)).toBeGreaterThan(easy);
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
