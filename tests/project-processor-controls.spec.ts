import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { InsertSlot } from '@/project/mixer';
import {
  catalogParamInfo,
  choiceLabel,
  insertAutomationDomain,
  type ProcessorParamInfo,
  processorControl,
  processorControlSpec,
  processorNumberSpec,
} from '@/project/processor-controls';
import { setWasmModule } from '@/project/runtime';
import * as core from '@/wasm/index.js';

/** Strip-shaped value carrying a single insert slot. */
function stripWith(processor: string): { inserts: InsertSlot[] } {
  return { inserts: [{ processor, params: {}, enabled: true }] };
}

function info(overrides: Partial<ProcessorParamInfo> & { name: string }): ProcessorParamInfo {
  return { type: 'number', ...overrides };
}

describe('processorNumberSpec', () => {
  it('takes the default from the catalog, inside the display window', () => {
    const spec = processorNumberSpec(
      'dynamics.compressor',
      'thresholdDb',
      info({ name: 'thresholdDb', default: -18, unit: 'dB' }),
    );
    expect(spec).toMatchObject({ min: -60, max: 0, defaultValue: -18, unit: 'dB' });
  });

  it('narrows the display window to the catalog bounds', () => {
    const spec = processorNumberSpec(
      'custom.processor',
      'toneHz',
      info({ name: 'toneHz', min: 100, max: 8000, default: 440 }),
    );
    expect(spec).toMatchObject({ min: 100, max: 8000, scale: 'log', defaultValue: 440 });
  });

  it('uses the catalog bounds whole for a parameter the app does not describe', () => {
    const spec = processorNumberSpec(
      'custom.processor',
      'amount',
      info({ name: 'amount', min: -2, max: 2, default: 0.5 }),
    );
    expect(spec).toMatchObject({ min: -2, max: 2, defaultValue: 0.5 });
  });

  it('keeps the heuristic window when the catalog publishes no bounds', () => {
    const withoutInfo = processorNumberSpec('custom.processor', 'releaseMs');
    const withNullBounds = processorNumberSpec(
      'custom.processor',
      'releaseMs',
      info({ name: 'releaseMs' }),
    );
    expect(withNullBounds).toEqual(withoutInfo);
  });

  it('keeps the display window when the catalog bounds would empty it', () => {
    const spec = processorNumberSpec(
      'custom.processor',
      'gainDb',
      info({ name: 'gainDb', min: 30, max: 40 }),
    );
    expect(spec).toMatchObject({ min: -24, max: 24 });
  });
});

describe('processorControlSpec', () => {
  it('reads a boolean default from the catalog', () => {
    expect(
      processorControlSpec(
        'custom.processor',
        'enabled',
        info({ name: 'enabled', type: 'boolean', default: true }),
      ),
    ).toEqual({ kind: 'boolean', defaultValue: true });
    expect(
      processorControlSpec('custom.processor', 'bypass', info({ name: 'bypass', type: 'boolean' })),
    ).toEqual({ kind: 'boolean', defaultValue: false });
  });

  it('builds a menu from the catalog choices, defaulting to the declared value', () => {
    expect(
      processorControlSpec(
        'saturation.softClipper',
        'aliasing',
        info({
          name: 'aliasing',
          type: 'enum',
          default: 3,
          choices: [
            { name: 'none', value: 0 },
            { name: 'oversample4x', value: 3 },
          ],
        }),
      ),
    ).toEqual({
      kind: 'enum',
      options: [
        { value: 'none', label: 'None' },
        { value: 'oversample4x', label: '4x Oversampling' },
      ],
      defaultValue: 'oversample4x',
    });
  });

  it('offers a numeric setting with gaps as a menu of its accepted values', () => {
    const spec = processorControlSpec(
      'saturation.tape',
      'oversampleFactor',
      info({
        name: 'oversampleFactor',
        default: 1,
        choices: [
          { name: '1', value: 1 },
          { name: '4', value: 4 },
        ],
      }),
    );
    expect(spec).toMatchObject({ kind: 'enum', defaultValue: 1 });
  });

  it('gives no control to an embedded string or array setting', () => {
    expect(
      processorControlSpec(
        'effects.reverb.convolution',
        'ir',
        info({ name: 'ir', type: 'string' }),
      ),
    ).toBeNull();
    expect(
      processorControlSpec('eq.dynamic', 'bands', info({ name: 'bands', type: 'array' })),
    ).toBeNull();
  });
});

describe('choiceLabel', () => {
  it('reads slopes, acronyms and camelCase names', () => {
    expect(choiceLabel('db24PerOct')).toBe('24 dB/oct');
    expect(choiceLabel('lr4')).toBe('LR4');
    expect(choiceLabel('lowShelf')).toBe('Low Shelf');
    expect(choiceLabel('veryHigh')).toBe('Very High');
    expect(choiceLabel('guitar1x12Combo')).toBe('Guitar 1x12 Combo');
    expect(choiceLabel('guitar2x12Open')).toBe('Guitar 2x12 Open-Back');
  });
});

describe('insertAutomationDomain', () => {
  it('resolves the addressed slot processor parameter domain', () => {
    expect(
      insertAutomationDomain(stripWith('dynamics.compressor'), 'insert:0:thresholdDb'),
    ).toEqual({ min: -60, max: 0, unit: 'dB' });
  });

  it('returns undefined for a fader/pan param', () => {
    expect(insertAutomationDomain(stripWith('dynamics.compressor'), 'faderDb')).toBeUndefined();
    expect(insertAutomationDomain(stripWith('dynamics.compressor'), 'pan')).toBeUndefined();
  });

  it('returns undefined when the strip or the addressed slot is absent', () => {
    expect(insertAutomationDomain(undefined, 'insert:0:thresholdDb')).toBeUndefined();
    expect(
      insertAutomationDomain(stripWith('dynamics.compressor'), 'insert:3:thresholdDb'),
    ).toBeUndefined();
  });

  it('draws an uncatalogued parameter in the range its rack control uses', () => {
    expect(insertAutomationDomain(stripWith('custom.processor'), 'insert:0:detector')).toEqual({
      min: 0,
      max: 1,
      unit: '',
    });
    expect(insertAutomationDomain(stripWith('custom.processor'), 'insert:0:releaseMs')).toEqual({
      min: 0,
      max: 5000,
      unit: 'ms',
    });
  });
});

describe('closed-set parameters on the real catalog', () => {
  beforeAll(async () => {
    await core.init({ wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`) });
    setWasmModule(core);
  });

  it('shows the name a core scene preset stores, not the default', () => {
    const inserts = core
      .mixingScenePresetNames()
      .flatMap((name) => sceneInsertsOf(core.mixingScenePreset(name)));
    const named = inserts.flatMap(({ processor, params }) =>
      Object.entries(params)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => ({ processor, key, value })),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const { processor, key, value } of named) {
      const info = catalogParamInfo(processor).find((entry) => entry.name === key);
      expect(processorControl(processor, key, value, info)).toMatchObject({ kind: 'enum', value });
    }
  });

  it('defaults a closed-set parameter to the name of the catalog default', () => {
    const info = catalogParamInfo('dynamics.compressor').find((entry) => entry.name === 'detector');
    expect(processorControl('dynamics.compressor', 'detector', undefined, info)).toMatchObject({
      value: 'rms',
      defaultValue: 'rms',
    });
  });
});

/** Every insert slot a mixing scene document carries, wherever it sits. */
function sceneInsertsOf(
  doc: unknown,
): Array<{ processor: string; params: Record<string, unknown> }> {
  if (Array.isArray(doc)) return doc.flatMap(sceneInsertsOf);
  if (typeof doc !== 'object' || doc === null) return [];
  const record = doc as Record<string, unknown>;
  const own =
    typeof record.processor === 'string' && typeof record.params === 'object' && record.params
      ? [{ processor: record.processor, params: record.params as Record<string, unknown> }]
      : [];
  return [...own, ...Object.values(record).flatMap(sceneInsertsOf)];
}
