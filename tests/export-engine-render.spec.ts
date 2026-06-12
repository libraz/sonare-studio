import { describe, expect, it } from 'vitest';
import { linearToDb } from '@/engine/mixer-sync';
import type { OfflineRenderEngine } from '@/export/engine-render';
import { renderProjectWithEngine } from '@/export/engine-render';
import { MixdownCancelledError } from '@/export/mixdown';
import type { LoadedAudioAsset } from '@/persistence/assets';
import type { ProjectDocument } from '@/project/serialization';

/** Records every engine call and renders a constant sample value. */
class FakeEngine implements OfflineRenderEngine {
  calls: Array<[string, ...unknown[]]> = [];
  destroyed = false;
  /** Sample value process() writes into every frame. */
  fill = 0.25;

  private record(name: string, ...args: unknown[]): void {
    this.calls.push([name, ...args]);
  }
  named(name: string): Array<[string, ...unknown[]]> {
    return this.calls.filter(([n]) => n === name);
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
  setMasterStripJson(json: string): void {
    this.record('setMasterStripJson', json);
  }
  setBusStripJson(busId: number, json: string): void {
    this.record('setBusStripJson', busId, json);
  }
  setLaneSidechain(trackId: number, insertIndex: number, sourceTrackId: number): void {
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
  setSoloMute(laneIndex: number, solo: boolean, mute: boolean): void {
    this.record('setSoloMute', laneIndex, solo, mute);
  }
  setParameter(paramId: number, value: number): void {
    this.record('setParameter', paramId, value);
  }
  setAutomationLane(paramId: number, points: unknown): void {
    this.record('setAutomationLane', paramId, points);
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
    for (const channel of channels) channel.fill(this.fill);
    return channels;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** Minimal valid document: one MIDI track and one audio track + a send bus. */
function makeDoc(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'engine-render-test',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    markers: [],
    sections: [],
    mixer: {
      master: { gainDb: -3, pan: 0.5, inserts: [], sends: [] },
      buses: [{ id: 'bus-a', name: 'A', gainDb: -6 }],
    },
    tracks: [
      {
        name: 'Keys',
        color: '#fff',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 0.5,
        pan: 0,
        clips: [
          {
            name: 'phrase',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [{ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          },
        ],
        automation: [
          {
            param: 'faderDb',
            enabled: true,
            points: [
              { ppq: 0, value: -24 },
              { ppq: 4, value: 0, curve: 'hold' },
            ],
          },
        ],
      },
      {
        name: 'Drums',
        color: '#000',
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        mixer: {
          gainDb: 2,
          pan: -0.25,
          inserts: [],
          sends: [{ busId: 'bus-a', levelDb: -9, enabled: true }],
        },
        clips: [
          {
            name: 'loop',
            kind: 'audio',
            assetId: 'asset-1',
            startPpq: 2,
            lengthPpq: 2,
            sourceOffsetPpq: 0,
            gain: 0.8,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [],
          },
        ],
      },
    ],
    masterAutomation: [
      { param: 'pan', enabled: true, points: [{ ppq: 1, value: -1 }] },
      { param: 'faderDb', enabled: false, points: [{ ppq: 0, value: -60 }] },
    ],
  } as unknown as ProjectDocument;
}

/** Fake OPFS asset: one second of stereo at the render rate. */
function fakeAsset(): LoadedAudioAsset {
  const frames = 48000;
  return {
    meta: { id: 'asset-1', name: 'loop.wav', sampleRate: 48000, numChannels: 2, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(0.5)],
  };
}

function renderOptions(engine: FakeEngine) {
  return {
    deps: null,
    createEngine: () => engine,
    loadAudioAsset: async () => fakeAsset(),
  };
}

describe('renderProjectWithEngine', () => {
  it('replays lanes, buses, sends, params, automation and clips onto the engine', async () => {
    const engine = new FakeEngine();
    const result = await renderProjectWithEngine(makeDoc(), renderOptions(engine));

    // Lanes with synthetic ids; the audio track's send maps to engine bus 1.
    expect(engine.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1 },
      { trackId: 2, sends: [{ busId: 1, levelDb: -9, enabled: true }] },
    ]);
    expect(engine.named('setTrackBuses')[0][1]).toEqual([{ busId: 1, gainDb: -6 }]);

    // Lane base parameters mirror the live mixer-sync derivation.
    const params = new Map(engine.named('setParameter').map(([, id, value]) => [id, value]));
    expect(params.get(0x4d580001)).toBeCloseTo(linearToDb(0.5), 5);
    expect(params.get(0x4d580101)).toBeCloseTo(linearToDb(1) + 2, 5);
    expect(params.get(0x4d580102)).toBeCloseTo(-0.25, 5);
    expect(params.get(0x4d58ff01)).toBeCloseTo(-3, 5);
    expect(params.get(0x4d58ff02)).toBeCloseTo(0.5, 5);

    // Automation: enabled lanes only, engine curve codes applied.
    const lanes = new Map(engine.named('setAutomationLane').map(([, id, points]) => [id, points]));
    expect(lanes.get(0x4d580001)).toEqual([
      { ppq: 0, value: -24, curveToNext: 0 },
      { ppq: 4, value: 0, curveToNext: 2 },
    ]);
    expect(lanes.get(0x4d58ff02)).toEqual([{ ppq: 1, value: -1, curveToNext: 0 }]);
    expect(lanes.has(0x4d58ff01)).toBe(false);

    // Instruments and MIDI schedules reach the engine.
    expect(engine.named('setSynthInstrument')[0]).toEqual(['setSynthInstrument', 'e-piano', 1]);
    const midi = engine.named('setMidiClips')[0][1] as unknown[];
    expect(midi.length).toBe(1);

    // The audio clip is placed at its timeline PPQ with the clip gain only.
    const clips = engine.named('setClips')[0][1] as Array<Record<string, unknown>>;
    expect(clips).toHaveLength(1);
    expect(clips[0].trackId).toBe(2);
    expect(clips[0].startPpq).toBe(2);
    expect(clips[0].gain).toBeCloseTo(0.8, 5);

    // 'project' range: content ends at ppq 4 (= 2 s at 120 BPM) + 2 s tail.
    expect(result.totalFrames).toBe(4 * 24000 + 2 * 48000);
    expect(result.channels[0][0]).toBeCloseTo(0.25, 5);
    expect(result.report.peakDb).toBeCloseTo(20 * Math.log10(0.25), 3);
    expect(engine.named('seekSample')[0][1]).toBe(0);
    expect(engine.destroyed).toBe(true);
  });

  it('renders an explicit window with a pre-roll before its start', async () => {
    const engine = new FakeEngine();
    const result = await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(engine),
      range: { startPpq: 1, endPpq: 3 },
    });
    // The window starts at sample 24000; the render seeks half a second
    // earlier (clamped at the timeline start) and discards the pre-roll so
    // stateful DSP is already in motion at the capture start.
    expect(engine.named('seekSample')[0][1]).toBe(0);
    expect(result.totalFrames).toBe(2 * 24000);
  });

  it('skips the master strip scene but keeps gain/pan without the master chain', async () => {
    const doc = makeDoc();
    (doc.mixer as { master: { inserts: unknown[] } }).master.inserts = [
      { processor: 'dynamics.limiter', params: {}, enabled: true },
    ];
    const withChain = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(withChain));
    expect(withChain.named('setMasterStripJson')).toHaveLength(1);

    const withoutChain = new FakeEngine();
    await renderProjectWithEngine(doc, {
      ...renderOptions(withoutChain),
      includeMasterChain: false,
    });
    expect(withoutChain.named('setMasterStripJson')).toHaveLength(0);
    const params = new Map(withoutChain.named('setParameter').map(([, id, value]) => [id, value]));
    expect(params.get(0x4d58ff01)).toBeCloseTo(-3, 5);
  });

  it('renders stems as isolated engine passes without the master stage', async () => {
    const engines: FakeEngine[] = [];
    const result = await renderProjectWithEngine(makeDoc(), {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
    });

    // One mix pass plus one pass per audible track, each on a fresh engine.
    expect(engines).toHaveLength(3);
    expect(engines.every((engine) => engine.destroyed)).toBe(true);
    expect(result.stems).toHaveLength(2);
    expect(result.stems?.[0]).toMatchObject({ trackIndex: 0, name: 'Keys' });
    expect(result.stems?.[1]).toMatchObject({ trackIndex: 1, name: 'Drums' });
    expect(result.stems?.[0].channels[0].length).toBe(result.totalFrames);
    expect(result.stems?.[0].channels[0][0]).toBeCloseTo(0.25, 5);

    // A stem pass isolates its lane via mutes (solo would keep the document's
    // own soloed tracks audible too).
    const stemPass = engines[1];
    expect(stemPass.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, false, false],
      ['setSoloMute', 1, false, true],
    ]);

    // Stems are pre-master: no master gain/pan and no master automation.
    const stemParams = new Map(stemPass.named('setParameter').map(([, id, value]) => [id, value]));
    expect(stemParams.has(0x4d58ff01)).toBe(false);
    expect(stemParams.has(0x4d58ff02)).toBe(false);
    const stemLaneIds = new Set(stemPass.named('setAutomationLane').map(([, id]) => id));
    expect(stemLaneIds.has(0x4d58ff02)).toBe(false);
    expect(stemLaneIds.has(0x4d580001)).toBe(true);

    // The mix pass keeps the document's solo/mute state and master levels.
    const mixPass = engines[0];
    expect(mixPass.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, false, false],
      ['setSoloMute', 1, false, false],
    ]);
    const mixParams = new Map(mixPass.named('setParameter').map(([, id, value]) => [id, value]));
    expect(mixParams.get(0x4d58ff01)).toBeCloseTo(-3, 5);
  });

  it('cancels between checkpoints and still destroys the engine', async () => {
    const engine = new FakeEngine();
    let blocks = 0;
    const promise = renderProjectWithEngine(makeDoc(), {
      ...renderOptions(engine),
      shouldCancel: () => ++blocks > 1,
    });
    await expect(promise).rejects.toBeInstanceOf(MixdownCancelledError);
    expect(engine.destroyed).toBe(true);
  });

  it('expands a comped audio clip into one engine clip per segment', async () => {
    const doc = makeDoc();
    const drumClip = doc.tracks[1].clips[0];
    drumClip.takes = [
      { assetId: 'asset-1', name: 'Take 1' },
      { assetId: 'asset-2', name: 'Take 2' },
    ];
    drumClip.compSegments = [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 1, takeIndex: 1 },
    ];

    // asset-1: constant stereo 0.5 (fakeAsset); asset-2: a mono index ramp so
    // the per-segment source offset is observable in the scheduled samples.
    const rampFrames = 48000;
    const ramp = new Float32Array(rampFrames);
    for (let i = 0; i < rampFrames; i++) ramp[i] = i;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async (assetId: string) =>
        assetId === 'asset-2'
          ? {
              meta: {
                id: 'asset-2',
                name: 'take2.wav',
                sampleRate: 48000,
                numChannels: 1,
                numFrames: rampFrames,
              },
              channels: [ramp],
            }
          : fakeAsset(),
    });

    const clips = engine.named('setClips')[0][1] as Array<{
      trackId: number;
      channels: Float32Array[];
      startPpq: number;
      lengthSamples: number;
      gain?: number;
    }>;
    expect(clips).toHaveLength(2);
    expect(clips.map((clip) => clip.trackId)).toEqual([2, 2]);
    // Clip at PPQ 2, segments at clip-relative 0 and 1.
    expect(clips.map((clip) => clip.startPpq)).toEqual([2, 3]);
    // Each segment is 1 PPQ = 0.5 s = 24000 frames at 120 BPM / 48 kHz.
    expect(clips.map((clip) => clip.lengthSamples)).toEqual([24000, 24000]);
    expect(clips[0].gain).toBeCloseTo(0.8, 5);
    expect(clips[1].gain).toBeCloseTo(0.8, 5);

    // First segment: take 1 (stereo, constant 0.5) from source offset 0.
    expect(clips[0].channels).toHaveLength(2);
    expect(clips[0].channels[0][0]).toBeCloseTo(0.5, 5);
    expect(clips[0].channels[0][23999]).toBeCloseTo(0.5, 5);
    // Second segment: take 2 (mono ramp) from source offset 1 PPQ = 24000 frames.
    expect(clips[1].channels).toHaveLength(1);
    expect(clips[1].channels[0][0]).toBe(24000);
    expect(clips[1].channels[0][23999]).toBe(47999);
  });
});

/** Document with a group track (index 2) that the audio track routes into. */
function makeGroupDoc(): ProjectDocument {
  const doc = makeDoc();
  const tracks = doc.tracks as unknown as Array<Record<string, unknown>>;
  tracks.push({
    name: 'Drum Bus',
    color: '#0af',
    kind: 'group',
    mute: false,
    solo: false,
    volume: 0.5,
    pan: 0,
    clips: [],
    mixer: {
      gainDb: -2,
      pan: 0,
      sends: [],
      inserts: [
        { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
        { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
      ],
    },
  });
  tracks[1].groupIndex = 2;
  return doc;
}

describe('renderProjectWithEngine with group tracks and sidechains', () => {
  it('declares the group bus after the send buses and routes members through it', async () => {
    const engine = new FakeEngine();
    await renderProjectWithEngine(makeGroupDoc(), renderOptions(engine));

    const buses = engine.named('setTrackBuses')[0][1] as Array<{ busId: number; gainDb: number }>;
    expect(buses).toHaveLength(2);
    expect(buses[0]).toEqual({ busId: 1, gainDb: -6 });
    expect(buses[1].busId).toBe(2);
    // Combined audible group level: track volume in dB plus the strip gain.
    expect(buses[1].gainDb).toBeCloseTo(linearToDb(0.5) - 2, 5);

    expect(engine.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1 },
      { trackId: 2, sends: [{ busId: 1, levelDb: -9, enabled: true }], outputBusId: 2 },
      { trackId: 3 },
    ]);
  });

  it('sends only the enabled group inserts to the bus strip and keeps the group lane neutral', async () => {
    const engine = new FakeEngine();
    await renderProjectWithEngine(makeGroupDoc(), renderOptions(engine));

    const busStrips = engine.named('setBusStripJson');
    expect(busStrips).toHaveLength(1);
    expect(busStrips[0][1]).toBe(2);
    expect(JSON.parse(busStrips[0][2] as string)).toEqual({
      version: 1,
      strips: [],
      buses: [
        {
          id: 'bus-2',
          role: 'submix',
          inserts: [
            { slot: 'pre', processor: 'dynamics.compressor', params: '{"thresholdDb":-20}' },
          ],
        },
      ],
      connections: [],
    });

    // The group's lane stays silent: no lane strip, fader/pan, or solo/mute.
    expect(engine.named('setTrackStripJson').filter(([, trackId]) => trackId === 3)).toEqual([]);
    const params = new Map(engine.named('setParameter').map(([, id, value]) => [id, value]));
    expect(params.has(0x4d580201)).toBe(false);
    expect(params.has(0x4d580202)).toBe(false);
    expect(engine.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, false, false],
      ['setSoloMute', 1, false, false],
    ]);
  });

  it('floors a muted group bus to silence and skips the bus strip without enabled inserts', async () => {
    const doc = makeGroupDoc();
    const group = doc.tracks[2] as unknown as {
      mute: boolean;
      mixer: { inserts: Array<{ enabled: boolean }> };
    };
    group.mute = true;
    for (const slot of group.mixer.inserts) slot.enabled = false;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const buses = engine.named('setTrackBuses')[0][1] as Array<{ busId: number; gainDb: number }>;
    expect(buses[1].gainDb).toBe(-120);
    expect(engine.named('setBusStripJson')).toEqual([]);
  });

  it('binds positional insert sidechains to lane ids and drops invalid references', async () => {
    const doc = makeGroupDoc();
    const drums = doc.tracks[1] as unknown as { mixer: { inserts: unknown[] } };
    drums.mixer.inserts = [
      // Valid: keyed from track index 0 (engine lane id 1).
      { processor: 'dynamics.compressor', params: {}, enabled: true, sidechainSourceIndex: 0 },
      // Self reference: dropped.
      { processor: 'dynamics.compressor', params: {}, enabled: true, sidechainSourceIndex: 1 },
      // Out of range: dropped.
      { processor: 'dynamics.compressor', params: {}, enabled: true, sidechainSourceIndex: 9 },
      // Not an integer index: dropped.
      { processor: 'dynamics.compressor', params: {}, enabled: true, sidechainSourceIndex: 0.5 },
    ];
    // Group-track inserts never bind a lane sidechain (they live on a bus).
    const group = doc.tracks[2] as unknown as {
      mixer: { inserts: Array<Record<string, unknown>> };
    };
    group.mixer.inserts[0].sidechainSourceIndex = 0;

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));
    expect(engine.named('setLaneSidechain')).toEqual([['setLaneSidechain', 2, 0, 1]]);
  });
});
