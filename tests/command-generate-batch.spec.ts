import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectChords } from '@/project/command/chords';
import { generateTracksBatchCommand, partForTrackName } from '@/project/command/generate-batch';
import { clearHistory, redo, undo } from '@/project/command/history';
import { createDefaultStrip } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
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
            frozen: { assetId: 'frozen-drums' },
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

    expect(undo()).toBe(true);
    expect(store.tracks.find((track) => track.id === trackId)).toEqual(beforeTrack);
    expect(store.clips.filter((clip) => clip.trackId === trackId).map((clip) => clip.id)).toEqual(
      oldClipIds,
    );
  });

  it('classifies generated track names', () => {
    expect(partForTrackName('Drums')).toBe('drums');
    expect(partForTrackName('bass')).toBe('bass');
    expect(partForTrackName('Counter melody')).toBe('counter');
    expect(partForTrackName('Lead synth')).toBeNull();
  });
});
