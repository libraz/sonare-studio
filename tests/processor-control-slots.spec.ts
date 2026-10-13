import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  catalogParamInfo,
  catalogSlots,
  editedProcessorParams,
  InsertConfigurationRefusedError,
  processorControls,
} from '@/project/processor-controls';
import * as wasm from '@/wasm/index.js';

// Which keys exist only under a condition is the engine catalog's to say.
vi.mock('@/project/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/project/runtime')>()),
  getWasmModule: () => wasm,
}));

beforeAll(async () => {
  const wasmBinary = readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`);
  await wasm.init({ wasmBinary } as Parameters<typeof wasm.init>[0]);
});

function rack(processor: string, params: Record<string, number | boolean>) {
  const info = catalogParamInfo(processor);
  return processorControls(
    processor,
    info.map((entry) => entry.name),
    params,
    info,
    catalogSlots(processor),
  );
}

function slotIds(processor: string, params: Record<string, number | boolean>): string[] {
  return rack(processor, params)
    .map((control) => control.id)
    .filter((id) => /^(band|midBand|sideBand)\d/u.test(id));
}

function keysOf(processor: string, slot: string): string[] {
  return catalogParamInfo(processor)
    .filter((entry) => entry.slot === slot)
    .map((entry) => entry.name);
}

describe('processorControls slots', () => {
  it('shows the EQ bands any key built, plus the frequency of the next free band', () => {
    const ids = slotIds('eq.parametric', { 'band0.frequencyHz': 120, 'band2.gainDb': -3 });
    expect(new Set(ids)).toEqual(
      new Set([
        ...keysOf('eq.parametric', 'band0'),
        'band1.frequencyHz',
        ...keysOf('eq.parametric', 'band2'),
      ]),
    );
  }, 60_000); // The first catalog lookup also pays for cold WASM metadata initialization in the full suite.

  it('offers a free band per mid/side family', () => {
    const ids = slotIds('eq.midSide', { 'midBand0.gainDb': 2 });
    expect(new Set(ids)).toEqual(
      new Set([
        ...keysOf('eq.midSide', 'midBand0'),
        'midBand1.frequencyHz',
        'sideBand0.frequencyHz',
      ]),
    );
  });

  it('shows the crossover bands of the default split and offers the next cutoff above it', () => {
    const controls = rack('multiband.compressor', {});
    const ids = controls.map((control) => control.id);
    expect(ids).toContain('band2.thresholdDb');
    expect(ids).not.toContain('band3.thresholdDb');
    expect(ids.filter((id) => id.startsWith('cutoff'))).toEqual([
      'cutoff0Hz',
      'cutoff1Hz',
      'cutoff2Hz',
    ]);
    const added = controls.find((control) => control.id === 'cutoff2Hz');
    expect(added?.kind === 'number' && added.value).toBeGreaterThan(2000);
  });

  it('offers a dynamic sub-band inside every crossover band that exists', () => {
    const ids = rack('multiband.dynamicEq', { 'band1.dyn0.frequencyHz': 500 }).map(
      (control) => control.id,
    );
    expect(ids).toEqual(expect.arrayContaining(keysOf('multiband.dynamicEq', 'band1.dyn0')));
    expect(ids).toEqual(
      expect.arrayContaining([
        'band0.dyn0.frequencyHz',
        'band1.dyn1.frequencyHz',
        'band2.dyn0.frequencyHz',
      ]),
    );
    expect(ids).not.toContain('band3.dyn0.frequencyHz');
  });
});

describe('editedProcessorParams', () => {
  it('keeps the default split when the first cutoff is supplied', () => {
    const params = editedProcessorParams('multiband.compressor', {}, 'cutoff2Hz', 8000);
    expect(params).toEqual({ cutoff0Hz: 120, cutoff1Hz: 2000, cutoff2Hz: 8000 });
    expect(() => wasm.masteringInsertTiming('multiband.compressor', params, 48000)).not.toThrow();
    expect(rack('multiband.compressor', params).map((control) => control.id)).toContain(
      'band3.thresholdDb',
    );
  });

  it('writes only the edited key once cutoffs are supplied, and for any other key', () => {
    expect(
      editedProcessorParams('multiband.compressor', { cutoff0Hz: 300 }, 'cutoff0Hz', 250),
    ).toEqual({ cutoff0Hz: 250 });
    expect(editedProcessorParams('multiband.compressor', {}, 'band0.ratio', 3)).toEqual({
      'band0.ratio': 3,
    });
  });
});

describe('coupled keys', () => {
  const room = 'effects.reverb.room';

  it('lets the engine judge a room size its placement allows', () => {
    const placed = editedProcessorParams(
      room,
      { sourceX: 1, sourceY: 1, listenerX: 2 },
      'listenerY',
      2,
    );
    // Under the bound measured with the default placement, but the moved placement fits.
    expect(editedProcessorParams(room, placed, 'lengthM', 3)).toMatchObject({ lengthM: 3 });
  });

  it('refuses a value the engine rejects with its coupled keys', () => {
    const small = { lengthM: 5.2, widthM: 4.3 };
    let refused: unknown;
    try {
      editedProcessorParams(room, small, 'receiverSpacingM', 2.5);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(InsertConfigurationRefusedError);
    expect((refused as InsertConfigurationRefusedError).related).toContain('lengthM');
  });

  it('does not send keys a configuration leaves unread', () => {
    const withUnusedBand = { 'band3.ratio': 2 };
    expect(editedProcessorParams('multiband.compressor', withUnusedBand, 'mode', 3)).toMatchObject({
      mode: 3,
    });
  });

  it('draws a coupled key from its stated bounds without clamping to them', () => {
    const length = rack(room, {}).find((control) => control.id === 'lengthM');
    expect(length).toMatchObject({
      kind: 'number',
      coupledWith: expect.arrayContaining(['listenerX']),
    });
    expect(length && 'accepts' in length ? length.accepts : undefined).toBeUndefined();
  });
});
