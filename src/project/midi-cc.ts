/**
 * MIDI continuous-controller (CC) helpers shared by the commands, serializer,
 * store mirror, engine MIDI sync and the piano-roll CC lane: a curated catalog
 * of the controllers the editor surfaces plus pure sanitize/clone routines for
 * clip CC lanes. Canvas-free and side-effect-free.
 *
 * Clip CC lanes are app-level metadata (the wasm Project stores notes only);
 * playback bakes each lane's points into the realtime MIDI clip schedule as
 * discrete CC events, so the lane is genuinely audible during transport.
 */

import type { ClipCcLane, ClipCcPoint, ClipPitchBendPoint, ClipPressurePoint } from './types';

/** Lowest MIDI controller number / value. */
export const MIDI_CC_MIN = 0;
/** Highest MIDI controller number / 7-bit value. */
export const MIDI_CC_MAX = 127;
/** Highest MIDI channel index (0-based). */
export const MIDI_CHANNEL_MAX = 15;
/** Highest MIDI 14-bit pitch-bend value. */
export const MIDI_PITCH_BEND_MAX = 16383;
/** Pitch-bend value with no bend applied (axis center). */
export const MIDI_PITCH_BEND_CENTER = 8192;

/** One CC controller the piano-roll lane header offers as a tab. */
export interface CcLaneOption {
  /** MIDI controller number (0-127). */
  controller: number;
  /** Short tab label that fits the narrow lane header. */
  label: string;
  /** Full controller name (tab tooltip). */
  title: string;
}

/**
 * Curated CC controllers exposed as lane tabs, in tab order. These are the
 * controllers most commonly drawn in a DAW piano roll; the data model accepts
 * any controller 0-127, so this list only governs the default UI affordance.
 */
export const PIANO_ROLL_CC_LANES: readonly CcLaneOption[] = [
  { controller: 1, label: 'CC1', title: 'Modulation (CC 1)' },
  { controller: 11, label: 'CC11', title: 'Expression (CC 11)' },
  { controller: 10, label: 'CC10', title: 'Pan (CC 10)' },
  { controller: 64, label: 'CC64', title: 'Sustain (CC 64)' },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamps to an integer in [min, max] (non-finite returns min). */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return clamp(Math.round(value), min, max);
}

/** True when `controller` is a valid MIDI controller number (integer 0-127). */
export function isValidController(controller: number): boolean {
  return Number.isInteger(controller) && controller >= MIDI_CC_MIN && controller <= MIDI_CC_MAX;
}

/** True when `channel` is a valid MIDI channel index (integer 0-15). */
export function isValidChannel(channel: number): boolean {
  return Number.isInteger(channel) && channel >= 0 && channel <= MIDI_CHANNEL_MAX;
}

/**
 * Normalizes CC breakpoints: drops non-finite entries, clamps each position to
 * [0, lengthPpq] and each value to an integer in [0, 127], collapses points
 * that land on the same position (last wins) and returns them sorted by ppq.
 *
 * @param points Raw breakpoints in any order.
 * @param lengthPpq Clip window length the positions are clamped to (>= 0).
 * @returns A fresh sorted, de-duplicated point list.
 */
export function sanitizeCcPoints(
  points: ReadonlyArray<ClipCcPoint>,
  lengthPpq: number,
): ClipCcPoint[] {
  const max = Number.isFinite(lengthPpq) && lengthPpq > 0 ? lengthPpq : 0;
  const byPpq = new Map<number, number>();
  for (const point of points) {
    if (!Number.isFinite(point.ppq)) continue;
    byPpq.set(clamp(point.ppq, 0, max), clampInt(point.value, MIDI_CC_MIN, MIDI_CC_MAX));
  }
  return [...byPpq.entries()].map(([ppq, value]) => ({ ppq, value })).sort((a, b) => a.ppq - b.ppq);
}

/**
 * Normalizes pitch-bend breakpoints: drops non-finite entries, clamps each
 * position to [0, lengthPpq] and each value to an integer in [0, 16383]
 * (8192 = center), collapses points on the same position (last wins) and
 * returns them sorted by ppq.
 *
 * @param points Raw breakpoints in any order.
 * @param lengthPpq Clip window length the positions are clamped to (>= 0).
 * @returns A fresh sorted, de-duplicated point list.
 */
export function sanitizePitchBendPoints(
  points: ReadonlyArray<ClipPitchBendPoint>,
  lengthPpq: number,
): ClipPitchBendPoint[] {
  const max = Number.isFinite(lengthPpq) && lengthPpq > 0 ? lengthPpq : 0;
  const byPpq = new Map<number, number>();
  for (const point of points) {
    if (!Number.isFinite(point.ppq)) continue;
    byPpq.set(clamp(point.ppq, 0, max), clampInt(point.value, 0, MIDI_PITCH_BEND_MAX));
  }
  return [...byPpq.entries()].map(([ppq, value]) => ({ ppq, value })).sort((a, b) => a.ppq - b.ppq);
}

/**
 * Normalizes aftertouch (channel/poly pressure) breakpoints: drops non-finite
 * entries, clamps each position to [0, lengthPpq] and each value to an integer
 * in [0, 127], collapses points on the same position (last wins) and returns
 * them sorted by ppq.
 *
 * @param points Raw breakpoints in any order.
 * @param lengthPpq Clip window length the positions are clamped to (>= 0).
 * @returns A fresh sorted, de-duplicated point list.
 */
export function sanitizePressurePoints(
  points: ReadonlyArray<ClipPressurePoint>,
  lengthPpq: number,
): ClipPressurePoint[] {
  const max = Number.isFinite(lengthPpq) && lengthPpq > 0 ? lengthPpq : 0;
  const byPpq = new Map<number, number>();
  for (const point of points) {
    if (!Number.isFinite(point.ppq)) continue;
    byPpq.set(clamp(point.ppq, 0, max), clampInt(point.value, MIDI_CC_MIN, MIDI_CC_MAX));
  }
  return [...byPpq.entries()].map(([ppq, value]) => ({ ppq, value })).sort((a, b) => a.ppq - b.ppq);
}

/**
 * Deep-copies a clip's CC lanes, dropping empty lanes. Returns undefined when
 * no lane survives so callers can omit the field entirely.
 *
 * @param lanes Source CC lanes (may be undefined).
 * @returns A fresh lane list, or undefined when there is nothing to keep.
 */
export function cloneCcLanes(
  lanes: ReadonlyArray<ClipCcLane> | undefined,
): ClipCcLane[] | undefined {
  if (lanes === undefined) return undefined;
  const out = lanes
    .filter((lane) => lane.points.length > 0)
    .map((lane) => ({
      controller: lane.controller,
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  return out.length > 0 ? out : undefined;
}
