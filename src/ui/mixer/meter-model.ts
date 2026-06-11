/**
 * Pure level-meter state machine for the mixer strip meters.
 *
 * Keeps the ballistics of the existing transport meter (peak/RMS falloff and
 * a peak-hold marker) and adds a clip indicator that latches when the peak
 * reaches 0 dBFS until explicitly reset. The model is canvas-free so it can
 * be unit-tested; the drawing component advances it once per animation frame.
 */

/** Bottom of the visible meter range in dB. */
export const METER_MIN_DB = -60;

/** Peak level at or above this many dBFS latches the clip indicator. */
export const CLIP_THRESHOLD_DB = 0;

/** Displayed-peak falloff in dB per second. */
export const PEAK_DECAY_DB_PER_S = 24;

/** RMS falloff in dB per second (slightly slower for a steadier bar). */
export const RMS_DECAY_DB_PER_S = 18;

/** Peak-hold marker hold time in milliseconds before it starts falling. */
export const PEAK_HOLD_MS = 1000;

/** Peak-hold marker falloff after the hold time, in dB per second. */
export const PEAK_HOLD_DECAY_DB_PER_S = 12;

/** Ballistic state of one meter channel. */
export interface MeterChannelModel {
  /** Displayed peak level in dB (decays toward the floor). */
  peakDb: number;
  /** Displayed RMS level in dB (decays toward the floor). */
  rmsDb: number;
  /** Peak-hold marker level in dB. */
  holdDb: number;
  /** Timestamp (ms) the hold marker was last raised. */
  holdAtMs: number;
  /** True once the peak reached {@link CLIP_THRESHOLD_DB}; latched. */
  clipped: boolean;
}

/** Target levels fed into one advance step. */
export interface MeterTargets {
  /** Instantaneous peak level in dB. */
  peakDb: number;
  /** Instantaneous RMS level in dB. */
  rmsDb: number;
}

/** Creates a silent meter channel resting at the floor. */
export function createMeterChannel(minDb = METER_MIN_DB): MeterChannelModel {
  return { peakDb: minDb, rmsDb: minDb, holdDb: minDb, holdAtMs: 0, clipped: false };
}

/**
 * Advances one channel by a time step: new targets raise the levels
 * instantly, otherwise they decay at the meter ballistics; the hold marker
 * stays for {@link PEAK_HOLD_MS} before falling; the clip flag latches.
 *
 * @param model Channel state, mutated in place.
 * @param targets Instantaneous levels of this step.
 * @param dtSec Time since the previous step in seconds.
 * @param nowMs Current timestamp in milliseconds.
 * @param minDb Meter floor (default {@link METER_MIN_DB}).
 * @returns The same model, for chaining.
 */
export function advanceMeterChannel(
  model: MeterChannelModel,
  targets: MeterTargets,
  dtSec: number,
  nowMs: number,
  minDb = METER_MIN_DB,
): MeterChannelModel {
  model.peakDb = Math.max(targets.peakDb, model.peakDb - PEAK_DECAY_DB_PER_S * dtSec, minDb);
  model.rmsDb = Math.max(targets.rmsDb, model.rmsDb - RMS_DECAY_DB_PER_S * dtSec, minDb);
  if (targets.peakDb >= model.holdDb) {
    model.holdDb = targets.peakDb;
    model.holdAtMs = nowMs;
  } else if (nowMs - model.holdAtMs > PEAK_HOLD_MS) {
    model.holdDb = Math.max(model.holdDb - PEAK_HOLD_DECAY_DB_PER_S * dtSec, minDb);
  }
  if (targets.peakDb >= CLIP_THRESHOLD_DB) model.clipped = true;
  return model;
}

/** Clears the latched clip indicator of one channel. */
export function resetMeterClip(model: MeterChannelModel): void {
  model.clipped = false;
}

/**
 * Maps a dB level to a fill fraction in [0, 1] (0 at the floor, 1 at 0 dBFS).
 *
 * @param db Level in dB.
 * @param minDb Meter floor (default {@link METER_MIN_DB}).
 */
export function meterFraction(db: number, minDb = METER_MIN_DB): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - minDb) / (0 - minDb)));
}
