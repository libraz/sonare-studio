import { describe, expect, it, vi } from 'vitest';

const ensureWasmMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/wasm', () => ({ ensureWasm: ensureWasmMock }));

import { createWasmMixdownDeps } from '@/export/mixdown';

describe('mixdown WASM metering adapter', () => {
  it('preserves absent dynamic range separately from a measured infinite range', async () => {
    const samples = new Float32Array([0, 0.25]);
    const sampleRate = 48000;

    const absentMeasurement = vi.fn(() => ({ windowRmsDb: new Float32Array(0) }));
    ensureWasmMock.mockResolvedValueOnce({ meteringDynamicRange: absentMeasurement });
    const absentDeps = await createWasmMixdownDeps();
    expect(absentDeps.metering?.dynamicRangeDb?.(samples, sampleRate)).toBeUndefined();
    expect(absentMeasurement).toHaveBeenCalledWith(samples, sampleRate);

    const infiniteMeasurement = vi.fn(() => ({
      dynamicRangeDb: Number.POSITIVE_INFINITY,
      windowRmsDb: new Float32Array([Number.NEGATIVE_INFINITY, -12]),
    }));
    ensureWasmMock.mockResolvedValueOnce({ meteringDynamicRange: infiniteMeasurement });
    const infiniteDeps = await createWasmMixdownDeps();
    expect(infiniteDeps.metering?.dynamicRangeDb?.(samples, sampleRate)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(infiniteMeasurement).toHaveBeenCalledWith(samples, sampleRate);
  });
});
