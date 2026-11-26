/**
 * Microphone recording for a running engine: binds a microphone to the engine
 * node and records through the engine's native capture path
 * (configureCapture / armCapture / capturedAudio).
 *
 * Capture model: configureCapture allocates the engine-side capture buffer up
 * front and selects `source: 'input'`, which captures the raw microphone
 * signal (the engine node's input) before any processing. Capture is gated to
 * the punch window — a half-open PPQ range [in, out) converted engine-side at
 * the current tempo map — and only runs while the transport plays, so a
 * count-in pre-roll (transport seeked earlier than the punch-in) is excluded
 * from the take without any host-side frame skipping. The engine itself
 * delays captured samples by recordOffsetSamples (record-latency
 * compensation) and reads the punch window in that compensated time, so
 * the host applies no further shift and the take spans exactly the window.
 *
 * Input monitoring is engine-side and configured separately from capture.
 * Updating the monitor never resends capture or changes armed state.
 * captureStatus / capturedAudio / resetCapture are async over a
 * request/response message channel and behave identically in SAB and
 * postMessage fallback modes. Meter snapshots tagged with
 * {@link INPUT_METER_TARGET_ID} carry the input-capture level in dBFS.
 *
 * Silence guarantees: requesting a microphone produces no sound. The input
 * monitor stays disabled until setMonitor(true) is called explicitly; nothing
 * here starts playback.
 */

import type {
  CapturePunch,
  EngineCaptureStatus,
  RealtimeVoiceChangerConfigInput,
  StreamingRetuneConfig,
} from '@libraz/libsonare';
import { isSonareError } from '@libraz/libsonare';
import { dbToLinear } from '@/lib/db';
import { errorMessage } from '@/lib/errors';
import { isFiniteNumber } from '@/lib/math';
import { ensureWasm } from '@/lib/wasm';
import { type NormalizedTempoMap, ppqToSeconds, secondsToPpq } from '@/project/tempo-map';
import type { EngineHandle } from './engine';
import {
  bindRealtimeVoiceChangerInput,
  bindRealtimeVoiceChangerRetuneInput,
} from './realtime-voice-changer';
import { bindStreamingRetuneInput, clampStreamingRetuneSemitones } from './streaming-retune';

/** Thrown when the environment cannot capture microphone audio at all. */
export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotSupportedError';
  }
}

/** Thrown when no microphone is available or access was denied. */
export class NoMicrophoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoMicrophoneError';
  }
}

/** Thrown when a recorder method is called in the wrong state. */
export class RecorderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderStateError';
  }
}

/**
 * getUserMedia constraints for tracking-quality capture: browser voice
 * processing (echo cancellation, noise suppression, auto gain) is disabled
 * and stereo is requested where the device offers it.
 */
export const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
  },
  video: false,
};

export function microphoneConstraints(inputDeviceId?: string): MediaStreamConstraints {
  const audio = { ...(MICROPHONE_CONSTRAINTS.audio as MediaTrackConstraints) };
  const deviceId = inputDeviceId?.trim();
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

/**
 * Meter target id of the engine's input-capture level: snapshots with this
 * targetId carry the microphone peak (dBFS) alongside master/lane records.
 */
export const INPUT_METER_TARGET_ID = 0xffff;

/** Engine capture source used for a take. */
export type RecordingCaptureSource = Extract<EngineCaptureStatus['source'], 'input' | 'output'>;

/**
 * Capture buffer length in seconds configured while idle: a small allocation
 * keeps the input source live on the engine before any take starts. start()
 * reconfigures the buffer to the full take length.
 */
const MONITOR_BUFFER_SECONDS = 1;

/**
 * Upper bound for one take when no explicit limit is passed (5 minutes).
 * The engine preallocates the whole capture buffer up front (stereo float:
 * seconds x sampleRate x 2 channels x 4 bytes), so this cap is a real
 * allocation rather than a grow-as-you-record limit.
 */
export const DEFAULT_MAX_DURATION_SECONDS = 300;

/** Default minimum interval between input-level callbacks. */
const DEFAULT_LEVEL_INTERVAL_MS = 50;

/**
 * Default upper bound on how many channels the input capture can carry. The
 * realtime engine node is created two channels wide, and its worklet copies at
 * most that many input channels into the capture path, so a wider device merge
 * would only add silent channels. Callers may override this to match a wider
 * engine node.
 */
const DEFAULT_CAPTURE_CHANNEL_LIMIT = 2;

/** A finished take handed back by {@link Recorder.stop}. */
export interface RecordingResult {
  /** Planar capture buffers (one per channel) at `sampleRate`. */
  channels: Float32Array[];
  /** Capture sample rate (the engine AudioContext rate) in Hz. */
  sampleRate: number;
  /** Timeline position in PPQ where the recorded material begins. */
  startPpq: number;
  /** Number of captured frames discarded because the engine buffer filled. */
  droppedFrames?: number;
}

/** Options for {@link Recorder.start}. */
export interface StartRecordingOptions {
  /** Timeline position in PPQ where the recorded material begins (>= 0). */
  startPpq: number;
  /**
   * Optional timeline position in PPQ where capture closes. When omitted, the
   * recorder uses `maxDurationSeconds` as the punch-out bound.
   */
  endPpq?: number;
  /** Tempo in BPM used for all PPQ/time conversions (> 0). */
  tempoBpm: number;
  /**
   * Normalized project tempo map for resolving a duration to PPQ. When
   * present, it keeps implicit punch-out positions aligned with the capture
   * buffer across tempo changes. `tempoBpm` remains the constant-tempo
   * fallback for direct callers that do not have a project map.
   */
  tempoMap?: NormalizedTempoMap;
  /**
   * Record-latency compensation in samples (>= 0), handed to the engine,
   * which delays capture by that many samples. A sound played at timeline
   * position T reaches the capture input roughly this many samples late, so
   * the shift re-aligns the take to `startPpq`.
   * Defaults to {@link defaultRecordOffsetSamples} of the engine context plus
   * the device's reported input latency ({@link inputLatencySamples}).
   */
  recordOffsetSamples?: number;
  /**
   * Additional playback-path latency in samples (>= 0), such as the current
   * project insert PDC. This is added to the device record offset for input
   * capture, so a new take is aligned with PDC-delayed playback lanes.
   */
  playbackLatencySamples?: number;
  /**
   * Maximum take length in seconds (> 0, default 300). Sizes the engine
   * capture buffer, so the whole span is allocated up front.
   */
  maxDurationSeconds?: number;
  /**
   * Timeline position in PPQ where an open-ended (no `endPpq`) capture auto
   * punches out (> startPpq). It bounds the same real-time span as
   * `maxDurationSeconds`, but resolved through the project tempo map so the
   * punch-out lands exactly when the preallocated buffer fills. Supplying it
   * overrides the implicit calculation from `tempoMap` (or `tempoBpm`).
   */
  punchOutPpq?: number;
}

/** The microphone routing produced by binding a stream to the engine node. */
export interface MicrophoneBinding {
  /** The captured media stream. */
  stream: MediaStream;
  /** The Web Audio source node wrapping the stream. */
  source: AudioNode;
  /** Updates an in-place realtime voice changer binding, when present. */
  setVoiceChangerPreset?(preset: RealtimeVoiceChangerConfigInput): boolean;
  /** Updates an in-place StreamingRetune binding, when present. */
  setStreamingRetuneConfig?(config: StreamingRetuneConfig): void;
  /** Disconnects the source and stops the stream tracks. */
  destroy(): void;
}

/** Injectable dependencies and tuning for {@link createRecorder}. */
export interface RecorderOptions {
  /** Media capture function; defaults to navigator.mediaDevices.getUserMedia. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /**
   * Microphone-to-engine binding; defaults to the libsonare
   * bindMicrophoneInput helper (mic source connected to the engine node).
   */
  bindInput?: (
    ctx: AudioContext,
    engineNode: AudioWorkletNode,
    options: {
      stream: MediaStream;
      stopTracksOnDestroy: boolean;
      signal?: AbortSignal;
      onProcessorError?: () => void;
    },
  ) => Promise<MicrophoneBinding>;
  /** Optional realtime voice changer preset inserted between microphone and engine input. */
  voiceChangerPreset?: RealtimeVoiceChangerConfigInput | null;
  /** Optional StreamingRetune semitone shift inserted between microphone and engine input. */
  streamingRetuneSemitones?: number;
  /**
   * Capture source. `input` records the raw microphone path; `output` records
   * the engine master output and does not require microphone access.
   */
  captureSource?: RecordingCaptureSource;
  /** Preferred audioinput device id. Empty/omitted uses the browser/OS default input. */
  inputDeviceId?: string;
  /**
   * Distinct audioinput device ids to capture at once, one per armed track that
   * requested its own device. When two or more distinct ids are present the
   * host opens one stream per device and merges them into a single multi-channel
   * capture (device order = channel index). One or zero entries falls back to
   * the single-device path using {@link RecorderOptions.inputDeviceId}.
   */
  inputDeviceIds?: ReadonlyArray<string | null | undefined>;
  /**
   * Maximum number of channels the input capture can carry (default 2). The
   * device merge is clamped to this width; extra devices are dropped with a
   * warning rather than failing (see {@link DEFAULT_CAPTURE_CHANNEL_LIMIT}).
   */
  captureChannelLimit?: number;
  /** Minimum interval between input-level callbacks in ms (default 50). */
  levelIntervalMs?: number;
}

/** Imperative microphone recorder returned by {@link createRecorder}. */
export interface Recorder {
  /**
   * Requests microphone access (tracking-quality constraints), binds the
   * stream to the engine node and configures the engine capture input.
   * Idempotent; concurrent calls share one request.
   *
   * @throws NotSupportedError When no capture API is available.
   * @throws NoMicrophoneError When access fails or is denied.
   */
  requestMicrophone(): Promise<void>;
  /** True once the microphone is bound and ready to record. */
  hasMicrophone(): boolean;
  /** Marks a project track as the recording destination. */
  arm(trackId: number): void;
  /** Clears the armed track. */
  disarm(): void;
  /** The armed project track id, or null when disarmed. */
  armedTrackId(): number | null;
  /** True between a successful start() and the matching stop(). */
  isRecording(): boolean;
  /**
   * Enables or disables engine-side input monitoring (the microphone input
   * mixed into the engine output). Disabled by default; the desired state is
   * remembered and applied once the microphone is bound.
   *
   * @param enabled Target monitor state.
   * @param gain Linear monitor gain; negative values are refused here, other values follow the engine domain; kept when omitted.
   */
  setMonitor(enabled: boolean, gain?: number): void;
  /** Current monitor state. */
  monitorEnabled(): boolean;
  /** Updates an active realtime voice changer worklet, when this recorder is using one. */
  setVoiceChangerPreset(preset: RealtimeVoiceChangerConfigInput): boolean;
  /** Updates an active StreamingRetune worklet, when this recorder is using one. */
  setStreamingRetuneSemitones(semitones: number): boolean;
  /**
   * Subscribes to throttled input peak levels (linear, 0..1+, max across
   * channels since the previous callback), derived from the engine's
   * input-capture meter snapshots.
   *
   * @returns An unsubscribe function.
   */
  onLevel(listener: (peak: number) => void): () => void;
  /**
   * Subscribes to microphone-loss events: fired once when the capture device
   * disappears (its track ends — unplugged, or the OS default input changes).
   * The binding is torn down before listeners run, so {@link hasMicrophone}
   * returns false and any in-flight take is discarded. Callers should surface
   * an error and let the user re-request the microphone.
   *
   * @returns An unsubscribe function.
   */
  onMicrophoneLost(listener: () => void): () => void;
  /**
   * Subscribes to a voice changer / StreamingRetune processor crashing while
   * bound. The binding is torn down exactly as for a lost microphone before
   * listeners run; callers should surface an error and let the user retry.
   *
   * @returns An unsubscribe function.
   */
  onInputProcessorError(listener: () => void): () => void;
  /**
   * Starts capturing the armed track through the engine record path: sizes
   * the capture buffer for the full take, resets the capture counters, arms
   * the engine (engine.armCapture) with the punch window configured
   * from `startPpq` to the max-duration bound. The caller drives the
   * transport around this call (seek — possibly earlier than `startPpq` for
   * a count-in — then play); the engine captures nothing outside the punch
   * window.
   *
   * @throws RecorderStateError When disposed, already recording, the
   *   microphone is missing, or no track is armed.
   */
  start(options: StartRecordingOptions): Promise<void>;
  /**
   * Disarms the engine record path, reads the captured take, resets the
   * engine capture and restores the idle capture config.
   *
   * @param options.captureTail Whether the transport is still running, so the
   *   take stays armed for the record offset first: capture runs that far
   *   behind the render position, and disarming at once would drop the input
   *   played up to the stop.
   * @returns The recorded frames, or null when nothing usable was captured
   *   (for example when stopped during the count-in).
   * @throws RecorderStateError When no recording is in progress.
   */
  stop(options?: { captureTail?: boolean }): Promise<RecordingResult | null>;
  /**
   * The render position, in PPQ, at which the engine has captured the whole
   * punch window of the take in progress (punch-out plus the record offset),
   * or null when idle. Callers that close capture themselves (auto-punch)
   * must wait for this rather than the bare musical punch-out.
   */
  capturePunchOutPpq(): number | null;
  /**
   * Releases everything: disarms an in-flight recording (discarding frames),
   * unsubscribes from engine meters and stops the microphone tracks. Safe to
   * call multiple times.
   */
  dispose(): void;
}

/** Status polls a stop makes while the disarm crosses to the audio thread. */
const DISARM_POLL_ATTEMPTS = 50;
/** Pause between those polls; a ring command lands within one render quantum. */
const DISARM_POLL_INTERVAL_MS = 10;

/**
 * Estimates the record-latency offset for a context: the playback path delay
 * (base + output latency) in samples. Input latency is not exposed by the
 * Web Audio API, so this is a lower bound; callers may override per device.
 *
 * @param ctx The engine AudioContext.
 * @returns Offset in samples (>= 0).
 */
export function defaultRecordOffsetSamples(ctx: AudioContext): number {
  const base = isFiniteNumber(ctx.baseLatency) ? ctx.baseLatency : 0;
  const outputLatency = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
  const output = isFiniteNumber(outputLatency) ? outputLatency : 0;
  return Math.max(0, Math.round((base + output) * ctx.sampleRate));
}

/**
 * Estimates the capture input latency of a media stream in samples: the
 * largest `latency` setting (seconds) the browser reports across the stream's
 * audio tracks. The Web Audio API does not surface input latency on the
 * AudioContext, but capture tracks may carry a `latency` hint (Chromium), so
 * adding it to {@link defaultRecordOffsetSamples} re-aligns takes that would
 * otherwise land a few milliseconds late. Returns 0 when no track reports it.
 *
 * @param stream The captured media stream.
 * @param sampleRate Capture sample rate in Hz.
 * @returns Input latency in samples (>= 0).
 */
export function inputLatencySamples(stream: MediaStream, sampleRate: number): number {
  let maxLatencySeconds = 0;
  for (const track of stream.getAudioTracks()) {
    const latency = (track.getSettings() as MediaTrackSettings & { latency?: number }).latency;
    if (isFiniteNumber(latency) && latency > maxLatencySeconds) {
      maxLatencySeconds = latency;
    }
  }
  return Math.max(0, Math.round(maxLatencySeconds * sampleRate));
}

/** Resolves the bound getUserMedia function, or null when unavailable. */
function defaultGetUserMedia(): ((c: MediaStreamConstraints) => Promise<MediaStream>) | null {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== 'function') return null;
  return devices.getUserMedia.bind(devices);
}

/** Default binding: libsonare's bindMicrophoneInput onto the engine node. */
async function defaultBindInput(
  ctx: AudioContext,
  engineNode: AudioWorkletNode,
  options: { stream: MediaStream; stopTracksOnDestroy: boolean; signal?: AbortSignal },
): Promise<MicrophoneBinding> {
  const wasm = await ensureWasm();
  options.signal?.throwIfAborted();
  return wasm.bindMicrophoneInput(ctx, engineNode, {
    stream: options.stream,
    stopTracksOnDestroy: options.stopTracksOnDestroy,
  });
}

/** Converts a peak in dBFS to linear amplitude (non-finite values map to 0). */
function dbPeakToLinear(db: number): number {
  return Number.isFinite(db) ? dbToLinear(db) : 0;
}

/**
 * Attaches an `ended` listener to every audio track of a stream so the
 * recorder learns when the capture device disappears (unplugged, or the OS
 * default input changes out from under us). A live but unmonitored device
 * fires no further audio, so without this the engine would keep capturing
 * silence into the take with no signal to the user.
 *
 * @param stream The captured media stream.
 * @param onLost Invoked once when any track ends.
 * @returns A cleanup function that removes every listener.
 */
function attachTrackEndedListeners(stream: MediaStream, onLost: () => void): () => void {
  const cleanups: Array<() => void> = [];
  for (const track of stream.getAudioTracks()) {
    const handler = (): void => onLost();
    track.addEventListener('ended', handler);
    cleanups.push(() => track.removeEventListener('ended', handler));
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Attaches device `ended` listeners across every stream of a merged capture,
 * so a take is aborted when any of the merged devices disappears.
 *
 * @param streams The captured media streams.
 * @param onLost Invoked once when any track of any stream ends.
 * @returns A cleanup function that removes every listener.
 */
function attachAllTrackEndedListeners(
  streams: ReadonlyArray<MediaStream>,
  onLost: () => void,
): () => void {
  const cleanups = streams.map((stream) => attachTrackEndedListeners(stream, onLost));
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/** Immutable state of one in-flight take. */
interface ActiveTake {
  trackId: number;
  startPpq: number;
  /** Render position in PPQ at which the punch window is fully captured. */
  capturePunchOutPpq: number;
  /** Capture sample rate at start time. */
  sampleRate: number;
  /** Samples the capture runs behind the render position. */
  offsetSamples: number;
}

/**
 * Creates a microphone recorder bound to a running engine handle.
 *
 * The recorder is store-free: it returns raw frames plus the take start
 * position and leaves asset ingestion and clip creation to the caller.
 *
 * @param handle Running engine handle from createEngine.
 * @param options Injectable dependencies (tests) and tuning.
 * @returns The recorder facade.
 */
export function createRecorder(handle: EngineHandle, options: RecorderOptions = {}): Recorder {
  const levelIntervalMs = options.levelIntervalMs ?? DEFAULT_LEVEL_INTERVAL_MS;
  const captureSource: RecordingCaptureSource = options.captureSource ?? 'input';
  const captureChannelLimit = Math.max(
    1,
    Math.floor(options.captureChannelLimit ?? DEFAULT_CAPTURE_CHANNEL_LIMIT),
  );
  /** Idle capture buffer size keeping the input path configured between takes. */
  const idleBufferFrames = Math.max(1, Math.ceil(MONITOR_BUFFER_SECONDS * handle.ctx.sampleRate));
  let disposed = false;
  let binding: MicrophoneBinding | null = null;
  /**
   * Every capture stream backing the current binding (one for a single device,
   * one per merged device). Drives per-stream latency and device-loss handling.
   */
  let bindingStreams: MediaStream[] = [];
  /** Channel count sent to configureCapture. A device merge uses one channel per input. */
  let captureChannelCount = DEFAULT_CAPTURE_CHANNEL_LIMIT;
  let micPromise: Promise<void> | null = null;
  let microphoneAbort: AbortController | null = null;
  let monitorOn = false;
  let monitorGainValue = 1;
  let armedTrack: number | null = null;
  let take: ActiveTake | null = null;
  let operationGeneration = 0;
  let phase: 'idle' | 'starting' | 'recording' | 'stopping' | 'disposed' = 'idle';
  /** Punch window of the take in progress; every config re-send restates it. */
  let capturePunch: CapturePunch | undefined;
  const levelListeners = new Set<(peak: number) => void>();
  let levelPeak = 0;
  let lastLevelEmit = 0;
  const micLostListeners = new Set<() => void>();
  const inputProcessorErrorListeners = new Set<() => void>();
  /** Removes the device `ended` listeners attached to the current binding. */
  let detachTrackListeners: (() => void) | null = null;

  /** Drops the input level to zero and notifies meters (e.g. after a take or mic loss). */
  const resetLevel = (): void => {
    levelPeak = 0;
    for (const listener of levelListeners) listener(0);
  };

  // Input level: snapshots tagged with the input meter target id carry the
  // capture peak in dBFS; master and lane records are ignored here.
  const unsubscribeMeter = handle.engine.onMeter((meter) => {
    if (meter.targetId !== INPUT_METER_TARGET_ID || levelListeners.size === 0) return;
    const peakDb = meter.peakDb;
    const channelCount = meter.numChannels;
    let peak = 0;
    for (let channel = 0; channel < channelCount && channel < peakDb.length; channel++) {
      const channelPeakDb = peakDb[channel];
      if (channelPeakDb !== undefined) peak = Math.max(peak, dbPeakToLinear(channelPeakDb));
    }
    if (peak > levelPeak) levelPeak = peak;
    const now = Date.now();
    if (now - lastLevelEmit < levelIntervalMs) return;
    lastLevelEmit = now;
    const emitted = levelPeak;
    levelPeak = 0;
    for (const listener of levelListeners) listener(emitted);
  });

  /** Sends the monitor state independently of capture configuration. */
  const updateEngineMonitor = (enabled = monitorOn, gain = monitorGainValue): void => {
    handle.engine.setInputMonitor({
      enabled: captureSource === 'input' && binding !== null && enabled,
      gain,
    });
  };

  /** Refusals expected when teardown races the engine or its command ring. */
  const isExpectedTeardownRefusal = (error: unknown): boolean =>
    isSonareError(error) && (error.codeName === 'InvalidState' || error.codeName === 'OutOfMemory');

  /** Keeps cleanup safe only for the coded refusals teardown can legitimately race. */
  const disableEngineMonitor = (): void => {
    try {
      handle.engine.setInputMonitor({ enabled: false });
    } catch (error) {
      if (!isExpectedTeardownRefusal(error)) throw error;
    }
  };

  /** Resets the message-port capture state, ignoring only a released handle. */
  const resetDiscardedCapture = async (): Promise<void> => {
    try {
      await handle.engine.resetCapture();
    } catch (error) {
      if (isSonareError(error) && error.codeName === 'InvalidState') return;
      throw error;
    }
  };

  const reportTeardownFailure = (error: unknown): void => {
    if (typeof globalThis.reportError === 'function') {
      globalThis.reportError(error);
      return;
    }
    console.error('Recorder capture reset failed during teardown', error);
  };

  const discardTakeForTeardown = (): void => {
    if (!take) return;
    take = null;
    capturePunch = undefined;
    try {
      handle.engine.armCapture({ armed: false });
    } catch (error) {
      if (!isExpectedTeardownRefusal(error)) throw error;
    } finally {
      void resetDiscardedCapture().catch(reportTeardownFailure);
    }
  };

  /**
   * Configures the buffer while capture is disarmed. Input capture uses the
   * raw microphone and output capture records the master. The engine applies
   * recordOffsetSamples as a capture delay.
   */
  const sendCaptureConfig = (bufferFrames: number, recordOffsetSamples = 0): void => {
    handle.engine.configureCapture({
      capacityFrames: bufferFrames,
      numChannels: captureChannelCount,
      source: captureSource,
      recordOffsetSamples,
      ...(capturePunch ? { punch: capturePunch } : {}),
    });
  };

  /** Largest reported input latency across every active capture stream. */
  const maxInputLatencySamples = (): number => {
    let max = 0;
    for (const stream of bindingStreams) {
      max = Math.max(max, inputLatencySamples(stream, handle.ctx.sampleRate));
    }
    return max;
  };

  const currentInputOffsetSamples = (): number =>
    captureSource === 'input' && binding
      ? defaultRecordOffsetSamples(handle.ctx) + maxInputLatencySamples()
      : 0;

  /**
   * Handles the capture device vanishing mid-session: aborts any in-flight
   * take, tears down the binding so hasMicrophone() reports false, and lets
   * subscribers (UI) prompt the user to reconnect. Idempotent.
   */
  const releaseLostBinding = (): boolean => {
    if (!binding) return false;
    operationGeneration += 1;
    detachTrackListeners?.();
    detachTrackListeners = null;
    let teardownError: unknown;
    try {
      disableEngineMonitor();
    } catch (error) {
      teardownError = error;
    }
    try {
      discardTakeForTeardown();
    } catch (error) {
      teardownError ??= error;
    }
    if (phase !== 'disposed') phase = 'idle';
    try {
      binding.destroy();
    } catch (error) {
      teardownError ??= error;
    } finally {
      binding = null;
      bindingStreams = [];
      captureChannelCount = DEFAULT_CAPTURE_CHANNEL_LIMIT;
      micPromise = null;
      resetLevel();
    }
    if (teardownError !== undefined) throw teardownError;
    return true;
  };

  const handleMicrophoneLost = (): void => {
    if (!releaseLostBinding()) return;
    for (const listener of [...micLostListeners]) listener();
  };

  const handleInputProcessorError = (): void => {
    if (!releaseLostBinding()) return;
    for (const listener of [...inputProcessorErrorListeners]) listener();
  };

  /**
   * Distinct, non-empty capture device ids the caller requested, in supplied
   * order (device order = merged channel index). Empty when none is requested.
   */
  const distinctDeviceIds = (): Array<string | undefined> => {
    const distinct: Array<string | undefined> = [];
    for (const id of options.inputDeviceIds ?? []) {
      const trimmed = id?.trim();
      const key = trimmed || undefined;
      if (!distinct.includes(key)) distinct.push(key);
    }
    return distinct;
  };

  /** Stops every track of a media stream (used on the merge teardown path). */
  const stopStreamTracks = (stream: MediaStream): void => {
    for (const track of stream.getTracks()) track.stop();
  };

  /**
   * Acquires one stream per distinct device and merges them into a single
   * multi-channel input feeding the engine node.
   *
   * Independent browser input devices run on independent hardware clocks with
   * no sample-accurate cross-device synchronization, so a long merged take can
   * drift channel-to-channel. The robust route for tightly synchronized
   * multi-input recording is an OS-level aggregate device, which presents as
   * one multi-channel input the existing per-track recordInputChannel demux
   * already splits. The merge is clamped to captureChannelLimit because the
   * engine ingests only that many input channels; extra devices are dropped.
   */
  const openMergedMicrophones = async (
    getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
    deviceIds: Array<string | undefined>,
    signal: AbortSignal,
  ): Promise<void> => {
    const used = deviceIds.slice(0, captureChannelLimit);
    if (deviceIds.length > used.length) {
      console.warn(
        `Recording input merge is capped at ${captureChannelLimit} channel(s); ` +
          `${deviceIds.length - used.length} device(s) were dropped.`,
      );
    }
    const streams: MediaStream[] = [];
    try {
      for (const id of used) {
        signal.throwIfAborted();
        const stream = await getUserMedia(microphoneConstraints(id));
        if (signal.aborted) {
          stopStreamTracks(stream);
          signal.throwIfAborted();
        }
        streams.push(stream);
      }
    } catch (err) {
      for (const stream of streams) stopStreamTracks(stream);
      if (signal.aborted) signal.throwIfAborted();
      throw new NoMicrophoneError(`Microphone access failed: ${errorMessage(err)}`);
    }
    const sources: MediaStreamAudioSourceNode[] = [];
    let merger: ChannelMergerNode | null = null;
    let stagedBinding: MicrophoneBinding | null = null;
    try {
      const ctx = handle.ctx;
      merger = ctx.createChannelMerger(used.length);
      for (const stream of streams) sources.push(ctx.createMediaStreamSource(stream));
      // A one-output discrete splitter keeps only each device's first channel
      // (a direct connect would down-mix it), so merged channel i carries
      // device i (the order recordingChannelRoutes demuxes onto tracks).
      sources.forEach((source, index) => {
        const splitter = ctx.createChannelSplitter(1);
        source.connect(splitter);
        splitter.connect(merger as ChannelMergerNode, 0, index);
      });
      merger.connect(handle.engine.node);
      const readyMerger = merger;
      const bound: MicrophoneBinding = {
        stream: streams[0],
        source: readyMerger,
        destroy: () => {
          try {
            readyMerger.disconnect();
          } catch {
            // Already disconnected during teardown; harmless.
          }
          for (const source of sources) {
            try {
              source.disconnect();
            } catch {
              // Already disconnected; harmless.
            }
          }
          for (const stream of streams) stopStreamTracks(stream);
        },
      };
      stagedBinding = bound;
      if (disposed || signal.aborted) {
        if (signal.aborted) signal.throwIfAborted();
        throw new RecorderStateError('Recorder has been disposed');
      }
      binding = bound;
      bindingStreams = streams;
      captureChannelCount = used.length;
      detachTrackListeners = attachAllTrackEndedListeners(streams, handleMicrophoneLost);
      sendCaptureConfig(idleBufferFrames, currentInputOffsetSamples());
      updateEngineMonitor();
    } catch (error) {
      if (stagedBinding) {
        detachTrackListeners?.();
        detachTrackListeners = null;
        stagedBinding.destroy();
        if (binding === stagedBinding) {
          binding = null;
          bindingStreams = [];
          captureChannelCount = DEFAULT_CAPTURE_CHANNEL_LIMIT;
        }
      } else {
        try {
          merger?.disconnect();
        } catch {
          // A partially connected merger may already be disconnected.
        }
        for (const source of sources) {
          try {
            source.disconnect();
          } catch {
            // A partially connected source may already be disconnected.
          }
        }
        for (const stream of streams) stopStreamTracks(stream);
      }
      disableEngineMonitor();
      throw error;
    }
  };

  /** One-shot microphone acquisition shared by concurrent callers. */
  const openMicrophone = async (signal: AbortSignal): Promise<void> => {
    const getUserMedia = options.getUserMedia ?? defaultGetUserMedia();
    if (!getUserMedia) {
      throw new NotSupportedError(
        'Microphone capture requires navigator.mediaDevices.getUserMedia',
      );
    }
    const deviceIds = distinctDeviceIds();
    if (deviceIds.length >= 2) {
      await openMergedMicrophones(getUserMedia, deviceIds, signal);
      return;
    }
    // A single requested device (one armed device-track) overrides the global
    // input; with none requested this is exactly the default input constraint.
    const singleDeviceId = deviceIds[0] ?? options.inputDeviceId;
    let stream: MediaStream;
    try {
      signal.throwIfAborted();
      stream = await getUserMedia(microphoneConstraints(singleDeviceId));
      if (signal.aborted) {
        stopStreamTracks(stream);
        signal.throwIfAborted();
      }
    } catch (err) {
      if (signal.aborted) signal.throwIfAborted();
      throw new NoMicrophoneError(`Microphone access failed: ${errorMessage(err)}`);
    }
    const retuneSemitones = clampStreamingRetuneSemitones(options.streamingRetuneSemitones ?? 0);
    const bindInput =
      options.bindInput ??
      (retuneSemitones !== 0 && options.voiceChangerPreset
        ? (ctx, engineNode, bindOptions) =>
            bindRealtimeVoiceChangerRetuneInput(ctx, engineNode, {
              ...bindOptions,
              preset: options.voiceChangerPreset ?? 'neutralMonitor',
              pitchSemitones: retuneSemitones,
              numChannels: 1,
            })
        : retuneSemitones !== 0
          ? (ctx, engineNode, bindOptions) =>
              bindStreamingRetuneInput(ctx, engineNode, {
                ...bindOptions,
                pitchSemitones: retuneSemitones,
                mix: 1,
                numChannels: 1,
              })
          : options.voiceChangerPreset
            ? (ctx, engineNode, bindOptions) =>
                bindRealtimeVoiceChangerInput(ctx, engineNode, {
                  ...bindOptions,
                  preset: options.voiceChangerPreset ?? 'neutralMonitor',
                  numChannels: 1,
                })
            : defaultBindInput);
    let bound: MicrophoneBinding;
    try {
      bound = await bindInput(handle.ctx, handle.engine.node, {
        stream,
        stopTracksOnDestroy: true,
        signal,
        onProcessorError: handleInputProcessorError,
      });
    } catch (error) {
      stopStreamTracks(stream);
      throw error;
    }
    if (disposed || signal.aborted) {
      bound.destroy();
      if (signal.aborted) signal.throwIfAborted();
      throw new RecorderStateError('Recorder has been disposed');
    }
    try {
      binding = bound;
      bindingStreams = [bound.stream];
      const actualChannels = bound.stream
        .getAudioTracks()
        .reduce((max, track) => Math.max(max, track.getSettings().channelCount ?? 1), 1);
      captureChannelCount = Math.max(1, Math.min(captureChannelLimit, actualChannels));
      // Learn when the device disappears so a take never silently fills with zeros.
      detachTrackListeners = attachTrackEndedListeners(bound.stream, handleMicrophoneLost);
      // The idle config makes the input source and the monitor state live on
      // the engine before any take starts.
      sendCaptureConfig(idleBufferFrames, currentInputOffsetSamples());
      updateEngineMonitor();
    } catch (error) {
      detachTrackListeners?.();
      detachTrackListeners = null;
      bound.destroy();
      if (binding === bound) {
        binding = null;
        bindingStreams = [];
        captureChannelCount = DEFAULT_CAPTURE_CHANNEL_LIMIT;
      }
      disableEngineMonitor();
      throw error;
    }
  };

  const requestMicrophone = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(new RecorderStateError('Recorder has been disposed'));
    }
    if (captureSource === 'output') return Promise.resolve();
    if (binding) return Promise.resolve();
    if (!micPromise) {
      const controller = new AbortController();
      microphoneAbort = controller;
      micPromise = openMicrophone(controller.signal)
        .catch((err) => {
          if (disposed && controller.signal.aborted) {
            throw new RecorderStateError('Recorder has been disposed');
          }
          throw err;
        })
        .finally(() => {
          if (microphoneAbort === controller) microphoneAbort = null;
          micPromise = null;
        });
    }
    return micPromise;
  };

  const setMonitor = (enabled: boolean, gain?: number): void => {
    if (disposed) return;
    const nextGain = gain ?? monitorGainValue;
    if (nextGain < 0) {
      throw new RangeError(`Monitor gain must be nonnegative, got ${nextGain}`);
    }
    if (binding || captureSource === 'output') updateEngineMonitor(enabled, nextGain);
    monitorOn = enabled;
    monitorGainValue = nextGain;
  };

  const setVoiceChangerPreset = (preset: RealtimeVoiceChangerConfigInput): boolean => {
    if (!binding?.setVoiceChangerPreset) return false;
    return binding.setVoiceChangerPreset(preset);
  };

  const setStreamingRetuneSemitones = (semitones: number): boolean => {
    if (!binding?.setStreamingRetuneConfig) return false;
    binding.setStreamingRetuneConfig({
      pitchSemitones: clampStreamingRetuneSemitones(semitones),
      mix: 1,
    });
    return true;
  };

  const start = async (startOptions: StartRecordingOptions): Promise<void> => {
    if (disposed) throw new RecorderStateError('Recorder has been disposed');
    if (phase !== 'idle')
      throw new RecorderStateError('Recording operation is already in progress');
    if (captureSource === 'input' && !binding) {
      throw new RecorderStateError('Request the microphone before recording');
    }
    if (armedTrack === null) throw new RecorderStateError('Arm a track before recording');
    const { startPpq, tempoBpm } = startOptions;
    if (!Number.isFinite(startPpq) || startPpq < 0) {
      throw new RangeError(`Recording startPpq must be finite and >= 0, got ${startPpq}`);
    }
    if (!Number.isFinite(tempoBpm) || tempoBpm <= 0) {
      throw new RangeError(`Recording tempoBpm must be finite and > 0, got ${tempoBpm}`);
    }
    const hasEndPpq = startOptions.endPpq !== undefined;
    const endPpq = startOptions.endPpq ?? 0;
    if (hasEndPpq && (!Number.isFinite(endPpq) || endPpq <= startPpq)) {
      throw new RangeError(
        `Recording endPpq must be finite and greater than startPpq, got ${endPpq}`,
      );
    }
    if (
      startOptions.punchOutPpq !== undefined &&
      (!Number.isFinite(startOptions.punchOutPpq) || startOptions.punchOutPpq <= startPpq)
    ) {
      throw new RangeError(
        `Recording punchOutPpq must be finite and greater than startPpq, got ${startOptions.punchOutPpq}`,
      );
    }
    const startSeconds = startOptions.tempoMap
      ? ppqToSeconds(startOptions.tempoMap, startPpq)
      : (startPpq * 60) / tempoBpm;
    const ppqToCaptureSeconds = (ppq: number): number =>
      (startOptions.tempoMap ? ppqToSeconds(startOptions.tempoMap, ppq) : (ppq * 60) / tempoBpm) -
      startSeconds;
    const boundPpq = hasEndPpq ? endPpq : startOptions.punchOutPpq;
    const punchDurationSeconds =
      boundPpq !== undefined ? ppqToCaptureSeconds(boundPpq) : DEFAULT_MAX_DURATION_SECONDS;
    const maxDurationSeconds = startOptions.maxDurationSeconds ?? punchDurationSeconds;
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
      throw new RangeError(
        `Recording maxDurationSeconds must be finite and > 0, got ${maxDurationSeconds}`,
      );
    }
    // The base offset compensates device playback/capture latency. Project PDC
    // is a separate playback-path delay, so add it even when a caller supplies
    // an explicit per-device calibration override.
    const baseOffsetSamples =
      startOptions.recordOffsetSamples ??
      (captureSource === 'input' && binding
        ? defaultRecordOffsetSamples(handle.ctx) + maxInputLatencySamples()
        : 0);
    const requestedPlaybackLatencySamples = startOptions.playbackLatencySamples ?? 0;
    if (!Number.isFinite(requestedPlaybackLatencySamples) || requestedPlaybackLatencySamples < 0) {
      throw new RangeError(
        `Recording playbackLatencySamples must be finite and >= 0, got ${requestedPlaybackLatencySamples}`,
      );
    }
    const playbackLatencySamples = captureSource === 'input' ? requestedPlaybackLatencySamples : 0;
    const offsetSamples = baseOffsetSamples + playbackLatencySamples;
    if (!Number.isFinite(offsetSamples) || offsetSamples < 0) {
      throw new RangeError(
        `Recording recordOffsetSamples must be finite and >= 0, got ${offsetSamples}`,
      );
    }
    const sampleRate = handle.ctx.sampleRate;
    const requestedPunchOutPpq =
      (hasEndPpq ? endPpq : startOptions.punchOutPpq) ??
      (startOptions.tempoMap
        ? secondsToPpq(startOptions.tempoMap, startSeconds + maxDurationSeconds)
        : startPpq + (maxDurationSeconds * tempoBpm) / 60);
    const requestedPunchDurationSeconds = ppqToCaptureSeconds(requestedPunchOutPpq);
    const captureDurationSeconds = Math.max(maxDurationSeconds, requestedPunchDurationSeconds);
    const punchOutPpq = startOptions.tempoMap
      ? secondsToPpq(startOptions.tempoMap, startSeconds + captureDurationSeconds)
      : startPpq + (captureDurationSeconds * tempoBpm) / 60;
    // The punch window is in compensated time, so the render position passes
    // its end `offsetSamples` before the engine has captured the tail.
    const captureCompleteSeconds = captureDurationSeconds + offsetSamples / sampleRate;
    const capturePunchOutPpq = startOptions.tempoMap
      ? secondsToPpq(startOptions.tempoMap, startSeconds + captureCompleteSeconds)
      : startPpq + (captureCompleteSeconds * tempoBpm) / 60;
    const trackId = armedTrack;
    const generation = ++operationGeneration;
    phase = 'starting';
    try {
      capturePunch = { startPpq, endPpq: punchOutPpq };
      if (captureSource === 'output') updateEngineMonitor();
      sendCaptureConfig(Math.max(1, Math.ceil(captureDurationSeconds * sampleRate)), offsetSamples);
      await handle.engine.resetCapture();
      if (disposed || generation !== operationGeneration) {
        throw new RecorderStateError('Recorder startup was cancelled');
      }
      // Punch-out = explicit endPpq or the max-duration bound; stop() disarms
      // earlier as needed. The half-open window keeps any count-in pre-roll out
      // of the buffer and lets auto-punch close sample-accurately at R.
      handle.engine.armCapture({ armed: true });
      take = { trackId, startPpq, capturePunchOutPpq, sampleRate, offsetSamples };
      phase = 'recording';
    } catch (error) {
      capturePunch = undefined;
      try {
        await resetDiscardedCapture();
      } finally {
        if (!disposed && generation === operationGeneration) phase = 'idle';
      }
      throw error;
    }
  };

  /**
   * Reads the capture status once the disarm has reached the audio thread.
   * The disarm travels the command ring and the reads and the idle config the
   * port, with no ordering between them; the engine refuses a capture config
   * while still armed, and a read before the disarm misses the last frames.
   */
  const captureStatusOnceDisarmed = async (): Promise<EngineCaptureStatus> => {
    for (let attempt = 0; attempt < DISARM_POLL_ATTEMPTS; attempt++) {
      const status = await handle.engine.captureStatus();
      if (!status.armed) return status;
      await new Promise((resolve) => setTimeout(resolve, DISARM_POLL_INTERVAL_MS));
    }
    throw new RecorderStateError('The engine did not disarm the capture');
  };

  const stop = async (options: { captureTail?: boolean } = {}): Promise<RecordingResult | null> => {
    const active = take;
    if (!active || phase !== 'recording') {
      throw new RecorderStateError('No recording in progress');
    }
    const generation = operationGeneration;
    phase = 'stopping';
    if (options.captureTail && active.offsetSamples > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, (active.offsetSamples / active.sampleRate) * 1000),
      );
      if (disposed || generation !== operationGeneration) {
        throw new RecorderStateError('Recorder stop was cancelled');
      }
    }
    handle.engine.armCapture({ armed: false });
    let status: Awaited<ReturnType<EngineHandle['engine']['captureStatus']>>;
    let captured: Float32Array[];
    try {
      status = await captureStatusOnceDisarmed();
      if (disposed || generation !== operationGeneration) {
        throw new RecorderStateError('Recorder stop was cancelled');
      }
      captured = await handle.engine.capturedAudio();
      if (disposed || generation !== operationGeneration) {
        throw new RecorderStateError('Recorder stop was cancelled');
      }
      await handle.engine.resetCapture();
      if (disposed || generation !== operationGeneration) {
        throw new RecorderStateError('Recorder stop was cancelled');
      }
    } catch (error) {
      if (!disposed && generation === operationGeneration) phase = 'recording';
      throw error;
    }
    take = null;
    capturePunch = undefined;
    phase = 'idle';
    if (status.droppedFrames > 0) {
      console.warn(`Recording capture dropped frames: ${status.droppedFrames}`);
    }
    // Back to the idle capture config between takes; input monitoring remains
    // configured separately on the engine.
    if (captureSource === 'output' || binding) {
      sendCaptureConfig(idleBufferFrames, currentInputOffsetSamples());
    }
    // Drop the input meter so it does not freeze on the last take's peak.
    resetLevel();
    // capturedAudio returns full-capacity planar buffers; only the first
    // capturedFrames samples of each channel are valid.
    let frames = status.capturedFrames;
    for (const channel of captured) frames = Math.min(frames, channel.length);
    if (frames <= 0 || captured.length === 0) return null;
    const channels = captured.map((channel) => channel.slice(0, frames));
    return {
      channels,
      sampleRate: active.sampleRate,
      startPpq: active.startPpq,
      ...(status.droppedFrames > 0 ? { droppedFrames: status.droppedFrames } : {}),
    };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    operationGeneration += 1;
    phase = 'disposed';
    unsubscribeMeter();
    detachTrackListeners?.();
    detachTrackListeners = null;
    let teardownError: unknown;
    try {
      disableEngineMonitor();
    } catch (error) {
      teardownError = error;
    }
    try {
      discardTakeForTeardown();
    } catch (error) {
      teardownError ??= error;
    }
    try {
      binding?.destroy();
    } catch (error) {
      teardownError ??= error;
    } finally {
      binding = null;
      bindingStreams = [];
      microphoneAbort?.abort(new DOMException('Recorder disposed.', 'AbortError'));
      microphoneAbort = null;
      micPromise = null;
      levelListeners.clear();
      micLostListeners.clear();
      inputProcessorErrorListeners.clear();
    }
    if (teardownError !== undefined) throw teardownError;
  };

  return {
    requestMicrophone,
    hasMicrophone: () => captureSource === 'output' || binding !== null,
    arm(trackId: number): void {
      if (phase !== 'idle') {
        throw new RecorderStateError('Cannot change the armed track during a recording operation');
      }
      armedTrack = trackId;
    },
    disarm(): void {
      if (phase !== 'idle') {
        throw new RecorderStateError('Cannot disarm during a recording operation');
      }
      armedTrack = null;
    },
    armedTrackId: () => armedTrack,
    isRecording: () => phase === 'recording' || phase === 'stopping',
    setMonitor,
    monitorEnabled: () => monitorOn,
    setVoiceChangerPreset,
    setStreamingRetuneSemitones,
    onLevel(listener: (peak: number) => void): () => void {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
    onMicrophoneLost(listener: () => void): () => void {
      micLostListeners.add(listener);
      return () => {
        micLostListeners.delete(listener);
      };
    },
    onInputProcessorError(listener: () => void): () => void {
      inputProcessorErrorListeners.add(listener);
      return () => {
        inputProcessorErrorListeners.delete(listener);
      };
    },
    start,
    stop,
    capturePunchOutPpq: () => (phase === 'recording' && take ? take.capturePunchOutPpq : null),
    dispose,
  };
}
