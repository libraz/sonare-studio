import { describe, expect, it } from 'vitest';
import {
  BUS_METER_TARGET_BASE,
  busMeterTargetId,
  decodeMeterTarget,
  INPUT_METER_TARGET_ID,
  LANE_METER_TARGET_BASE,
  laneMeterTargetId,
  MASTER_METER_TARGET_ID,
  MAX_BUS_METER_TARGETS,
  MAX_LANE_METER_TARGETS,
} from '@/engine/meter-targets';

describe('decodeMeterTarget', () => {
  it('decodes the master target id', () => {
    expect(decodeMeterTarget(MASTER_METER_TARGET_ID)).toEqual({ kind: 'master' });
    expect(decodeMeterTarget(0)).toEqual({ kind: 'master' });
  });

  it('decodes the full lane range with laneIndex = targetId - base', () => {
    expect(decodeMeterTarget(1)).toEqual({ kind: 'lane', laneIndex: 0 });
    expect(decodeMeterTarget(17)).toEqual({ kind: 'lane', laneIndex: 16 });
    expect(decodeMeterTarget(32)).toEqual({ kind: 'lane', laneIndex: 31 });
  });

  it('decodes the full bus range with busIndex = targetId - base', () => {
    expect(decodeMeterTarget(33)).toEqual({ kind: 'bus', busIndex: 0 });
    expect(decodeMeterTarget(40)).toEqual({ kind: 'bus', busIndex: 7 });
  });

  it('decodes the input capture target id', () => {
    expect(decodeMeterTarget(0xffff)).toEqual({ kind: 'input' });
    expect(decodeMeterTarget(INPUT_METER_TARGET_ID)).toEqual({ kind: 'input' });
  });

  it('returns null for ids outside every known range', () => {
    expect(decodeMeterTarget(41)).toBeNull();
    expect(decodeMeterTarget(-1)).toBeNull();
    expect(decodeMeterTarget(0xfffe)).toBeNull();
    expect(decodeMeterTarget(0x10000)).toBeNull();
  });
});

describe('laneMeterTargetId', () => {
  it('encodes lane indices across the supported range', () => {
    expect(laneMeterTargetId(0)).toBe(LANE_METER_TARGET_BASE);
    expect(laneMeterTargetId(MAX_LANE_METER_TARGETS - 1)).toBe(32);
  });

  it('throws a RangeError outside [0, MAX_LANE_METER_TARGETS)', () => {
    expect(() => laneMeterTargetId(-1)).toThrow(RangeError);
    expect(() => laneMeterTargetId(MAX_LANE_METER_TARGETS)).toThrow(RangeError);
    expect(() => laneMeterTargetId(1.5)).toThrow(RangeError);
  });

  it('round-trips through decodeMeterTarget', () => {
    for (let lane = 0; lane < MAX_LANE_METER_TARGETS; lane++) {
      expect(decodeMeterTarget(laneMeterTargetId(lane))).toEqual({
        kind: 'lane',
        laneIndex: lane,
      });
    }
  });
});

describe('busMeterTargetId', () => {
  it('encodes bus indices across the supported range', () => {
    expect(busMeterTargetId(0)).toBe(BUS_METER_TARGET_BASE);
    expect(busMeterTargetId(MAX_BUS_METER_TARGETS - 1)).toBe(40);
  });

  it('throws a RangeError outside [0, MAX_BUS_METER_TARGETS)', () => {
    expect(() => busMeterTargetId(-1)).toThrow(RangeError);
    expect(() => busMeterTargetId(MAX_BUS_METER_TARGETS)).toThrow(RangeError);
    expect(() => busMeterTargetId(0.5)).toThrow(RangeError);
  });

  it('round-trips through decodeMeterTarget', () => {
    for (let bus = 0; bus < MAX_BUS_METER_TARGETS; bus++) {
      expect(decodeMeterTarget(busMeterTargetId(bus))).toEqual({ kind: 'bus', busIndex: bus });
    }
  });
});
