import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneScoreAnnotations } from '@/project/annotations';
import { setProjectChords } from '@/project/command/chords';
import { setTrackFrozen } from '@/project/command/clips-state';
import { generateTracksBatchCommand } from '@/project/command/generate-batch';
import { clearHistory, redo, undo } from '@/project/command/history';
import { addNote, renameTrack, setNoteAnnotation } from '@/project/commands';
import { CURRENT_ALGORITHM_VERSION, partForTrack, sanitizeProvenance } from '@/project/generation';
import { createDefaultStrip } from '@/project/mixer';
import { getProject, useProjectStore } from '@/project/store';
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
            instrument: { kind: 'synth-preset', preset: 'warm-pad' },
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
    expect(project.trackCount()).toBe(baseTracks);
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
