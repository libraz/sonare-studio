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
 * record-latency compensation is applied here by trimming the head of the
 * take in stop().
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
import type { EngineHandle } from './engine';

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

/**
 * Meter target id of the engine's input-capture level: snapshots with this
 * targetId carry the microphone peak (dBFS) alongside master/lane records.
 */
export const INPUT_METER_TARGET_ID = 0xffff;

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
const DEFAULT_MAX_DURATION_SECONDS = 300;

/** Default minimum interval between input-level callbacks. */
const DEFAULT_LEVEL_INTERVAL_MS = 50;

/** A finished take handed back by {@link Recorder.stop}. */
export interface RecordingResult {
  /** Planar capture buffers (one per channel) at `sampleRate`. */
  channels: Float32Array[];
  /** Capture sample rate (the engine AudioContext rate) in Hz. */
  sampleRate: number;
  /** Timeline position in PPQ where the recorded material begins. */
  startPpq: number;
}

/** Options for {@link Recorder.start}. */
export interface StartRecordingOptions {
  /** Timeline position in PPQ where the recorded material begins (>= 0). */
  startPpq: number;
  /** Tempo in BPM used for all PPQ/time conversions (> 0). */
  tempoBpm: number;
  /**
   * Record-latency compensation in samples (>= 0): the first that many
   * captured frames are dropped when the take is assembled. A sound played
   * at timeline position T reaches the capture input roughly this many
   * samples late, so trimming the head re-aligns the take to `startPpq`.
   * Defaults to {@link defaultRecordOffsetSamples} of the engine context.
   */
  recordOffsetSamples?: number;
  /**
   * Maximum take length in seconds (> 0, default 300). Sizes the engine
   * capture buffer, so the whole span is allocated up front.
   */
  maxDurationSeconds?: number;
}

/** The microphone routing produced by binding a stream to the engine node. */
export interface MicrophoneBinding {
  /** The captured media stream. */
  stream: MediaStream;
  /** The Web Audio source node wrapping the stream. */
  source: AudioNode;
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
    options: { stream: MediaStream; stopTracksOnClose: boolean },
  ) => Promise<MicrophoneBinding>;
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
  options: { stream: MediaStream; stopTracksOnClose: boolean },
): Promise<MicrophoneBinding> {
  const wasm = await ensureWasm();
  return wasm.bindMicrophoneInput(ctx, engineNode, options);
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
  /** Idle capture buffer size keeping the input path configured between takes. */
  const idleBufferFrames = Math.max(1, Math.ceil(MONITOR_BUFFER_SECONDS * handle.ctx.sampleRate));
  let disposed = false;
  let binding: MicrophoneBinding | null = null;
  let micPromise: Promise<void> | null = null;
  let monitorOn = false;
  let monitorGainValue = 1;
  let armedTrack: number | null = null;
  let take: ActiveTake | null = null;
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
   * (Re)sends the engine capture config: raw input source, stereo, and the
   * current monitor state. Re-sending preserves armed state and buffered
   * audio, so this doubles as the monitor toggle. recordOffsetSamples is
   * engine-side metadata only; the actual latency trim happens in stop().
   */
  const sendCaptureConfig = (bufferFrames: number): void => {
    captureBufferFrames = bufferFrames;
    handle.engine.configureCapture({
      bufferFrames,
      channels: 2,
      source: 'input',
      recordOffsetSamples: 0,
      inputMonitor: { enabled: monitorOn, gain: monitorGainValue },
    });
  };

  /**
   * Handles the capture device vanishing mid-session: aborts any in-flight
   * take, tears down the binding so hasMicrophone() reports false, and lets
   * subscribers (UI) prompt the user to reconnect. Idempotent.
   */
  const handleMicrophoneLost = (): void => {
    if (!binding) return;
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
    binding.close();
    binding = null;
    micPromise = null;
    resetLevel();
    for (const listener of [...micLostListeners]) listener();
  };

  /** One-shot microphone acquisition shared by concurrent callers. */
  const openMicrophone = async (): Promise<void> => {
    const getUserMedia = options.getUserMedia ?? defaultGetUserMedia();
    if (!getUserMedia) {
      throw new NotSupportedError(
        'Microphone capture requires navigator.mediaDevices.getUserMedia',
      );
    }
    let stream: MediaStream;
    try {
      stream = await getUserMedia(MICROPHONE_CONSTRAINTS);
    } catch (err) {
      throw new NoMicrophoneError(
        `Microphone access failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const bindInput = options.bindInput ?? defaultBindInput;
    const bound = await bindInput(handle.ctx, handle.engine.node, {
      stream,
      stopTracksOnClose: true,
    });
    if (disposed) {
      bound.close();
      throw new RecorderStateError('Recorder has been disposed');
    }
    binding = bound;
    // Learn when the device disappears so a take never silently fills with zeros.
    detachTrackListeners = attachTrackEndedListeners(bound.stream, handleMicrophoneLost);
    // The idle config makes the input source and the monitor state live on
    // the engine before any take starts.
    sendCaptureConfig(idleBufferFrames);
  };

  const requestMicrophone = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(new RecorderStateError('Recorder has been disposed'));
    }
    if (binding) return Promise.resolve();
    if (!micPromise) {
      micPromise = openMicrophone().catch((err) => {
        micPromise = null;
        throw err;
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
    if (binding) sendCaptureConfig(captureBufferFrames);
  };

  const start = async (startOptions: StartRecordingOptions): Promise<void> => {
    if (disposed) throw new RecorderStateError('Recorder has been disposed');
    if (take) throw new RecorderStateError('Recording is already in progress');
    if (!binding) throw new RecorderStateError('Request the microphone before recording');
    if (armedTrack === null) throw new RecorderStateError('Arm a track before recording');
    const { startPpq, tempoBpm } = startOptions;
    if (!Number.isFinite(startPpq) || startPpq < 0) {
      throw new RangeError(`Recording startPpq must be finite and >= 0, got ${startPpq}`);
    }
    if (!Number.isFinite(tempoBpm) || tempoBpm <= 0) {
      throw new RangeError(`Recording tempoBpm must be finite and > 0, got ${tempoBpm}`);
    }
    const maxDurationSeconds = startOptions.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
      throw new RangeError(
        `Recording maxDurationSeconds must be finite and > 0, got ${maxDurationSeconds}`,
      );
    }
    const offsetSamples =
      startOptions.recordOffsetSamples ?? defaultRecordOffsetSamples(handle.ctx);
    if (!Number.isFinite(offsetSamples) || offsetSamples < 0) {
      throw new RangeError(
        `Recording recordOffsetSamples must be finite and >= 0, got ${offsetSamples}`,
      );
    }
    const sampleRate = handle.ctx.sampleRate;
    const trackId = armedTrack;
    sendCaptureConfig(Math.max(1, Math.ceil(maxDurationSeconds * sampleRate)));
    await handle.engine.resetCapture();
    handle.engine.armRecord(trackId, true);
    // Punch-out = the max-duration bound; stop() disarms earlier as needed.
    // The half-open window keeps any count-in pre-roll out of the buffer.
    handle.engine.punch(startPpq, startPpq + (maxDurationSeconds * tempoBpm) / 60);
    take = { trackId, startPpq, offsetSamples, sampleRate };
  };

  const stop = async (): Promise<RecordingResult | null> => {
    const active = take;
    if (!active) throw new RecorderStateError('No recording in progress');
    take = null;
    handle.engine.armRecord(active.trackId, false);
    const status = await handle.engine.captureStatus();
    const captured = await handle.engine.capturedAudio();
    if (status.overflowCount > 0) {
      console.warn(`Recording capture overflow: ${status.overflowCount} samples dropped`);
    }
    await handle.engine.resetCapture();
    // Back to the idle config so the monitor state survives between takes.
    if (binding) sendCaptureConfig(idleBufferFrames);
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
    return { channels, sampleRate: active.sampleRate, startPpq: active.startPpq };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
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
    micPromise = null;
    levelListeners.clear();
    micLostListeners.clear();
  };

  return {
    requestMicrophone,
    hasMicrophone: () => binding !== null,
    arm(trackId: number): void {
      if (take) throw new RecorderStateError('Cannot change the armed track while recording');
      armedTrack = trackId;
    },
    disarm(): void {
      if (take) throw new RecorderStateError('Cannot disarm while recording');
      armedTrack = null;
    },
    armedTrackId: () => armedTrack,
    isRecording: () => take !== null,
    setMonitor,
    monitorEnabled: () => monitorOn,
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
