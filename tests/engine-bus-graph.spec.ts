import { describe, expect, it, vi } from 'vitest';
import { engineBusGraph } from '@/engine/bus-graph';
import type { EngineHandle } from '@/engine/engine';
import { createStripSync } from '@/engine/strip-sync';
import { buildBusRouting } from '@/export/engine-render-context';
import {
  createDefaultMixerState,
  createDefaultStrip,
  type MixerBus,
  type MixerStrip,
  type ProjectMixerState,
  returnSoloRouting,
} from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import type { EditorTrack } from '@/project/types';

vi.mock('@/project/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/project/runtime')>()),
  currentWasmModule: () => ({}),
}));

interface TrackSpec {
  kind: 'midi' | 'group';
  /** Index of the group track this track belongs to. */
  groupIndex?: number;
  mixer?: MixerStrip;
}

function strip(overrides: Partial<MixerStrip> = {}): MixerStrip {
  return { ...createDefaultStrip(), ...overrides };
}

function bus(id: string, overrides: Partial<MixerBus> = {}): MixerBus {
  return { id, name: id, gainDb: 0, ...overrides };
}

/** Live mirror: track ids are index + 1, so group ref = id. */
function liveTracks(specs: TrackSpec[]): EditorTrack[] {
  return specs.map((spec, index) => ({
    id: index + 1,
    name: `Track ${index + 1}`,
    color: '#60a5fa',
    kind: spec.kind,
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: index,
    ...(spec.groupIndex !== undefined ? { groupId: spec.groupIndex + 1 } : {}),
    ...(spec.mixer ? { mixer: spec.mixer } : {}),
  }));
}

/** Offline document: tracks reference their group by index. */
function documentFor(specs: TrackSpec[], mixer: ProjectMixerState): ProjectDocument {
  return {
    tracks: specs.map((spec) => ({
      kind: spec.kind,
      volume: 1,
      mute: false,
      solo: false,
      pan: 0,
      ...(spec.groupIndex !== undefined ? { groupIndex: spec.groupIndex } : {}),
      ...(spec.mixer ? { mixer: spec.mixer } : {}),
    })),
    mixer,
  } as unknown as ProjectDocument;
}

function liveProgram(specs: TrackSpec[], mixer: ProjectMixerState) {
  const engine = {
    setTrackStripJson: vi.fn(),
    setMasterStripJson: vi.fn(),
    setTrackStripInsertParamByName: vi.fn(),
    setMasterStripInsertParamByName: vi.fn(),
    setBusStripInsertParamByName: vi.fn(),
    setStripEq: vi.fn(),
    setStripInsertBypassed: vi.fn(),
    setTrackBuses: vi.fn(),
    setBusGain: vi.fn(() => true),
    setTrackSends: vi.fn(),
    setTrackOutputBus: vi.fn(),
    setBusSidechain: vi.fn(),
    setMasterSidechain: vi.fn(),
    setBusStripJson: vi.fn(),
    setLaneSidechain: vi.fn(),
  };
  const handle = { engine, ctx: { state: 'running' } } as unknown as EngineHandle;
  createStripSync(handle).sync(liveTracks(specs), mixer);
  const lastFor = (fn: ReturnType<typeof vi.fn>, trackId: number) =>
    fn.mock.calls.filter((call) => call[0] === trackId).at(-1)?.[1];
  return {
    buses: engine.setTrackBuses.mock.calls.at(-1)?.[0] ?? [],
    lanes: specs.map((_, index) => ({
      outputBusId: lastFor(engine.setTrackOutputBus, index + 1) ?? 0,
      sends: lastFor(engine.setTrackSends, index + 1) ?? [],
    })),
  };
}

function offlineProgram(specs: TrackSpec[], mixer: ProjectMixerState) {
  const routing = buildBusRouting(
    documentFor(specs, mixer),
    specs.map((_, index) => index + 1),
  );
  return {
    buses: routing.buses,
    lanes: routing.lanes.map((lane) => ({
      outputBusId: lane.outputBusId ?? 0,
      sends: lane.sends ?? [],
    })),
  };
}

const routedTracks: TrackSpec[] = [
  { kind: 'group', mixer: strip({ sends: [{ busId: 'verb', levelDb: -6, enabled: true }] }) },
  { kind: 'midi', groupIndex: 0 },
  {
    kind: 'midi',
    mixer: strip({
      outputBusId: 'surround',
      sends: [
        { busId: 'verb', levelDb: -3, enabled: true, timing: 'preFader' },
        { busId: 'verb', levelDb: -9, enabled: true },
        { busId: 'gone', levelDb: 0, enabled: true },
      ],
    }),
  },
  { kind: 'midi', mixer: strip({ outputBusId: 'gone' }) },
];

const routedMixer: ProjectMixerState = {
  ...createDefaultMixerState(),
  buses: [
    bus('verb', {
      channelLayout: 'mono',
      // Imported documents can carry a self route the command layer refuses.
      strip: strip({
        outputBusId: 'verb',
        sends: [
          { busId: 'verb', levelDb: 0, enabled: true },
          { busId: 'surround', levelDb: -4, enabled: true },
        ],
      }),
    }),
    bus('surround', { channelLayout: '5.1', gainDb: -2 }),
  ],
};

describe('engineBusGraph', () => {
  it('numbers return buses, then group buses, then the discard sink', () => {
    const mixer = { buses: [bus('a', { solo: true }), bus('b')] };
    const graph = engineBusGraph({
      buses: mixer.buses,
      returnSolo: returnSoloRouting(mixer.buses),
      groups: [{ ref: 4, strip: undefined, gainDb: -1 }],
    });
    expect(graph.keys).toEqual(['a', 'b', 'group:4', 'return-solo-discard']);
    expect(graph.discardBusId).toBe(4);
    expect(graph.trackOutputBus({ kind: 'midi', groupRef: 4 })).toBe(4);
    expect(graph.trackOutputBus({ kind: 'group' })).toBe(0);
  });

  it('declares layouts and drops self routes and duplicate or undeclared sends', () => {
    const graph = engineBusGraph({
      buses: routedMixer.buses,
      returnSolo: returnSoloRouting(routedMixer.buses),
      groups: [],
    });
    expect(graph.declarations).toEqual([
      {
        busId: 1,
        gainDb: 0,
        channelLayout: 'mono',
        sends: [{ busId: 2, levelDb: -4, enabled: true }],
      },
      { busId: 2, gainDb: -2, channelLayout: '5.1' },
    ]);
  });
});

describe('live and offline bus programs', () => {
  it('declare the same buses, outputs and sends', () => {
    const live = liveProgram(routedTracks, routedMixer);
    expect(offlineProgram(routedTracks, routedMixer)).toEqual(live);
    expect(live.lanes[2]).toEqual({
      outputBusId: 2,
      sends: [{ busId: 1, levelDb: -3, enabled: true, sendTiming: 'preFader' }],
    });
    expect(live.lanes[3].outputBusId).toBe(0);
  });

  it('agree while a return is soloed', () => {
    const mixer: ProjectMixerState = {
      ...routedMixer,
      buses: routedMixer.buses.map((entry, index) =>
        index === 1 ? { ...entry, solo: true } : entry,
      ),
    };
    const live = liveProgram(routedTracks, mixer);
    expect(offlineProgram(routedTracks, mixer)).toEqual(live);
    expect(live.buses).toHaveLength(4);
    expect(live.lanes[2].outputBusId).toBe(4);
  });
});
