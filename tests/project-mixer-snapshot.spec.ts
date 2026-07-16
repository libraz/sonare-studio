import { describe, expect, it } from 'vitest';
import {
  type AutomationLaneState,
  busAutomationTarget,
  insertAutomationParam,
  masteringAutomationParam,
} from '@/project/automation';
import { buildMixerSnapshot, mergeMixerSnapshot } from '@/project/command/mixer';
import { createDefaultStrip, type MixerStrip, type ProjectMixerState } from '@/project/mixer';
import type { EditorTrack } from '@/project/types';

function strip(over: Partial<MixerStrip> = {}): MixerStrip {
  return { ...createDefaultStrip(), ...over };
}

function track(id: number, over: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id,
    name: `T${id}`,
    color: '#888',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
    ...over,
  };
}

function mixer(over: Partial<ProjectMixerState> = {}): ProjectMixerState {
  return { master: createDefaultStrip(), buses: [], ...over };
}

function automationLane(over: Partial<AutomationLaneState> = {}): AutomationLaneState {
  return {
    target: busAutomationTarget('bus-1'),
    param: 'faderDb',
    enabled: true,
    points: [{ ppq: 0, value: -6 }],
    ...over,
  };
}

describe('buildMixerSnapshot', () => {
  it('captures the mixer state and per-track strip/flags, deep-copied', () => {
    const source = mixer({
      master: strip({ gainDb: -3 }),
      buses: [
        {
          id: 'bus-1',
          name: 'Plate',
          gainDb: -6,
          strip: strip({
            inserts: [
              { processor: 'dynamics.compressor', params: { thresholdDb: -18 }, enabled: true },
            ],
          }),
        },
      ],
      vcaGroups: [{ id: 'vca-1', name: 'Drums', gainDb: -2 }],
    });
    const tracks = [
      track(1, { mixer: strip({ gainDb: 2 }), mute: true, solo: true, soloSafe: true }),
    ];
    const automation = [
      automationLane({
        target: busAutomationTarget('bus-1'),
        points: [{ ppq: 4, value: -9, curve: 'hold' }],
      }),
      automationLane({ target: busAutomationTarget('missing'), points: [{ ppq: 0, value: -3 }] }),
      automationLane({ target: 1, param: 'pan', points: [{ ppq: 0, value: 0.5 }] }),
    ];
    const snap = buildMixerSnapshot(source, tracks, automation);

    expect(snap.mixer.master.gainDb).toBe(-3);
    expect(snap.mixer.buses[0].name).toBe('Plate');
    expect(snap.mixer.buses[0].strip?.inserts[0].params.thresholdDb).toBe(-18);
    expect(snap.mixer.vcaGroups?.[0]).toEqual({ id: 'vca-1', name: 'Drums', gainDb: -2 });
    expect(snap.tracks).toHaveLength(1);
    expect(snap.tracks[0]).toMatchObject({ id: 1, mute: true, solo: true, soloSafe: true });
    expect(snap.tracks[0].mixer.gainDb).toBe(2);
    expect(snap.automationLanes).toEqual([
      {
        target: busAutomationTarget('bus-1'),
        param: 'faderDb',
        enabled: true,
        points: [{ ppq: 4, value: -9, curve: 'hold' }],
      },
    ]);

    // Deep copy: mutating the source does not change the snapshot.
    source.master.gainDb = 10;
    source.buses[0].strip!.inserts[0].params.thresholdDb = -40;
    source.vcaGroups![0].name = 'Changed';
    tracks[0].mixer!.gainDb = 99;
    automation[0].points[0].value = -40;
    expect(snap.mixer.master.gainDb).toBe(-3);
    expect(snap.mixer.buses[0].strip?.inserts[0].params.thresholdDb).toBe(-18);
    expect(snap.mixer.vcaGroups?.[0].name).toBe('Drums');
    expect(snap.tracks[0].mixer.gainDb).toBe(2);
    expect(snap.automationLanes?.[0].points[0].value).toBe(-9);
  });

  it('omits soloSafe/vcaId when the track does not carry them, defaults strip', () => {
    const snap = buildMixerSnapshot(mixer(), [track(1)]);
    expect(snap.tracks[0].soloSafe).toBeUndefined();
    expect(snap.tracks[0].vcaId).toBeUndefined();
    expect(snap.tracks[0].mixer).toEqual(createDefaultStrip());
  });
});

describe('mergeMixerSnapshot', () => {
  it('restores the master strip and existing tracks strip/flags', () => {
    const snap = buildMixerSnapshot(mixer({ master: strip({ gainDb: -6 }) }), [
      track(1, { mixer: strip({ gainDb: 4, pan: 0.5 }), mute: true }),
    ]);
    const current = [track(1, { mixer: strip({ gainDb: 0 }), mute: false })];
    const { mixer: nextMixer, tracks } = mergeMixerSnapshot(snap, current);

    expect(nextMixer.master.gainDb).toBe(-6);
    expect(tracks[0].mixer?.gainDb).toBe(4);
    expect(tracks[0].mixer?.pan).toBe(0.5);
    expect(tracks[0].mute).toBe(true);
  });

  it('leaves tracks added after the snapshot untouched (but routing-sanitized)', () => {
    const snap = buildMixerSnapshot(mixer(), [track(1)]);
    const current = [track(1), track(2, { mixer: strip({ gainDb: 7 }) })];
    const { tracks } = mergeMixerSnapshot(snap, current);
    expect(tracks).toHaveLength(2);
    expect(tracks[1].mixer?.gainDb).toBe(7);
  });

  it('ignores snapshot tracks that no longer exist', () => {
    const snap = buildMixerSnapshot(mixer(), [track(1), track(99, { mute: true })]);
    const { tracks } = mergeMixerSnapshot(snap, [track(1)]);
    expect(tracks.map((entry) => entry.id)).toEqual([1]);
  });

  it('drops sends and output routing to buses missing from the restored mixer', () => {
    // Snapshot restores a mixer with only bus 'b1'; the track routed to 'b2'.
    const snap = buildMixerSnapshot(mixer({ buses: [{ id: 'b1', name: 'B1', gainDb: 0 }] }), [
      track(1, {
        mixer: strip({
          outputBusId: 'b2',
          sends: [
            { busId: 'b1', levelDb: -6, enabled: true },
            { busId: 'b2', levelDb: -3, enabled: true },
          ],
        }),
      }),
    ]);
    const { tracks } = mergeMixerSnapshot(snap, [track(1)]);
    expect(tracks[0].mixer?.outputBusId).toBeUndefined();
    expect(tracks[0].mixer?.sends.map((s) => s.busId)).toEqual(['b1']);
  });

  it('drops VCA membership pointing at a group missing from the restored mixer', () => {
    const snap = buildMixerSnapshot(mixer(), [track(1, { vcaId: 'vca-9' })]);
    const { tracks } = mergeMixerSnapshot(snap, [track(1)]);
    expect(tracks[0].vcaId).toBeUndefined();
  });

  it('restores VCA membership when the group exists in the restored mixer', () => {
    const snap = buildMixerSnapshot(
      mixer({ vcaGroups: [{ id: 'vca-1', name: 'VCA 1', gainDb: 0 }] }),
      [track(1, { vcaId: 'vca-1' })],
    );
    const { tracks } = mergeMixerSnapshot(snap, [track(1, { vcaId: undefined })]);
    expect(tracks[0].vcaId).toBe('vca-1');
  });

  it('restores bus return strips and VCA names from the snapshot mixer', () => {
    const snap = buildMixerSnapshot(
      mixer({
        buses: [
          {
            id: 'fx',
            name: 'FX Snap',
            gainDb: -4,
            strip: strip({
              inserts: [{ processor: 'saturation.tape', params: { drive: 0.3 }, enabled: true }],
            }),
          },
        ],
        vcaGroups: [{ id: 'vca-1', name: 'Snap VCA', gainDb: -5 }],
      }),
      [track(1)],
    );
    const { mixer: nextMixer } = mergeMixerSnapshot(snap, [track(1)]);
    expect(nextMixer.buses[0]).toMatchObject({ id: 'fx', name: 'FX Snap', gainDb: -4 });
    expect(nextMixer.buses[0].strip?.inserts).toEqual([
      { processor: 'saturation.tape', params: { drive: 0.3 }, enabled: true },
    ]);
    expect(nextMixer.vcaGroups?.[0]).toEqual({ id: 'vca-1', name: 'Snap VCA', gainDb: -5 });
  });

  it('restores bus automation lanes while preserving non-bus automation', () => {
    const target = busAutomationTarget('fx');
    const snap = buildMixerSnapshot(
      mixer({ buses: [{ id: 'fx', name: 'FX Snap', gainDb: -4 }] }),
      [track(1)],
      [automationLane({ target, points: [{ ppq: 0, value: -8 }] })],
    );
    const currentLanes = [
      automationLane({ target, points: [{ ppq: 0, value: -1 }] }),
      automationLane({ target: busAutomationTarget('other'), points: [{ ppq: 0, value: -2 }] }),
      automationLane({ target: 1, param: 'pan', points: [{ ppq: 0, value: 0.5 }] }),
      automationLane({ target: 'master', points: [{ ppq: 0, value: -3 }] }),
    ];

    const { automationLanes } = mergeMixerSnapshot(snap, [track(1)], currentLanes);

    expect(automationLanes).toEqual([
      { target: 1, param: 'pan', enabled: true, points: [{ ppq: 0, value: 0.5 }] },
      { target: 'master', param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -3 }] },
      { target, param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -8 }] },
    ]);
  });

  it('restores captured processor lanes, migrates legacy indices, and prunes replaced-chain lanes', () => {
    const snapshotMixer = mixer({
      master: strip({
        inserts: [
          {
            id: 'snapshot-master-insert',
            processor: 'eq.tilt',
            params: { tiltDb: 1 },
            enabled: true,
          },
        ],
      }),
      masteringChain: {
        processors: [
          {
            id: 'snapshot-mastering',
            processor: 'maximizer.truePeakLimiter',
            params: { ceilingDb: -1 },
            enabled: true,
          },
        ],
      },
    });
    const snapshotTracks = [
      track(1, {
        mixer: strip({
          inserts: [
            {
              id: 'snapshot-track-insert',
              processor: 'saturation.tape',
              params: { drive: 0.4 },
              enabled: true,
            },
          ],
        }),
      }),
    ];
    const snap = buildMixerSnapshot(snapshotMixer, snapshotTracks, [
      automationLane({ target: 1, param: insertAutomationParam(0, 'drive') }),
      automationLane({ target: 'master', param: insertAutomationParam(0, 'tiltDb') }),
      automationLane({ target: 'master', param: masteringAutomationParam(0, 'ceilingDb') }),
    ]);
    expect(snap.automationLanes?.map((lane) => lane.param)).toEqual([
      insertAutomationParam('snapshot-track-insert', 'drive'),
      insertAutomationParam('snapshot-master-insert', 'tiltDb'),
      masteringAutomationParam('snapshot-mastering', 'ceilingDb'),
    ]);

    const currentTracks = [
      track(1, {
        mixer: strip({
          inserts: [
            {
              id: 'current-track-insert',
              processor: 'dynamics.compressor',
              params: { thresholdDb: -12 },
              enabled: true,
            },
          ],
        }),
      }),
    ];
    const currentLanes = [
      automationLane({
        target: 1,
        param: insertAutomationParam('current-track-insert', 'thresholdDb'),
      }),
      automationLane({
        target: 'master',
        param: insertAutomationParam('current-master-insert', 'drive'),
      }),
      automationLane({
        target: 'master',
        param: masteringAutomationParam('current-mastering', 'ceilingDb'),
      }),
      automationLane({ target: 1, param: 'faderDb' }),
    ];

    const { automationLanes } = mergeMixerSnapshot(snap, currentTracks, currentLanes);
    expect(automationLanes.map((lane) => lane.param)).toEqual([
      'faderDb',
      insertAutomationParam('snapshot-track-insert', 'drive'),
      insertAutomationParam('snapshot-master-insert', 'tiltDb'),
      masteringAutomationParam('snapshot-mastering', 'ceilingDb'),
    ]);
  });
});
