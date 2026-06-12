/**
 * Automation lane model: plain data describing parameter automation over the
 * timeline (app-level metadata, like markers and sections). Lanes target a
 * track or the master strip and hold points kept sorted by PPQ by the
 * commands layer (src/project/commands.ts).
 */

/** Parameter automatable by a lane. */
export type AutomationParam = 'faderDb' | 'pan';

/** Interpolation curve from a point toward the next one. */
export type AutomationCurve = 'linear' | 'exponential' | 'hold' | 's-curve';

/** One automation point on a lane. */
export interface AutomationPoint {
  /** Point position in PPQ (>= 0). */
  ppq: number;
  /** Parameter value at this point (see {@link clampAutomationValue}). */
  value: number;
  /** Curve toward the next point; absent = 'linear'. */
  curve?: AutomationCurve;
}

/** One automation lane: a target, the automated parameter and its points. */
export interface AutomationLaneState {
  /** Lane target: a track id or 'master'. */
  target: number | 'master';
  /** Automated parameter. */
  param: AutomationParam;
  /** Points sorted by ascending PPQ (the commands layer keeps the order). */
  points: AutomationPoint[];
  /** Whether the lane is applied during playback. */
  enabled: boolean;
}

/** Numeric wire codes per automation curve (engine/persistence encoding). */
export const AUTOMATION_CURVE_CODES: Record<AutomationCurve, number> = {
  linear: 0,
  exponential: 1,
  hold: 2,
  's-curve': 3,
};

/** Minimum fader automation value in dB (treated as -inf by the fader law). */
export const AUTOMATION_FADER_DB_MIN = -120;

/** Maximum fader automation value in dB. */
export const AUTOMATION_FADER_DB_MAX = 24;

/** Minimum pan automation value (hard left). */
export const AUTOMATION_PAN_MIN = -1;

/** Maximum pan automation value (hard right). */
export const AUTOMATION_PAN_MAX = 1;

/**
 * Returns the numeric wire code of a curve.
 *
 * @param curve Curve name; absent defaults to 'linear'.
 * @returns The matching {@link AUTOMATION_CURVE_CODES} entry.
 */
export function automationCurveCode(curve?: AutomationCurve): number {
  return AUTOMATION_CURVE_CODES[curve ?? 'linear'];
}

/**
 * Clamps an automation value into the parameter's valid range.
 *
 * @param param Automated parameter.
 * @param value Raw value (finite).
 * @returns The value clamped to [-120, 24] dB for 'faderDb' or [-1, 1] for
 *   'pan'.
 */
export function clampAutomationValue(param: AutomationParam, value: number): number {
  if (param === 'faderDb') {
    return Math.min(AUTOMATION_FADER_DB_MAX, Math.max(AUTOMATION_FADER_DB_MIN, value));
  }
  return Math.min(AUTOMATION_PAN_MAX, Math.max(AUTOMATION_PAN_MIN, value));
}

/**
 * Builds the stable identity key of a lane, e.g. "master:pan" or "5:faderDb".
 *
 * @param target Lane target: a track id or 'master'.
 * @param param Automated parameter.
 * @returns The "<target>:<param>" key.
 */
export function automationLaneKey(target: number | 'master', param: AutomationParam): string {
  return `${target}:${param}`;
}

/** True when the value is one of the {@link AutomationCurve} names. */
function isAutomationCurve(value: unknown): value is AutomationCurve {
  return typeof value === 'string' && value in AUTOMATION_CURVE_CODES;
}

/** True when the value is one of the {@link AutomationParam} names. */
export function isAutomationParam(value: unknown): value is AutomationParam {
  return value === 'faderDb' || value === 'pan';
}

/**
 * Sanitizes a point list: drops points with non-finite ppq/value or negative
 * ppq, clamps values into the parameter range, drops unknown curve names and
 * sorts by ascending PPQ (stable for equal positions).
 *
 * @param param Automated parameter (selects the value range).
 * @param points Candidate points (not mutated).
 * @returns A new array of new point objects.
 */
export function sanitizeAutomationPoints(
  param: AutomationParam,
  points: ReadonlyArray<AutomationPoint>,
): AutomationPoint[] {
  const out: AutomationPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.ppq) || point.ppq < 0 || !Number.isFinite(point.value)) continue;
    const next: AutomationPoint = {
      ppq: point.ppq,
      value: clampAutomationValue(param, point.value),
    };
    if (isAutomationCurve(point.curve)) next.curve = point.curve;
    out.push(next);
  }
  // Array.prototype.sort is stable, so equal-ppq points keep their order.
  out.sort((a, b) => a.ppq - b.ppq);
  return out;
}

/** Deep-copies a lane into plain objects (detached from reactivity). */
export function cloneAutomationLane(lane: AutomationLaneState): AutomationLaneState {
  return { ...lane, points: lane.points.map((point) => ({ ...point })) };
}

/** Epsilon shifting exponential interpolation away from log(0). */
const EXPONENTIAL_EPSILON = 1e-9;

/** Sign of a value, treating 0 (and -0) as positive. */
function signOrPositive(value: number): number {
  return Math.sign(value) || 1;
}

/**
 * Evaluates a lane's value at a PPQ position, replicating the engine's
 * interpolation math. Outside the point range the nearest endpoint value
 * holds. Between two points the segment's curve (stored on the earlier point)
 * interpolates:
 *
 * - 'hold' keeps the earlier value until the next point.
 * - 'exponential' interpolates in an epsilon-shifted log domain of the
 *   magnitudes when both endpoints share a sign; endpoints straddling zero
 *   fall back to linear.
 * - 's-curve' applies smoothstep easing to the blend factor.
 * - 'linear' (and absent) blends linearly.
 *
 * @param points Lane points sorted by ascending PPQ.
 * @param ppq Position to evaluate, in PPQ.
 * @returns The interpolated value; 0 when the lane has no points.
 */
export function evaluateAutomationValue(
  points: ReadonlyArray<AutomationPoint>,
  ppq: number,
): number {
  if (points.length === 0) return 0;
  if (ppq <= points[0].ppq) return points[0].value;
  const last = points[points.length - 1];
  if (ppq >= last.ppq) return last.value;
  let index = 0;
  while (index + 1 < points.length && points[index + 1].ppq <= ppq) index++;
  const a = points[index];
  const b = points[index + 1];
  const span = b.ppq - a.ppq;
  const t = span > 0 ? Math.min(1, Math.max(0, (ppq - a.ppq) / span)) : 0;
  switch (a.curve ?? 'linear') {
    case 'hold':
      return a.value;
    case 'exponential': {
      const sa = signOrPositive(a.value);
      const sb = signOrPositive(b.value);
      if (sa !== sb) return a.value + (b.value - a.value) * t;
      const la = Math.log(Math.abs(a.value) + EXPONENTIAL_EPSILON);
      const lb = Math.log(Math.abs(b.value) + EXPONENTIAL_EPSILON);
      return sa * (Math.exp(la + (lb - la) * t) - EXPONENTIAL_EPSILON);
    }
    case 's-curve': {
      const shaped = t * t * (3 - 2 * t);
      return a.value + (b.value - a.value) * shaped;
    }
    default:
      return a.value + (b.value - a.value) * t;
  }
}

/**
 * Sanitizes an untrusted document automation list (a track's `automation`
 * field or the document's `masterAutomation`) into store lanes bound to the
 * given target. Entries are dropped unless the param is a known
 * {@link AutomationParam} and the points field is an array; surviving points
 * are run through {@link sanitizeAutomationPoints} and `enabled` is coerced
 * to a boolean (absent = true).
 *
 * @param value Candidate entry list; non-arrays yield [].
 * @param target Lane target the entries belong to (a track id or 'master').
 * @returns A new array of well-formed lanes.
 */
export function sanitizeAutomationEntries(
  value: unknown,
  target: number | 'master',
): AutomationLaneState[] {
  if (!Array.isArray(value)) return [];
  const out: AutomationLaneState[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const lane = entry as { param?: unknown; points?: unknown; enabled?: unknown };
    if (!isAutomationParam(lane.param) || !Array.isArray(lane.points)) continue;
    out.push({
      target,
      param: lane.param,
      points: sanitizeAutomationPoints(lane.param, lane.points as AutomationPoint[]),
      enabled: lane.enabled === undefined ? true : Boolean(lane.enabled),
    });
  }
  return out;
}
