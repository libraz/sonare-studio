import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_INSERT_VALUE_LIMIT,
  type AutomationPoint,
  automationLaneKey,
  busAutomationTarget,
  busIdFromAutomationTarget,
  clampAutomationValue,
  cloneAutomationLane,
  evaluateAutomationValue,
  insertAutomationParam,
  instrumentAutomationParam,
  isAutomationParam,
  isBusAutomationTarget,
  isInsertAutomationParam,
  isInstrumentAutomationParam,
  isMasteringAutomationParam,
  masteringAutomationParam,
  parseInsertAutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
  sanitizeAutomationEntries,
  sanitizeAutomationPoints,
} from '@/project/automation';

describe('automation model', () => {
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
      expect(automationLaneKey(busAutomationTarget('fx'), 'faderDb')).toBe('bus:fx:faderDb');
    });

    it('encodes and detects bus targets', () => {
      const target = busAutomationTarget('fx');
      expect(isBusAutomationTarget(target)).toBe(true);
      expect(isBusAutomationTarget('master')).toBe(false);
      expect(busIdFromAutomationTarget(target)).toBe('fx');
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
        { ppq: 0, value: 0, curve: 'sCurve' },
        { ppq: 1, value: 0, curve: 'bogus' },
      ] as AutomationPoint[];
      expect(sanitizeAutomationPoints('pan', points)).toEqual([
        { ppq: 0, value: 0, curve: 'sCurve' },
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

    it('finds the correct segment in a dense lane', () => {
      const points = Array.from({ length: 1_024 }, (_, ppq) => ({ ppq, value: ppq }));
      expect(evaluateAutomationValue(points, 777.25)).toBeCloseTo(777.25, 12);
      expect(evaluateAutomationValue(points, 1_022.75)).toBeCloseTo(1_022.75, 12);
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
        { ppq: 0, value: 0, curve: 'sCurve' },
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

  describe('insert automation params', () => {
    it('encodes and round-trips index + paramName', () => {
      const param = insertAutomationParam(2, 'thresholdDb');
      expect(param).toBe('insert:2:thresholdDb');
      expect(isInsertAutomationParam(param)).toBe(true);
      expect(parseInsertAutomationParam(param)).toEqual({
        insertIndex: 2,
        paramName: 'thresholdDb',
      });
    });

    it('keeps a paramName that itself contains colons', () => {
      const param = insertAutomationParam(0, 'band:1:gain');
      expect(param).toBe('insert:0:band:1:gain');
      expect(parseInsertAutomationParam(param)).toEqual({
        insertIndex: 0,
        paramName: 'band:1:gain',
      });
    });

    it('encodes and round-trips a stable processor identity', () => {
      const param = insertAutomationParam('processor/a', 'band:1:gain');
      expect(param).toBe('insert-id:processor%2Fa:band:1:gain');
      expect(parseInsertAutomationParam(param)).toEqual({
        processorId: 'processor/a',
        paramName: 'band:1:gain',
      });
      expect(isAutomationParam(param)).toBe(true);
    });

    it('rejects malformed tokens', () => {
      expect(isInsertAutomationParam('faderDb')).toBe(false);
      expect(parseInsertAutomationParam('faderDb')).toBeUndefined();
      expect(parseInsertAutomationParam('insert:2')).toBeUndefined();
      expect(parseInsertAutomationParam('insert:2:')).toBeUndefined();
      expect(parseInsertAutomationParam('insert:-1:gain')).toBeUndefined();
      expect(parseInsertAutomationParam('insert:1.5:gain')).toBeUndefined();
      expect(parseInsertAutomationParam('insert:x:gain')).toBeUndefined();
    });

    it('isAutomationParam accepts faderDb/pan and valid structured tokens only', () => {
      expect(isAutomationParam('faderDb')).toBe(true);
      expect(isAutomationParam('pan')).toBe(true);
      expect(isAutomationParam('insert:0:gainDb')).toBe(true);
      expect(isAutomationParam('mastering:0:ceilingDb')).toBe(true);
      expect(isAutomationParam('instrument:cutoffHz')).toBe(true);
      expect(isAutomationParam('volume')).toBe(false);
      expect(isAutomationParam('insert:-1:gainDb')).toBe(false);
      expect(isAutomationParam('mastering:-1:ceilingDb')).toBe(false);
      expect(isAutomationParam('instrument:')).toBe(false);
      expect(isAutomationParam(5)).toBe(false);
    });

    it('clamps insert values to the wide finite sentinel', () => {
      const param = insertAutomationParam(0, 'gainDb');
      expect(clampAutomationValue(param, 5)).toBe(5);
      expect(clampAutomationValue(param, AUTOMATION_INSERT_VALUE_LIMIT * 2)).toBe(
        AUTOMATION_INSERT_VALUE_LIMIT,
      );
      expect(clampAutomationValue(param, -AUTOMATION_INSERT_VALUE_LIMIT * 2)).toBe(
        -AUTOMATION_INSERT_VALUE_LIMIT,
      );
    });

    it('builds unique lane keys across slots, params and targets', () => {
      const keys = new Set([
        automationLaneKey(1, insertAutomationParam(0, 'gainDb')),
        automationLaneKey(1, insertAutomationParam(1, 'gainDb')),
        automationLaneKey(1, insertAutomationParam(0, 'mix')),
        automationLaneKey('master', insertAutomationParam(0, 'gainDb')),
        automationLaneKey(1, 'faderDb'),
      ]);
      expect(keys.size).toBe(5);
      expect(automationLaneKey(1, insertAutomationParam(0, 'gainDb'))).toBe('1:insert:0:gainDb');
    });

    it('sanitizeAutomationEntries keeps valid insert lanes and drops malformed ones', () => {
      const lanes = sanitizeAutomationEntries(
        [
          {
            param: insertAutomationParam(0, 'thresholdDb'),
            points: [{ ppq: 0, value: -12 }],
            enabled: true,
          },
          { param: 'insert:-1:gainDb', points: [{ ppq: 0, value: 0 }], enabled: true },
          { param: 'insert:0:', points: [{ ppq: 0, value: 0 }], enabled: true },
        ],
        3,
      );
      expect(lanes).toEqual([
        {
          target: 3,
          param: 'insert:0:thresholdDb',
          points: [{ ppq: 0, value: -12 }],
          enabled: true,
        },
      ]);
    });
  });

  describe('mastering automation params', () => {
    it('encodes and round-trips processor index + paramName', () => {
      const param = masteringAutomationParam(2, 'ceilingDb');
      expect(param).toBe('mastering:2:ceilingDb');
      expect(isMasteringAutomationParam(param)).toBe(true);
      expect(parseMasteringAutomationParam(param)).toEqual({
        processorIndex: 2,
        paramName: 'ceilingDb',
      });
    });

    it('keeps a paramName that itself contains colons', () => {
      const param = masteringAutomationParam(0, 'band:1:gain');
      expect(param).toBe('mastering:0:band:1:gain');
      expect(parseMasteringAutomationParam(param)).toEqual({
        processorIndex: 0,
        paramName: 'band:1:gain',
      });
    });

    it('encodes and round-trips a stable mastering processor identity', () => {
      const param = masteringAutomationParam('master/processor', 'ceilingDb');
      expect(param).toBe('mastering-id:master%2Fprocessor:ceilingDb');
      expect(parseMasteringAutomationParam(param)).toEqual({
        processorId: 'master/processor',
        paramName: 'ceilingDb',
      });
      expect(isAutomationParam(param)).toBe(true);
    });

    it('rejects malformed tokens', () => {
      expect(isMasteringAutomationParam('insert:0:gainDb')).toBe(false);
      expect(parseMasteringAutomationParam('mastering:2')).toBeUndefined();
      expect(parseMasteringAutomationParam('mastering:2:')).toBeUndefined();
      expect(parseMasteringAutomationParam('mastering:-1:gain')).toBeUndefined();
      expect(parseMasteringAutomationParam('mastering:1.5:gain')).toBeUndefined();
      expect(parseMasteringAutomationParam('mastering:x:gain')).toBeUndefined();
    });

    it('sanitizeAutomationEntries keeps valid mastering lanes and drops malformed ones', () => {
      const lanes = sanitizeAutomationEntries(
        [
          {
            param: masteringAutomationParam(0, 'ceilingDb'),
            points: [{ ppq: 0, value: -1 }],
            enabled: true,
          },
          { param: 'mastering:-1:gainDb', points: [{ ppq: 0, value: 0 }], enabled: true },
          { param: 'mastering:0:', points: [{ ppq: 0, value: 0 }], enabled: true },
        ],
        'master',
      );
      expect(lanes).toEqual([
        {
          target: 'master',
          param: 'mastering:0:ceilingDb',
          points: [{ ppq: 0, value: -1 }],
          enabled: true,
        },
      ]);
    });
  });

  describe('instrument automation params', () => {
    it('encodes and round-trips a synth-patch paramName', () => {
      const param = instrumentAutomationParam('cutoffHz');
      expect(param).toBe('instrument:cutoffHz');
      expect(isInstrumentAutomationParam(param)).toBe(true);
      expect(parseInstrumentAutomationParam(param)).toEqual({ paramName: 'cutoffHz' });
    });

    it('keeps a paramName that itself contains colons', () => {
      const param = instrumentAutomationParam('macro:1');
      expect(param).toBe('instrument:macro:1');
      expect(parseInstrumentAutomationParam(param)).toEqual({ paramName: 'macro:1' });
    });

    it('rejects malformed tokens', () => {
      expect(isInstrumentAutomationParam('mastering:0:gainDb')).toBe(false);
      expect(parseInstrumentAutomationParam('instrument:')).toBeUndefined();
    });

    it('sanitizeAutomationEntries keeps valid instrument lanes and drops malformed ones', () => {
      const lanes = sanitizeAutomationEntries(
        [
          {
            param: instrumentAutomationParam('cutoffHz'),
            points: [{ ppq: 0, value: 1200 }],
            enabled: true,
          },
          { param: 'instrument:', points: [{ ppq: 0, value: 0 }], enabled: true },
        ],
        3,
      );
      expect(lanes).toEqual([
        {
          target: 3,
          param: 'instrument:cutoffHz',
          points: [{ ppq: 0, value: 1200 }],
          enabled: true,
        },
      ]);
    });
  });
});
