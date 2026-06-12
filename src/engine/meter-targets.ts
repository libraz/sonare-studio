/**
 * Engine meter target id map. The engine publishes one meter record stream
 * with a `targetId` discriminating the measured signal:
 *
 * - `0` — master output. The full record is meaningful, including true peak
 *   and the LUFS loudness fields.
 * - `1..32` — mixer track lane, where `laneIndex = targetId - 1`. Lane order
 *   matches the mixer sync's `laneTrackIds()` declaration order.
 * - `33..40` — mixer bus, where `busIndex = targetId - 33`.
 * - `0xFFFF` — input capture (recording level).
 *
 * Lane and bus records are lightweight: peak/RMS/correlation are meaningful,
 * the true-peak and LUFS fields are not.
 */

import { INPUT_METER_TARGET_ID } from './recorder';

/** Target id of the master output meter (full record incl. true peak/LUFS). */
export const MASTER_METER_TARGET_ID = 0;

/** First target id of the mixer track lane range. */
export const LANE_METER_TARGET_BASE = 1;

/** Number of mixer track lane meter targets. */
export const MAX_LANE_METER_TARGETS = 32;

/** First target id of the mixer bus range. */
export const BUS_METER_TARGET_BASE = 33;

/** Number of mixer bus meter targets. */
export const MAX_BUS_METER_TARGETS = 8;

export { INPUT_METER_TARGET_ID };

/** Decoded identity of one meter target id. */
export type MeterTarget =
  | { kind: 'master' }
  | { kind: 'lane'; laneIndex: number }
  | { kind: 'bus'; busIndex: number }
  | { kind: 'input' };

/**
 * Decodes a raw meter target id into its measured signal.
 *
 * @param targetId The `targetId` field of a meter record.
 * @returns The decoded target, or null for ids outside every known range.
 */
export function decodeMeterTarget(targetId: number): MeterTarget | null {
  if (targetId === MASTER_METER_TARGET_ID) return { kind: 'master' };
  if (targetId === INPUT_METER_TARGET_ID) return { kind: 'input' };
  if (
    targetId >= LANE_METER_TARGET_BASE &&
    targetId < LANE_METER_TARGET_BASE + MAX_LANE_METER_TARGETS
  ) {
    return { kind: 'lane', laneIndex: targetId - LANE_METER_TARGET_BASE };
  }
  if (
    targetId >= BUS_METER_TARGET_BASE &&
    targetId < BUS_METER_TARGET_BASE + MAX_BUS_METER_TARGETS
  ) {
    return { kind: 'bus', busIndex: targetId - BUS_METER_TARGET_BASE };
  }
  return null;
}

/**
 * Returns the meter target id of a mixer track lane.
 *
 * @param laneIndex Lane index in the mixer sync's declared lane order.
 * @returns The target id of the lane's meter records.
 * @throws RangeError When the index is outside `[0, MAX_LANE_METER_TARGETS)`.
 */
export function laneMeterTargetId(laneIndex: number): number {
  if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= MAX_LANE_METER_TARGETS) {
    throw new RangeError(`lane index out of range [0, ${MAX_LANE_METER_TARGETS}): ${laneIndex}`);
  }
  return LANE_METER_TARGET_BASE + laneIndex;
}

/**
 * Returns the meter target id of a mixer bus.
 *
 * @param busIndex Bus index in mixer bus order.
 * @returns The target id of the bus's meter records.
 * @throws RangeError When the index is outside `[0, MAX_BUS_METER_TARGETS)`.
 */
export function busMeterTargetId(busIndex: number): number {
  if (!Number.isInteger(busIndex) || busIndex < 0 || busIndex >= MAX_BUS_METER_TARGETS) {
    throw new RangeError(`bus index out of range [0, ${MAX_BUS_METER_TARGETS}): ${busIndex}`);
  }
  return BUS_METER_TARGET_BASE + busIndex;
}
