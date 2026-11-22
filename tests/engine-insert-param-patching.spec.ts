import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { insertNumericParams, insertParamStructure } from '@/engine/insert-param-patching';
import type { InsertSlot } from '@/project/mixer';
import { setWasmModule } from '@/project/runtime';
import * as core from '@/wasm/index.js';

beforeAll(async () => {
  await core.init({ wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`) });
  setWasmModule(core);
});

describe('realtime insert params', () => {
  const compressor: InsertSlot = {
    processor: 'dynamics.compressor',
    params: { detector: 'logRms', thresholdDb: -20 },
    enabled: true,
  };

  it('sends a realtime closed-set parameter as the value its catalog name stands for', () => {
    expect(insertNumericParams([compressor])).toEqual([{ detector: 2, thresholdDb: -20 }]);
  });

  it('keeps a realtime closed-set parameter out of the strip structure', () => {
    expect(insertParamStructure(compressor)).toEqual({});
  });

  it('patches a top-level realtime number without marking the strip structure', () => {
    const slot: InsertSlot = {
      processor: 'dynamics.compressor',
      params: { thresholdDb: -20 },
      enabled: true,
    };
    expect(insertParamStructure(slot)).toEqual({});
    expect(insertNumericParams([slot])).toEqual([{ thresholdDb: -20 }]);
  });

  it('rebuilds for a closed-set parameter the engine reads only while building', () => {
    const eq: InsertSlot = {
      processor: 'eq.parametric',
      params: { 'band0.type': 'highPass' },
      enabled: true,
    };
    expect(insertParamStructure(eq)).toEqual({ 'band0.type': 'highPass' });
  });
});
