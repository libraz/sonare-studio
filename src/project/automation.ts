/**
 * Automation lane model: plain data describing parameter automation over the
 * timeline (app-level metadata, like markers and sections). Lanes target a
 * track, the master strip, or a mixer bus and hold points kept sorted by PPQ
 * by the commands layer (src/project/commands.ts).
 */

import type { AutomationCurve as EngineAutomationCurve } from '@/wasm/index.js';

/** A mixer bus automation target encoded with its stable project bus id. */
export type BusAutomationTarget = `bus:${string}`;

/** Lane target: a track id, the master strip, or a mixer bus. */
export type AutomationTarget = number | 'master' | BusAutomationTarget;

/**
 * An insert-parameter automation target. Current tokens encode the stable
 * processor identity as "insert-id:<id>:<paramName>"; positional
 * "insert:<index>:<paramName>" tokens remain readable for old documents.
 */
export type InsertAutomationParam = `insert:${number}:${string}` | `insert-id:${string}:${string}`;

/**
 * A mastering-chain processor parameter automation target. Current tokens use
 * "mastering-id:<id>:<paramName>"; positional "mastering:<index>:<paramName>"
 * tokens remain readable and are migrated during project load.
 */
export type MasteringAutomationParam =
  | `mastering:${number}:${string}`
  | `mastering-id:${string}:${string}`;

/**
 * A synth-patch instrument parameter automation target encoded as
 * "instrument:<paramName>". The lane target names the MIDI track; the token
 * only carries the SynthPatch JSON-key parameter name.
 */
export type InstrumentAutomationParam = `instrument:${string}`;

/** Parameter automatable by a lane. */
export type AutomationParam =
  | 'faderDb'
  | 'pan'
  | InsertAutomationParam
  | MasteringAutomationParam
  | InstrumentAutomationParam;

/** The slot index and parameter name decoded from an {@link InsertAutomationParam}. */
export interface InsertParamRef {
  /** Legacy positional slot index, present only for old lane tokens. */
  insertIndex?: number;
  /** Stable processor identity, present for current lane tokens. */
  processorId?: string;
  /** Processor JSON-key parameter name (may itself contain ':'). */
  paramName: string;
}

/** The mastering-chain slot index and parameter name decoded from a token. */
export interface MasteringParamRef {
  /** Legacy positional slot index, present only for old lane tokens. */
  processorIndex?: number;
  /** Stable processor identity, present for current lane tokens. */
  processorId?: string;
  /** Processor JSON-key parameter name (may itself contain ':'). */
  paramName: string;
}

/** The synth-patch parameter name decoded from an instrument token. */
export interface InstrumentParamRef {
  /** SynthPatch JSON-key parameter name (may itself contain ':'). */
  paramName: string;
}

/** Interpolation curve from a point toward the next one (the engine's vocabulary). */
export type AutomationCurve = EngineAutomationCurve;

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
  /** Lane target: a track id, 'master', or a mixer bus target. */
  target: AutomationTarget;
  /** Automated parameter. */
  param: AutomationParam;
  /** Points sorted by ascending PPQ (the commands layer keeps the order). */
  points: AutomationPoint[];
  /** Whether the lane is applied during playback. */
  enabled: boolean;
}

/**
 * Every {@link AutomationCurve} name, for validating stored data. Mirrors the
 * core union, which has no runtime list; the core-surface contract spec fails once it has.
 */
export const AUTOMATION_CURVES: ReadonlySet<string> = new Set<AutomationCurve>([
  'linear',
  'exponential',
  'hold',
  'sCurve',
]);

/** Minimum fader automation value in dB (treated as -inf by the fader law). */
export const AUTOMATION_FADER_DB_MIN = -120;

/** Maximum fader automation value in dB. */
export const AUTOMATION_FADER_DB_MAX = 24;

/** Minimum pan automation value (hard left). */
export const AUTOMATION_PAN_MIN = -1;

/** Maximum pan automation value (hard right). */
export const AUTOMATION_PAN_MAX = 1;

/**
 * Symmetric clamp bound for insert-parameter automation values. Insert params
 * have no shared range (each processor parameter has its own), so values are
 * only guarded against non-finite extremes with a wide, non-destructive
 * sentinel; per-parameter display ranges live in
 * src/project/insert-param-domains.ts.
 */
export const AUTOMATION_INSERT_VALUE_LIMIT = 1e6;

/**
 * Clamps an automation value into the parameter's valid range.
 *
 * @param param Automated parameter.
 * @param value Raw value (finite).
 * @returns The value clamped to [-120, 24] dB for 'faderDb', [-1, 1] for
 *   'pan', or the wide [-1e6, 1e6] sentinel for an insert parameter.
 */
export function clampAutomationValue(param: AutomationParam, value: number): number {
  if (param === 'faderDb') {
    return Math.min(AUTOMATION_FADER_DB_MAX, Math.max(AUTOMATION_FADER_DB_MIN, value));
  }
  if (param === 'pan') {
    return Math.min(AUTOMATION_PAN_MAX, Math.max(AUTOMATION_PAN_MIN, value));
  }
  return Math.min(AUTOMATION_INSERT_VALUE_LIMIT, Math.max(-AUTOMATION_INSERT_VALUE_LIMIT, value));
}

/**
 * Builds the stable identity key of a lane, e.g. "master:pan" or "5:faderDb".
 *
 * @param target Lane target: a track id or 'master'.
 * @param param Automated parameter.
 * @returns The "<target>:<param>" key.
 */
export function automationLaneKey(target: AutomationTarget, param: AutomationParam): string {
  return `${target}:${param}`;
}

/** Encodes a mixer bus id into an automation lane target. */
export function busAutomationTarget(busId: string): BusAutomationTarget {
  return `bus:${busId}`;
}

/** True when the automation target names a mixer bus. */
export function isBusAutomationTarget(target: AutomationTarget): target is BusAutomationTarget {
  return typeof target === 'string' && target.startsWith('bus:');
}

/** Extracts the project bus id from a bus automation target. */
export function busIdFromAutomationTarget(target: BusAutomationTarget): string {
  return target.slice(4);
}

/**
 * Encodes an insert processor identity and parameter name. String identities
 * produce the stable current format; numbers produce the legacy format for
 * backward-compatible import and tests.
 *
 * @param insertIdentity Stable processor id, or a legacy slot index.
 * @param paramName Processor JSON-key parameter name (may contain ':').
 * @returns The "insert:<index>:<paramName>" token.
 */
export function insertAutomationParam(
  insertIdentity: number | string,
  paramName: string,
): InsertAutomationParam {
  return typeof insertIdentity === 'number'
    ? `insert:${insertIdentity}:${paramName}`
    : `insert-id:${encodeURIComponent(insertIdentity)}:${paramName}`;
}

/**
 * Encodes a stable mastering processor id (or legacy index) and parameter.
 *
 * @param processorIdentity Stable processor id, or a legacy slot index.
 * @param paramName Processor JSON-key parameter name (may contain ':').
 * @returns The "mastering:<index>:<paramName>" token.
 */
export function masteringAutomationParam(
  processorIdentity: number | string,
  paramName: string,
): MasteringAutomationParam {
  return typeof processorIdentity === 'number'
    ? `mastering:${processorIdentity}:${paramName}`
    : `mastering-id:${encodeURIComponent(processorIdentity)}:${paramName}`;
}

/**
 * Encodes a synth-patch instrument parameter name into an automation token.
 *
 * @param paramName SynthPatch JSON-key parameter name (may contain ':').
 * @returns The "instrument:<paramName>" token.
 */
export function instrumentAutomationParam(paramName: string): InstrumentAutomationParam {
  return `instrument:${paramName}`;
}

/** True when an automation param token addresses an insert parameter. */
export function isInsertAutomationParam(param: string): param is InsertAutomationParam {
  return param.startsWith('insert:') || param.startsWith('insert-id:');
}

/** True when an automation param token addresses a mastering-chain parameter. */
export function isMasteringAutomationParam(param: string): param is MasteringAutomationParam {
  return param.startsWith('mastering:') || param.startsWith('mastering-id:');
}

/** True when an automation param token addresses a synth-patch instrument parameter. */
export function isInstrumentAutomationParam(param: string): param is InstrumentAutomationParam {
  return param.startsWith('instrument:');
}

/**
 * Decodes either stable or legacy insert automation tokens. Only the identity
 * separator is structural, so parameter names containing ':' survive.
 *
 * @param param Candidate token.
 * @returns The decoded reference, or undefined when the token is malformed
 *   (non-integer/negative index or an empty parameter name).
 */
export function parseInsertAutomationParam(param: string): InsertParamRef | undefined {
  if (!isInsertAutomationParam(param)) return undefined;
  const stable = param.startsWith('insert-id:');
  const rest = param.slice(stable ? 'insert-id:'.length : 'insert:'.length);
  const separator = rest.indexOf(':');
  if (separator < 0) return undefined;
  const identityText = rest.slice(0, separator);
  const paramName = rest.slice(separator + 1);
  if (paramName.length === 0) return undefined;
  if (stable) {
    try {
      const processorId = decodeURIComponent(identityText);
      return processorId.length > 0 ? { processorId, paramName } : undefined;
    } catch {
      return undefined;
    }
  }
  const insertIndex = Number(identityText);
  if (!Number.isInteger(insertIndex) || insertIndex < 0) return undefined;
  return { insertIndex, paramName };
}

/**
 * Decodes either stable or legacy mastering automation tokens.
 *
 * @param param Candidate token.
 * @returns The decoded reference, or undefined when malformed.
 */
export function parseMasteringAutomationParam(param: string): MasteringParamRef | undefined {
  if (!isMasteringAutomationParam(param)) return undefined;
  const stable = param.startsWith('mastering-id:');
  const rest = param.slice(stable ? 'mastering-id:'.length : 'mastering:'.length);
  const separator = rest.indexOf(':');
  if (separator < 0) return undefined;
  const identityText = rest.slice(0, separator);
  const paramName = rest.slice(separator + 1);
  if (paramName.length === 0) return undefined;
  if (stable) {
    try {
      const processorId = decodeURIComponent(identityText);
      return processorId.length > 0 ? { processorId, paramName } : undefined;
    } catch {
      return undefined;
    }
  }
  const processorIndex = Number(identityText);
  if (!Number.isInteger(processorIndex) || processorIndex < 0) return undefined;
  return { processorIndex, paramName };
}

/**
 * Decodes an instrument automation param token into its SynthPatch parameter
 * name. The token is "instrument:<paramName>"; everything after the first ':'
 * is part of the parameter name.
 *
 * @param param Candidate token.
 * @returns The decoded reference, or undefined when malformed.
 */
export function parseInstrumentAutomationParam(param: string): InstrumentParamRef | undefined {
  if (!isInstrumentAutomationParam(param)) return undefined;
  const paramName = param.slice('instrument:'.length);
  if (paramName.length === 0) return undefined;
  return { paramName };
}

/** True when the value is one of the {@link AutomationCurve} names. */
function isAutomationCurve(value: unknown): value is AutomationCurve {
  return typeof value === 'string' && AUTOMATION_CURVES.has(value);
}

/** True when the value is a valid {@link AutomationParam}. */
export function isAutomationParam(value: unknown): value is AutomationParam {
  if (value === 'faderDb' || value === 'pan') return true;
  return (
    typeof value === 'string' &&
    (parseInsertAutomationParam(value) !== undefined ||
      parseMasteringAutomationParam(value) !== undefined ||
      parseInstrumentAutomationParam(value) !== undefined)
  );
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
 * - 'sCurve' applies smoothstep easing to the blend factor.
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
  // Curves are sampled once per a few screen pixels. A linear scan here made
  // dense lanes O(samples × points) on every repaint; find the enclosing
  // segment in logarithmic time instead.
  let lower = 0;
  let upper = points.length - 1;
  while (lower + 1 < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (points[middle].ppq <= ppq) lower = middle;
    else upper = middle;
  }
  const index = lower;
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
    case 'sCurve': {
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
  target: AutomationTarget,
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
