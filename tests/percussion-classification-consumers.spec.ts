import { spelledKeyOf } from '@libraz/libcantus';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harmonize = vi.hoisted(() => vi.fn());

vi.mock('@libraz/libcantus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@libraz/libcantus')>()),
  harmonizeMelody: harmonize,
}));
vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

import {
  editableDrumTracks,
  harmonicNotes,
  isDrumTrack,
  percussionNoteTest,
  preferredNoteChannel,
} from '@/compose/tracks';
import type { NotatedPart, NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { quantizeToScore } from '@/notation/quantize';
import { setProjectChords } from '@/project/command/chords';
import { addMidiClip } from '@/project/command/clips';
import { harmonizeFromMelodyCommand } from '@/project/command/generate-harmonize';
import { generateMotifCommand } from '@/project/command/generate-motif';
import { clearHistory } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { addTrack, setTrackChordFollow, setTrackPercussion } from '@/project/command/tracks';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorNote, EditorTrack } from '@/project/types';
import { MAJOR_MODE_MASK } from '@/project/types';
import { buildFullScore, fullScorePartTrackIds } from '@/ui/score/score-projection';
import { buildProjectScore } from '@/ui/score/use-score-notation';

const GM2_DRUM_BANK = 120 << 7;

function track(partial: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id: 1,
    name: 'Imported Part',
    color: '#fff',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...partial,
  };
}

function note(id: number, pitch: number, channel: number, startPpq = 0): EditorNote {
  return { id, pitch, velocity: 96, startPpq, durationPpq: 1, channel };
}

function clip(id: number, trackId: number, notes: EditorNote[]): EditorClip {
  return {
    id,
    trackId,
    name: 'Clip',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes,
  };
}

function engravedPitches(part: NotatedPart): number[] {
  return part.measures.flatMap((measure) =>
    measure.voices.flatMap((voice) =>
      voice.events.flatMap((event) => (event.kind === 'note' ? event.pitches : [])),
    ),
  );
}

function engravedChannels(part: NotatedPart): number[] {
  return part.measures.flatMap((measure) =>
    measure.voices.flatMap((voice) =>
      voice.events.flatMap((event) => (event.kind === 'note' ? (event.midiChannels ?? []) : [])),
    ),
  );
}

const scoreOptions = {
  divisionPpq: 1,
  timeSig: { beats: 4, beatUnit: 4 },
  keyFifths: 0,
  clipStartPpq: 0,
  clipLengthPpq: 4,
  displayTransposeSemitones: 2,
};

describe('track-level percussion classification', () => {
  it('does not classify a melodic SF2 track from a channel-10-only map', () => {
    const sf2 = track({
      instrument: {
        kind: 'sf2',
        fontId: 'font',
        bank: 0,
        channelMap: [{ channel: 9, bank: GM2_DRUM_BANK, program: 0 }],
      },
    });
    expect(isDrumTrack(sf2)).toBe(false);
    expect(isDrumTrack(sf2, [note(1, 60, 0), note(2, 64, 0), note(3, 36, 9)])).toBe(false);
    expect(preferredNoteChannel(sf2, [note(1, 60, 0)])).toBe(0);
  });

  it('classifies an SF2 track whose every channel resolves to a kit', () => {
    const channelMap = Array.from({ length: 16 }, (_, channel) => ({
      channel,
      bank: GM2_DRUM_BANK,
      program: 0,
    }));
    expect(isDrumTrack(track({ instrument: { kind: 'sf2', fontId: 'font', channelMap } }))).toBe(
      true,
    );
  });

  it('classifies every note of a drum track and no note of a forced melodic track', () => {
    const kitNotes = [note(1, 36, 0), note(2, 38, 0)];
    const kit = track({ percussion: true });
    expect(kitNotes.every(percussionNoteTest(kit, kitNotes))).toBe(true);
    expect(harmonicNotes(kit, kitNotes)).toEqual([]);

    const melodic = track({ percussion: false });
    const mixed = [note(1, 60, 0), note(2, 36, 9)];
    expect(mixed.some(percussionNoteTest(melodic, mixed))).toBe(false);
    expect(harmonicNotes(melodic, mixed)).toEqual(mixed);
  });

  it('picks the section-drum target from the drum classification, not the name', () => {
    const tracks = [
      track({ id: 1, name: 'Drums', percussion: false }),
      track({ id: 2, name: 'Part 2', instrument: { kind: 'synth-preset', preset: 'drum-kit' } }),
      track({ id: 3, name: 'Part 3' }),
    ];
    const clips = [clip(1, 3, [note(1, 36, 9), note(2, 38, 9)])];
    expect(editableDrumTracks(tracks, clips).map((entry) => entry.id)).toEqual([2, 3]);
    expect(editableDrumTracks([tracks[0]], [])).toEqual([]);
  });
});

describe('score engraving of percussion', () => {
  it('keeps channel-10 drum pitches under display transpose on mixed and drum-only input', () => {
    const drumOnly = quantizeToScore([note(1, 36, 9)], scoreOptions);
    expect(engravedPitches(drumOnly.parts[0])).toEqual([36]);

    const mixed = quantizeToScore([note(1, 60, 0), note(2, 36, 9)], scoreOptions);
    expect(mixed.parts.map((part) => engravedPitches(part))).toEqual([[62], [36]]);

    const xml = serializeMusicXml({ ...drumOnly, transposeSemitones: 2 } as NotatedScore);
    expect(xml).toContain('Bass Drum');
    expect(xml).not.toContain('Acoustic Snare');
  });

  it('engraves a forced-percussion track on the drum map whatever its channel', () => {
    const store = {
      tracks: [track({ id: 1, name: 'Kit', percussion: true })],
      clips: [clip(1, 1, [note(1, 36, 0), note(2, 42, 0, 1)])],
      scoreAnnotations: {},
    };
    const score = buildFullScore(store as never, scoreOptions);
    expect(score.parts).toHaveLength(1);
    expect(score.parts[0].clef).toBe('treble');
    expect(engravedPitches(score.parts[0]).sort()).toEqual([36, 42]);
    expect(new Set(engravedChannels(score.parts[0]))).toEqual(new Set([9]));
    expect(fullScorePartTrackIds(store as never, 0, 4)).toEqual([1]);
  });

  it('engraves the active clip of a forced-percussion track on the drum map', async () => {
    const active = { ...clip(1, 1, [note(1, 36, 0), note(2, 42, 0, 1)]), kind: 'midi' as const };
    const store = {
      tracks: [track({ id: 1, name: 'Kit', percussion: true })],
      clips: [active],
      activeClip: active,
      scoreAnnotations: {},
      displayTransposeSemitones: 2,
      clipStartPpq: 0,
      projectName: '',
      sections: [],
      markers: [],
      tempoSegments: [],
      tempoBpm: 120,
    };
    const score = await buildProjectScore(store as never, {
      divisionPpq: 1,
      timeSig: { beats: 4, beatUnit: 4 },
      measureLenPpq: 4,
      clipLengthPpq: 4,
      keyFifths: 0,
      chordsEnabled: false,
      fullScoreEnabled: false,
      layoutSettings: { barsPerSystem: 0, barsPerPage: 0 },
    });
    expect(engravedPitches(score.parts[0]).sort()).toEqual([36, 42]);
    expect(new Set(engravedChannels(score.parts[0]))).toEqual(new Set([9]));
  });

  it('does not split a forced-melodic track into a separate percussion part', () => {
    const store = {
      tracks: [track({ id: 1, name: 'Lead', percussion: false })],
      clips: [clip(1, 1, [note(1, 60, 0), note(2, 64, 9, 1)])],
      scoreAnnotations: {},
    };
    const score = buildFullScore(store as never, scoreOptions);
    expect(score.parts.map((part) => part.id)).toEqual(['P1']);
    expect(engravedPitches(score.parts[0]).sort()).toEqual([62, 66]);
    expect(engravedChannels(score.parts[0])).not.toContain(9);
    expect(fullScorePartTrackIds(store as never, 0, 4)).toEqual([1]);
  });
});

describe('composition commands on percussion', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    harmonize.mockReset();
  });

  function activeClipOn(trackId: number): void {
    store.clipId = addMidiClip({ trackId, startPpq: 0, lengthPpq: 8 });
    store.refresh();
  }

  const cMajor = { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 };

  it('chord-follow leaves a drum-kit track and channel-10 notes of a melodic track alone', () => {
    const kitId = addTrack({ name: 'Part A' });
    activeClipOn(kitId);
    for (const pitch of [36, 38, 42]) addNote({ pitch, startPpq: 0, durationPpq: 1, channel: 0 });
    store.tracks = store.tracks.map((entry) =>
      entry.id === kitId
        ? { ...entry, instrument: { kind: 'synth-preset', preset: 'drum-kit' } }
        : entry,
    );
    setProjectChords([cMajor]);
    setTrackChordFollow(kitId, 'chordTones');

    const padId = addTrack({ name: 'Pad' });
    activeClipOn(padId);
    for (const pitch of [60, 64, 67]) addNote({ pitch, startPpq: 0, durationPpq: 1 });
    addNote({ pitch: 38, startPpq: 0, durationPpq: 1, channel: 9 });
    setTrackChordFollow(padId, 'chordTones');

    setProjectChords([{ ...cMajor, rootPc: 4, quality: 1 }]);

    const pitchesOf = (trackId: number) =>
      (store.clipsByTrack.get(trackId) ?? []).flatMap((entry) =>
        entry.notes.map((n) => [n.channel, n.pitch]),
      );
    expect(pitchesOf(kitId).map(([, pitch]) => pitch)).toEqual([36, 38, 42]);
    const pad = pitchesOf(padId);
    expect(pad.find(([channel]) => channel === 9)?.[1]).toBe(38);
    expect(pad.filter(([channel]) => channel === 0).map(([, pitch]) => pitch)).not.toEqual([
      60, 64, 67,
    ]);
  });

  it('harmonize transpose moves only the melody notes, not channel-10 hits', () => {
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    addNote({ pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 });
    harmonize.mockImplementation(() => ({
      transposeSemitones: 5,
      key: spelledKeyOf({ rootPc: 0, modeMask12: MAJOR_MODE_MASK }),
      chords: [{ rootPc: 0, quality: 'maj' as const, startBeat: 0 }],
      melodyRoles: [],
    }));

    harmonizeFromMelodyCommand({ transpose: true });

    const notes = store.activeClip?.notes ?? [];
    expect(notes.filter((n) => n.channel === 0).map((n) => n.pitch)).toEqual([65, 69]);
    expect(notes.filter((n) => n.channel === 9).map((n) => n.pitch)).toEqual([36]);
  });

  it('refuses a motif into a drum-track clip without touching it', () => {
    const kitId = addTrack({ name: 'Part B' });
    setTrackPercussion(kitId, true);
    activeClipOn(kitId);
    addNote({ pitch: 36, startPpq: 0, durationPpq: 1 });
    const before = store.activeClip?.notes.map((n) => n.pitch);

    expect(() => generateMotifCommand({ bars: 1, mode: 'replace', develop: false })).toThrow(
      /percussion/,
    );
    expect(store.activeClip?.notes.map((n) => n.pitch)).toEqual(before);
  });
});
