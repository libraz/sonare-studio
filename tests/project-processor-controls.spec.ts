import { describe, expect, it } from 'vitest';
import type { InsertSlot } from '@/project/mixer';
import {
  choiceLabel,
  insertAutomationDomain,
  type ProcessorParamInfo,
  processorControlSpec,
  processorControls,
  processorNumberSpec,
} from '@/project/processor-controls';

/** Strip-shaped value carrying a single insert slot. */
function stripWith(processor: string): { inserts: InsertSlot[] } {
  return { inserts: [{ processor, params: {}, enabled: true }] };
}

function info(overrides: Partial<ProcessorParamInfo> & { name: string }): ProcessorParamInfo {
  return { type: 'number', unit: null, min: null, max: null, default: null, ...overrides };
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
      processorControlSpec(
        'custom.processor',
        'bypass',
        info({ name: 'bypass', type: 'boolean', default: null }),
      ),
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
        { value: 0, label: 'None' },
        { value: 3, label: '4x Oversampling' },
      ],
      defaultValue: 3,
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

describe('processorControls band slots', () => {
  const bandNames = (prefix: string, count: number): string[] =>
    Array.from({ length: count }, (_, index) => [
      `${prefix}${index}.frequencyHz`,
      `${prefix}${index}.gainDb`,
      `${prefix}${index}.q`,
    ]).flat();

  it('shows the bands in use plus the frequency of the next free band', () => {
    const controls = processorControls('eq.parametric', bandNames('band', 4), {
      'band0.frequencyHz': 120,
      'band2.frequencyHz': 4000,
    });
    expect(controls.map((control) => control.id)).toEqual([
      'band0.frequencyHz',
      'band0.gainDb',
      'band0.q',
      'band1.frequencyHz',
      'band2.frequencyHz',
      'band2.gainDb',
      'band2.q',
    ]);
  });

  it('offers a free band per mid/side family', () => {
    const controls = processorControls(
      'eq.midSide',
      [...bandNames('midBand', 2), ...bandNames('sideBand', 2)],
      { 'midBand0.frequencyHz': 300 },
    );
    expect(controls.map((control) => control.id)).toEqual([
      'midBand0.frequencyHz',
      'midBand0.gainDb',
      'midBand0.q',
      'midBand1.frequencyHz',
      'sideBand0.frequencyHz',
    ]);
  });

  it('keeps every crossover band of a multiband processor', () => {
    const names = ['band0.thresholdDb', 'band1.thresholdDb', 'band2.thresholdDb'];
    expect(
      processorControls('multiband.compressor', names, {}).map((control) => control.id),
    ).toEqual(names);
  });
});
