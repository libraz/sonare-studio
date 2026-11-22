import type { MaybeRefOrGetter, Ref } from 'vue';
import { getCurrentScope, onScopeDispose, ref, toValue } from 'vue';
import type { EngineHandle } from '@/engine/engine';
import { tryQueue } from '@/engine/mixer-sync';
import { clamp01 } from '@/lib/math';
import { createRecordingCycle, type RecordingCycle } from '@/project/loop-recording';
import {
  DEFAULT_TEMPO_BPM,
  normalizeTempoMap,
  ppqToSeconds,
  samplesToPpq,
  secondsToPpq,
} from '@/project/tempo-map';
import type { TempoSegment } from '@/project/types';
import type { EngineTelemetry } from '@/wasm/index.js';
import type { SonareEngine } from '@/wasm/worklet.js';

/** Telemetry record type emitted once per processed audio block. */
const TELEMETRY_PROCESS_BLOCK = 'processBlock';

/** Default tempo assumed until {@link UseTransportReturn.setTempo} is called. */

/** Reactive transport state and 1:1 engine transport actions returned by {@link useTransport}. */
export interface UseTransportReturn {
  /** True between a successful `play()` and the next successful `stop()`. */
  isPlaying: Ref<boolean>;
  /**
   * Playhead position in seconds, derived from engine telemetry
   * (`timelineSample / ctx.sampleRate`). Updated via requestAnimationFrame
   * polling while playing; immediate seeks update it optimistically, while
   * future seeks commit only after process telemetry reaches their renderFrame.
   */
  positionSeconds: Ref<number>;
  /**
   * Playhead position in PPQ (quarter-note pulses), converted from the engine's
   * `timelineSample` through the project tempo map (which replicates the
   * engine's tempo math), so it is exact under tempo segments and ramps. Also
   * Immediate seeks update it optimistically; future seeks commit only after
   * process telemetry reaches their renderFrame.
   */
  positionPpq: Ref<number>;
  /**
   * Audible output position in seconds, derived from `audibleTimelineSample`.
   * Unlike `positionSeconds`, this includes graph/output delay and is suited to
   * alignment with live input.
   */
  audiblePositionSeconds: Ref<number>;
  /** Audible output position in PPQ, derived through the project tempo map. */
  audiblePositionPpq: Ref<number>;
  /** Last tempo set through this composable, in BPM. The engine exposes no tempo getter. */
  tempo: Ref<number>;
  /** Project tempo segments currently used for PPQ <-> seconds conversions. */
  tempoSegments: Ref<ReadonlyArray<TempoSegment>>;
  /** True when a loop region is active (last successful `setLoop` had `enabled !== false`). */
  loopEnabled: Ref<boolean>;
  /** Loop region start in PPQ (quarter-note pulses). */
  loopStartPpq: Ref<number>;
  /** Loop region end in PPQ (quarter-note pulses). */
  loopEndPpq: Ref<number>;
  /** True when the metronome click is enabled. */
  metronomeEnabled: Ref<boolean>;
  /** Recording-cycle owner over this transport's loop; loop edits are refused while it is active. */
  recordingCycle: RecordingCycle;
  /**
   * Estimated delay from a transport command to the audible output, in seconds.
   * This is the AudioContext base/output latency and is refreshed when an
   * engine handle is used. It is useful for aligning live input timestamps
   * with a transport started from rest.
   */
  playbackLatencySeconds: Ref<number>;
  /**
   * Starts playback via `engine.transport.play`.
   *
   * @param renderFrame Absolute AudioContext sample time to start at; omit for ASAP.
   * @returns False when the engine is unavailable or the command was rejected.
   */
  play(renderFrame?: number): boolean;
  /**
   * Stops playback via `engine.transport.stop`.
   *
   * @param renderFrame Absolute AudioContext sample time to stop at; omit for ASAP.
   * @returns False when the engine is unavailable or the command was rejected.
   */
  stop(renderFrame?: number): boolean;
  /**
   * Seeks to a timeline position in seconds via `engine.transport.seekSeconds`.
   *
   * @param seconds Target timeline position in seconds.
   * @param renderFrame Absolute AudioContext sample time to apply the seek at; omit for ASAP.
   * @returns False when the engine rejected the command; without an engine the
   *   position is held and applied when one attaches.
   */
  seek(seconds: number, renderFrame?: number): boolean;
  /**
   * Seeks to a timeline position in PPQ (quarter-note pulses) via `engine.transport.seekPpq`.
   *
   * @param ppq Target timeline position in quarter-note pulses (fractional allowed).
   * @param renderFrame Absolute AudioContext sample time to apply the seek at; omit for ASAP.
   * @returns False when the engine rejected the command; without an engine the
   *   position is held and applied when one attaches.
   */
  seekPpq(ppq: number, renderFrame?: number): boolean;
  /**
   * Asks a suspended AudioContext to resume. Call it synchronously inside the
   * user gesture that starts sound: a suspended context accepts play but never advances.
   */
  resumeContext(): void;
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
   * not move the playhead in bars. A stopped engine is re-seeked to match.
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
   * @returns False while a take is recording or when the engine rejected the
   *   command; without an engine the region is held and applied when one attaches.
   */
  setLoop(startPpq: number, endPpq: number, enabled?: boolean): boolean;
  /**
   * Toggles (or explicitly sets) the metronome and can update its click gain.
   *
   * @param enabled Explicit target state; omit to flip the current state.
   * @param beatGain Optional beat-click gain (0..1); accent gain tracks it at 2x.
   * @returns The resulting metronome state (unchanged when the engine refused it).
   */
  toggleMetronome(enabled?: boolean, beatGain?: number): boolean;
  /** Stops position polling and releases the telemetry subscription. Called automatically on scope dispose. */
  dispose(): void;
}

/**
 * Vue composable wrapping the libsonare engine transport with reactive state.
 *
 * The engine may be created lazily (after a user gesture): pass a ref or getter
 * that resolves to `null`/`undefined` until the engine exists. Position, loop
 * and metronome are held here and pushed to each engine the first time it is
 * used; play and stop are no-ops returning `false` without an engine.
 *
 * Units: all musical positions are PPQ (quarter-note pulses, 1.0 = one quarter
 * note, fractions allowed); `renderFrame` arguments are absolute AudioContext
 * sample times (omitted = apply ASAP); `positionSeconds` is timeline seconds.
 *
 * The playhead is fed by engine ProcessBlock telemetry. While playing, a
 * requestAnimationFrame loop calls `engine.pollTelemetry()` (drains the SAB
 * telemetry ring in 'sab' mode; a no-op in 'postMessage' mode where telemetry
 * arrives as port messages) and an `onTelemetry` subscription converts
 * `timelineSample` to seconds using the AudioContext sample rate and to
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
  const audiblePositionSeconds = ref(0);
  const audiblePositionPpq = ref(0);
  const tempo = ref(DEFAULT_TEMPO_BPM);
  const tempoSegments = ref<TempoSegment[]>([]);
  const loopEnabled = ref(false);
  const loopStartPpq = ref(0);
  const loopEndPpq = ref(0);
  const metronomeEnabled = ref(false);
  const playbackLatencySeconds = ref(0);
  const recordingCycle = createRecordingCycle({
    enabled: loopEnabled,
    startPpq: loopStartPpq,
    endPpq: loopEndPpq,
  });

  /** Tempo map mirroring what the transport sync sends to the engine. */
  let tempoMap = normalizeTempoMap([], DEFAULT_TEMPO_BPM);

  const resolveHandle = (): EngineHandle | null => toValue(handleSource) ?? null;

  const updatePlaybackLatency = (handle: EngineHandle): void => {
    const baseLatency = handle.ctx.baseLatency;
    const outputLatency = (handle.ctx as AudioContext & { outputLatency?: number }).outputLatency;
    const base = typeof baseLatency === 'number' && Number.isFinite(baseLatency) ? baseLatency : 0;
    const output =
      typeof outputLatency === 'number' && Number.isFinite(outputLatency) ? outputLatency : 0;
    playbackLatencySeconds.value = Math.max(0, base + output);
  };

  let subscribedEngine: SonareEngine | null = null;
  let unsubscribeTelemetry: (() => void) | null = null;
  let rafId: number | null = null;
  let lastRenderFrame = 0;
  let scheduledSequence = 0;
  let scheduledActions: Array<{
    engine: SonareEngine;
    renderFrame: number;
    sequence: number;
    commit: () => void;
  }> = [];
  /** Last metronome beat gain requested; replayed with the metronome state. */
  let metronomeBeatGain: number | undefined;

  const metronomeConfig = (enabled: boolean, beatGain: number | undefined) => ({
    enabled,
    ...(beatGain === undefined ? {} : { beatGain, accentGain: Math.min(1, beatGain * 2) }),
  });

  const telemetryPositionSample = (telemetry: EngineTelemetry): number => {
    if (Number.isFinite(telemetry.timelineSample)) return telemetry.timelineSample;
    return telemetry.audibleTimelineSample;
  };

  const commitScheduledActions = (engine: SonareEngine, renderFrame: number): void => {
    if (!Number.isFinite(renderFrame)) return;
    lastRenderFrame = Math.max(lastRenderFrame, renderFrame);
    const due = scheduledActions
      .filter((action) => action.engine === engine && action.renderFrame <= renderFrame)
      .sort((a, b) => a.renderFrame - b.renderFrame || a.sequence - b.sequence);
    if (due.length === 0) return;
    const dueSet = new Set(due);
    scheduledActions = scheduledActions.filter((action) => !dueSet.has(action));
    for (const action of due) action.commit();
  };

  /**
   * Pushes the studio-held loop, metronome and position to an engine seeing
   * them for the first time. The seek is sample-based because the tempo map
   * reaches the engine over the port, unordered with the command ring.
   */
  const applyTransportState = (handle: EngineHandle): void => {
    handle.engine.transport.setLoop({
      startPpq: loopStartPpq.value,
      endPpq: loopEndPpq.value,
      enabled: loopEnabled.value,
    });
    handle.engine.setMetronome(metronomeConfig(metronomeEnabled.value, metronomeBeatGain));
    handle.engine.transport.seekSec(ppqToSeconds(tempoMap, positionPpq.value));
  };

  /**
   * Subscribes the position listener to the handle's engine; an engine seen for
   * the first time also receives the held transport state.
   */
  const ensureTelemetrySubscription = (handle: EngineHandle): void => {
    updatePlaybackLatency(handle);
    if (subscribedEngine === handle.engine) return;
    unsubscribeTelemetry?.();
    scheduledActions = scheduledActions.filter((action) => action.engine === handle.engine);
    lastRenderFrame = 0;
    const sampleRate = handle.ctx.sampleRate;
    unsubscribeTelemetry = handle.engine.onTelemetry((telemetry: EngineTelemetry): void => {
      if (telemetry.type !== TELEMETRY_PROCESS_BLOCK) return;
      const sample = telemetryPositionSample(telemetry);
      const audibleSample = Number.isFinite(telemetry.audibleTimelineSample)
        ? telemetry.audibleTimelineSample
        : sample;
      positionSeconds.value = sample / sampleRate;
      positionPpq.value = samplesToPpq(tempoMap, sample, sampleRate);
      audiblePositionSeconds.value = audibleSample / sampleRate;
      audiblePositionPpq.value = samplesToPpq(tempoMap, audibleSample, sampleRate);
      commitScheduledActions(handle.engine, telemetry.renderFrame);
    });
    subscribedEngine = handle.engine;
    applyTransportState(handle);
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
      const hasScheduledAction = scheduledActions.length > 0;
      if (!isPlaying.value && !hasScheduledAction) return;
      const handle = resolveHandle();
      if (handle) {
        ensureTelemetrySubscription(handle);
        handle.engine.pollTelemetry();
      }
      if (isPlaying.value || scheduledActions.length > 0) {
        rafId = globalThis.requestAnimationFrame(tick);
      }
    };
    rafId = globalThis.requestAnimationFrame(tick);
  };

  const commitAtRenderFrame = (
    handle: EngineHandle,
    renderFrame: number | undefined,
    commit: () => void,
  ): void => {
    if (
      renderFrame !== undefined &&
      Number.isFinite(renderFrame) &&
      renderFrame > lastRenderFrame
    ) {
      scheduledActions.push({
        engine: handle.engine,
        renderFrame,
        sequence: scheduledSequence++,
        commit,
      });
      startPolling();
      return;
    }
    commit();
  };

  const play = (renderFrame?: number): boolean => {
    const handle = resolveHandle();
    if (!handle) return false;
    updatePlaybackLatency(handle);
    ensureTelemetrySubscription(handle);
    const ok = tryQueue(() => handle.engine.transport.play(renderFrame));
    if (ok) {
      commitAtRenderFrame(handle, renderFrame, () => {
        isPlaying.value = true;
        startPolling();
      });
    }
    return ok;
  };

  const stop = (renderFrame?: number): boolean => {
    const handle = resolveHandle();
    if (!handle) return false;
    const ok = tryQueue(() => handle.engine.transport.stop(renderFrame));
    if (ok) {
      if (renderFrame === undefined) handle.engine.pushMidiPanic();
      else handle.engine.pushMidiPanic(renderFrame);
      commitAtRenderFrame(handle, renderFrame, () => {
        isPlaying.value = false;
        stopPolling();
      });
    }
    return ok;
  };

  const seek = (seconds: number, renderFrame?: number): boolean => {
    const commit = (): void => {
      positionSeconds.value = seconds;
      positionPpq.value = secondsToPpq(tempoMap, seconds);
      audiblePositionSeconds.value = seconds;
      audiblePositionPpq.value = secondsToPpq(tempoMap, seconds);
    };
    const handle = resolveHandle();
    if (!handle) {
      commit();
      return true;
    }
    ensureTelemetrySubscription(handle);
    const ok = tryQueue(() => handle.engine.transport.seekSec(seconds, renderFrame));
    if (ok) {
      if (renderFrame === undefined) handle.engine.pushMidiPanic();
      else handle.engine.pushMidiPanic(renderFrame);
      commitAtRenderFrame(handle, renderFrame, commit);
    }
    return ok;
  };

  const seekPpq = (ppq: number, renderFrame?: number): boolean => {
    const commit = (): void => {
      positionPpq.value = ppq;
      positionSeconds.value = ppqToSeconds(tempoMap, ppq);
      audiblePositionPpq.value = ppq;
      audiblePositionSeconds.value = ppqToSeconds(tempoMap, ppq);
    };
    const handle = resolveHandle();
    if (!handle) {
      commit();
      return true;
    }
    ensureTelemetrySubscription(handle);
    const ok = tryQueue(() => handle.engine.transport.seekPpq(ppq, renderFrame));
    if (ok) {
      if (renderFrame === undefined) handle.engine.pushMidiPanic();
      else handle.engine.pushMidiPanic(renderFrame);
      commitAtRenderFrame(handle, renderFrame, commit);
    }
    return ok;
  };

  const resumeContext = (): void => {
    const ctx = resolveHandle()?.ctx;
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => undefined);
  };

  const setTempo = (bpm: number): void => {
    tempo.value = bpm;
  };

  const setTempoMap = (segments: ReadonlyArray<TempoSegment>): void => {
    tempoSegments.value = segments.map((segment) => ({ ...segment }));
    tempoMap = normalizeTempoMap(segments, tempo.value);
    positionSeconds.value = ppqToSeconds(tempoMap, positionPpq.value);
    audiblePositionSeconds.value = ppqToSeconds(tempoMap, audiblePositionPpq.value);
    // The engine keeps its sample position across a tempo change; move it back onto the shown bar.
    const handle = resolveHandle();
    if (handle && subscribedEngine === handle.engine && !isPlaying.value) {
      handle.engine.transport.seekSec(positionSeconds.value);
    }
  };

  const setLoop = (startPpq: number, endPpq: number, enabled = true): boolean => {
    // A take is interpreted with the loop the transport plays it through.
    if (recordingCycle.active.value) return false;
    const handle = resolveHandle();
    const ok = handle
      ? tryQueue(() => handle.engine.transport.setLoop({ startPpq, endPpq, enabled }))
      : true;
    if (ok) {
      loopStartPpq.value = startPpq;
      loopEndPpq.value = endPpq;
      loopEnabled.value = enabled;
    }
    return ok;
  };

  const toggleMetronome = (enabled?: boolean, beatGain?: number): boolean => {
    const handle = resolveHandle();
    const next = enabled ?? !metronomeEnabled.value;
    const gain = Number.isFinite(beatGain) ? clamp01(beatGain as number) : undefined;
    // A full command ring refuses the change; keep the toggle on the engine's state.
    if (handle && !tryQueue(() => handle.engine.setMetronome(metronomeConfig(next, gain)))) {
      return metronomeEnabled.value;
    }
    if (gain !== undefined) metronomeBeatGain = gain;
    metronomeEnabled.value = next;
    return next;
  };

  const dispose = (): void => {
    stopPolling();
    scheduledActions = [];
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
    audiblePositionSeconds,
    audiblePositionPpq,
    tempo,
    tempoSegments,
    loopEnabled,
    loopStartPpq,
    loopEndPpq,
    metronomeEnabled,
    recordingCycle,
    playbackLatencySeconds,
    play,
    stop,
    seek,
    seekPpq,
    resumeContext,
    setTempo,
    setTempoMap,
    setLoop,
    toggleMetronome,
    dispose,
  };
}
