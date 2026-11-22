import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATABLE_SYNTH_PARAMS,
  type StoredSynthPatch,
  synthParamReachesSoundingVoices,
  validateTrackInstrument,
} from '@/project/instrument';
import { setWasmModule } from '@/project/runtime';
import {
  clampEngineParams,
  createPatchDraft,
  engineParamBlockers,
  engineParamStep,
  humanizeEngineParamName,
  PATCH_FIELD_SPECS,
  patchEditCount,
  patchFieldSpec,
  sanitizePatchDraft,
  wasmEngineParamInfo,
} from '@/ui/devices/patch-draft';
import * as wasm from '@/wasm/index.js';

beforeAll(async () => {
  await wasm.init({
    wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`),
  } as Parameters<typeof wasm.init>[0]);
  setWasmModule(wasm as unknown as Parameters<typeof setWasmModule>[0]);
});

/** Binds the patch on a real engine, which throws on anything it refuses. */
function acceptedByEngine(patch: StoredSynthPatch): void {
  const engine = new wasm.RealtimeEngine({ sampleRate: 48000, maxBlockSize: 512 });
  engine.setTrackLanes([{ trackId: 1 }]);
  engine.setSynthInstrument(1, patch);
}

const NEW_TIMES = ['ampDelayMs', 'ampHoldMs', 'filterDelayMs', 'filterHoldMs'] as const;

describe('new wrapper fields', () => {
  it('spec ranges match the library descriptors', () => {
    const info = wasm.synthPatchParamInfo();
    for (const id of ['driftRateHz', ...NEW_TIMES]) {
      const spec = patchFieldSpec(id);
      const entry = info.find((e) => e.name === id);
      expect(spec, id).not.toBeNull();
      expect(entry, id).toBeDefined();
      expect([spec?.min, spec?.max]).toEqual([entry?.min, entry?.max]);
    }
  });

  it('are automatable but only apply at the next envelope stage', () => {
    for (const id of ['driftRateHz', ...NEW_TIMES]) {
      expect(AUTOMATABLE_SYNTH_PARAMS).toContain(id);
      expect(synthParamReachesSoundingVoices(id)).toBe(false);
    }
  });

  it('every automatable synth param has an editor spec', () => {
    for (const id of AUTOMATABLE_SYNTH_PARAMS) {
      expect(
        PATCH_FIELD_SPECS.some((spec) => spec.id === id),
        id,
      ).toBe(true);
    }
  });

  it('round-trips through sanitize and the library', () => {
    const patch = sanitizePatchDraft({
      preset: 'violin',
      engineMode: 'bowedString',
      driftRateHz: 99,
      ampDelayMs: 10,
      ampHoldMs: -4,
      filterDelayMs: 20,
      filterHoldMs: 30,
      oneShot: true,
    });
    expect(patch).toMatchObject({
      driftRateHz: 20,
      ampDelayMs: 10,
      ampHoldMs: 0,
      filterDelayMs: 20,
      filterHoldMs: 30,
      oneShot: true,
    });
    expect(() => acceptedByEngine(patch)).not.toThrow();
  });

  it('keeps an explicit oneShot off so it can override a one-shot base', () => {
    expect(sanitizePatchDraft({ oneShot: false }).oneShot).toBe(false);
    expect(sanitizePatchDraft({}).oneShot).toBeUndefined();
  });

  it('seeds the draft from the preset base', () => {
    const draft = createPatchDraft({ kind: 'synth-preset', preset: 'violin' }, (name) =>
      wasm.synthPresetPatch(name),
    );
    expect(draft.driftRateHz).toBeCloseTo(0.3);
    expect(draft.ampDelayMs).toBe(0);
    expect(draft.oneShot).toBe(false);
  });
});

describe('engineParams', () => {
  it('clamps and rounds to the descriptor, then the library accepts the patch', () => {
    const patch = sanitizePatchDraft({
      engineMode: 'fm',
      engineParams: { algorithm: 9.4, 'ops0.ratio': -3, 'ops0.level': 2 },
    });
    expect(patch.engineParams).toEqual({ algorithm: 5, 'ops0.ratio': 0, 'ops0.level': 2 });
    expect(() => acceptedByEngine(patch)).not.toThrow();
  });

  it('maps booleans to 0/1 and drops non-finite values', () => {
    const patch = sanitizePatchDraft({
      engineMode: 'bowedString',
      engineParams: { elastoPlastic: 0.7, bowForce: Number.NaN },
    });
    expect(patch.engineParams).toEqual({ elastoPlastic: 1 });
  });

  it('drops keys the engine does not list', () => {
    const patch = sanitizePatchDraft({
      engineMode: 'bowedString',
      engineParams: { bowForce: 0.9, algorithm: 3, bogus: 1 },
    });
    expect(patch.engineParams).toEqual({ bowForce: 0.9 });
  });

  it('drops everything for engines without a model section', () => {
    expect(
      sanitizePatchDraft({ engineMode: 'subtractive', engineParams: { bowForce: 0.9 } })
        .engineParams,
    ).toBeUndefined();
    expect(sanitizePatchDraft({ engineParams: { bowForce: 0.9 } }).engineParams).toBeUndefined();
  });

  it('prunes when the engine changes', () => {
    const params = { bowForce: 0.9, algorithm: 3 };
    expect(clampEngineParams(params, wasmEngineParamInfo('fm'))).toEqual({ algorithm: 3 });
    expect(clampEngineParams(params, wasmEngineParamInfo('bowedString'))).toEqual({
      bowForce: 0.9,
    });
  });

  it('is carried from a stored patch into the draft and counted as an edit', () => {
    const draft = createPatchDraft({
      kind: 'synth-patch',
      patch: { engineMode: 'bowedString', engineParams: { bowForce: 0.3, junk: Number.NaN } },
    });
    expect(draft.engineParams).toEqual({ bowForce: 0.3 });
    expect(patchEditCount(draft)).toBe(2);
  });

  it('validates the stored shape', () => {
    const base = { kind: 'synth-patch' as const };
    expect(() =>
      validateTrackInstrument({ ...base, patch: { engineParams: { bowForce: 0.5 } } }),
    ).not.toThrow();
    expect(() =>
      validateTrackInstrument({ ...base, patch: { engineParams: { bowForce: Number.NaN } } }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({
        ...base,
        patch: { engineParams: [] as unknown as Record<string, number> },
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({ ...base, patch: { oneShot: 1 as unknown as boolean } }),
    ).toThrow(RangeError);
  });

  it('humanizes keys and picks steps', () => {
    expect(humanizeEngineParamName('bowForce')).toBe('Bow Force');
    expect(humanizeEngineParamName('ranks2.level')).toBe('Ranks 2 · Level');
    expect(humanizeEngineParamName('fm.algorithm')).toBe('Fm · Algorithm');
    const info = wasmEngineParamInfo('fm');
    expect(engineParamStep(info.find((e) => e.name === 'algorithm') ?? info[0])).toBe(1);
    expect(
      engineParamStep({ name: 'x', type: 'number', min: 0, max: 1, default: 0, unit: 'none' }),
    ).toBe(0.001);
  });
});

describe('engine fields that do not reach the voice', () => {
  const engine = (mode: string) => wasm.synthEngineParamInfo(mode as never);
  const field = (mode: string, name: string) => {
    const info = engine(mode).find((entry) => entry.name === name);
    if (!info) throw new Error(`${mode} lists no ${name}`);
    return info;
  };
  const patchInfo = () => wasm.synthPatchParamInfo();

  it('names every unmet condition, base values included', () => {
    const info = field('percussion', 'noiseBurstCount');
    expect(engineParamBlockers(info, {}, engine('percussion'), patchInfo())).toEqual([
      expect.objectContaining({ key: 'gmKit', relation: 'eq', value: false }),
      expect.objectContaining({ key: 'noiseGain', relation: 'gt', value: 0 }),
    ]);
    const kitOff: StoredSynthPatch = { engineParams: { gmKit: 0 } };
    expect(engineParamBlockers(info, kitOff, engine('percussion'), patchInfo())).toEqual([
      expect.objectContaining({ key: 'noiseGain' }),
    ]);
    const custom: StoredSynthPatch = { engineParams: { gmKit: 0, noiseGain: 0.5 } };
    expect(engineParamBlockers(info, custom, engine('percussion'), patchInfo())).toBeNull();
  });

  it('reads patch fields and their defaults for a patch-scoped condition', () => {
    const info = field('bowedString', 'corpusScale');
    const blocked = engineParamBlockers(info, {}, engine('bowedString'), patchInfo());
    expect(blocked?.map((condition) => condition.key)).toEqual(['body', 'bodyMix']);
    const violin: StoredSynthPatch = { body: 'violin', bodyMix: 0.5 } as StoredSynthPatch;
    expect(engineParamBlockers(info, violin, engine('bowedString'), patchInfo())).toBeNull();
  });

  it('leaves an ungated field active', () => {
    const info = engine('bowedString').find((entry) => entry.activeWhen === undefined);
    expect(info).toBeDefined();
    if (info) expect(engineParamBlockers(info, {}, engine('bowedString'), patchInfo())).toBeNull();
  });
});
