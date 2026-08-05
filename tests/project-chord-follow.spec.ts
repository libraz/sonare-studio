import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chordAt,
  chordFollowUpdates,
  shortestPitchClassDelta,
  snapPitchToPitchClasses,
} from '@/project/chord-follow';
import { chordTonePitchClasses, type EditorChordSymbol } from '@/project/chords';
import {
  addMidiClip,
  addNote,
  addTrack,
  clearHistory,
  setClipLoop,
  setProjectChords,
  setTrackChordFollow,
  setTrackPercussion,
  undo,
} from '@/project/commands';
import type { ProjectDocument } from '@/project/serialization';
import { loadProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';

const wasmModule = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  wasmModule.current = fakeModule as unknown as Record<string, unknown>;
  return { ensureWasm: async () => wasmModule.current };
});

/** C major over bar 1, A minor over bar 2. */
const cMajor: EditorChordSymbol = { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 };
const aMinor: EditorChordSymbol = { startPpq: 4, endPpq: 8, rootPc: 9, quality: 1 };

describe('chord follow mapping', () => {
  it('takes the shorter way around the circle', () => {
    expect(shortestPitchClassDelta(0, 2)).toBe(2);
    expect(shortestPitchClassDelta(0, 10)).toBe(-2);
    expect(shortestPitchClassDelta(0, 6)).toBe(6);
    expect(shortestPitchClassDelta(11, 0)).toBe(1);
  });

  it('lists the tones a chord asks for, including its slash bass', () => {
    expect(chordTonePitchClasses(cMajor)).toEqual([0, 4, 7]);
    expect(chordTonePitchClasses({ ...cMajor, quality: 4, extensions: [9] })).toEqual([
      0, 4, 7, 9, 10,
    ]);
    expect(chordTonePitchClasses({ ...cMajor, bassPc: 5 })).toEqual([0, 4, 5, 7]);
  });

  it('snaps a pitch to the nearest allowed class, ties upward', () => {
    // D (62) is one semitone from both C# and D#; the tie goes up.
    expect(snapPitchToPitchClasses(62, [1, 3])).toBe(63);
    // D is two semitones from both C and E; the upward tie makes it E.
    expect(snapPitchToPitchClasses(62, [0, 4, 7])).toBe(64);
    expect(snapPitchToPitchClasses(60, [])).toBe(60);
  });

  it('resolves the chord governing a position', () => {
    expect(chordAt([cMajor, aMinor], 3.9)?.rootPc).toBe(0);
    expect(chordAt([cMajor, aMinor], 4)?.rootPc).toBe(9);
    expect(chordAt([cMajor, aMinor], 8)).toBeNull();
  });

  it('transposes by the root change and lands on the new chord', () => {
    // C major -> F major: everything moves up a fourth and stays a chord tone.
    const updates = chordFollowUpdates(
      [
        { id: 1, pitch: 60, timelinePpq: 0 },
        { id: 2, pitch: 64, timelinePpq: 1 },
        { id: 3, pitch: 67, timelinePpq: 2 },
      ],
      [cMajor],
      [{ ...cMajor, rootPc: 5 }],
    );

    expect(updates).toEqual([
      { id: 1, pitch: 65 },
      { id: 2, pitch: 69 },
      { id: 3, pitch: 72 },
    ]);
  });

  it('keeps notes outside every chord region untouched', () => {
    expect(chordFollowUpdates([{ id: 1, pitch: 60, timelinePpq: 20 }], [cMajor], [aMinor])).toEqual(
      [],
    );
  });

  it('pulls every note onto the root in root mode', () => {
    const updates = chordFollowUpdates(
      [
        { id: 1, pitch: 40, timelinePpq: 0 },
        { id: 2, pitch: 45, timelinePpq: 2 },
      ],
      [cMajor],
      [{ ...cMajor, rootPc: 7 }],
      'root',
    );

    // Both land on a G, each near where it was.
    expect(updates.map((update) => update.pitch % 12)).toEqual([7, 7]);
  });
});

describe('chord follow through the chord command', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    await store.init();
    clearHistory();
  });

  /** One bar of a C major triad on a fresh MIDI track. */
  function triadTrack(): { trackId: number; noteIds: number[] } {
    const trackId = addTrack({ name: 'Pad' });
    const clipId = addMidiClip({ trackId, lengthPpq: 8, startPpq: 0 });
    store.clipId = clipId;
    store.refresh();
    const noteIds = [60, 64, 67].map((pitch) =>
      addNote({ pitch, startPpq: 0, durationPpq: 4, velocity: 96 }),
    );
    return { trackId, noteIds };
  }

  function pitches(noteIds: readonly number[]): number[] {
    return noteIds.map((id) => store.notes.find((note) => note.id === id)?.pitch ?? -1);
  }

  it('re-voices a following track with the chord change, in one undo step', () => {
    const { trackId, noteIds } = triadTrack();
    setProjectChords([cMajor]);
    setTrackChordFollow(trackId, 'chordTones');

    setProjectChords([{ ...cMajor, rootPc: 5 }]);

    expect(pitches(noteIds)).toEqual([65, 69, 72]);
    expect(undo()).toBe(true);
    expect(pitches(noteIds)).toEqual([60, 64, 67]);
    expect(store.chords[0].rootPc).toBe(0);
  });

  it('leaves tracks that do not follow alone', () => {
    const { noteIds } = triadTrack();
    setProjectChords([cMajor]);

    setProjectChords([{ ...cMajor, rootPc: 5 }]);

    expect(pitches(noteIds)).toEqual([60, 64, 67]);
  });

  it('never follows percussion tracks or looping clips', () => {
    const { trackId, noteIds } = triadTrack();
    setProjectChords([cMajor]);
    setTrackChordFollow(trackId, 'chordTones');
    setTrackPercussion(trackId, true);

    setProjectChords([{ ...cMajor, rootPc: 5 }]);
    expect(pitches(noteIds)).toEqual([60, 64, 67]);

    setTrackPercussion(trackId, null);
    setClipLoop(store.clipId, true, 4);
    setProjectChords([{ ...cMajor, rootPc: 7 }]);
    expect(pitches(noteIds)).toEqual([60, 64, 67]);
  });

  it('persists the follow mode with the track', async () => {
    const { trackId } = triadTrack();
    setTrackChordFollow(trackId, 'root');

    expect(store.tracks.find((track) => track.id === trackId)?.chordFollow).toBe('root');

    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    expect(doc.tracks.find((track) => track.name === 'Pad')?.chordFollow).toBe('root');

    await loadProjectDocument(doc);
    const reloaded = store.tracks.find((track) => track.name === 'Pad');
    expect(reloaded?.chordFollow).toBe('root');

    setTrackChordFollow(reloaded?.id ?? -1, null);
    expect(store.tracks.find((track) => track.name === 'Pad')?.chordFollow).toBeUndefined();
  });
});

describe('chord follow entry point', () => {
  const headers = readFileSync(
    resolve(process.cwd(), 'src/components/arrangement/TrackHeaderList.vue'),
    'utf8',
  );

  it('offers the three modes from the track header menu', () => {
    expect(headers).toContain("id: 'chord-follow-off'");
    expect(headers).toContain("setTrackChordFollow(track.id, 'chordTones')");
    expect(headers).toContain("setTrackChordFollow(track.id, 'root')");
  });

  it('labels the modes in every locale', () => {
    for (const bundle of [en, ja]) {
      const header = bundle.shell.arrangement.trackHeader;
      expect(header.chordFollow.length).toBeGreaterThan(0);
      expect(header.chordFollowOff.length).toBeGreaterThan(0);
      expect(header.chordFollowChordTones.length).toBeGreaterThan(0);
      expect(header.chordFollowRoot.length).toBeGreaterThan(0);
    }
  });
});
