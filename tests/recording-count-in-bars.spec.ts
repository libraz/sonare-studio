import { describe, expect, it } from 'vitest';
import { resolveRecordingStartPlan } from '@/project/loop-recording';

const plan = (
  positionPpq: number,
  countInBars: number,
  timeSignatures: Array<{ startPpq: number; numerator: number; denominator: number }> = [],
) =>
  resolveRecordingStartPlan({
    positionPpq,
    startedFromRest: true,
    loopEnabled: false,
    loopStartPpq: 0,
    loopEndPpq: 0,
    countInBars,
    timeSignatures,
  });

describe('count-in bars', () => {
  it('counts in whole bars before a punch on a bar line', () => {
    expect(plan(8, 1)).toMatchObject({ countInStartPpq: 4, countInPpq: 4, punchInPpq: 8 });
    expect(plan(8, 2)).toMatchObject({ countInStartPpq: 0, countInPpq: 8 });
  });

  it('plays every requested bar in full before a mid-bar punch', () => {
    expect(plan(10, 1)).toMatchObject({ countInStartPpq: 4, countInPpq: 6, punchInPpq: 10 });
    expect(plan(14, 2)).toMatchObject({ countInStartPpq: 4, countInPpq: 10 });
  });

  it('walks a mid-bar punch back over a meter change', () => {
    const meters = [
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 6, numerator: 5, denominator: 8 },
    ];
    // 7 PPQ sits inside the first 5/8 bar [6, 8.5); one full bar before it is the 3/4 bar [3, 6).
    expect(plan(7, 1, meters)).toMatchObject({ countInStartPpq: 3, countInPpq: 4 });
    expect(plan(8.5, 1, meters)).toMatchObject({ countInStartPpq: 6, countInPpq: 2.5 });
  });
});
