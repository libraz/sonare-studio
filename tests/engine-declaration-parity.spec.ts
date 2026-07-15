import { describe, expect, it } from 'vitest';
import { createAutomationSync } from '@/engine/automation-sync';
import type { EngineHandle } from '@/engine/engine';
import { createStripSync } from '@/engine/strip-sync';
import { type OfflineRenderEngine, renderProjectWithEngine } from '@/export/engine-render';
import {
  busParamId,
  ENGINE_MIXER_PARAM_FADER_DB,
  ENGINE_MIXER_PARAM_PAN,
  laneParamId,
  masterParamId,
} from '@/export/engine-render-types';
import {
  type AutomationLaneState,
  busAutomationTarget,
  insertAutomationParam,
} from '@/project/automation';
import { createDefaultMixerState, createDefaultStrip, type MixerStrip } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import type { EditorTrack } from '@/project/types';
import type { EqBand } from '@/wasm/index.js';

type EngineCall = [string, ...unknown[]];
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
  setTrackStripJson(trackId: number, json: string): void {
    this.record('setTrackStripJson', trackId, json);
  }
  setBusStripJson(busId: number, json: string): void {
    this.record('setBusStripJson', busId, json);
  }
  setMasterStripJson(json: string): void {
    this.record('setMasterStripJson', json);
  }
  setLaneSidechain(trackId: number, insertIndex: number, sourceTrackId: number | null): void {
    this.record('setLaneSidechain', trackId, insertIndex, sourceTrackId);
  }
  setTrackStripInsertBypassed(trackId: number, index: number, bypassed: boolean): void {
    this.record('setTrackStripInsertBypassed', trackId, index, bypassed);
  }
  setMasterStripInsertBypassed(index: number, bypassed: boolean): void {
    this.record('setMasterStripInsertBypassed', index, bypassed);
  }
  setTrackStripEqBandJson(trackId: number, bandIndex: number, json: string): void {
    this.record('setTrackStripEqBandJson', trackId, bandIndex, json);
  }
  setMasterStripEqBandJson(bandIndex: number, json: string): void {
    this.record('setMasterStripEqBandJson', bandIndex, json);
  }
  setStripInsertBypassed(target: number | 'master', index: number, bypassed: boolean): void {
    this.record('setStripInsertBypassed', target, index, bypassed);
  }
  setStripEq(target: number | 'master', bandIndex: number, band: EqBand): void {
    this.record('setStripEq', target, bandIndex, band);
  }
  setSoloMute(laneIndex: number, solo: boolean, mute: boolean): void {
    this.record('setSoloMute', laneIndex, solo, mute);
  }
  setTrackStripPanLaw(trackId: number, panLaw: unknown): void {
    this.record('setTrackStripPanLaw', trackId, panLaw);
  }
  setTrackStripPanMode(trackId: number, panMode: unknown): void {
    this.record('setTrackStripPanMode', trackId, panMode);
  }
  setTrackStripDualPan(trackId: number, leftPan: number, rightPan: number): void {
    this.record('setTrackStripDualPan', trackId, leftPan, rightPan);
  }
  setTrackStripChannelDelaySamples(trackId: number, delaySamples: number): void {
    this.record('setTrackStripChannelDelaySamples', trackId, delaySamples);
  }
  setParameter(paramId: number, value: number): void {
    this.record('setParameter', paramId, value);
  }
  automationParamId(target: number | 'master', param: 'faderDb' | 'pan'): number {
    this.record('automationParamId', target, param);
    const kind = param === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
    if (target === 'master') return masterParamId(kind);
    return laneParamId(target - 1, kind);
  }
  busAutomationParamId(busId: number): number {
    this.record('busAutomationParamId', busId);
    return busParamId(busId);
  }
  setAutomationLane(paramId: number, points: unknown): void {
    this.record('setAutomationLane', paramId, points);
  }
  resolveTrackInsertAutomationId(trackId: number, insertIndex: number, paramName: string): number {
    this.record('resolveTrackInsertAutomationId', trackId, insertIndex, paramName);
    return (0xe0000000 | (trackId << 16) | (insertIndex << 8) | paramName.length) >>> 0;
  }
  resolveMasterInsertAutomationId(insertIndex: number, paramName: string): number {
    this.record('resolveMasterInsertAutomationId', insertIndex, paramName);
    return (0xe1000000 | (insertIndex << 8) | paramName.length) >>> 0;
  }
  resolveBusInsertAutomationId(busId: number, insertIndex: number, paramName: string): number {
    this.record('resolveBusInsertAutomationId', busId, insertIndex, paramName);
    return (0xe2000000 | (busId << 16) | (insertIndex << 8) | paramName.length) >>> 0;
  }
  setTempoSegments(segments: unknown): void {
    this.record('setTempoSegments', segments);
  }
  setClips(clips: unknown): void {
    this.record('setClips', clips);
  }
  setMidiClips(clips: unknown): void {
    this.record('setMidiClips', clips);
  }
  setSynthInstrument(patch?: object | string, destinationId?: number): void {
    this.record('setSynthInstrument', patch, destinationId);
  }
  loadSoundFont(data: Uint8Array): void {
    this.record('loadSoundFont', data);
  }
  setSf2Instrument(config?: object, destinationId?: number): void {
    this.record('setSf2Instrument', config, destinationId);
  }
  setMidiFx(destinationId: number, json: string): void {
    this.record('setMidiFx', destinationId, json);
  }
  setSends(trackId: number, sends: unknown): void {
    this.record('setSends', trackId, sends);
  }
  setBusGain(busId: number, gainDb: number): void {
    this.record('setBusGain', busId, gainDb);
  }
  setTrackOutputBus(trackId: number, busId: number): void {
    this.record('setTrackOutputBus', trackId, busId);
  }
  setTrackStripInsertParamByName(
    trackId: number,
    insertIndex: number,
    paramName: string,
    value: number,
  ): void {
    this.record('setTrackStripInsertParamByName', trackId, insertIndex, paramName, value);
  }
  setMasterStripInsertParamByName(insertIndex: number, paramName: string, value: number): void {
    this.record('setMasterStripInsertParamByName', insertIndex, paramName, value);
  }
  setBusStripInsertParamByName(
    busId: number,
    insertIndex: number,
    paramName: string,
    value: number,
  ): void {
    this.record('setBusStripInsertParamByName', busId, insertIndex, paramName, value);
  }
  seekSample(sample: number): void {
    this.record('seekSample', sample);
  }
  settleParameters(): void {
    this.record('settleParameters');
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

const eqBands: EqBand[] = [{ enabled: true, type: 'peak', frequencyHz: 1200, gainDb: 3, q: 1 }];

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
    if (name === 'setTrackStripJson') result.push(['strip-json', 'track', args[0], args[1]]);
    if (name === 'setBusStripJson') result.push(['strip-json', 'bus', args[0], args[1]]);
    if (name === 'setMasterStripJson') result.push(['strip-json', 'master', args[0]]);
    if (name === 'setTrackStripInsertBypassed') {
      result.push(['strip-bypass', 'track', args[0], args[1], args[2]]);
    }
    if (name === 'setMasterStripInsertBypassed') {
      result.push(['strip-bypass', 'master', args[0], args[1]]);
    }
    if (name === 'setStripInsertBypassed') {
      const [target, index, bypassed] = args;
      result.push(
        target === 'master'
          ? ['strip-bypass', 'master', index, bypassed]
          : ['strip-bypass', 'track', target, index, bypassed],
      );
    }
    if (name === 'setTrackStripEqBandJson') {
      result.push(['strip-eq', 'track', args[0], args[1], args[2]]);
    }
    if (name === 'setMasterStripEqBandJson') {
      result.push(['strip-eq', 'master', args[0], args[1]]);
    }
    if (name === 'setStripEq') {
      const [target, bandIndex, band] = args;
      result.push(
        target === 'master'
          ? ['strip-eq', 'master', bandIndex, JSON.stringify(band)]
          : ['strip-eq', 'track', target, bandIndex, JSON.stringify(band)],
      );
    }
    if (
      name === 'resolveTrackInsertAutomationId' ||
      name === 'resolveMasterInsertAutomationId' ||
      name === 'resolveBusInsertAutomationId'
    ) {
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
