import { describe, expect, it } from 'vitest';
import { createDefaultStrip, type InsertSlot, type MixerStrip } from '@/project/mixer';
import {
  insertGainReductionBySlot,
  insertGainReductionEngineIndex,
} from '@/ui/mixer/insert-gain-reduction';

function slot(processor: InsertSlot['processor'], enabled = true): InsertSlot {
  return { processor, enabled, params: {} };
}

function strip(...inserts: InsertSlot[]): MixerStrip {
  return { ...createDefaultStrip(), inserts };
}

describe('insertGainReductionBySlot', () => {
  it('maps engine insert order onto store slots, quiet below the epsilon', () => {
    const s = strip(slot('eq.parametric'), slot('dynamics.compressor'), slot('dynamics.limiter'));
    expect(insertGainReductionBySlot('lane', s, [0, -3.25, -0.05])).toEqual([
      undefined,
      3.25,
      undefined,
    ]);
  });

  it('keeps a bypassed slot quiet and its neighbours on their own indices', () => {
    const s = strip(slot('dynamics.compressor', false), slot('dynamics.limiter'));
    expect(insertGainReductionBySlot('bus', s, [-6, -2])).toEqual([undefined, 2]);
    expect(insertGainReductionBySlot('lane', s, [-6, -2])).toEqual([undefined, 2]);
  });

  it('ignores master mastering-chain entries appended after the store inserts', () => {
    const s = strip(slot('dynamics.compressor'));
    expect(insertGainReductionBySlot('master', s, [-1.5, -9])).toEqual([1.5]);
  });

  it('leaves slots past a short engine reading quiet', () => {
    const s = strip(slot('dynamics.compressor'), slot('dynamics.limiter'));
    expect(insertGainReductionBySlot('lane', s, [-4])).toEqual([4, undefined]);
    expect(insertGainReductionBySlot('lane', s, [])).toEqual([undefined, undefined]);
  });

  it('uses the bus automation index for bus chains', () => {
    const s = strip(slot('dynamics.compressor', false), slot('dynamics.limiter'));
    expect(insertGainReductionEngineIndex('bus', s, 1)).toBe(1);
    expect(insertGainReductionEngineIndex('lane', s, 2)).toBeUndefined();
  });
});
