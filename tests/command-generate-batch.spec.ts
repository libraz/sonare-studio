import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneScoreAnnotations } from '@/project/annotations';
import { setProjectChords } from '@/project/command/chords';
import { setTrackFrozen } from '@/project/command/clips-state';
import { generateTracksBatchCommand } from '@/project/command/generate-batch';
import { clearHistory, redo, undo } from '@/project/command/history';
import {
  addMidiClip,
  addNote,
  addTrack,
  renameTrack,
  setActiveClip,
  setNoteAnnotation,
  setTrackChordFollow,
} from '@/project/commands';
import {
  CURRENT_ALGORITHM_VERSION,
  MAX_GENERATION_SEED,
  normalizeGenerationSeed,
  partForTrack,
  partSeed,
  sanitizeProvenance,
} from '@/project/generation';
import { createDefaultStrip } from '@/project/mixer';
import { getProject, useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const FOUR_CHORDS = [
  { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
  { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
  { startPpq: 8, endPpq: 12, rootPc: 9, quality: 0 },
  { startPpq: 12, endPpq: 16, rootPc: 5, quality: 0 },
];

describe('generateTracksBatchCommand', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('generates multiple parts in a single undoable transaction', () => {
    setProjectChords(FOUR_CHORDS);
    const trackCount = store.tracks.length;
    const written = generateTracksBatchCommand([
      { part: 'drums', params: { bars: 4 }, target: { kind: 'new' } },
      { part: 'bass', params: {}, target: { kind: 'new' } },
      { part: 'backing', params: {}, target: { kind: 'new' } },
    ]);
    expect(written).toBe(3);
    expect(store.tracks.length).toBe(trackCount + 3);
    for (const name of ['Drums', 'Bass', 'Backing']) {
      expect(store.tracks.some((track) => track.name === name)).toBe(true);
    }
    // One undo removes every generated part at once.
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount);
    expect(redo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount + 3);
  });

  it('tiles chords to the requested shorter arrangement while keeping part bars explicit', () => {
    setProjectChords(FOUR_CHORDS);
    const trackCount = store.tracks.length;
    const written = generateTracksBatchCommand(
      [
        { part: 'motif', params: { bars: 1 }, target: { kind: 'new' } },
        { part: 'drums', params: { bars: 1 }, target: { kind: 'new' } },
        { part: 'bass', params: {}, target: { kind: 'new' } },
        { part: 'backing', params: {}, target: { kind: 'new' } },
      ],
      { targetBars: 2 },
    );

    expect(written).toBe(4);
    expect(store.chords).toEqual(FOUR_CHORDS.slice(0, 2));
    expect(
      store.clips.find((clip) => clip.trackId === store.tracks.find((t) => t.name === 'Motif')?.id)
        ?.lengthPpq,
    ).toBe(4);
    expect(
      store.clips.find((clip) => clip.trackId === store.tracks.find((t) => t.name === 'Drums')?.id)
        ?.lengthPpq,
    ).toBe(4);
    expect(
      store.clips.find((clip) => clip.trackId === store.tracks.find((t) => t.name === 'Bass')?.id)
        ?.lengthPpq,
    ).toBe(8);
    expect(
      store.clips.find(
        (clip) => clip.trackId === store.tracks.find((t) => t.name === 'Backing')?.id,
      )?.lengthPpq,
    ).toBe(8);

    expect(undo()).toBe(true);
    expect(store.tracks).toHaveLength(trackCount);
    expect(store.chords).toEqual(FOUR_CHORDS);
  });

  it('tiles a longer target by repeating the progression and extends chord-based clips', () => {
    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand(
      [
        { part: 'bass', params: {}, target: { kind: 'new' } },
        { part: 'backing', params: {}, target: { kind: 'new' } },
      ],
      { targetBars: 6 },
    );

    expect(store.chords.map((chord) => chord.rootPc)).toEqual([0, 7, 9, 5, 0, 7]);
    expect(store.chords.at(-1)?.endPpq).toBe(24);
    for (const name of ['Bass', 'Backing']) {
      const track = store.tracks.find((entry) => entry.name === name);
      expect(track).toBeDefined();
      expect(store.clips.find((clip) => clip.trackId === track?.id)?.lengthPpq).toBe(24);
    }
  });

  it('clips a repeated chord at the final target boundary', () => {
    setProjectChords([
      { startPpq: 0, endPpq: 6, rootPc: 0, quality: 0 },
      { startPpq: 6, endPpq: 16, rootPc: 7, quality: 0 },
    ]);
    generateTracksBatchCommand([{ part: 'backing', params: {}, target: { kind: 'new' } }], {
      targetBars: 3,
    });

    expect(store.chords).toEqual([
      { startPpq: 0, endPpq: 6, rootPc: 0, quality: 0 },
      { startPpq: 6, endPpq: 12, rootPc: 7, quality: 0 },
    ]);
    const backing = store.tracks.find((track) => track.name === 'Backing');
    expect(store.clips.find((clip) => clip.trackId === backing?.id)?.lengthPpq).toBe(12);
  });

  it('keeps chord-follow updates in the same whole-generation undo step', () => {
    const activeClip = store.activeClip;
    if (activeClip === null) throw new Error('missing active clip fixture');
    const noteId = addNote({ pitch: 60, startPpq: 4, durationPpq: 1 });
    setTrackChordFollow(activeClip.trackId, 'root');
    setProjectChords([
      { startPpq: 2, endPpq: 6, rootPc: 0, quality: 0 },
      { startPpq: 6, endPpq: 10, rootPc: 7, quality: 0 },
    ]);
    clearHistory();

    generateTracksBatchCommand([{ part: 'backing', params: {}, target: { kind: 'new' } }], {
      targetBars: 2,
    });

    expect(store.notes.find((note) => note.id === noteId)?.pitch).toBe(55);
    expect(undo()).toBe(true);
    expect(store.notes.find((note) => note.id === noteId)?.pitch).toBe(60);
    expect(store.chords).toEqual([
      { startPpq: 2, endPpq: 6, rootPc: 0, quality: 0 },
      { startPpq: 6, endPpq: 10, rootPc: 7, quality: 0 },
    ]);
  });

  it('does not re-voice a chord-follow replacement after rebuilding its target plan', () => {
    const noteShape = (trackId: number) =>
      store.clips
        .find((clip) => clip.trackId === trackId)
        ?.notes.map(({ pitch, startPpq, durationPpq, velocity, channel }) => ({
          pitch,
          startPpq,
          durationPpq,
          velocity,
          channel,
        }));
    const latestBackingId = (): number => {
      const track = [...store.tracks]
        .reverse()
        .find((entry) => entry.generated?.part === 'backing');
      if (track === undefined) throw new Error('missing backing fixture');
      return track.id;
    };

    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([{ part: 'backing', params: {}, target: { kind: 'new' } }], {
      targetBars: 6,
    });
    const expectedId = latestBackingId();
    const expected = noteShape(expectedId);

    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([{ part: 'backing', params: {}, target: { kind: 'new' } }], {
      targetBars: 4,
    });
    const followerId = latestBackingId();
    const oldFollower = noteShape(followerId);
    generateTracksBatchCommand([{ part: 'backing', params: {}, target: { kind: 'new' } }], {
      targetBars: 4,
    });
    const plainId = latestBackingId();
    const oldPlain = noteShape(plainId);
    setTrackChordFollow(followerId, 'root');
    clearHistory();

    expect(
      generateTracksBatchCommand(
        [
          { part: 'backing', params: {}, target: { kind: 'replaceTrack', trackId: followerId } },
          { part: 'backing', params: {}, target: { kind: 'replaceTrack', trackId: plainId } },
        ],
        { targetBars: 6 },
      ),
    ).toBe(2);
    expect(noteShape(followerId)).toEqual(expected);
    expect(noteShape(plainId)).toEqual(expected);

    expect(undo()).toBe(true);
    expect(store.chords).toEqual(FOUR_CHORDS);
    expect(noteShape(followerId)).toEqual(oldFollower);
    expect(noteShape(plainId)).toEqual(oldPlain);
  });

  it('rebuilds motif clip merges after chord-follow revoice and undoes them atomically', () => {
    const followerClip = store.activeClip;
    if (followerClip === null) throw new Error('missing active clip fixture');
    const plainTrackId = addTrack({ name: 'Plain motif' });
    const plainClipId = addMidiClip({ trackId: plainTrackId, lengthPpq: 32 });
    const noteShape = (clipId: number) =>
      store.clips
        .find((clip) => clip.id === clipId)
        ?.notes.map(({ pitch, startPpq, durationPpq, velocity, channel }) => ({
          pitch,
          startPpq,
          durationPpq,
          velocity,
          channel,
        }));

    setActiveClip(followerClip.id);
    addNote({ pitch: 60, startPpq: 4, durationPpq: 1 });
    setActiveClip(plainClipId);
    addNote({ pitch: 60, startPpq: 4, durationPpq: 1 });
    setTrackChordFollow(followerClip.trackId, 'root');
    setProjectChords([
      { startPpq: 2, endPpq: 6, rootPc: 0, quality: 0 },
      { startPpq: 6, endPpq: 10, rootPc: 7, quality: 0 },
    ]);
    clearHistory();

    setActiveClip(followerClip.id);
    generateTracksBatchCommand(
      [
        {
          part: 'motif',
          params: { bars: 1, seed: 0, develop: true },
          target: { kind: 'clip', mode: 'append' },
        },
      ],
      { targetBars: 3 },
    );
    const followerResult = noteShape(followerClip.id);
    const followerGenerated = followerResult?.filter((note) => note.startPpq >= 5);
    expect(followerResult?.find((note) => note.startPpq === 4)?.pitch).toBe(55);
    expect(followerGenerated?.length).toBeGreaterThan(0);
    expect(undo()).toBe(true);
    expect(store.chords).toEqual([
      { startPpq: 2, endPpq: 6, rootPc: 0, quality: 0 },
      { startPpq: 6, endPpq: 10, rootPc: 7, quality: 0 },
    ]);
    expect(noteShape(followerClip.id)?.find((note) => note.startPpq === 4)?.pitch).toBe(60);

    setActiveClip(plainClipId);
    generateTracksBatchCommand(
      [
        {
          part: 'motif',
          params: { bars: 1, seed: 0, develop: true },
          target: { kind: 'clip', mode: 'append' },
        },
      ],
      { targetBars: 3 },
    );
    const plainResult = noteShape(plainClipId);
    expect(plainResult?.filter((note) => note.startPpq >= 5)).toEqual(followerGenerated);
    expect(plainResult?.find((note) => note.startPpq === 4)?.pitch).toBe(60);
    expect(undo()).toBe(true);
    expect(store.chords).toEqual([
      { startPpq: 2, endPpq: 6, rootPc: 0, quality: 0 },
      { startPpq: 6, endPpq: 10, rootPc: 7, quality: 0 },
    ]);
    expect(noteShape(plainClipId)?.find((note) => note.startPpq === 4)?.pitch).toBe(60);
  });

  it('keeps motif and drums available at a requested length without chords', () => {
    const written = generateTracksBatchCommand(
      [
        { part: 'motif', params: { bars: 1 }, target: { kind: 'new' } },
        { part: 'drums', params: { bars: 1 }, target: { kind: 'new' } },
      ],
      { targetBars: 2 },
    );

    expect(written).toBe(2);
    expect(store.chords).toEqual([]);
    expect(store.tracks.map((track) => track.name)).toEqual(['Piano', 'Motif', 'Drums']);
  });

  it('rejects invalid whole lengths and non-four-four target ranges before writing', () => {
    setProjectChords(FOUR_CHORDS);
    const before = store.chords.map((chord) => ({ ...chord }));
    for (const targetBars of [0, 257, 1.5]) {
      expect(() =>
        generateTracksBatchCommand([{ part: 'bass', params: {}, target: { kind: 'new' } }], {
          targetBars,
        }),
      ).toThrow(RangeError);
      expect(store.chords).toEqual(before);
    }

    store.timeSignatures = [{ startPpq: 0, numerator: 3, denominator: 4 }];
    expect(() =>
      generateTracksBatchCommand([{ part: 'bass', params: {}, target: { kind: 'new' } }], {
        targetBars: 1,
      }),
    ).toThrow(/4\/4/);
    expect(store.chords).toEqual(before);
  });

  it('skips empty generations', () => {
    // No chords: bass and backing are no-ops; only drums lands.
    const trackCount = store.tracks.length;
    const written = generateTracksBatchCommand([
      { part: 'drums', params: { bars: 2 }, target: { kind: 'new' } },
      { part: 'bass', params: {}, target: { kind: 'new' } },
    ]);
    expect(written).toBe(1);
    expect(store.tracks.length).toBe(trackCount + 1);
  });

  it('keeps available parts when an empty project has no counter melody source', async () => {
    await store.loadDocument(createTemplate('empty'));
    setProjectChords(FOUR_CHORDS);
    const written = generateTracksBatchCommand([
      { part: 'motif', params: { bars: 4 }, target: { kind: 'new' } },
      { part: 'drums', params: { bars: 4 }, target: { kind: 'new' } },
      { part: 'bass', params: {}, target: { kind: 'new' } },
      { part: 'counter', params: {}, target: { kind: 'new' } },
      { part: 'backing', params: {}, target: { kind: 'new' } },
    ]);
    expect(written).toBe(4);
    expect(store.tracks.map((track) => track.name)).toEqual(['Motif', 'Drums', 'Bass', 'Backing']);
    expect(undo()).toBe(true);
    expect(store.tracks).toHaveLength(0);
  });

  it('replaces an existing generated track in the same undo step', () => {
    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    expect(drums).toBeDefined();
    const trackCount = store.tracks.length;

    const written = generateTracksBatchCommand([
      {
        part: 'drums',
        params: { bars: 2, style: 'funk' },
        target: { kind: 'replaceTrack', trackId: drums?.id ?? -1 },
      },
    ]);
    expect(written).toBe(1);
    // Replace nets zero and preserves the existing track identity.
    expect(store.tracks.length).toBe(trackCount);
    const drumTracks = store.tracks.filter((track) => track.name === 'Drums');
    expect(drumTracks).toHaveLength(1);
    expect(drumTracks[0]?.id).toBe(drums?.id);

    // The replacement reverts in one undo, restoring its original content.
    expect(undo()).toBe(true);
    expect(store.tracks.filter((track) => track.name === 'Drums')[0]?.id).toBe(drums?.id);
  });

  it('preserves all track-scoped state and references while replacing content', () => {
    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    expect(drums).toBeDefined();
    const trackId = drums?.id as number;
    const oldClipIds = store.clips
      .filter((clip) => clip.trackId === trackId)
      .map((clip) => clip.id);
    const oldClip = store.clips.find((clip) => clip.id === oldClipIds[0]);
    const oldNoteId = oldClip?.notes[0]?.id;
    if (oldClip === undefined || oldNoteId === undefined) {
      throw new Error('missing generated clip note fixture');
    }
    setNoteAnnotation(oldClip.id, oldNoteId, { dynamics: 'f' });
    const unrelatedClip = store.clips.find((clip) => clip.trackId !== trackId);
    if (unrelatedClip === undefined) throw new Error('missing unrelated clip fixture');
    const unrelatedNoteId = addNote({ pitch: 48, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(unrelatedClip.id, unrelatedNoteId, { articulation: 'tenuto' });
    const beforeScoreAnnotations = cloneScoreAnnotations(store.scoreAnnotations);
    const strip = {
      ...createDefaultStrip(),
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: { thresholdDb: -18 },
          enabled: true,
        },
      ],
    };
    store.tracks = store.tracks.map((track) =>
      track.id === trackId
        ? {
            ...track,
            color: '#abcdef',
            mute: true,
            solo: true,
            soloSafe: true,
            volume: 0.7,
            pan: -0.2,
            groupId: 777,
            vcaId: 'vca-drums',
            recordInputChannel: 3,
            recordInputDeviceId: 'device-a',
            externalMidiMode: 'project',
            instrument: { kind: 'synth-preset', preset: 'warmPad' },
            mixer: strip,
          }
        : track.id === store.tracks[0].id
          ? {
              ...track,
              mixer: {
                ...createDefaultStrip(),
                inserts: [
                  {
                    processor: 'dynamics.compressor',
                    params: {},
                    enabled: true,
                    sidechainSourceTrackId: trackId,
                  },
                ],
              },
            }
          : track,
    );
    store.mixer = {
      ...store.mixer,
      vcaGroups: [{ id: 'vca-drums', name: 'Drums VCA', gainDb: -4 }],
    };
    store.automationLanes = [
      { target: trackId, param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -6 }] },
    ];
    store.midiCcBindings.set(`gain:${trackId}`, { channel: 0, controller: 7 });
    const beforeTrack = store.tracks.find((track) => track.id === trackId);
    clearHistory();

    const written = generateTracksBatchCommand([
      {
        part: 'drums',
        params: { bars: 2, style: 'funk' },
        target: { kind: 'replaceTrack', trackId },
      },
    ]);

    expect(written).toBe(1);
    expect(store.tracks.find((track) => track.id === trackId)).toEqual(beforeTrack);
    expect(store.automationLanes).toEqual([
      { target: trackId, param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -6 }] },
    ]);
    expect(store.midiCcBindings.get(`gain:${trackId}`)).toEqual({ channel: 0, controller: 7 });
    expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBe(trackId);
    const replacement = store.clips.filter((clip) => clip.trackId === trackId);
    expect(replacement).toHaveLength(1);
    expect(replacement[0].id).not.toBe(oldClipIds[0]);
    expect(replacement[0].lengthPpq).toBe(8);
    expect(store.scoreAnnotations[oldClipIds[0]]).toBeUndefined();
    expect(store.scoreAnnotations[unrelatedClip.id]?.[unrelatedNoteId]).toEqual({
      articulation: 'tenuto',
    });

    expect(undo()).toBe(true);
    expect(store.tracks.find((track) => track.id === trackId)).toEqual(beforeTrack);
    expect(store.clips.filter((clip) => clip.trackId === trackId).map((clip) => clip.id)).toEqual(
      oldClipIds,
    );
    expect(store.scoreAnnotations).toEqual(beforeScoreAnnotations);
  });

  it('rejects frozen clip and replacement targets before changing native or mirror state', () => {
    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const drums = store.tracks.find((track) => track.name === 'Drums');
    if (!drums) throw new Error('missing generated drums fixture');
    setTrackFrozen(drums.id, { assetId: 'frozen-drums' });
    const activeTrackId = store.activeClip?.trackId;
    if (activeTrackId === undefined) throw new Error('missing active clip fixture');
    setTrackFrozen(activeTrackId, { assetId: 'frozen-active' });
    clearHistory();
    const nativeBefore = getProject().toJson();
    const mirrorBefore = JSON.stringify({ tracks: store.tracks, clips: store.clips });

    expect(() =>
      generateTracksBatchCommand([
        {
          part: 'drums',
          params: { bars: 2 },
          target: { kind: 'replaceTrack', trackId: drums.id },
        },
      ]),
    ).toThrow(/unfreeze/i);
    expect(() =>
      generateTracksBatchCommand([
        {
          part: 'motif',
          params: { bars: 1, develop: false },
          target: { kind: 'clip', mode: 'replace' },
        },
      ]),
    ).toThrow(/unfreeze/i);
    expect(getProject().toJson()).toBe(nativeBefore);
    expect(JSON.stringify({ tracks: store.tracks, clips: store.clips })).toBe(mirrorBefore);
  });

  it('rolls back a partial generation when a native write throws mid-transaction', () => {
    setProjectChords(FOUR_CHORDS);
    const project = getProject();
    const baseTracks = store.tracks.length;
    const nativeBefore = project.toJson();
    // The last of addTrack → addClip → setMidiEvents fails after the first two
    // native edits already landed; the transaction must undo exactly those.
    const spy = vi.spyOn(project, 'setMidiEvents').mockImplementationOnce(() => {
      throw new Error('native write failed');
    });
    expect(() =>
      generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]),
    ).toThrow('native write failed');
    spy.mockRestore();

    // No orphaned track/clip survived and the Project matches its pre-state.
    expect(store.tracks.length).toBe(baseTracks);
    expect(project.tracks()).toHaveLength(baseTracks);
    expect(project.toJson()).toBe(nativeBefore);

    // The undo stack stayed aligned with the Project history: a subsequent
    // generation still undoes cleanly in one step.
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    expect(store.tracks.length).toBe(baseTracks + 1);
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(baseTracks);
  });

  // A generated track is recognised by what wrote it, so renaming it keeps it a
  // regeneration target where the old name match would have lost it.
  it('records which part wrote each generated track', () => {
    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([
      { part: 'drums', params: { bars: 4 }, target: { kind: 'new' } },
      { part: 'bass', params: {}, target: { kind: 'new' } },
    ]);

    const drums = store.tracks.find((track) => track.name === 'Drums');
    const bass = store.tracks.find((track) => track.name === 'Bass');
    expect(drums?.generated).toEqual({
      part: 'drums',
      seed: 0,
      algorithmVersion: CURRENT_ALGORITHM_VERSION,
    });
    expect(bass?.generated?.part).toBe('bass');

    renameTrack(drums?.id ?? -1, 'Kit A');
    expect(partForTrack(store.tracks.find((track) => track.id === drums?.id) ?? { name: '' })).toBe(
      'drums',
    );
  });

  it('records the seed the part was generated from', () => {
    generateTracksBatchCommand([
      { part: 'drums', params: { bars: 4, seed: 9 }, target: { kind: 'new' } },
    ]);
    expect(store.tracks.find((track) => track.name === 'Drums')?.generated?.seed).toBe(9);
  });

  // Replacing keeps the track id and its name, so the record is the only thing
  // that can say the track now carries a different part.
  it('rewrites the record when one part replaces another on a track', () => {
    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([{ part: 'drums', params: { bars: 4 }, target: { kind: 'new' } }]);
    const trackId = store.tracks.find((track) => track.name === 'Drums')?.id ?? -1;

    generateTracksBatchCommand([
      { part: 'bass', params: {}, target: { kind: 'replaceTrack', trackId } },
    ]);

    const track = store.tracks.find((entry) => entry.id === trackId);
    expect(track?.generated?.part).toBe('bass');
  });

  const followOf = (part: 'backing') =>
    store.tracks.find((track) => track.generated?.part === part)?.leadFollow;

  it('makes a backing generated with a new motif follow the motif track', () => {
    setProjectChords(FOUR_CHORDS);
    const trackCount = store.tracks.length;
    generateTracksBatchCommand([
      { part: 'motif', params: {}, target: { kind: 'new' } },
      { part: 'backing', params: {}, target: { kind: 'new' } },
    ]);
    const motif = store.tracks.find((track) => track.generated?.part === 'motif');
    expect(followOf('backing')?.leadTrackId).toBe(motif?.id);
    // The follow setting and any thinning belong to the one generation step.
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount);
  });

  it('follows the active clip track when the motif is written into a clip', () => {
    setProjectChords(FOUR_CHORDS);
    const activeTrackId = store.activeClip?.trackId;
    generateTracksBatchCommand([
      { part: 'motif', params: {}, target: { kind: 'clip', mode: 'append' } },
      { part: 'backing', params: {}, target: { kind: 'new' } },
    ]);
    expect(activeTrackId).toBeDefined();
    expect(followOf('backing')?.leadTrackId).toBe(activeTrackId);
  });

  it('follows the replaced track when the motif replaces one', () => {
    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([{ part: 'bass', params: {}, target: { kind: 'new' } }]);
    const replacedId = store.tracks.find((track) => track.generated?.part === 'bass')?.id ?? -1;
    generateTracksBatchCommand([
      { part: 'motif', params: {}, target: { kind: 'replaceTrack', trackId: replacedId } },
      { part: 'backing', params: {}, target: { kind: 'new' } },
    ]);
    expect(followOf('backing')?.leadTrackId).toBe(replacedId);
  });

  it('leaves a backing generated without a motif unfollowed', () => {
    setProjectChords(FOUR_CHORDS);
    generateTracksBatchCommand([{ part: 'backing', params: {}, target: { kind: 'new' } }]);
    expect(followOf('backing')).toBeUndefined();
  });
});

describe('partForTrack', () => {
  it('reads the part off the record, whatever the track is called', () => {
    const record = { part: 'counter' as const, seed: 3, algorithmVersion: 1 };
    expect(partForTrack({ name: 'Anything at all', generated: record })).toBe('counter');
    // The record outranks a name that says otherwise.
    expect(partForTrack({ name: 'Drums', generated: record })).toBe('counter');
  });

  // Tracks generated before the record existed have only their name to go on.
  it('falls back to the canonical part name when there is no record', () => {
    expect(partForTrack({ name: 'Drums' })).toBe('drums');
    expect(partForTrack({ name: '  bass ' })).toBe('bass');
    expect(partForTrack({ name: 'Counter melody' })).toBe('counter');
    expect(partForTrack({ name: 'Lead synth' })).toBeNull();
  });
});

describe('sanitizeProvenance', () => {
  it('accepts a whole record', () => {
    expect(sanitizeProvenance({ part: 'motif', seed: 0, algorithmVersion: 1 })).toEqual({
      part: 'motif',
      seed: 0,
      algorithmVersion: 1,
    });
  });

  it('drops anything it cannot read as a whole record', () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      { part: 'lead', seed: 1, algorithmVersion: 1 },
      { part: 'motif', seed: 1.5, algorithmVersion: 1 },
      { part: 'motif', seed: -1, algorithmVersion: 1 },
      { part: 'motif', seed: 1 },
      { part: 'motif', seed: 1, algorithmVersion: 0 },
    ]) {
      expect(sanitizeProvenance(value)).toBeUndefined();
    }
  });
});

describe('partSeed', () => {
  it('gives the same part the same seed for the same project seed', () => {
    expect(partSeed(1234, 'drums', 0)).toBe(partSeed(1234, 'drums', 0));
  });

  // Each part addresses its own path, so one project seed still separates them.
  it('separates the parts under one project seed', () => {
    const seeds = ['motif', 'drums', 'bass', 'counter', 'backing'].map((part) =>
      partSeed(1234, part, 0),
    );
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  // This is the whole point of rerolling by path rather than by picking a new
  // number: the parts nobody touched keep sounding as they did.
  it('leaves every other part untouched when one is rerolled', () => {
    const before = partSeed(1234, 'bass', 0);
    expect(partSeed(1234, 'drums', 1)).not.toBe(partSeed(1234, 'drums', 0));
    expect(partSeed(1234, 'bass', 0)).toBe(before);
  });

  it('changes every part when the project seed changes', () => {
    expect(partSeed(1234, 'drums', 0)).not.toBe(partSeed(1235, 'drums', 0));
  });
});

describe('normalizeGenerationSeed', () => {
  it('keeps a whole seed inside the 32-bit range', () => {
    expect(normalizeGenerationSeed(0)).toBe(0);
    expect(normalizeGenerationSeed(7)).toBe(7);
    expect(normalizeGenerationSeed(MAX_GENERATION_SEED)).toBe(MAX_GENERATION_SEED);
  });

  // A seed is a name for a piece, not a measurement, so an unusable value reads
  // as the default rather than stopping the generator.
  it('reads anything unusable as the default seed', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
      expect(normalizeGenerationSeed(value)).toBe(0);
    }
    expect(normalizeGenerationSeed(MAX_GENERATION_SEED + 10)).toBe(MAX_GENERATION_SEED);
    expect(normalizeGenerationSeed(3.6)).toBe(4);
  });
});
