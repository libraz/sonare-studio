import type { WorkletMeterSnapshot } from '@libraz/libsonare/worklet';
import type { EngineHandle } from '@/engine/engine.js';
import { SILENCE_DB } from '@/lib/db';
import { MASTER_METER_TARGET_ID } from './meter-targets';
import { createTargetListeners } from './target-listeners';

/**
 * Latest stereo level readings exposed by a {@link MeterBridge}.
 *
 * Mirrors the engine's `WorkletMeterSnapshot` payload minus the
 * discriminator and target id, with all peak/RMS dB values normalized to
 * finite numbers (clamped to {@link SILENCE_DB}). Optional measurements
 * are passed through unclamped. Negative infinity represents measured silence
 * for true peak and LUFS.
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
  /** Stereo correlation in [-1, 1], when measured. */
  correlation?: number;
  /** Left channel true peak in dBTP (full records only). */
  truePeakDbtpL?: number;
  /** Right channel true peak in dBTP (full records only). */
  truePeakDbtpR?: number;
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
 * Callback receiving a target strip's per-insert gain reduction: dB values
 * (each <= 0) indexed by engine insert, pre-fader inserts before post-fader.
 */
export type InsertGainReductionListener = (valuesDb: readonly number[]) => void;

/** Minimum interval between per-insert gain-reduction polls of one target on the ring transport. */
export const INSERT_GAIN_REDUCTION_POLL_MS = 66;

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
  /**
   * Registers a listener for the target strip's per-insert gain reduction.
   * The postMessage transport carries it on meter records; on the ring
   * transport the bridge polls the worklet only while a listener exists.
   *
   * @param listener Called with each new per-insert reading.
   * @returns An unsubscribe function; safe to call more than once.
   */
  subscribeInsertGainReduction(listener: InsertGainReductionListener): () => void;
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
  /**
   * Resolves once every target that gained an insert gain-reduction listener
   * has had its first poll settle; at once when no poll is due.
   */
  whenInsertGainReductionPolled(): Promise<void>;
  /** Stops all meter delivery and releases engine subscriptions. Idempotent. */
  dispose(): void;
}

/** A level reading representing silence, shared by every source that has no data yet. */
const SILENT_LEVELS: StereoMeterLevels = Object.freeze({
  frame: 0,
  peakDbL: SILENCE_DB,
  peakDbR: SILENCE_DB,
  rmsDbL: SILENCE_DB,
  rmsDbR: SILENCE_DB,
});

/** Clamps a possibly non-finite dB value to the silence floor. */
function clampDb(db: number | undefined): number {
  return db !== undefined && Number.isFinite(db) && db > SILENCE_DB ? db : SILENCE_DB;
}

/** True for a finite level or a reading of silence. */
function isLevel(db: number | undefined): db is number {
  return Number.isFinite(db) || db === Number.NEGATIVE_INFINITY;
}

/** Normalizes an engine snapshot, preserving its optional measurements. */
function toLevels(snapshot: WorkletMeterSnapshot): StereoMeterLevels {
  const levels: StereoMeterLevels = {
    frame: snapshot.frame,
    peakDbL: clampDb(snapshot.peakDb[0]),
    peakDbR: clampDb(snapshot.peakDb[1]),
    rmsDbL: clampDb(snapshot.rmsDb[0]),
    rmsDbR: clampDb(snapshot.rmsDb[1]),
  };
  if (Number.isFinite(snapshot.correlation)) levels.correlation = snapshot.correlation;
  const truePeakDbtpL = snapshot.truePeakDbtp[0];
  const truePeakDbtpR = snapshot.truePeakDbtp[1];
  if (isLevel(truePeakDbtpL)) levels.truePeakDbtpL = truePeakDbtpL;
  if (isLevel(truePeakDbtpR)) levels.truePeakDbtpR = truePeakDbtpR;
  if (isLevel(snapshot.momentaryLufs)) levels.momentaryLufs = snapshot.momentaryLufs;
  if (isLevel(snapshot.shortTermLufs)) levels.shortTermLufs = snapshot.shortTermLufs;
  if (isLevel(snapshot.integratedLufs)) levels.integratedLufs = snapshot.integratedLufs;
  if (Number.isFinite(snapshot.gainReductionDb)) levels.gainReductionDb = snapshot.gainReductionDb;
  return levels;
}

/**
 * Creates a meter bridge for a running engine.
 *
 * Records arrive through `engine.onMeter` in both transport modes. In SAB mode
 * a requestAnimationFrame loop polls per-insert gain reduction for watched
 * targets, running only while such a listener exists.
 *
 * Every record is routed by its target id; the bridge's own latest/subscribe
 * track the master output (target id 0).
 *
 * @param handle The engine handle returned by `createEngine`.
 * @returns A bridge exposing per-target sources plus dispose.
 */
export function createMeterBridge(handle: EngineHandle): MeterBridge {
  const latestByTarget = new Map<number, StereoMeterLevels>();
  const meterListeners = createTargetListeners<StereoMeterLevels>(() => disposed);
  const sources = new Map<number, MeterSource>();
  const insertGrListeners = createTargetListeners<readonly number[]>(() => disposed);
  const insertGrPolls = new Map<number, { inFlight: boolean; lastMs: number; settled: boolean }>();
  const polledWaiters: Array<() => void> = [];
  let disposed = false;
  let rafId = 0;

  const publish = (snapshot: WorkletMeterSnapshot): void => {
    const targetId = snapshot.targetId ?? MASTER_METER_TARGET_ID;
    const levels = toLevels(snapshot);
    latestByTarget.set(targetId, levels);
    meterListeners.emit(targetId, levels);
    // Only the newest record per target in a drain carries the array.
    if (snapshot.insertGainReductionDb) {
      publishInsertGr(targetId, snapshot.insertGainReductionDb);
    }
  };

  function publishInsertGr(targetId: number, valuesDb: readonly number[]): void {
    insertGrListeners.emit(targetId, valuesDb);
  }

  // Ring records have a fixed layout without per-insert values, so ask the
  // worklet for each watched target, one request in flight and throttled.
  const pollInsertGr = (now: number): void => {
    for (const [targetId, listeners] of insertGrListeners.entries()) {
      if (listeners.size === 0) continue;
      let state = insertGrPolls.get(targetId);
      if (!state) {
        state = { inFlight: false, lastMs: Number.NEGATIVE_INFINITY, settled: false };
        insertGrPolls.set(targetId, state);
      }
      if (state.inFlight || now - state.lastMs < INSERT_GAIN_REDUCTION_POLL_MS) continue;
      const poll = state;
      poll.inFlight = true;
      poll.lastMs = now;
      handle.engine.pollInsertGainReduction(targetId).then(
        (valuesDb) => {
          poll.inFlight = false;
          poll.settled = true;
          if (!disposed) publishInsertGr(targetId, valuesDb);
          wakePolledWaiters();
        },
        () => {
          // Rejected once the node is destroyed; the next frame retries otherwise.
          poll.inFlight = false;
          poll.settled = true;
          wakePolledWaiters();
        },
      );
    }
  };

  const firstPollPending = (): boolean => {
    if (disposed || handle.capabilities.mode !== 'sab') return false;
    for (const [targetId, listeners] of insertGrListeners.entries()) {
      if (listeners.size > 0 && !insertGrPolls.get(targetId)?.settled) return true;
    }
    return false;
  };
  function wakePolledWaiters(): void {
    if (firstPollPending()) return;
    for (const wake of polledWaiters.splice(0)) wake();
  }

  // onMeter is the single source in both transport modes: any facade
  // subscription (onMeter, onTelemetry, onMidiOut) starts an internal ring
  // poller that shares the read index, so draining pollMeters() as well would
  // lose records.
  const unsubscribeOnMeter = handle.engine.onMeter(publish);

  // Fall back to a timer where requestAnimationFrame is unavailable (e.g. workers).
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback): number => self.setTimeout(() => cb(performance.now()), 16);
  const cancelRaf =
    typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id: number): void => self.clearTimeout(id);

  // Ring records carry no per-insert values, so only SAB mode needs the poll,
  // and only while an insert gain-reduction listener exists.
  const poll = (now: number): void => {
    rafId = 0;
    if (disposed || !insertGrListeners.hasListeners()) return;
    pollInsertGr(now);
    rafId = raf(poll);
  };
  const ensurePolling = (): void => {
    if (disposed || rafId !== 0 || handle.capabilities.mode !== 'sab') return;
    rafId = raf(poll);
  };

  const sourceFor = (targetId: number): MeterSource => {
    const existing = sources.get(targetId);
    if (existing) return existing;
    const source: MeterSource = {
      get latest(): StereoMeterLevels {
        return latestByTarget.get(targetId) ?? SILENT_LEVELS;
      },
      subscribe(listener: MeterListener): () => void {
        return meterListeners.subscribe(targetId, listener);
      },
      subscribeInsertGainReduction(listener: InsertGainReductionListener): () => void {
        const unsubscribe = insertGrListeners.subscribe(targetId, listener);
        ensurePolling();
        return () => {
          unsubscribe();
          // A target that loses its last listener polls afresh when watched again.
          if (!insertGrListeners.hasListeners(targetId)) insertGrPolls.delete(targetId);
          wakePolledWaiters();
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
    subscribeInsertGainReduction(listener: InsertGainReductionListener): () => void {
      return master.subscribeInsertGainReduction(listener);
    },
    forTarget(targetId: number): MeterSource {
      return sourceFor(targetId);
    },
    whenInsertGainReductionPolled(): Promise<void> {
      if (!firstPollPending()) return Promise.resolve();
      return new Promise<void>((resolve) => polledWaiters.push(resolve));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelRaf(rafId);
      unsubscribeOnMeter();
      meterListeners.clear();
      insertGrListeners.clear();
      wakePolledWaiters();
    },
  };
}
