import { describe, expect, it } from 'vitest';
import {
  analyzeImpulseResponseRange,
  detectAcousticRange,
  estimateRoomRange,
  formatMeasure,
} from '@/ui/sample-editor/room-acoustics';
import { analyzeImpulseResponseFn, detectAcousticFn, estimateRoomFn } from './fakes/analysis';

describe('room acoustics optional measurements', () => {
  it('omits blind RT60 when every band is unmeasured', () => {
    const summary = detectAcousticRange(
      {
        detectAcoustic: detectAcousticFn(() => ({
          rt60Bands: new Float32Array([Number.NaN, Number.NaN]),
          confidence: 0,
          isBlind: true,
        })),
      },
      [new Float32Array([0, 0])],
      48000,
    );

    const expected = { kind: 'blind', confidence: 0, isBlind: true };
    expect(summary).toStrictEqual(expected);
    expect(JSON.parse(JSON.stringify(summary))).toStrictEqual(expected);
  });

  it('keeps an unmeasured estimate absent and formats it as not measured', () => {
    const estimate = estimateRoomRange(
      {
        estimateRoom: estimateRoomFn(() => ({ confidence: 0 })),
      },
      [new Float32Array([0, 0])],
      48000,
    );

    expect(estimate).toStrictEqual({ confidence: 0 });
    expect('drrDb' in estimate).toBe(false);
    expect(formatMeasure(estimate.drrDb, 1, ' dB')).toBe('—');
  });

  it('keeps an infinite direct-to-reverberant measurement distinct from absence', () => {
    const estimate = estimateRoomRange(
      {
        estimateRoom: estimateRoomFn(() => ({ confidence: 0, drrDb: Number.POSITIVE_INFINITY })),
      },
      [new Float32Array([0.5, -0.5])],
      48000,
    );

    expect(estimate).toStrictEqual({ confidence: 0, drrDb: Number.POSITIVE_INFINITY });
    expect(formatMeasure(estimate.drrDb, 1, ' dB')).toBe('∞ dB');
  });

  it('propagates measured zero clarity while omitting unmeasured clarity', () => {
    const summary = analyzeImpulseResponseRange(
      {
        analyzeImpulseResponse: analyzeImpulseResponseFn(() => ({
          c50: 0,
          confidence: 0.6,
          isBlind: false,
        })),
      },
      [new Float32Array([1, 0])],
      48000,
    );

    expect(summary).toStrictEqual({
      kind: 'impulse',
      c50: 0,
      confidence: 0.6,
      isBlind: false,
    });
    expect(formatMeasure(summary.c50, 1, ' dB')).toBe('0.0 dB');
    expect(formatMeasure(summary.c80, 1, ' dB')).toBe('—');
  });
});
