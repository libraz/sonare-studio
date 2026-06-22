import type { EngineHandle } from '@/engine/engine.js';
import type { SonareWorkletScopeSnapshot } from '@/wasm/worklet.js';
import { MASTER_METER_TARGET_ID } from './meter-targets';

/**
 * Bridges the engine's scope telemetry (windowed-FFT spectrum bands plus a
 * decimated stereo goniometer) to the UI, mirroring {@link createMeterBridge}.
 *
 * Unlike the master-only Web Audio {@link AnalyserBridge}, scope telemetry is
 * produced inside the realtime engine per render target (master, every mixer
 * lane, every bus) using the same target-id numbering as meters, so per-strip
 * spectrum and goniometer become reachable. It is opt-in and only flows in SAB
 * mode on the embind runtime (the FFT is too heavy for a postMessage
 * fallback); on other transports the bridge reports `available === false`.
 */

/** One scope frame for a single target: spectrum bands plus goniometer points. */
export interface ScopeFrame {
  /** Absolute engine frame the snapshot was taken at. */
  frame: number;
  /** Spectrum magnitudes in dB, one per configured band (low to high). */
  bands: Float32Array;
  /** Interleaved stereo goniometer points: [l0, r0, l1, r1, ...]. */
  points: Float32Array;
}

/** Callback invoked whenever a new scope frame arrives for a target. */
export type ScopeListener = (frame: ScopeFrame) => void;

/**
 * Read-only view of one scope target's stream: the most recent frame plus a
 * subscription for new frames.
 */
export interface ScopeSource {
  /** True when scope telemetry can flow on this engine (SAB + embind). */
  readonly available: boolean;
  /**
   * Audio sample rate in Hz. The engine aggregates the FFT into `bands`
   * linearly-spaced bands over [0, Nyquist], so band `b`'s center frequency is
   * `(b + 0.5) / bands.length * (sampleRate / 2)`.
   */
  readonly sampleRate: number;
  /** The most recent frame, or null until the engine publishes one. */
  readonly latest: ScopeFrame | null;
  /**
   * Registers a listener for new scope frames of this target.
   *
   * @param listener Called with each new frame of the target.
   * @returns An unsubscribe function; safe to call more than once.
   */
  subscribe(listener: ScopeListener): () => void;
}

/**
 * Scope telemetry bridge. The bridge itself is the master-output source; other
 * targets (lanes, buses) are reached via {@link ScopeBridge.forTarget} using
 * the meter target-id map (see meter-targets.ts).
 */
export interface ScopeBridge extends ScopeSource {
  /**
   * Returns the scope source of one target id. The source is silent until the
   * engine publishes a frame for that target.
   *
   * @param targetId Engine target id (same numbering as meter targets).
   * @returns A source tracking that target's latest frame and frames.
   */
  forTarget(targetId: number): ScopeSource;
  /** Stops scope delivery and releases engine subscriptions. Idempotent. */
  dispose(): void;
}

/** True when the negotiated capabilities can carry scope telemetry. */
function scopeIsAvailable(handle: EngineHandle): boolean {
  return handle.capabilities.mode === 'sab' && handle.capabilities.runtimeTarget === 'embind';
}

/** Copies an engine snapshot into a stable {@link ScopeFrame}. */
function toFrame(snapshot: SonareWorkletScopeSnapshot): ScopeFrame {
  return { frame: snapshot.frame, bands: snapshot.bands, points: snapshot.points };
}

/**
 * Creates a scope bridge for a running engine.
 *
 * Delivery mirrors the meter bridge: `engine.onScope` push callbacks plus a
 * requestAnimationFrame loop draining `engine.pollScope()` in SAB mode. Every
 * frame is routed by its target id; the bridge's own latest/subscribe track
 * the master output.
 *
 * @param handle The engine handle returned by `createEngine`.
 * @returns A bridge exposing per-target scope sources plus dispose.
 */
export function createScopeBridge(handle: EngineHandle): ScopeBridge {
  const available = scopeIsAvailable(handle);
  const sampleRate = handle.ctx.sampleRate;
  const latestByTarget = new Map<number, ScopeFrame>();
  const listenersByTarget = new Map<number, Set<ScopeListener>>();
  const sources = new Map<number, ScopeSource>();
  let disposed = false;
  let rafId = 0;

  const publish = (snapshot: SonareWorkletScopeSnapshot): void => {
    const targetId = snapshot.targetId ?? MASTER_METER_TARGET_ID;
    const frame = toFrame(snapshot);
    latestByTarget.set(targetId, frame);
    const listeners = listenersByTarget.get(targetId);
    if (listeners) {
      for (const listener of listeners) {
        listener(frame);
      }
    }
  };

  const unsubscribeOnScope = available ? handle.engine.onScope(publish) : () => undefined;

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
    for (const snapshot of handle.engine.pollScope()) {
      publish(snapshot);
    }
    rafId = raf(poll);
  };
  if (available && handle.capabilities.mode === 'sab') {
    rafId = raf(poll);
  }

  const sourceFor = (targetId: number): ScopeSource => {
    const existing = sources.get(targetId);
    if (existing) return existing;
    const source: ScopeSource = {
      available,
      sampleRate,
      get latest(): ScopeFrame | null {
        return latestByTarget.get(targetId) ?? null;
      },
      subscribe(listener: ScopeListener): () => void {
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
    available,
    sampleRate,
    get latest(): ScopeFrame | null {
      return master.latest;
    },
    subscribe(listener: ScopeListener): () => void {
      return master.subscribe(listener);
    },
    forTarget(targetId: number): ScopeSource {
      return sourceFor(targetId);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelRaf(rafId);
      unsubscribeOnScope();
      for (const listeners of listenersByTarget.values()) {
        listeners.clear();
      }
      listenersByTarget.clear();
    },
  };
}
