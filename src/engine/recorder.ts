/**
 * Microphone recording for a running engine: binds a microphone to the engine
 * node and records through the engine's native capture path
 * (configureCapture / armRecord / punch / capturedAudio).
 *
 * Capture model: configureCapture allocates the engine-side capture buffer up
 * front and selects `source: 'input'`, which captures the raw microphone
 * signal (the engine node's input) before any processing. Capture is gated to
 * the punch window — a half-open PPQ range [in, out) converted engine-side at
 * the current tempo map — and only runs while the transport plays, so a
 * count-in pre-roll (transport seeked earlier than the punch-in) is excluded
 * from the take without any host-side frame skipping. The engine treats
 * recordOffsetSamples as metadata only and never shifts captured samples;
 * record-latency compensation is sent to the engine and also applied here by
 * trimming the head of the take in stop().
 *
 * Input monitoring is engine-side: the capture config's inputMonitor switch
 * controls whether the microphone input is also mixed into the engine output.
 * Re-sending the config (for example to toggle the monitor) does not lose
 * armed state or buffered audio. captureStatus / capturedAudio / resetCapture
 * are async over a request/response message channel and behave identically in
 * SAB and postMessage fallback modes. Meter snapshots tagged with
 * {@link INPUT_METER_TARGET_ID} carry the input-capture level in dBFS.
 *
 * Silence guarantees: requesting a microphone produces no sound. The input
 * monitor stays disabled until setMonitor(true) is called explicitly; nothing
 * here starts playback.
 */

import { dbToLinear } from '@/lib/db';
import { ensureWasm } from '@/lib/wasm';
import type { EngineCaptureStatus, RealtimeVoiceChangerConfigInput } from '@/wasm/index.js';
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
 * keeps the input source and the monitor state live on the engine before any
 * take starts. start() reconfigures the buffer to the full take length.
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
  /** Number of samples dropped because the engine capture buffer filled. */
  overflowCount?: number;
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
   * Record-latency compensation in samples (>= 0): the first that many
   * captured frames are dropped when the take is assembled. A sound played
   * at timeline position T reaches the capture input roughly this many
   * samples late, so trimming the head re-aligns the take to `startPpq`.
   * Defaults to {@link defaultRecordOffsetSamples} of the engine context plus
   * the device's reported input latency ({@link inputLatencySamples}).
   */
  recordOffsetSamples?: number;
  /**
   * Maximum take length in seconds (> 0, default 300). Sizes the engine
   * capture buffer, so the whole span is allocated up front.
   */
  maxDurationSeconds?: number;
  /**
   * Timeline position in PPQ where an open-ended (no `endPpq`) capture auto
   * punches out (> startPpq). It bounds the same real-time span as
   * `maxDurationSeconds`, but resolved through the project tempo map so the
   * punch-out lands exactly when the preallocated buffer fills. When omitted,
   * the recorder derives the bound from `tempoBpm`, which only matches a
   * constant-tempo project — under a tempo map that estimate drifts, closing
   * the window early or overrunning the buffer.
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
  setVoiceChangerPreset?(preset: RealtimeVoiceChangerConfigInput): void;
  /** Updates an in-place StreamingRetune binding, when present. */
  setStreamingRetuneConfig?(config: { semitones?: number; mix?: number; grainSize?: number }): void;
  /** Disconnects the source and stops the stream tracks. */
  close(): void;
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
    options: { stream: MediaStream; stopTracksOnClose: boolean; signal?: AbortSignal },
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
   * @param gain Linear monitor gain (finite, >= 0); kept when omitted.
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
   * Starts capturing the armed track through the engine record path: sizes
   * the capture buffer for the full take, resets the capture counters, arms
   * the engine (engine.armRecord) and sets the punch window (engine.punch)
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
   * @returns The recorded frames (head-trimmed by the record-latency
   *   offset), or null when nothing usable was captured (for example when
   *   stopped during the count-in).
   * @throws RecorderStateError When no recording is in progress.
   */
  stop(): Promise<RecordingResult | null>;
  /**
   * Releases everything: disarms an in-flight recording (discarding frames),
   * unsubscribes from engine meters and stops the microphone tracks. Safe to
   * call multiple times.
   */
  dispose(): void;
}

/**
 * Estimates the record-latency offset for a context: the playback path delay
 * (base + output latency) in samples. Input latency is not exposed by the
 * Web Audio API, so this is a lower bound; callers may override per device.
 *
 * @param ctx The engine AudioContext.
 * @returns Offset in samples (>= 0).
 */
export function defaultRecordOffsetSamples(ctx: AudioContext): number {
  const base =
    typeof ctx.baseLatency === 'number' && Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
  const outputLatency = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
  const output =
    typeof outputLatency === 'number' && Number.isFinite(outputLatency) ? outputLatency : 0;
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
    if (typeof latency === 'number' && Number.isFinite(latency) && latency > maxLatencySeconds) {
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
  options: { stream: MediaStream; stopTracksOnClose: boolean; signal?: AbortSignal },
): Promise<MicrophoneBinding> {
  const wasm = await ensureWasm();
  options.signal?.throwIfAborted();
  return wasm.bindMicrophoneInput(ctx, engineNode, {
    stream: options.stream,
    stopTracksOnClose: options.stopTracksOnClose,
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
  /** Record-latency head trim applied when the take is assembled. */
  offsetSamples: number;
  /** Capture sample rate at start time. */
  sampleRate: number;
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
  /**
   * Channel count sent to configureCapture. Stays at the engine width (2) for a
   * single device only when the device actually reports two channels; a device
   * merge uses one channel per opened device.
   */
  let captureChannelCount = DEFAULT_CAPTURE_CHANNEL_LIMIT;
  let micPromise: Promise<void> | null = null;
  let microphoneAbort: AbortController | null = null;
  let monitorOn = false;
  let monitorGainValue = 1;
  let armedTrack: number | null = null;
  let take: ActiveTake | null = null;
  let operationGeneration = 0;
  let phase: 'idle' | 'starting' | 'recording' | 'stopping' | 'disposed' = 'idle';
  let captureBufferFrames = idleBufferFrames;
  const levelListeners = new Set<(peak: number) => void>();
  let levelPeak = 0;
  let lastLevelEmit = 0;
  const micLostListeners = new Set<() => void>();
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
    const peak = Math.max(dbPeakToLinear(meter.peakDbL), dbPeakToLinear(meter.peakDbR));
    if (peak > levelPeak) levelPeak = peak;
    const now = Date.now();
    if (now - lastLevelEmit < levelIntervalMs) return;
    lastLevelEmit = now;
    const emitted = levelPeak;
    levelPeak = 0;
    for (const listener of levelListeners) listener(emitted);
  });

  /**
   * (Re)sends the engine capture config. Input capture uses the raw microphone
   * source and current monitor state; output capture records the master output
   * and keeps input monitoring disabled. Re-sending preserves armed state and
   * buffered audio. recordOffsetSamples is also applied host-side in stop()
   * so stored takes stay aligned even on engines that only treat it as
   * monitor/capture metadata.
   */
  const sendCaptureConfig = (bufferFrames: number, recordOffsetSamples = 0): void => {
    captureBufferFrames = bufferFrames;
    handle.engine.configureCapture({
      bufferFrames,
      channels: captureChannelCount,
      source: captureSource,
      recordOffsetSamples,
      inputMonitor: {
        enabled: captureSource === 'input' && monitorOn,
        gain: monitorGainValue,
      },
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
  const handleMicrophoneLost = (): void => {
    if (!binding) return;
    operationGeneration += 1;
    detachTrackListeners?.();
    detachTrackListeners = null;
    if (take) {
      const active = take;
      take = null;
      handle.engine.armRecord(active.trackId, false);
      void handle.engine.resetCapture().catch(() => {
        // The device is gone; a failed reset is harmless.
      });
    }
    if (phase !== 'disposed') phase = 'idle';
    binding.close();
    binding = null;
    bindingStreams = [];
    captureChannelCount = DEFAULT_CAPTURE_CHANNEL_LIMIT;
    micPromise = null;
    resetLevel();
    for (const listener of [...micLostListeners]) listener();
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
      throw new NoMicrophoneError(
        `Microphone access failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const sources: MediaStreamAudioSourceNode[] = [];
    let merger: ChannelMergerNode | null = null;
    let stagedBinding: MicrophoneBinding | null = null;
    try {
      const ctx = handle.ctx;
      merger = ctx.createChannelMerger(used.length);
      for (const stream of streams) sources.push(ctx.createMediaStreamSource(stream));
      // Each device's first channel feeds one merger input, so merged channel i
      // carries device i (the order recordingChannelRoutes demuxes onto tracks).
      sources.forEach((source, index) => {
        source.connect(merger as ChannelMergerNode, 0, index);
      });
      merger.connect(handle.engine.node);
      const readyMerger = merger;
      const bound: MicrophoneBinding = {
        stream: streams[0],
        source: readyMerger,
        close: () => {
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
    } catch (error) {
      if (stagedBinding) {
        detachTrackListeners?.();
        detachTrackListeners = null;
        stagedBinding.close();
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
      throw new NoMicrophoneError(
        `Microphone access failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const retuneSemitones = clampStreamingRetuneSemitones(options.streamingRetuneSemitones ?? 0);
    const bindInput =
      options.bindInput ??
      (retuneSemitones !== 0 && options.voiceChangerPreset
        ? (ctx, engineNode, bindOptions) =>
            bindRealtimeVoiceChangerRetuneInput(ctx, engineNode, {
              ...bindOptions,
              preset: options.voiceChangerPreset ?? 'neutral-monitor',
              semitones: retuneSemitones,
              channelCount: 1,
            })
        : retuneSemitones !== 0
          ? (ctx, engineNode, bindOptions) =>
              bindStreamingRetuneInput(ctx, engineNode, {
                ...bindOptions,
                semitones: retuneSemitones,
                mix: 1,
                channelCount: 1,
              })
          : options.voiceChangerPreset
            ? (ctx, engineNode, bindOptions) =>
                bindRealtimeVoiceChangerInput(ctx, engineNode, {
                  ...bindOptions,
                  preset: options.voiceChangerPreset ?? 'neutral-monitor',
                  channelCount: 1,
                })
            : defaultBindInput);
    let bound: MicrophoneBinding;
    try {
      bound = await bindInput(handle.ctx, handle.engine.node, {
        stream,
        stopTracksOnClose: true,
        signal,
      });
    } catch (error) {
      stopStreamTracks(stream);
      throw error;
    }
    if (disposed || signal.aborted) {
      bound.close();
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
    } catch (error) {
      detachTrackListeners?.();
      detachTrackListeners = null;
      bound.close();
      if (binding === bound) {
        binding = null;
        bindingStreams = [];
        captureChannelCount = DEFAULT_CAPTURE_CHANNEL_LIMIT;
      }
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
    if (gain !== undefined) {
      if (!Number.isFinite(gain) || gain < 0) {
        throw new RangeError(`Monitor gain must be finite and >= 0, got ${gain}`);
      }
      monitorGainValue = gain;
    }
    monitorOn = enabled;
    // Re-send with the current buffer size (the recording size while a take
    // is running) so toggling the monitor never shrinks an active capture.
    if (binding) sendCaptureConfig(captureBufferFrames, currentInputOffsetSamples());
  };

  const setVoiceChangerPreset = (preset: RealtimeVoiceChangerConfigInput): boolean => {
    if (!binding?.setVoiceChangerPreset) return false;
    binding.setVoiceChangerPreset(preset);
    return true;
  };

  const setStreamingRetuneSemitones = (semitones: number): boolean => {
    if (!binding?.setStreamingRetuneConfig) return false;
    binding.setStreamingRetuneConfig({
      semitones: clampStreamingRetuneSemitones(semitones),
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
    const punchDurationSeconds = hasEndPpq
      ? ((endPpq - startPpq) * 60) / tempoBpm
      : DEFAULT_MAX_DURATION_SECONDS;
    const maxDurationSeconds = startOptions.maxDurationSeconds ?? punchDurationSeconds;
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
      throw new RangeError(
        `Recording maxDurationSeconds must be finite and > 0, got ${maxDurationSeconds}`,
      );
    }
    // The default offset compensates both the playback path (base + output
    // latency) and the capture path (the device's reported input latency), so
    // a take lands on its start position rather than a few ms late. An explicit
    // override replaces the whole estimate.
    const offsetSamples =
      startOptions.recordOffsetSamples ??
      (captureSource === 'input' && binding
        ? defaultRecordOffsetSamples(handle.ctx) + maxInputLatencySamples()
        : 0);
    if (!Number.isFinite(offsetSamples) || offsetSamples < 0) {
      throw new RangeError(
        `Recording recordOffsetSamples must be finite and >= 0, got ${offsetSamples}`,
      );
    }
    const sampleRate = handle.ctx.sampleRate;
    const trackId = armedTrack;
    const generation = ++operationGeneration;
    let engineArmed = false;
    phase = 'starting';
    try {
      sendCaptureConfig(Math.max(1, Math.ceil(maxDurationSeconds * sampleRate)), offsetSamples);
      await handle.engine.resetCapture();
      if (disposed || generation !== operationGeneration) {
        throw new RecorderStateError('Recorder startup was cancelled');
      }
      handle.engine.armRecord(trackId, true);
      engineArmed = true;
      // Punch-out = explicit endPpq or the max-duration bound; stop() disarms
      // earlier as needed. The half-open window keeps any count-in pre-roll out
      // of the buffer and lets auto-punch close sample-accurately at R.
      handle.engine.punch(
        startPpq,
        hasEndPpq
          ? endPpq
          : (startOptions.punchOutPpq ?? startPpq + (maxDurationSeconds * tempoBpm) / 60),
      );
      take = { trackId, startPpq, offsetSamples, sampleRate };
      phase = 'recording';
    } catch (error) {
      if (engineArmed) handle.engine.armRecord(trackId, false);
      await handle.engine.resetCapture().catch(() => undefined);
      if (!disposed && generation === operationGeneration) phase = 'idle';
      throw error;
    }
  };

  const stop = async (): Promise<RecordingResult | null> => {
    const active = take;
    if (!active || phase !== 'recording') {
      throw new RecorderStateError('No recording in progress');
    }
    const generation = operationGeneration;
    phase = 'stopping';
    handle.engine.armRecord(active.trackId, false);
    let status: Awaited<ReturnType<EngineHandle['engine']['captureStatus']>>;
    let captured: Float32Array[];
    try {
      status = await handle.engine.captureStatus();
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
    phase = 'idle';
    if (status.overflowCount > 0) {
      console.warn(`Recording capture overflow: ${status.overflowCount} samples dropped`);
    }
    // Back to the idle config so the monitor state survives between takes.
    if (captureSource === 'output' || binding) {
      sendCaptureConfig(idleBufferFrames, currentInputOffsetSamples());
    }
    // Drop the input meter so it does not freeze on the last take's peak.
    resetLevel();
    // capturedAudio returns full-capacity planar buffers; only the first
    // capturedFrames samples of each channel are valid.
    let frames = status.capturedFrames;
    for (const channel of captured) frames = Math.min(frames, channel.length);
    // The first offsetSamples frames are input-latency lead-in: a sound at
    // timeline position T reaches the input about that many samples late, so
    // dropping them re-aligns the take to startPpq.
    const kept = frames - active.offsetSamples;
    if (kept <= 0 || captured.length === 0) return null;
    const channels = captured.map((channel) => channel.slice(active.offsetSamples, frames));
    return {
      channels,
      sampleRate: active.sampleRate,
      startPpq: active.startPpq,
      ...(status.overflowCount > 0 ? { overflowCount: status.overflowCount } : {}),
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
    if (take) {
      const active = take;
      take = null;
      handle.engine.armRecord(active.trackId, false);
      void handle.engine.resetCapture().catch(() => {
        // The engine may already be tearing down; a failed reset is harmless.
      });
    }
    binding?.close();
    binding = null;
    bindingStreams = [];
    microphoneAbort?.abort(new DOMException('Recorder disposed.', 'AbortError'));
    microphoneAbort = null;
    micPromise = null;
    levelListeners.clear();
    micLostListeners.clear();
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
    start,
    stop,
    dispose,
  };
}
