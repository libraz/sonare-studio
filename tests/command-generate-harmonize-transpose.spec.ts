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
import { clearHistory, undo } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { addTrack, setTrackChordFollow, setTrackPercussion } from '@/project/command/tracks';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

const key = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

function result(shift: number, resolvedKey = key) {
  return {
    transposeSemitones: shift,
    key: spelledKeyOf(resolvedKey),
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
    expect(segmentInputs.map((input) => input.ts)).toEqual([
      { numerator: 4, denominator: 4 },
      { numerator: 3, denominator: 4 },
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

  it('passes each meter to its range and threads inferred keys after the first range', () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    addNote({ pitch: 64, startPpq: 3, durationPpq: 1 });
    store.scaleHighlight = { enabled: false, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    store.timeSignatures = [
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 3, numerator: 6, denominator: 8 },
    ];
    const inferred = { rootPc: 4, modeMask12: MAJOR_MODE_MASK };
    let segmentCall = 0;
    harmonize.mockImplementation((input) => {
      if (input.placement.transposeSearch) return result(0, inferred);
      segmentCall += 1;
      return result(0, inferred);
    });

    harmonizeFromMelodyCommand();

    const segmentInputs = harmonize.mock.calls.map(([input]) => input);
    expect(segmentCall).toBe(2);
    expect(segmentInputs.map((input) => input.ts)).toEqual([
      { numerator: 3, denominator: 4 },
      { numerator: 6, denominator: 8 },
    ]);
    expect(segmentInputs[0]).not.toHaveProperty('key');
    expect(segmentInputs[1]?.key).toEqual(inferred);
  });

  it('places chord slots on the project bar grid when the clip starts mid-bar', () => {
    const trackId = addTrack({ name: 'Lead' });
    const clipId = addMidiClip({ trackId, startPpq: 2, lengthPpq: 8 });
    store.clipId = clipId;
    store.refresh();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    addNote({ pitch: 64, startPpq: 3, durationPpq: 1 });
    harmonize.mockImplementation(() => ({
      ...result(0),
      chords: [
        { rootPc: 0, quality: 'maj' as const, startBeat: 0 },
        { rootPc: 7, quality: 'maj' as const, startBeat: 4 },
      ],
    }));

    harmonizeFromMelodyCommand();

    // The melody reaches the harmonizer on the bar grid (clip start 2 -> +2).
    expect(
      harmonize.mock.calls[0][0].melody.map((note: { startBeat: number }) => note.startBeat),
    ).toEqual([2, 5]);
    expect(store.chords.map((chord) => [chord.startPpq, chord.endPpq])).toEqual([
      [2, 4],
      [4, 6],
    ]);
  });

  it('refuses a percussion clip', () => {
    const trackId = addTrack({ name: 'Kit' });
    setTrackPercussion(trackId, true);
    store.clipId = addMidiClip({ trackId, startPpq: 0, lengthPpq: 4 });
    store.refresh();
    addNote({ pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 });

    expect(() => harmonizeFromMelodyCommand()).toThrow('percussion');
    expect(harmonize).not.toHaveBeenCalled();
  });

  it('drops channel-10 notes of a melodic track from the melody', () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    addNote({ pitch: 36, startPpq: 1, durationPpq: 1, channel: 9 });
    harmonize.mockImplementation(() => result(0));

    harmonizeFromMelodyCommand();

    expect(harmonize.mock.calls[0][0].melody.map((note: { pitch: number }) => note.pitch)).toEqual([
      60,
    ]);
  });

  it('re-voices a Follow chord track part in the same undo step as the harmonized chords', () => {
    const padTrack = addTrack({ name: 'Pad' });
    const padClip = addMidiClip({ trackId: padTrack, startPpq: 0, lengthPpq: 8 });
    store.clipId = padClip;
    store.refresh();
    const padNoteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 4 });
    setProjectChords([{ startPpq: 0, endPpq: 8, rootPc: 0, quality: 0 }]);
    setTrackChordFollow(padTrack, 'root');
    const leadTrack = addTrack({ name: 'Lead' });
    store.clipId = addMidiClip({ trackId: leadTrack, startPpq: 0, lengthPpq: 8 });
    store.refresh();
    addNote({ pitch: 65, startPpq: 0, durationPpq: 1 });
    harmonize.mockImplementation(() => ({
      ...result(0),
      chords: [{ rootPc: 5, quality: 'maj' as const, startBeat: 0 }],
    }));

    harmonizeFromMelodyCommand();
    const padPitch = () =>
      store.clips.find((clip) => clip.id === padClip)?.notes.find((note) => note.id === padNoteId)
        ?.pitch;
    expect(padPitch()).not.toBe(60);

    expect(undo()).toBe(true);
    expect(padPitch()).toBe(60);
    expect(store.chords[0].rootPc).toBe(0);
  });
});
