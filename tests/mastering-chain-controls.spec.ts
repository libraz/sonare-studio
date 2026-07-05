import { describe, expect, it } from 'vitest';
import type { InsertSlot } from '@/project/mixer';
import { clampControlValue, masteringProcessorControls } from '@/ui/mastering/chain-controls';

function slot(processor: string, params: Record<string, number> = {}): InsertSlot {
  return { processor, params, enabled: true };
}

describe('mastering chain controls', () => {
  it('prefers processor-specific insert domains over name heuristics', () => {
    const controls = masteringProcessorControls(
      slot('dynamics.compressor', { thresholdDb: -18 }),
      () => ['thresholdDb', 'attackMs', 'releaseMs', 'makeupGainDb'],
    );

    expect(controls.find((c) => c.id === 'thresholdDb')).toMatchObject({
      value: -18,
      min: -60,
      max: 0,
      unit: 'dB',
    });
    expect(controls.find((c) => c.id === 'attackMs')).toMatchObject({
      value: 10,
      min: 0,
      max: 200,
      unit: 'ms',
    });
    expect(controls.find((c) => c.id === 'releaseMs')).toMatchObject({
      min: 0,
      max: 2000,
      unit: 'ms',
    });
    expect(controls.find((c) => c.id === 'makeupGainDb')).toMatchObject({
      min: -12,
      max: 24,
      unit: 'dB',
    });
  });

  it('keeps name heuristics only for unknown custom processors', () => {
    const controls = masteringProcessorControls(slot('custom.weird'), () => [
      'resonanceQ',
      'q',
      'quantize',
      'quality',
    ]);

    expect(controls.find((c) => c.id === 'resonanceQ')).toMatchObject({ min: 0.1, max: 18 });
    expect(controls.find((c) => c.id === 'q')).toMatchObject({ min: 0.1, max: 18 });
    expect(controls.find((c) => c.id === 'quantize')).toMatchObject({ min: 0, max: 1 });
    expect(controls.find((c) => c.id === 'quality')).toMatchObject({ min: 0, max: 1 });
  });

  it('uses the resolved control range for clamping', () => {
    const [control] = masteringProcessorControls(slot('dynamics.compressor'), () => ['attackMs']);

    expect(clampControlValue(control, 900)).toBe(200);
    expect(clampControlValue(control, -5)).toBe(0);
  });
});
