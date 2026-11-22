import type { EqBandInput } from '@libraz/libsonare';
import { describe, expect, it } from 'vitest';
import { createAutomationSync } from '@/engine/automation-sync';
import type { EngineHandle } from '@/engine/engine';
import { createStripSync } from '@/engine/strip-sync';
import { type OfflineRenderEngine, renderProjectWithEngine } from '@/export/engine-render';
import {
  type AutomationLaneState,
  busAutomationTarget,
  insertAutomationParam,
} from '@/project/automation';
import { createDefaultMixerState, createDefaultStrip, type MixerStrip } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import type { EditorTrack } from '@/project/types';

type EngineCall = [string, ...unknown[]];

const ENGINE_MIXER_TARGET_BASE = 0x4d580000;
const ENGINE_MIXER_LANE_MASTER = 0xff;
const ENGINE_MIXER_PARAM_FADER_DB = 1;
const ENGINE_MIXER_PARAM_PAN = 2;

/** Stub track fader/pan id; both declaration paths must resolve the same one. */
function stubTrackParamId(trackId: number, param: 'faderDb' | 'pan'): number {
  const kind = param === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
  return ENGINE_MIXER_TARGET_BASE | ((trackId - 1) << 8) | kind;
}

/** Stub master fader/pan id; both declaration paths must resolve the same one. */
function stubMasterParamId(param: 'faderDb' | 'pan'): number {
  const kind = param === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
  return ENGINE_MIXER_TARGET_BASE | (ENGINE_MIXER_LANE_MASTER << 8) | kind;
}

/** Stub bus fader id. */
function stubBusParamId(busId: number): number {
  return ENGINE_MIXER_TARGET_BASE | ((254 - busId) << 8) | ENGINE_MIXER_PARAM_FADER_DB;
}
type SemanticCall = [string, ...unknown[]];

class DeclarationRecorder implements OfflineRenderEngine {
  calls: EngineCall[] = [];

  private record(name: string, ...args: unknown[]): void {
    this.calls.push([name, ...args]);
  }

  setTrackLanes(lanes: unknown): void {
    this.record('setTrackLanes', lanes);
  }
  setTrackBuses(buses: unknown): void {
    this.record('setTrackBuses', buses);
  }
  setStrip(target: number | 'master', strip: unknown): void {
    this.record('setStrip', target, strip);
  }
  setBusStrip(busId: number, strip: unknown): void {
    this.record('setBusStrip', busId, strip);
  }
  setStripSidechain(target: number | 'master', insertIndex: number, source: unknown): void {
    this.record('setStripSidechain', target, insertIndex, source);
  }
  setBusSidechain(busId: number, insertIndex: number, source: unknown): void {
    this.record('setBusSidechain', busId, insertIndex, source);
  }
  setStripInsertBypassed(
    target: number | 'master',
    index: number,
    state: { bypassed: boolean },
  ): void {
    this.record('setStripInsertBypassed', target, index, state.bypassed);
  }
  setBusInsertBypassed(busId: number, index: number, state: { bypassed: boolean }): void {
    this.record('setBusInsertBypassed', busId, index, state.bypassed);
  }
  setStripEqBand(target: number | 'master', bandIndex: number, band: EqBandInput): void {
    this.record('setStripEqBand', target, bandIndex, band);
  }
  setBusEqBand(busId: number, bandIndex: number, band: EqBandInput): void {
    this.record('setBusEqBand', busId, bandIndex, band);
  }
  setTrackSoloMute(trackId: number, state: { solo: boolean; mute: boolean }): void {
    this.record('setTrackSoloMute', trackId, state.solo, state.mute);
  }
  setStripPanLaw(trackId: number, panLaw: unknown): void {
    this.record('setStripPanLaw', trackId, panLaw);
  }
  setStripPanMode(trackId: number, panMode: unknown): void {
    this.record('setStripPanMode', trackId, panMode);
  }
  setStripDualPan(trackId: number, leftPan: number, rightPan: number): void {
    this.record('setStripDualPan', trackId, leftPan, rightPan);
  }
  setStripChannelDelaySamples(trackId: number, delaySamples: number): void {
    this.record('setStripChannelDelaySamples', trackId, delaySamples);
  }
  resolveStripAutomationId(target: number | 'master', param: 'faderDb' | 'pan' | 'width'): number {
    this.record('resolveStripAutomationId', target, param);
    if (param === 'width') return -1;
    if (target === 'master') return stubMasterParamId(param);
    return stubTrackParamId(target, param);
  }
  resolveBusAutomationId(busId: number, _param: 'faderDb'): number {
    this.record('resolveBusAutomationId', busId);
    return stubBusParamId(busId);
  }
  setAutomationLane(paramId: number, points: unknown): void {
    this.record('setAutomationLane', paramId, points);
  }
  resolveStripInsertAutomationId(
    target: number | 'master',
    insertIndex: number,
    paramName: string,
  ): number {
    this.record('resolveStripInsertAutomationId', target, insertIndex, paramName);
    const base = target === 'master' ? 0xe1000000 : 0xe0000000 | (target << 16);
    return (base | (insertIndex << 8) | paramName.length) >>> 0;
  }
  resolveBusInsertAutomationId(busId: number, insertIndex: number, paramName: string): number {
    this.record('resolveBusInsertAutomationId', busId, insertIndex, paramName);
    return (0xe2000000 | (busId << 16) | (insertIndex << 8) | paramName.length) >>> 0;
  }
  setParameter(paramId: number, value: number): void {
    this.record('setParameter', paramId, value);
  }
  setTempoSegments(segments: unknown): void {
    this.record('setTempoSegments', segments);
  }
  setClips(clips: unknown): void {
    this.record('setClips', clips);
  }
  get warpStretchOverflowCount(): number {
    return 0;
  }
  settleParameters(): void {
    this.record('settleParameters');
  }
  resolveInstrumentAutomationId(destinationId: number, paramName: string): number {
    this.record('resolveInstrumentAutomationId', destinationId, paramName);
    return 0;
  }
  setWarpVoiceCapacity(voices: number): void {
    this.record('setWarpVoiceCapacity', voices);
  }
  setMidiClips(clips: unknown): void {
    this.record('setMidiClips', clips);
  }
  setSynthInstrument(destinationId: number, patch?: object): void {
    this.record('setSynthInstrument', destinationId, patch);
  }
  loadSoundFont(data: Uint8Array): void {
    this.record('loadSoundFont', data);
  }
  setSf2Instrument(destinationId: number, config?: object): void {
    this.record('setSf2Instrument', destinationId, config);
  }
  setMidiFx(destinationId: number, config: object): void {
    this.record('setMidiFx', destinationId, config);
  }
  setTrackSends(trackId: number, sends: unknown): void {
    this.record('setTrackSends', trackId, sends);
  }
  setBusGainDb(busId: number, gainDb: number): void {
    this.record('setBusGainDb', busId, gainDb);
  }
  setTrackOutputBus(trackId: number, busId: number | null): void {
    this.record('setTrackOutputBus', trackId, busId);
  }
  setStripInsertParam(
    target: number | 'master',
    insertIndex: number,
    param: { name: string; value: number },
  ): void {
    this.record('setStripInsertParam', target, insertIndex, param);
  }
  setBusInsertParam(
    busId: number,
    insertIndex: number,
    param: { name: string; value: number },
  ): void {
    this.record('setBusInsertParam', busId, insertIndex, param);
  }
  pushMidiUmp(destinationId: number, words: readonly number[]): void {
    this.record('pushMidiUmp', destinationId, words);
  }
  seekSample(sample: number): void {
    this.record('seekSample', sample);
  }
  play(): void {
    this.record('play');
  }
  stop(): void {
    this.record('stop');
  }
  process(channels: Float32Array[]): Float32Array[] {
    this.record('process', channels[0]?.length ?? 0);
    return channels;
  }
  destroy(): void {
    this.record('destroy');
  }
}

function makeStrip(overrides: Partial<MixerStrip> = {}): MixerStrip {
  return { ...createDefaultStrip(), ...overrides };
}

const eqBands: EqBandInput[] = [
  { enabled: true, type: 'peak', frequencyHz: 1200, gainDb: 3, q: 1 },
];

function parityFixture(): {
  doc: ProjectDocument;
  tracks: EditorTrack[];
  mixer: ReturnType<typeof createDefaultMixerState>;
  lanes: AutomationLaneState[];
} {
  const trackStrip = makeStrip({
    inputTrimDb: 3,
    width: 0.5,
    inserts: [
      { processor: 'dynamics.compressor', enabled: true, params: { thresholdDb: -18 } },
      { processor: 'saturation.tape', enabled: false, params: { driveDb: 0.4 } },
    ],
    eq: { enabled: true, bands: eqBands },
  });
  const busStrip = makeStrip({
    inserts: [
      { processor: 'stereo.monoMaker', enabled: false, params: { cutoffHz: 120 } },
      { processor: 'dynamics.limiter', enabled: true, params: { thresholdDb: -3 } },
    ],
  });
  const groupStrip = makeStrip({
    polarityInvertLeft: true,
    inserts: [
      { processor: 'eq.tilt', enabled: false, params: { tiltDb: -1 } },
      { processor: 'eq.bandPass', enabled: true, params: { frequencyHz: 900 } },
    ],
  });
  const master = makeStrip({
    pan: -0.1,
    inserts: [
      { processor: 'dynamics.brickwallLimiter', enabled: false, params: { ceilingDb: -1 } },
    ],
    eq: {
      enabled: true,
      bands: [{ enabled: true, type: 'highShelf', frequencyHz: 8000, gainDb: 1 }],
    },
  });
  const tracks = [
    {
      id: 1,
      name: 'Keys',
      color: '#fff',
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      order: 0,
      mixer: trackStrip,
      clips: [],
    },
    {
      id: 2,
      name: 'Group',
      color: '#ddd',
      kind: 'group',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      order: 1,
      mixer: groupStrip,
      clips: [],
    },
  ] as unknown as EditorTrack[];
  const lanes: AutomationLaneState[] = [
    { target: 1, param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -3 }] },
    {
      target: 1,
      param: insertAutomationParam(1, 'driveDb'),
      enabled: true,
      points: [{ ppq: 1, value: 0.6, curve: 'hold' }],
    },
    {
      target: busAutomationTarget('bus-a'),
      param: insertAutomationParam(1, 'thresholdDb'),
      enabled: true,
      points: [
        { ppq: 2, value: 0.7 },
        { ppq: Number.NaN, value: 1 },
      ],
    },
    {
      target: 2,
      param: insertAutomationParam(1, 'frequencyHz'),
      enabled: true,
      points: [{ ppq: 3, value: 1200 }],
    },
    { target: 2, param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -9 }] },
    { target: 'master', param: 'pan', enabled: true, points: [{ ppq: 0, value: 0.25 }] },
  ];
  const mixer = {
    ...createDefaultMixerState(),
    master,
    buses: [{ id: 'bus-a', name: 'A', gainDb: -4, strip: busStrip, automation: [lanes[2]] }],
  };
  const doc = {
    schemaVersion: 3,
    name: 'declaration-parity',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    markers: [],
    sections: [],
    mixer,
    tracks: [
      { ...tracks[0], automation: [lanes[0], lanes[1]] },
      { ...tracks[1], automation: [lanes[3], lanes[4]] },
    ],
    masterAutomation: [lanes[5]],
  } as unknown as ProjectDocument;
  return { doc, tracks, mixer, lanes };
}

function normalize(calls: readonly EngineCall[]): SemanticCall[] {
  const result: SemanticCall[] = [];
  for (const call of calls) {
    const [name, ...args] = call;
    if (name === 'setStrip') {
      const [target, strip] = args;
      result.push(
        target === 'master'
          ? ['strip', 'master', JSON.stringify(strip)]
          : ['strip', 'track', target, JSON.stringify(strip)],
      );
    }
    if (name === 'setBusStrip') result.push(['strip', 'bus', args[0], JSON.stringify(args[1])]);
    if (name === 'setStripInsertBypassed') {
      const [target, index, bypassed] = args;
      result.push(
        target === 'master'
          ? ['strip-bypass', 'master', index, bypassed]
          : ['strip-bypass', 'track', target, index, bypassed],
      );
    }
    if (name === 'setStripEqBand') {
      const [target, bandIndex, band] = args;
      result.push(
        target === 'master'
          ? ['strip-eq', 'master', bandIndex, JSON.stringify(band)]
          : ['strip-eq', 'track', target, bandIndex, JSON.stringify(band)],
      );
    }
    if (name === 'resolveStripInsertAutomationId' || name === 'resolveBusInsertAutomationId') {
      result.push([name, ...args]);
    }
    if (name === 'setAutomationLane') result.push(['automation', args[0], JSON.stringify(args[1])]);
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('engine declaration parity', () => {
  it('keeps live strip and automation declarations aligned with offline export', async () => {
    const { doc, tracks, mixer, lanes } = parityFixture();
    const exportEngine = new DeclarationRecorder();
    await renderProjectWithEngine(doc, {
      createEngine: () => exportEngine,
      deps: null,
      loadAudioAsset: async () => {
        throw new Error('unexpected audio asset load');
      },
      range: { startPpq: 0, endPpq: 1 },
      releaseTailSeconds: 0,
      resolvePreset: (preset) => preset,
    });

    const liveEngine = new DeclarationRecorder();
    const handle = { engine: liveEngine } as unknown as EngineHandle;
    const stripSync = createStripSync(handle);
    stripSync.sync(tracks, mixer);
    createAutomationSync(handle, {
      knownTrackIds: () =>
        tracks.filter((track) => track.kind !== 'group').map((track) => track.id),
      busIdFor: (busId) => stripSync.busIdFor(busId),
      groupBusIdFor: (trackId) => stripSync.groupBusIdFor(trackId),
      busInsertIndexFor: (busId, index) => stripSync.busInsertIndexFor(busId, index),
      groupInsertIndexFor: (trackId, index) => stripSync.groupInsertIndexFor(trackId, index),
      restoreParam: () => {},
    }).sync(lanes);

    expect(normalize(liveEngine.calls)).toEqual(normalize(exportEngine.calls));
  });
});
