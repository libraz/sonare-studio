import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_CURVE_CODES,
  type AutomationPoint,
  automationCurveCode,
  automationLaneKey,
  clampAutomationValue,
  cloneAutomationLane,
  evaluateAutomationValue,
  sanitizeAutomationEntries,
  sanitizeAutomationPoints,
} from '@/project/automation';

describe('automation model', () => {
  describe('curve codes', () => {
    it('maps every curve name to its wire code', () => {
      expect(AUTOMATION_CURVE_CODES).toEqual({
        linear: 0,
        exponential: 1,
        hold: 2,
        's-curve': 3,
      });
    });

    it('automationCurveCode defaults an absent curve to linear', () => {
      expect(automationCurveCode()).toBe(0);
      expect(automationCurveCode(undefined)).toBe(0);
      expect(automationCurveCode('linear')).toBe(0);
      expect(automationCurveCode('exponential')).toBe(1);
      expect(automationCurveCode('hold')).toBe(2);
      expect(automationCurveCode('s-curve')).toBe(3);
    });
  });

  describe('clampAutomationValue', () => {
    it('clamps faderDb into [-120, 24]', () => {
      expect(clampAutomationValue('faderDb', -200)).toBe(-120);
      expect(clampAutomationValue('faderDb', 100)).toBe(24);
      expect(clampAutomationValue('faderDb', -6)).toBe(-6);
      expect(clampAutomationValue('faderDb', -120)).toBe(-120);
      expect(clampAutomationValue('faderDb', 24)).toBe(24);
    });

    it('clamps pan into [-1, 1]', () => {
      expect(clampAutomationValue('pan', -2)).toBe(-1);
      expect(clampAutomationValue('pan', 2)).toBe(1);
      expect(clampAutomationValue('pan', 0.25)).toBe(0.25);
    });
  });

  describe('automationLaneKey', () => {
    it('builds "<target>:<param>" keys', () => {
      expect(automationLaneKey('master', 'pan')).toBe('master:pan');
      expect(automationLaneKey(5, 'faderDb')).toBe('5:faderDb');
    });
  });

  describe('sanitizeAutomationPoints', () => {
    it('drops points with non-finite or negative ppq and non-finite values', () => {
      const points: AutomationPoint[] = [
        { ppq: -1, value: 0 },
        { ppq: Number.NaN, value: 0 },
        { ppq: Number.POSITIVE_INFINITY, value: 0 },
        { ppq: 4, value: Number.NaN },
        { ppq: 4, value: Number.NEGATIVE_INFINITY },
        { ppq: 4, value: -6 },
      ];
      expect(sanitizeAutomationPoints('faderDb', points)).toEqual([{ ppq: 4, value: -6 }]);
    });

    it('clamps values into the parameter range', () => {
      expect(sanitizeAutomationPoints('faderDb', [{ ppq: 0, value: 999 }])).toEqual([
        { ppq: 0, value: 24 },
      ]);
      expect(sanitizeAutomationPoints('pan', [{ ppq: 0, value: -5 }])).toEqual([
        { ppq: 0, value: -1 },
      ]);
    });

    it('sorts by ascending ppq, keeping equal positions stable', () => {
      const points: AutomationPoint[] = [
        { ppq: 8, value: 1 },
        { ppq: 0, value: 0.5, curve: 'hold' },
        { ppq: 8, value: -1 },
        { ppq: 4, value: 0 },
      ];
      expect(sanitizeAutomationPoints('pan', points)).toEqual([
        { ppq: 0, value: 0.5, curve: 'hold' },
        { ppq: 4, value: 0 },
        { ppq: 8, value: 1 },
        { ppq: 8, value: -1 },
      ]);
    });

    it('returns new point objects and leaves the input untouched', () => {
      const input: AutomationPoint[] = [
        { ppq: 8, value: 100 },
        { ppq: 0, value: 0 },
      ];
      const out = sanitizeAutomationPoints('faderDb', input);
      expect(input).toEqual([
        { ppq: 8, value: 100 },
        { ppq: 0, value: 0 },
      ]);
      expect(out[1]).not.toBe(input[0]);
    });

    it('keeps known curve names and drops unknown ones', () => {
      const points = [
        { ppq: 0, value: 0, curve: 's-curve' },
        { ppq: 1, value: 0, curve: 'bogus' },
      ] as AutomationPoint[];
      expect(sanitizeAutomationPoints('pan', points)).toEqual([
        { ppq: 0, value: 0, curve: 's-curve' },
        { ppq: 1, value: 0 },
      ]);
    });
  });

  describe('evaluateAutomationValue', () => {
    it('returns 0 for an empty lane', () => {
      expect(evaluateAutomationValue([], 0)).toBe(0);
      expect(evaluateAutomationValue([], 480)).toBe(0);
    });

    it('holds the nearest endpoint value outside the point range', () => {
      const points: AutomationPoint[] = [
        { ppq: 4, value: -6 },
        { ppq: 8, value: 0 },
      ];
      expect(evaluateAutomationValue(points, 0)).toBe(-6);
      expect(evaluateAutomationValue(points, 4)).toBe(-6);
      expect(evaluateAutomationValue(points, 8)).toBe(0);
      expect(evaluateAutomationValue(points, 100)).toBe(0);
    });

    it('returns the exact point value at an interior point position', () => {
      const points: AutomationPoint[] = [
        { ppq: 0, value: 0 },
        { ppq: 4, value: 3 },
        { ppq: 8, value: 10 },
      ];
      expect(evaluateAutomationValue(points, 4)).toBe(3);
    });

    it('interpolates linearly by default and for the linear curve', () => {
      const points: AutomationPoint[] = [
        { ppq: 0, value: 0, curve: 'linear' },
        { ppq: 8, value: 4 },
      ];
      expect(evaluateAutomationValue(points, 2)).toBeCloseTo(1, 12);
      expect(evaluateAutomationValue(points, 4)).toBeCloseTo(2, 12);
      const noCurve: AutomationPoint[] = [
        { ppq: 0, value: 0 },
        { ppq: 8, value: 4 },
      ];
      expect(evaluateAutomationValue(noCurve, 6)).toBeCloseTo(3, 12);
    });

    it('keeps the earlier value across a hold segment', () => {
      const points: AutomationPoint[] = [
        { ppq: 0, value: -12, curve: 'hold' },
        { ppq: 8, value: 0 },
      ];
      expect(evaluateAutomationValue(points, 1)).toBe(-12);
      expect(evaluateAutomationValue(points, 7.999)).toBe(-12);
      expect(evaluateAutomationValue(points, 8)).toBe(0);
    });

    it('applies smoothstep easing on an s-curve segment', () => {
      const points: AutomationPoint[] = [
        { ppq: 0, value: 0, curve: 's-curve' },
        { ppq: 8, value: 8 },
      ];
      // smoothstep(0.25) = 0.15625, smoothstep(0.5) = 0.5.
      expect(evaluateAutomationValue(points, 2)).toBeCloseTo(1.25, 12);
      expect(evaluateAutomationValue(points, 4)).toBeCloseTo(4, 12);
    });

    it('interpolates exponential segments geometrically for positive endpoints', () => {
      const points: AutomationPoint[] = [
        { ppq: 0, value: 1, curve: 'exponential' },
        { ppq: 8, value: 100 },
      ];
      // Midpoint of a log-domain blend is the geometric mean.
      expect(evaluateAutomationValue(points, 4)).toBeCloseTo(10, 6);
    });

    it('keeps the sign on exponential segments with negative endpoints', () => {
      const points: AutomationPoint[] = [
        { ppq: 0, value: -1, curve: 'exponential' },
        { ppq: 8, value: -100 },
      ];
      expect(evaluateAutomationValue(points, 4)).toBeCloseTo(-10, 6);
    });

    it('falls back to linear when an exponential segment straddles zero', () => {
      const points: AutomationPoint[] = [
        { ppq: 0, value: -1, curve: 'exponential' },
        { ppq: 8, value: 1 },
      ];
      expect(evaluateAutomationValue(points, 2)).toBeCloseTo(-0.5, 12);
      expect(evaluateAutomationValue(points, 4)).toBeCloseTo(0, 12);
      expect(evaluateAutomationValue(points, 6)).toBeCloseTo(0.5, 12);
    });

    it('stays near zero at the start of an exponential ramp from zero', () => {
      const points: AutomationPoint[] = [
        { ppq: 0, value: 0, curve: 'exponential' },
        { ppq: 8, value: 1 },
      ];
      // Zero counts as positive, so the blend runs in the epsilon-shifted
      // log domain and hugs zero through the first half.
      expect(evaluateAutomationValue(points, 4)).toBeGreaterThanOrEqual(0);
      expect(evaluateAutomationValue(points, 4)).toBeLessThan(0.01);
    });
  });

  describe('cloneAutomationLane', () => {
    it('deep-copies the lane and its points', () => {
      const lane = {
        target: 'master' as const,
        param: 'pan' as const,
        points: [{ ppq: 0, value: 0 }],
        enabled: true,
      };
      const copy = cloneAutomationLane(lane);
      expect(copy).toEqual(lane);
      expect(copy).not.toBe(lane);
      expect(copy.points).not.toBe(lane.points);
      expect(copy.points[0]).not.toBe(lane.points[0]);
    });
  });

  describe('sanitizeAutomationEntries', () => {
    it('returns [] for non-arrays', () => {
      expect(sanitizeAutomationEntries(undefined, 'master')).toEqual([]);
      expect(sanitizeAutomationEntries(null, 1)).toEqual([]);
      expect(sanitizeAutomationEntries('oops', 'master')).toEqual([]);
      expect(sanitizeAutomationEntries({}, 1)).toEqual([]);
    });

    it('drops entries with a bad param or points field', () => {
      const lanes = sanitizeAutomationEntries(
        [
          null,
          'oops',
          { param: 'volume', points: [], enabled: true },
          { param: 'pan', points: 'oops', enabled: true },
          { param: 'faderDb', points: [{ ppq: 0, value: 0 }], enabled: true },
        ],
        'master',
      );
      expect(lanes).toEqual([
        { target: 'master', param: 'faderDb', points: [{ ppq: 0, value: 0 }], enabled: true },
      ]);
    });

    it('binds entries to the given target, sanitizes points and coerces enabled (absent = true)', () => {
      const lanes = sanitizeAutomationEntries(
        [
          {
            param: 'faderDb',
            points: [
              { ppq: 8, value: 999 },
              { ppq: -1, value: 0 },
              { ppq: 0, value: -3 },
            ],
          },
          { param: 'pan', points: [], enabled: 0 },
        ],
        2,
      );
      expect(lanes).toEqual([
        {
          target: 2,
          param: 'faderDb',
          points: [
            { ppq: 0, value: -3 },
            { ppq: 8, value: 24 },
          ],
          enabled: true,
        },
        { target: 2, param: 'pan', points: [], enabled: false },
      ]);
    });
  });
});
