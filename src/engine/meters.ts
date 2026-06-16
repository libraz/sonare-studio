import type { EngineHandle } from '@/engine/engine.js';
import type { SonareWorkletMeterSnapshot } from '@/wasm/worklet.js';
import { MASTER_METER_TARGET_ID } from './meter-targets';

/**
 * Floor used to normalize non-finite dB values (silence is reported as
 * `-Infinity` by the engine); anything below this is clamped.
 */
export const METER_SILENCE_DB = -120;

/**
 * Latest stereo level readings exposed by a {@link MeterBridge}.
 *
 * Mirrors the engine's `SonareWorkletMeterSnapshot` payload minus the
 * discriminator and target id, with all peak/RMS dB values normalized to
 * finite numbers (clamped to {@link METER_SILENCE_DB}). The optional fields
 * come from full records (the master target): they are passed through
 * unclamped and omitted when the engine reports a non-finite value, which is
 * also the case for the lightweight lane/bus records.
 */
export interface StereoMeterLevels {
  /** Absolute engine frame the snapshot was taken at. */
  frame: number;
  /** Left channel peak level in dBFS. */
  peakDbL: number;
  /** Right channel peak level in dBFS. */
  peakDbR: number;
  /** Left channel RMS level in dBFS. */
  rmsDbL: number;
  /** Right channel RMS level in dBFS. */
  rmsDbR: number;
  /** Stereo correlation in [-1, 1]. */
  correlation: number;
  /** Left channel true peak in dBTP (full records only). */
  truePeakDbL?: number;
  /** Right channel true peak in dBTP (full records only). */
  truePeakDbR?: number;
  /** Momentary loudness in LUFS (full records only). */
  momentaryLufs?: number;
  /** Short-term loudness in LUFS (full records only). */
  shortTermLufs?: number;
  /** Integrated loudness in LUFS (full records only). */
  integratedLufs?: number;
  /**
   * Strip gain reduction in dB from the strip's dynamics processors (omitted
   * when the engine reports a non-finite value). Present on any target whose
   * insert chain runs a compressor/limiter, not only the master.
   */
  gainReductionDb?: number;
}

/** Callback invoked whenever a new meter snapshot arrives. */
export type MeterListener = (levels: StereoMeterLevels) => void;

/**
 * Read-only view of one meter target's level stream: the most recent levels
 * plus a subscription for new snapshots.
 */
export interface MeterSource {
  /** The most recent levels (a silent snapshot until data arrives). */
  readonly latest: StereoMeterLevels;
  /**
   * Registers a listener for new meter snapshots of this target.
   *
   * @param listener Called with the normalized levels of each new snapshot.
   * @returns An unsubscribe function; safe to call more than once.
   */
  subscribe(listener: MeterListener): () => void;
}

/**
 * Bridges engine meter telemetry to the UI: keeps the most recent stereo
 * peak/RMS levels per meter target and fans new snapshots out to
 * subscribers. The bridge itself is the master-output source; other targets
 * (lanes, buses, input capture) are reached via {@link MeterBridge.forTarget}.
 */
export interface MeterBridge extends MeterSource {
  /**
   * Returns the level source of one meter target id (see meter-targets.ts
   * for the id map). The source is silent until the engine publishes a
   * record for that target.
   *
   * @param targetId Engine meter target id.
   * @returns A source tracking that target's latest levels and snapshots.
   */
  forTarget(targetId: number): MeterSource;
  /** Stops all meter delivery and releases engine subscriptions. Idempotent. */
  dispose(): void;
}

/** A level reading representing silence. */
function silentLevels(): StereoMeterLevels {
  return {
    frame: 0,
    peakDbL: METER_SILENCE_DB,
    peakDbR: METER_SILENCE_DB,
    rmsDbL: METER_SILENCE_DB,
    rmsDbR: METER_SILENCE_DB,
    correlation: 0,
  };
}

/** Clamps a possibly non-finite dB value to the silence floor. */
function clampDb(db: number): number {
  return Number.isFinite(db) && db > METER_SILENCE_DB ? db : METER_SILENCE_DB;
}

/** Normalizes an engine snapshot, omitting non-finite full-record fields. */
function toLevels(snapshot: SonareWorkletMeterSnapshot): StereoMeterLevels {
  const levels: StereoMeterLevels = {
    frame: snapshot.frame,
    peakDbL: clampDb(snapshot.peakDbL),
    peakDbR: clampDb(snapshot.peakDbR),
    rmsDbL: clampDb(snapshot.rmsDbL),
    rmsDbR: clampDb(snapshot.rmsDbR),
    correlation: snapshot.correlation,
  };
  if (Number.isFinite(snapshot.truePeakDbL)) levels.truePeakDbL = snapshot.truePeakDbL;
  if (Number.isFinite(snapshot.truePeakDbR)) levels.truePeakDbR = snapshot.truePeakDbR;
  if (Number.isFinite(snapshot.momentaryLufs)) levels.momentaryLufs = snapshot.momentaryLufs;
  if (Number.isFinite(snapshot.shortTermLufs)) levels.shortTermLufs = snapshot.shortTermLufs;
  if (Number.isFinite(snapshot.integratedLufs)) levels.integratedLufs = snapshot.integratedLufs;
  if (Number.isFinite(snapshot.gainReductionDb)) levels.gainReductionDb = snapshot.gainReductionDb;
  return levels;
}

/**
 * Creates a meter bridge for a running engine.
 *
 * Delivery strategy covers both transport modes:
 * - `engine.onMeter` push callbacks (the only source in postMessage mode).
 * - A requestAnimationFrame loop draining `engine.pollMeters()`, which only
 *   yields data in SAB mode; the loop is started only when the negotiated
 *   capabilities report `mode === 'sab'`.
 *
 * Every record is routed by its target id; the bridge's own latest/subscribe
 * track the master output (target id 0).
 *
 * @param handle The engine handle returned by `createEngine`.
 * @returns A bridge exposing per-target sources plus dispose.
 */
export function createMeterBridge(handle: EngineHandle): MeterBridge {
  const latestByTarget = new Map<number, StereoMeterLevels>();
  const listenersByTarget = new Map<number, Set<MeterListener>>();
  const sources = new Map<number, MeterSource>();
  let disposed = false;
  let rafId = 0;

  const publish = (snapshot: SonareWorkletMeterSnapshot): void => {
    const targetId = snapshot.targetId ?? MASTER_METER_TARGET_ID;
    const levels = toLevels(snapshot);
    latestByTarget.set(targetId, levels);
    const listeners = listenersByTarget.get(targetId);
    if (listeners) {
      for (const listener of listeners) {
        listener(levels);
      }
    }
  };

  const unsubscribeOnMeter = handle.engine.onMeter(publish);

  // Fall back to a timer where requestAnimationFrame is unavailable (e.g. workers).
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback): number => setTimeout(() => cb(performance.now()), 16);
  const cancelRaf =
    typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id: number): void => clearTimeout(id);

  const poll = (): void => {
    if (disposed) return;
    // Publish every polled record in order so each target's latest reading
    // reflects its newest record.
    for (const snapshot of handle.engine.pollMeters()) {
      publish(snapshot);
    }
    rafId = raf(poll);
  };
  if (handle.capabilities.mode === 'sab') {
    rafId = raf(poll);
  }

  const sourceFor = (targetId: number): MeterSource => {
    const existing = sources.get(targetId);
    if (existing) return existing;
    const source: MeterSource = {
      get latest(): StereoMeterLevels {
        return latestByTarget.get(targetId) ?? silentLevels();
      },
      subscribe(listener: MeterListener): () => void {
        let listeners = listenersByTarget.get(targetId);
        if (!listeners) {
          listeners = new Set();
          listenersByTarget.set(targetId, listeners);
        }
        if (!disposed) {
          listeners.add(listener);
        }
        return () => {
          listenersByTarget.get(targetId)?.delete(listener);
        };
      },
    };
    sources.set(targetId, source);
    return source;
  };

  const master = sourceFor(MASTER_METER_TARGET_ID);

  return {
    get latest(): StereoMeterLevels {
      return master.latest;
    },
    subscribe(listener: MeterListener): () => void {
      return master.subscribe(listener);
    },
    forTarget(targetId: number): MeterSource {
      return sourceFor(targetId);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelRaf(rafId);
      unsubscribeOnMeter();
      for (const listeners of listenersByTarget.values()) {
        listeners.clear();
      }
      listenersByTarget.clear();
    },
  };
}
