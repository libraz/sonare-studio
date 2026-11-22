import * as wasm from '@libraz/libsonare';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATABLE_SYNTH_PARAMS } from '@/project/instrument';
import { patchFieldSpec } from '@/ui/devices/patch-draft';
import { coreWasmBinary } from './core-package';

// Checked against the real engine: its parameterInfo describes every hosted
// instrument parameter, which a stub cannot.
beforeAll(async () => {
  const wasmBinary = coreWasmBinary();
  await wasm.init({ wasmBinary } as Parameters<typeof wasm.init>[0]);
});

describe('instrument automation parameters', () => {
  it('are realtime-safe engine parameters whose editor range the engine accepts', () => {
    const engine = new wasm.RealtimeEngine({ sampleRate: 48000, maxBlockSize: 512 });
    engine.setTrackLanes([{ trackId: 1 }]);
    engine.setSynthInstrument(1, { preset: 'sawLead' });
    for (const name of AUTOMATABLE_SYNTH_PARAMS) {
      const id = engine.resolveInstrumentAutomationId(1, name);
      expect(id, name).toBeGreaterThanOrEqual(0);
      const info = engine.parameterInfo(id);
      expect(info.rtSafe, name).toBe(true);
      const spec = patchFieldSpec(name);
      expect(spec, name).not.toBeNull();
      expect(spec?.min, name).toBeGreaterThanOrEqual(info.minValue);
      expect(spec?.max, name).toBeLessThanOrEqual(info.maxValue);
    }
  });
});
