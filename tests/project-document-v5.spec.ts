import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { upgradeProjectDocument } from '@/project/document-schema';
import {
  gainFloorToReductionDb,
  linearToThresholdDb,
  upgradeDocumentToV5,
  upgradeMasteringOverrides,
  upgradePresetName,
  upgradeTrackPresetToV2,
} from '@/project/document-schema-v5';
import { setWasmModule } from '@/project/runtime';
import type { ProjectDocument } from '@/project/serialization';
import * as wasm from '@/wasm/index.js';

type Json = Record<string, unknown>;

const read = (json: string) => wasm.masteringChainConfigFromJson(json);

/** Every leaf of a nested object, keyed by its dotted path; arrays are leaves. */
function leaves(value: unknown, prefix = '', out: Json = {}): Json {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) {
      leaves(inner, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out[prefix] = value;
  }
  return out;
}

beforeAll(async () => {
  await wasm.init({
    wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`),
  } as Parameters<typeof wasm.init>[0]);
  setWasmModule(wasm);
});

describe('unit conversions', () => {
  it('converts a linear clip threshold to dBFS within the 2.0 domain', () => {
    expect(linearToThresholdDb(1)).toBe(0);
    expect(linearToThresholdDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(linearToThresholdDb(0.001)).toBeCloseTo(-60, 10);
    expect(linearToThresholdDb(0)).toBe(-890);
    expect(linearToThresholdDb(2)).toBe(0);
  });

  it('converts a denoiser gain floor to a positive reduction depth', () => {
    expect(gainFloorToReductionDb(0.1)).toBeCloseTo(20, 10);
    expect(gainFloorToReductionDb(0.05)).toBeCloseTo(26.0206, 4);
    expect(gainFloorToReductionDb(1)).toBe(0);
  });
});

describe('mastering overrides', () => {
  it('nests 1.x dotted keys under their 2.0 paths, units and tokens', () => {
    const { overrides, dropped } = upgradeMasteringOverrides(
      {
        'loudness.targetLufs': -14,
        'loudness.ceilingDb': -1,
        'maximizer.truePeakLimiter.ceilingDb': -0.5,
        'dynamics.deesser.bandpassQ': 2,
        'dynamics.compressor.detector': 2,
        'repair.declip.clipThreshold': 0.5,
        'repair.denoise.gainFloor': 0.1,
        'repair.denoise.mode': 1,
        'saturation.exciter.aliasing': 3,
        'eq.tilt.tiltDb': 1.5,
        'dynamics.multibandComp.lowRatio': 2,
        'dynamics.multibandComp.highAttackMs': 5,
        'dynamics.multibandComp.lowCutoffHz': 120,
        'dynamics.multibandComp.highCutoffHz': 4000,
        'dynamics.compressor.sidechainHpfEnabled': true,
        'dynamics.compressor.sidechainHpfHz': 80,
      },
      'pop',
      wasm,
    );
    const popBands = wasm.masteringPresetParams('pop').dynamics?.multibandComp?.bands ?? [];
    expect(popBands).toHaveLength(3);
    expect(dropped).toEqual([]);
    expect(overrides).toEqual({
      loudness: { targetLufs: -14, ceilingDbtp: -1 },
      maximizer: { truePeakLimiter: { ceilingDbtp: -0.5 } },
      dynamics: {
        deesser: { bandPassQ: 2 },
        compressor: { detector: 'logRms', sidechainHighPassHz: 80 },
        multibandComp: {
          bands: [{ ...popBands[0], ratio: 2 }, popBands[1], { ...popBands[2], attackMs: 5 }],
          crossover: { cutoffsHz: [120, 4000] },
        },
      },
      repair: {
        declip: { clipThresholdDb: linearToThresholdDb(0.5) },
        denoise: { reductionDb: gainFloorToReductionDb(0.1), mode: 'mmseStsa' },
      },
      saturation: { exciter: { aliasing: 'oversample4x' } },
      eq: { tilt: { tiltDb: 1.5 } },
    });
    expect(() => read(JSON.stringify({ version: 2, params: overrides }))).not.toThrow();
  });

  it('takes the crossover point 1.x left to the preset from the preset', () => {
    const cutoffs = wasm.masteringPresetParams('edm').dynamics?.multibandComp?.crossover?.cutoffsHz;
    const { overrides, dropped } = upgradeMasteringOverrides(
      { 'dynamics.multibandComp.lowCutoffHz': 150 },
      'edm',
      wasm,
    );
    expect(dropped).toEqual([]);
    expect(overrides).toEqual({
      dynamics: { multibandComp: { crossover: { cutoffsHz: [150, cutoffs?.[1]] } } },
    });
  });

  it('migrates every 1.x preset parameter set without a drop, onto the 2.0 preset values', () => {
    // masteringPresetParams of every preset, recorded from the 1.x core.
    const recorded: { keys: string[]; presets: Record<string, Array<number | boolean>> } =
      JSON.parse(
        readFileSync(`${process.cwd()}/tests/fixtures/mastering-preset-params-1x.json`, 'utf8'),
      );
    const presetNames = new Set<string>(wasm.masteringPresetNames());
    for (const [name, values] of Object.entries(recorded.presets)) {
      expect(presetNames.has(name), name).toBe(true);
      const flat = Object.fromEntries(recorded.keys.map((key, i) => [key, values[i]]));
      const { overrides, dropped } = upgradeMasteringOverrides(flat, name, wasm);
      expect(dropped, name).toEqual([]);
      const current = leaves(wasm.masteringPresetParams(name as wasm.MasteringPreset));
      for (const [path, value] of Object.entries(leaves(overrides))) {
        if (typeof value === 'number')
          expect(current[path], `${name} ${path}`).toBeCloseTo(value, 4);
        else expect(current[path], `${name} ${path}`).toEqual(value);
      }
    }
  });

  it('migrates the studio-only 1.x override spellings without a drop', () => {
    const { overrides, dropped } = upgradeMasteringOverrides(
      {
        'repair.reductionDb': 12,
        'repair.nFft': 2048,
        'repair.hopLength': 512,
        'repair.ddAlpha': 0.98,
        'repair.gainFloor': 0.1,
        'eq.tiltDb': 1,
        'eq.pivotHz': 1000,
      },
      'pop',
      wasm,
    );
    expect(dropped).toEqual([]);
    expect(overrides).toEqual({
      repair: {
        denoise: {
          reductionDb: gainFloorToReductionDb(0.1),
          nFft: 2048,
          hopLength: 512,
          ddAlpha: 0.98,
        },
      },
      eq: { tilt: { tiltDb: 1, pivotHz: 1000 } },
    });
  });

  it('drops only what 2.0 refuses or 1.x could not hold, and reports each with its reason', () => {
    const { overrides, dropped } = upgradeMasteringOverrides(
      {
        'retired.stage.knob': 1,
        'saturation.exciter.aliasing': 1,
        'loudness.targetLufs': 'loud',
        'dynamics.compressor.sidechainHpfEnabled': false,
        'dynamics.compressor.sidechainHpfHz': 80,
      },
      'pop',
      wasm,
    );
    expect(overrides).toEqual({});
    expect(dropped.map(({ key, value }) => [key, value])).toEqual([
      ['loudness.targetLufs', 'loud'],
      ['retired.stage.knob', 1],
      ['saturation.exciter.aliasing', 1],
    ]);
    for (const drop of dropped) expect(drop.reason).not.toBe('');
  });

  it('turns an enabled sidechain filter without a stored corner into the 1.x default', () => {
    expect(
      upgradeMasteringOverrides({ 'dynamics.compressor.sidechainHpfEnabled': true }, 'pop', wasm)
        .overrides,
    ).toEqual({ dynamics: { compressor: { sidechainHighPassHz: 100 } } });
  });
});

/** Every insert parameter 1.x spelled differently, keyed by its 1.x processor id. */
const RETIRED_INSERT_PARAMS: Record<string, Record<string, number | boolean>> = {
  'dynamics.compressor': { sidechainHpfEnabled: true, sidechainHpfHz: 120 },
  'dynamics.sidechainRouter': { sidechainHpfEnabled: true },
  'dynamics.deesser': { bandpassQ: 2 },
  'dynamics.gate': { keyHpfHz: 80 },
  'effects.acoustic.roomMorph': { maxSeconds: 2 },
  'effects.reverb.room': { maxSeconds: 2 },
  'effects.reverb.velvet': { reverbTimeS: 1.5 },
  'effects.reverb.dattorro': {},
  'effects.modulation.rotary': { accelTauS: 0.5, decelTauS: 1 },
  'effects.modulation.pitchShifter': { semitones: 3, cents: 5, semitones2: -3, cents2: -5 },
  'eq.pultec': {},
  'eq.apiStyle': {},
  'eq.dynamic': { 'band0.lookaheadMs': 2 },
  'eq.midSide': { 'sideBand3.lookaheadMs': 2 },
  'multiband.dynamicEq': { 'band2.dyn5.lookaheadMs': 2 },
  'maximizer.adaptiveRelease': { ceilingDb: -1 },
  'maximizer.truePeakLimiter': { ceilingDb: -1 },
  'repair.declip': { clipThreshold: 0.5 },
  'repair.trimSilence': { threshold: 0.001 },
  'voice.changer': { retuneSemitones: 2, eqHighpassHz: 90, retuneGrainSize: 512 },
};

function docWithInserts(inserts: Json[]): Json {
  return {
    schemaVersion: 4,
    tracks: [{ kind: 'audio', clips: [], mixer: { gainDb: 0, pan: 0, sends: [], inserts } }],
  };
}

function upgradedInserts(inserts: Json[]): Json[] {
  const out = upgradeDocumentToV5(docWithInserts(inserts), wasm).document;
  return ((out.tracks as Json[])[0].mixer as Json).inserts as Json[];
}

describe('insert slots', () => {
  it('lands every retired processor and parameter on a name the 2.0 catalog has', () => {
    const catalog = new Map(
      wasm
        .masteringProcessorCatalog()
        .map((entry) => [entry.id, new Set(entry.params.map((param) => param.name))]),
    );
    const slots = upgradedInserts(
      Object.entries(RETIRED_INSERT_PARAMS).map(([processor, params]) => ({
        processor,
        params,
        enabled: true,
      })),
    );
    for (const slot of slots) {
      const names = catalog.get(slot.processor as string);
      expect(names, String(slot.processor)).toBeDefined();
      for (const key of Object.keys(slot.params as Json)) {
        expect(names?.has(key), `${slot.processor}.${key}`).toBe(true);
      }
    }
  });

  it('converts values whose meaning changed with the name', () => {
    const [compressor, router, routerOff, declip, trim, voice, voiceAuto, dynEq] = upgradedInserts(
      [
        { processor: 'dynamics.compressor', params: { sidechainHpfEnabled: true } },
        { processor: 'dynamics.sidechainRouter', params: { sidechainHpfEnabled: true } },
        { processor: 'dynamics.sidechainRouter', params: { sidechainHpfHz: 200 } },
        { processor: 'repair.declip', params: { clipThreshold: 0.5 } },
        { processor: 'repair.trimSilence', params: { threshold: 0 } },
        { processor: 'voice.changer', params: { retuneGrainSize: 512 } },
        { processor: 'voice.changer', params: { retuneGrainSize: 0 } },
        { processor: 'eq.dynamic', params: { 'band0.lookaheadMs': 2, 'band0.detectorDelayMs': 5 } },
      ].map((slot) => ({ ...slot, enabled: true })),
    );
    expect(compressor.params).toEqual({ sidechainHighPassHz: 100 });
    expect(router.params).toEqual({ sidechainHighPassHz: 90 });
    expect(routerOff.params).toEqual({});
    expect(declip.params).toEqual({ clipThresholdDb: linearToThresholdDb(0.5) });
    expect(trim.params).toEqual({ thresholdDb: -890 });
    expect(voice.params).toEqual({ retuneGrainSizeSamples: 512 });
    expect(voiceAuto.params).toEqual({});
    expect(dynEq.params).toEqual({ 'band0.detectorDelayMs': 5 });
  });
});

function v4Document(): Json {
  const strip = (inserts: Json[], extra: Json = {}): Json => ({
    gainDb: 0,
    pan: 0,
    sends: [],
    inserts,
    ...extra,
  });
  return {
    schemaVersion: 4,
    tracks: [
      {
        kind: 'midi',
        instrument: {
          kind: 'synth-patch',
          patch: {
            preset: 'warm-pad',
            engineMode: 'karplus-strong',
            filterModel: 'moog-ladder',
            filterOutput: 'lowpass',
            body: 'wood-tube',
            sampleLoop: 'key-down',
            modRoutings: [{ source: 'mod-wheel', destination: 'cutoff-cents', amount: 1 }],
          },
        },
        mixer: strip(
          [
            { id: 'p-comp', processor: 'dynamics.compressor', params: {}, enabled: true },
            {
              id: 'p/pitch',
              processor: 'effects.modulation.pitchShifter',
              params: { semitones: 3 },
              enabled: true,
            },
          ],
          {
            panLaw: 'const3dB',
            eq: {
              bands: [
                {
                  type: 'LowShelf',
                  coeffMode: 'Rbj',
                  placement: 'Mid',
                  phase: 'LinearPhase',
                  lookaheadMs: 2,
                },
              ],
            },
            surroundPan: { azimuth: 30, divergence: 0, lfe: 0, elevation: 10, distance: 1 },
          },
        ),
        automation: [
          {
            param: `insert-id:${encodeURIComponent('p/pitch')}:semitones`,
            points: [{ ppq: 0, value: 0, curve: 's-curve' }],
            enabled: true,
          },
          { param: 'insert:1:cents', points: [], enabled: true },
          { param: 'faderDb', points: [{ ppq: 0, value: 0, curve: 'linear' }], enabled: true },
        ],
        clips: [
          {
            ccLanes: [{ controller: 1, points: [{ ppq: 0, value: 0, curve: 's-curve' }] }],
            midiTakes: [{ pitchBendLanes: [{ points: [{ ppq: 0, value: 0, curve: 's-curve' }] }] }],
          },
        ],
      },
    ],
    masterAutomation: [
      { param: 'mastering-id:p-tpl:ceilingDb', points: [], enabled: true },
      { param: 'mastering:0:ceilingDb', points: [], enabled: true },
    ],
    mixer: {
      master: strip([]),
      buses: [],
      masteringChain: {
        preset: 'pop',
        presetOverrides: { 'loudness.ceilingDb': -1 },
        processors: [
          {
            id: 'p-tpl',
            processor: 'maximizer.truePeakLimiter',
            params: { ceilingDb: -1 },
            enabled: true,
          },
        ],
      },
    },
    midiCcBindings: [
      {
        target: `insert-id:0:${encodeURIComponent('p/pitch')}:semitones`,
        channel: 0,
        controller: 1,
        trackScoped: true,
      },
      { target: 'insert:0:1:cents', channel: 0, controller: 2, trackScoped: true },
      { target: 'mastering-id:p-tpl:ceilingDb', channel: 0, controller: 3 },
      { target: 'mastering:0:ceilingDb', channel: 0, controller: 4 },
    ],
    mixerSnapshots: {
      slots: {
        A: {
          mixer: { master: strip([], { panLaw: 'linear0dB' }), buses: [] },
          tracks: [
            {
              trackIndex: 0,
              mixer: strip([
                {
                  id: 'snap-dattorro',
                  processor: 'effects.reverb.dattorro',
                  params: {},
                  enabled: true,
                },
                {
                  id: 'snap-pitch',
                  processor: 'effects.modulation.pitchShifter',
                  params: { cents: 5 },
                  enabled: true,
                },
              ]),
            },
          ],
          automationLanes: [{ target: 0, param: 'insert:1:cents', points: [], enabled: true }],
        },
      },
    },
  };
}

describe('document walk', () => {
  it('rewrites every 1.x token of a schema-4 document and marks it schema 5', () => {
    const input = v4Document();
    const before = structuredClone(input);
    const { document: out, dropped } = upgradeDocumentToV5(input, wasm);
    expect(dropped).toEqual([]);
    expect(input).toEqual(before);
    expect(out.schemaVersion).toBe(5);

    const track = (out.tracks as Json[])[0];
    expect(track.instrument).toEqual({
      kind: 'synth-patch',
      patch: {
        preset: 'warmPad',
        engineMode: 'karplusStrong',
        filterModel: 'transistorLadder',
        filterOutput: 'lowPass',
        body: 'woodTube',
        sampleLoop: 'keyDown',
        modRoutings: [{ source: 'modWheel', destination: 'cutoffCents', amount: 1 }],
      },
    });
    const mixer = track.mixer as Json;
    expect(mixer.panLaw).toBe('const3Db');
    expect(mixer.eq).toEqual({
      bands: [
        {
          type: 'lowShelf',
          coeffMode: 'rbj',
          placement: 'mid',
          phase: 'linearPhase',
          detectorDelayMs: 2,
        },
      ],
    });
    expect(mixer.surroundPan).toEqual({ azimuth: 30, divergence: 0, lfe: 0 });
    expect((mixer.inserts as Json[])[1].params as Json).toEqual({ pitchSemitones: 3 });

    expect((track.automation as Json[]).map((lane) => lane.param)).toEqual([
      `insert-id:${encodeURIComponent('p/pitch')}:pitchSemitones`,
      'insert:1:pitchCents',
      'faderDb',
    ]);
    expect(((track.automation as Json[])[0].points as Json[])[0].curve).toBe('sCurve');
    const clip = (track.clips as Json[])[0];
    expect((((clip.ccLanes as Json[])[0].points as Json[])[0] as Json).curve).toBe('sCurve');
    const take = (clip.midiTakes as Json[])[0];
    expect((((take.pitchBendLanes as Json[])[0].points as Json[])[0] as Json).curve).toBe('sCurve');

    expect((out.masterAutomation as Json[]).map((lane) => lane.param)).toEqual([
      'mastering-id:p-tpl:ceilingDbtp',
      'mastering:0:ceilingDbtp',
    ]);
    const chain = (out.mixer as Json).masteringChain as Json;
    expect(chain.presetOverrides).toEqual({ loudness: { ceilingDbtp: -1 } });
    expect((chain.processors as Json[])[0].params as Json).toEqual({ ceilingDbtp: -1 });

    expect((out.midiCcBindings as Json[]).map((binding) => binding.target)).toEqual([
      `insert-id:0:${encodeURIComponent('p/pitch')}:pitchSemitones`,
      'insert:0:1:pitchCents',
      'mastering-id:p-tpl:ceilingDbtp',
      'mastering:0:ceilingDbtp',
    ]);

    const snapshot = ((out.mixerSnapshots as Json).slots as Json).A as Json;
    expect(((snapshot.mixer as Json).master as Json).panLaw).toBe('linear0Db');
    const snapshotInserts = ((snapshot.tracks as Json[])[0].mixer as Json).inserts as Json[];
    expect(snapshotInserts.map((slot) => slot.processor)).toEqual([
      'effects.reverb.plate',
      'effects.modulation.pitchShifter',
    ]);
    expect(snapshotInserts[1].params).toEqual({ pitchCents: 5 });
    expect((snapshot.automationLanes as Json[])[0].param).toBe('insert:1:pitchCents');
  });

  it('reports each dropped override with the document path it was stored under', () => {
    const { document, dropped } = upgradeDocumentToV5(
      {
        schemaVersion: 4,
        tracks: [],
        mixer: {
          masteringChain: { preset: 'pop', presetOverrides: { 'retired.knob': 1 }, processors: [] },
        },
        mixerSnapshots: {
          slots: {
            B: {
              mixer: {
                masteringChain: {
                  preset: 'pop',
                  presetOverrides: { 'loudness.targetLufs': -12, 'retired.knob': 2 },
                  processors: [],
                },
              },
            },
          },
        },
      },
      wasm,
    );
    expect(dropped.map(({ location, key, value }) => [location, key, value])).toEqual([
      ['mixer.masteringChain.presetOverrides', 'retired.knob', 1],
      ['mixerSnapshots.slots.B.mixer.masteringChain.presetOverrides', 'retired.knob', 2],
    ]);
    const slot = ((document.mixerSnapshots as Json).slots as Json).B as Json;
    expect(((slot.mixer as Json).masteringChain as Json).presetOverrides).toEqual({
      loudness: { targetLufs: -12 },
    });
  });

  it('pins a pre-v4 default instrument to the 2.0 spelling of the 1.x electric piano', () => {
    const { document: doc } = upgradeProjectDocument({
      schemaVersion: 2,
      tracks: [{ kind: 'midi', clips: [] }],
    } as unknown as ProjectDocument);
    expect(doc.schemaVersion).toBe(5);
    expect(doc.tracks[0].instrument).toEqual({ kind: 'synth-preset', preset: 'ePiano' });
    expect(wasm.synthPresetNames()).toContain('ePiano');
  });

  it('maps 1.x kebab-case preset names onto the 2.0 preset list', () => {
    const names = new Set<string>(wasm.synthPresetNames());
    for (const name of ['e-piano', 'warm-pad', 'acoustic-piano', 'church-organ']) {
      expect(names.has(upgradePresetName(name)), name).toBe(true);
    }
    expect(upgradePresetName('va:warm-pad')).toBe('va:warmPad');
  });
});

describe('track presets', () => {
  it('upgrades a version-1 preset strip and instrument to version 2', () => {
    const out = upgradeTrackPresetToV2({
      schemaVersion: 1,
      name: 'Legacy',
      strip: {
        gainDb: 0,
        pan: 0,
        panLaw: 'const6dB',
        sends: [],
        inserts: [{ processor: 'eq.pultec', params: {}, enabled: true }],
      },
      instrument: { kind: 'synth-patch', patch: { filterModel: 'moog-ladder' } },
    });
    expect(out).toEqual({
      schemaVersion: 2,
      name: 'Legacy',
      strip: {
        gainDb: 0,
        pan: 0,
        panLaw: 'const6Db',
        sends: [],
        inserts: [{ processor: 'eq.passiveTube', params: {}, enabled: true }],
      },
      instrument: { kind: 'synth-patch', patch: { filterModel: 'transistorLadder' } },
    });
  });
});
