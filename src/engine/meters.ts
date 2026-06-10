import type { EngineHandle } from '@/engine/engine.js';
import type { SonareWorkletMeterSnapshot } from '@/wasm/worklet.js';

/**
 * Floor used to normalize non-finite dB values (silence is reported as
 * `-Infinity` by the engine); anything below this is clamped.
 */
export const METER_SILENCE_DB = -120;

/**
 * Latest stereo level readings exposed by a {@link MeterBridge}.
 *
 * Mirrors the engine's `SonareWorkletMeterSnapshot` payload
 * (`{ type: 'meter', frame, peakDbL, peakDbR, rmsDbL, rmsDbR, correlation }`)
 * minus the discriminator, with all dB values normalized to finite numbers
 * (clamped to {@link METER_SILENCE_DB}).
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
}

/** Callback invoked whenever a new meter snapshot arrives. */
export type MeterListener = (levels: StereoMeterLevels) => void;

/**
 * Bridges engine meter telemetry to the UI: keeps the most recent stereo
 * peak/RMS levels and fans new snapshots out to subscribers.
 */
export interface MeterBridge {
  /** The most recent levels (a silent snapshot until data arrives). */
  readonly latest: StereoMeterLevels;
  /**
   * Registers a listener for new meter snapshots.
   *
   * @param listener Called with the normalized levels of each new snapshot.
   * @returns An unsubscribe function; safe to call more than once.
   */
  subscribe(listener: MeterListener): () => void;
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

/**
 * Creates a meter bridge for a running engine.
 *
 * Delivery strategy covers both transport modes:
 * - `engine.onMeter` push callbacks (the only source in postMessage mode).
 * - A requestAnimationFrame loop draining `engine.pollMeters()`, which only
 *   yields data in SAB mode; the loop is started only when the negotiated
 *   capabilities report `mode === 'sab'`.
 *
 * @param handle The engine handle returned by `createEngine`.
 * @returns A bridge exposing the latest levels plus subscribe/dispose.
 */
export function createMeterBridge(handle: EngineHandle): MeterBridge {
  const listeners = new Set<MeterListener>();
  let latest = silentLevels();
  let disposed = false;
  let rafId = 0;

  const publish = (snapshot: SonareWorkletMeterSnapshot): void => {
    latest = {
      frame: snapshot.frame,
      peakDbL: clampDb(snapshot.peakDbL),
      peakDbR: clampDb(snapshot.peakDbR),
      rmsDbL: clampDb(snapshot.rmsDbL),
      rmsDbR: clampDb(snapshot.rmsDbR),
      correlation: snapshot.correlation,
    };
    for (const listener of listeners) {
      listener(latest);
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
    const snapshots = handle.engine.pollMeters();
    if (snapshots.length > 0) {
      // Only the most recent snapshot matters for level display.
      publish(snapshots[snapshots.length - 1]);
    }
    rafId = raf(poll);
  };
  if (handle.capabilities.mode === 'sab') {
    rafId = raf(poll);
  }

  return {
    get latest(): StereoMeterLevels {
      return latest;
    },
    subscribe(listener: MeterListener): () => void {
      if (!disposed) {
        listeners.add(listener);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelRaf(rafId);
      unsubscribeOnMeter();
      listeners.clear();
    },
  };
}
