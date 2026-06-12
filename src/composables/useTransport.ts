import type { MaybeRefOrGetter, Ref } from 'vue';
import { getCurrentScope, onScopeDispose, ref, toValue } from 'vue';
import type { EngineHandle } from '@/engine/engine';
import { normalizeTempoMap, ppqToSeconds, samplesToPpq, secondsToPpq } from '@/project/tempo-map';
import type { TempoSegment } from '@/project/types';
import type { SonareEngine, SonareEngineTelemetryRecord } from '@/wasm/worklet.js';

/** Telemetry record type emitted once per processed audio block (SonareEngineTelemetryType.ProcessBlock). */
const TELEMETRY_PROCESS_BLOCK = 0;

/** Default tempo assumed until {@link UseTransportReturn.setTempo} is called. */
const DEFAULT_TEMPO_BPM = 120;

/** Reactive transport state and 1:1 engine transport actions returned by {@link useTransport}. */
export interface UseTransportReturn {
  /** True between a successful `play()` and the next successful `stop()`. */
  isPlaying: Ref<boolean>;
  /**
   * Playhead position in seconds, derived from engine telemetry
   * (`audibleTimelineSample / ctx.sampleRate`). Updated via requestAnimationFrame
   * polling while playing; also set optimistically by `seek()` / `seekPpq()`.
   */
  positionSeconds: Ref<number>;
  /**
   * Playhead position in PPQ (quarter-note pulses), converted from the engine's
   * `audibleTimelineSample` through the project tempo map (which replicates the
   * engine's tempo math), so it is exact under tempo segments and ramps. Also
   * set optimistically by `seek()` / `seekPpq()`.
   */
  positionPpq: Ref<number>;
  /** Last tempo set through this composable, in BPM. The engine exposes no tempo getter. */
  tempo: Ref<number>;
  /** True when a loop region is active (last successful `setLoop` had `enabled !== false`). */
  loopEnabled: Ref<boolean>;
  /** Loop region start in PPQ (quarter-note pulses). */
  loopStartPpq: Ref<number>;
  /** Loop region end in PPQ (quarter-note pulses). */
  loopEndPpq: Ref<number>;
  /** True when the metronome click is enabled. */
  metronomeEnabled: Ref<boolean>;
  /**
   * Starts playback via `engine.transport.play`.
   *
   * @param sampleTime Absolute AudioContext sample time to start at; omit for ASAP.
   * @returns False when the engine is unavailable or the command was rejected.
   */
  play(sampleTime?: number): boolean;
  /**
   * Stops playback via `engine.transport.stop`.
   *
   * @param sampleTime Absolute AudioContext sample time to stop at; omit for ASAP.
   * @returns False when the engine is unavailable or the command was rejected.
   */
  stop(sampleTime?: number): boolean;
  /**
   * Seeks to a timeline position in seconds via `engine.transport.seekSeconds`.
   *
   * @param seconds Target timeline position in seconds.
   * @param sampleTime Absolute AudioContext sample time to apply the seek at; omit for ASAP.
   * @returns False when the engine is unavailable or the command was rejected.
   */
  seek(seconds: number, sampleTime?: number): boolean;
  /**
   * Seeks to a timeline position in PPQ (quarter-note pulses) via `engine.transport.seekPpq`.
   *
   * @param ppq Target timeline position in quarter-note pulses (fractional allowed).
   * @param sampleTime Absolute AudioContext sample time to apply the seek at; omit for ASAP.
   * @returns False when the engine is unavailable or the command was rejected.
   */
  seekPpq(ppq: number, sampleTime?: number): boolean;
  /**
   * Updates the local `tempo` ref only (display and metronome conversions
   * depend on it). The engine's tempo is owned by the transport sync
   * (`src/engine/transport-sync.ts`, which sends `setTempoSegments`), so this
   * never calls into the engine. The tempo map used for playhead conversions
   * changes only via `setTempoMap`.
   *
   * @param bpm Tempo in beats (quarter notes) per minute.
   */
  setTempo(bpm: number): void;
  /**
   * Replaces the tempo map used for PPQ <-> seconds playhead conversions.
   * Keeps the playhead's musical position: `positionPpq` is preserved and
   * `positionSeconds` is re-derived through the new map, so a tempo edit does
   * not move the playhead in bars.
   *
   * @param segments Project tempo segments (normalized internally; the current
   *   `tempo` is the fallback when no usable segment exists).
   */
  setTempoMap(segments: ReadonlyArray<TempoSegment>): void;
  /**
   * Sets the loop region via `engine.transport.setLoop` and mirrors it into the loop refs.
   *
   * @param startPpq Loop start in quarter-note pulses.
   * @param endPpq Loop end in quarter-note pulses.
   * @param enabled Whether the loop is active (default true).
   * @returns False when the engine is unavailable or the command was rejected.
   */
  setLoop(startPpq: number, endPpq: number, enabled?: boolean): boolean;
  /**
   * Toggles (or explicitly sets) the metronome via `engine.setMetronome({ enabled })`.
   *
   * @param enabled Explicit target state; omit to flip the current state.
   * @returns The resulting metronome state (unchanged when the engine is unavailable).
   */
  toggleMetronome(enabled?: boolean): boolean;
  /** Stops position polling and releases the telemetry subscription. Called automatically on scope dispose. */
  dispose(): void;
}

/**
 * Vue composable wrapping the libsonare engine transport with reactive state.
 *
 * The engine may be created lazily (after a user gesture): pass a ref or getter
 * that resolves to `null`/`undefined` until the engine exists. Actions invoked
 * before the engine is available are no-ops returning `false`.
 *
 * Units: all musical positions are PPQ (quarter-note pulses, 1.0 = one quarter
 * note, fractions allowed); `sampleTime` arguments are absolute AudioContext
 * sample times (omitted = apply ASAP); `positionSeconds` is timeline seconds.
 *
 * The playhead is fed by engine ProcessBlock telemetry. While playing, a
 * requestAnimationFrame loop calls `engine.pollTelemetry()` (drains the SAB
 * telemetry ring in 'sab' mode; a no-op in 'postMessage' mode where telemetry
 * arrives as port messages) and an `onTelemetry` subscription converts
 * `audibleTimelineSample` to seconds using the AudioContext sample rate and to
 * PPQ through the project tempo map (set via `setTempoMap`), replicating the
 * engine's tempo math so the PPQ playhead is exact under segments and ramps.
 *
 * @param handleSource The engine handle, or a ref/getter resolving to one (or null while absent).
 * @returns Reactive transport state and delegating actions.
 */
export function useTransport(
  handleSource: MaybeRefOrGetter<EngineHandle | null | undefined>,
): UseTransportReturn {
  const isPlaying = ref(false);
  const positionSeconds = ref(0);
  const positionPpq = ref(0);
  const tempo = ref(DEFAULT_TEMPO_BPM);
  const loopEnabled = ref(false);
  const loopStartPpq = ref(0);
  const loopEndPpq = ref(0);
  const metronomeEnabled = ref(false);

  /** Tempo map mirroring what the transport sync sends to the engine. */
  let tempoMap = normalizeTempoMap([], DEFAULT_TEMPO_BPM);

  const resolveHandle = (): EngineHandle | null => toValue(handleSource) ?? null;

  let subscribedEngine: SonareEngine | null = null;
  let unsubscribeTelemetry: (() => void) | null = null;
  let rafId: number | null = null;

  /** Subscribes the position listener to the handle's engine (resubscribes when the engine changes). */
  const ensureTelemetrySubscription = (handle: EngineHandle): void => {
    if (subscribedEngine === handle.engine) return;
    unsubscribeTelemetry?.();
    const sampleRate = handle.ctx.sampleRate;
    unsubscribeTelemetry = handle.engine.onTelemetry(
      (telemetry: SonareEngineTelemetryRecord): void => {
        if (telemetry.type !== TELEMETRY_PROCESS_BLOCK) return;
        positionSeconds.value = telemetry.audibleTimelineSample / sampleRate;
        positionPpq.value = samplesToPpq(tempoMap, telemetry.audibleTimelineSample, sampleRate);
      },
    );
    subscribedEngine = handle.engine;
  };

  const stopPolling = (): void => {
    if (rafId !== null) {
      globalThis.cancelAnimationFrame?.(rafId);
      rafId = null;
    }
  };

  /** Drains telemetry once per animation frame while playing. */
  const startPolling = (): void => {
    if (rafId !== null || typeof globalThis.requestAnimationFrame !== 'function') return;
    const tick = (): void => {
      rafId = null;
      if (!isPlaying.value) return;
      const handle = resolveHandle();
      if (handle) {
        ensureTelemetrySubscription(handle);
        handle.engine.pollTelemetry();
      }
      rafId = globalThis.requestAnimationFrame(tick);
    };
    rafId = globalThis.requestAnimationFrame(tick);
  };

  const play = (sampleTime?: number): boolean => {
    const handle = resolveHandle();
    if (!handle) return false;
    ensureTelemetrySubscription(handle);
    const ok = handle.engine.transport.play(sampleTime);
    if (ok) {
      isPlaying.value = true;
      startPolling();
    }
    return ok;
  };

  const stop = (sampleTime?: number): boolean => {
    const handle = resolveHandle();
    if (!handle) return false;
    const ok = handle.engine.transport.stop(sampleTime);
    if (ok) {
      isPlaying.value = false;
      stopPolling();
    }
    return ok;
  };

  const seek = (seconds: number, sampleTime?: number): boolean => {
    const handle = resolveHandle();
    if (!handle) return false;
    ensureTelemetrySubscription(handle);
    const ok = handle.engine.transport.seekSeconds(seconds, sampleTime);
    if (ok) {
      positionSeconds.value = seconds;
      positionPpq.value = secondsToPpq(tempoMap, seconds);
    }
    return ok;
  };

  const seekPpq = (ppq: number, sampleTime?: number): boolean => {
    const handle = resolveHandle();
    if (!handle) return false;
    ensureTelemetrySubscription(handle);
    const ok = handle.engine.transport.seekPpq(ppq, sampleTime);
    if (ok) {
      positionPpq.value = ppq;
      positionSeconds.value = ppqToSeconds(tempoMap, ppq);
    }
    return ok;
  };

  const setTempo = (bpm: number): void => {
    tempo.value = bpm;
  };

  const setTempoMap = (segments: ReadonlyArray<TempoSegment>): void => {
    tempoMap = normalizeTempoMap(segments, tempo.value);
    positionSeconds.value = ppqToSeconds(tempoMap, positionPpq.value);
  };

  const setLoop = (startPpq: number, endPpq: number, enabled = true): boolean => {
    const handle = resolveHandle();
    if (!handle) return false;
    const ok = handle.engine.transport.setLoop(startPpq, endPpq, enabled);
    if (ok) {
      loopStartPpq.value = startPpq;
      loopEndPpq.value = endPpq;
      loopEnabled.value = enabled;
    }
    return ok;
  };

  const toggleMetronome = (enabled?: boolean): boolean => {
    const handle = resolveHandle();
    if (!handle) return metronomeEnabled.value;
    const next = enabled ?? !metronomeEnabled.value;
    handle.engine.setMetronome({ enabled: next });
    metronomeEnabled.value = next;
    return next;
  };

  const dispose = (): void => {
    stopPolling();
    unsubscribeTelemetry?.();
    unsubscribeTelemetry = null;
    subscribedEngine = null;
  };

  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  return {
    isPlaying,
    positionSeconds,
    positionPpq,
    tempo,
    loopEnabled,
    loopStartPpq,
    loopEndPpq,
    metronomeEnabled,
    play,
    stop,
    seek,
    seekPpq,
    setTempo,
    setTempoMap,
    setLoop,
    toggleMetronome,
    dispose,
  };
}
