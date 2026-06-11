/**
 * Microphone recording for a running engine: binds a microphone to the engine
 * node, captures the input on the host thread, and returns the recorded
 * frames together with the timeline position where the take starts.
 *
 * Capture model: arming and punching delegate to the engine record path
 * (engine.armRecord / engine.punch), but the declared engine API offers no
 * channel that carries captured frames from the AudioWorklet back to the main
 * thread (RealtimeEngine.capturedAudio exists only on control-thread engine
 * instances). The recorder therefore taps the microphone source with a
 * host-side capture node and assembles the take itself, applying count-in
 * skip and record-latency offset in plain sample math. For the same reason,
 * input monitoring runs through a host-side gain node: the engine's
 * setInputMonitor switch is not part of the worklet command protocol.
 *
 * Silence guarantees: requesting a microphone produces no sound. The capture
 * tap drains into a zero-gain stage and the monitor path stays disconnected
 * until setMonitor(true) is called explicitly; nothing here starts playback.
 */

import { ensureWasm } from '@/lib/wasm';
import { engineTrackId, ppqToSeconds } from '@/project/scheduling';
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

/** Upper bound for one take when no explicit limit is passed (10 minutes). */
const DEFAULT_MAX_DURATION_SECONDS = 600;

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
   * Count-in length in PPQ (>= 0, default 0). The transport is expected to
   * start rolling at `startPpq - countInPpq`; the captured count-in span is
   * discarded so the take begins exactly at `startPpq`.
   */
  countInPpq?: number;
  /**
   * Record-latency compensation in samples (>= 0): that many extra captured
   * frames are dropped at the punch-in so material played against the heard
   * output lands on the timeline where it was intended. Defaults to
   * {@link defaultRecordOffsetSamples} of the engine context.
   */
  recordOffsetSamples?: number;
  /** Maximum take length in seconds (> 0, default 600). Extra frames are dropped. */
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

/** A host-side capture tap delivering microphone blocks to the recorder. */
export interface CaptureTap {
  /** Disconnects the tap and stops block delivery. */
  close(): void;
}

/**
 * Builds a capture tap on a microphone source node. The factory must invoke
 * `onBlock` with planar buffers the recorder may retain (no reuse across
 * calls); the default implementation posts transferred copies from an
 * AudioWorklet processor.
 */
export type CaptureTapFactory = (
  ctx: AudioContext,
  source: AudioNode,
  channelCount: number,
  onBlock: (channels: ReadonlyArray<Float32Array>) => void,
) => Promise<CaptureTap> | CaptureTap;

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
  /** Capture tap factory; defaults to an AudioWorklet-based tap. */
  createTap?: CaptureTapFactory;
  /** Minimum interval between input-level callbacks in ms (default 50). */
  levelIntervalMs?: number;
}

/** Imperative microphone recorder returned by {@link createRecorder}. */
export interface Recorder {
  /**
   * Requests microphone access (tracking-quality constraints), binds the
   * stream to the engine node and installs the capture tap. Idempotent;
   * concurrent calls share one request.
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
   * Enables or disables host-side input monitoring (microphone to context
   * destination through a gain node). Disabled by default; the desired state
   * is remembered and applied once the microphone is bound.
   *
   * @param enabled Target monitor state.
   * @param gain Linear monitor gain (finite, >= 0); kept when omitted.
   */
  setMonitor(enabled: boolean, gain?: number): void;
  /** Current monitor state. */
  monitorEnabled(): boolean;
  /**
   * Subscribes to throttled input peak levels (linear, 0..1+, max across
   * channels since the previous callback).
   *
   * @returns An unsubscribe function.
   */
  onLevel(listener: (peak: number) => void): () => void;
  /**
   * Starts capturing the armed track: arms the engine record path
   * (engine.armRecord), sets the punch window (engine.punch), and begins
   * collecting tap blocks. The caller drives the transport (seek to
   * `startPpq - countInPpq`, then play) around this call.
   *
   * @throws RecorderStateError When disposed, already recording, the
   *   microphone is missing, or no track is armed.
   */
  start(options: StartRecordingOptions): void;
  /**
   * Stops capturing, disarms the engine record path and assembles the take.
   *
   * @returns The recorded frames, or null when nothing usable was captured
   *   (for example when stopped during the count-in).
   * @throws RecorderStateError When no recording is in progress.
   */
  stop(): RecordingResult | null;
  /**
   * Releases everything: aborts an in-flight recording (discarding frames),
   * closes the tap, disconnects the monitor path and stops the microphone
   * tracks. Safe to call multiple times.
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

/** Reads the channel count from the stream's first audio track (default 2). */
function streamChannelCount(stream: MediaStream): number {
  const track = stream.getAudioTracks()[0];
  const channels = track?.getSettings?.().channelCount;
  return typeof channels === 'number' && channels >= 1 ? Math.floor(channels) : 2;
}

/** Registered name of the capture-tap AudioWorklet processor. */
const TAP_PROCESSOR_NAME = 'sonare-studio-capture-tap';

/**
 * Inline AudioWorklet module for the capture tap: forwards every input block
 * to the main thread as transferred copies and writes no output (the node's
 * output stays silent).
 */
const TAP_PROCESSOR_SOURCE = `
registerProcessor('${TAP_PROCESSOR_NAME}', class extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const channels = input.map((channel) => channel.slice(0));
      this.port.postMessage(channels, channels.map((channel) => channel.buffer));
    }
    return true;
  }
});
`;

/** Contexts that already loaded the tap processor module. */
const tapModuleContexts = new WeakSet<BaseAudioContext>();

/**
 * Default capture tap: an AudioWorkletNode fed by the microphone source,
 * kept pulled by the rendering graph through a zero-gain stage so it never
 * becomes audible. The module is loaded from a same-origin blob URL (COEP
 * compatible).
 */
async function createWorkletTap(
  ctx: AudioContext,
  source: AudioNode,
  channelCount: number,
  onBlock: (channels: ReadonlyArray<Float32Array>) => void,
): Promise<CaptureTap> {
  if (typeof AudioWorkletNode !== 'function' || !ctx.audioWorklet) {
    throw new NotSupportedError('Microphone capture requires AudioWorklet support');
  }
  if (!tapModuleContexts.has(ctx)) {
    const url = URL.createObjectURL(
      new Blob([TAP_PROCESSOR_SOURCE], { type: 'application/javascript' }),
    );
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    tapModuleContexts.add(ctx);
  }
  const node = new AudioWorkletNode(ctx, TAP_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount,
    channelCountMode: 'explicit',
  });
  node.port.onmessage = (event: MessageEvent): void => {
    onBlock(event.data as Float32Array[]);
  };
  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(node);
  node.connect(silent);
  silent.connect(ctx.destination);
  return {
    close(): void {
      node.port.onmessage = null;
      try {
        source.disconnect(node);
      } catch {
        // The source may already be torn down; disconnecting is best-effort.
      }
      node.disconnect();
      silent.disconnect();
    },
  };
}

/** Mutable state of one in-flight take. */
interface ActiveCapture {
  trackId: number;
  startPpq: number;
  /** Frames to drop at the head (count-in span + record-latency offset). */
  skipFrames: number;
  /** Hard cap on kept frames (max take duration). */
  maxFrames: number;
  /** Total frames seen since start (kept or dropped). */
  receivedFrames: number;
  /** Channel count, fixed by the first kept block (0 until then). */
  channelCount: number;
  /** Kept block slices, per block one buffer per channel. */
  blocks: Float32Array[][];
  /** Total kept frames across blocks. */
  keptFrames: number;
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
  let disposed = false;
  let binding: MicrophoneBinding | null = null;
  let tap: CaptureTap | null = null;
  let micPromise: Promise<void> | null = null;
  let monitorNode: GainNode | null = null;
  let monitorConnected = false;
  let monitorOn = false;
  let monitorGainValue = 1;
  let armedTrack: number | null = null;
  let capture: ActiveCapture | null = null;
  const levelListeners = new Set<(peak: number) => void>();
  let levelPeak = 0;
  let lastLevelEmit = 0;

  /** Computes and (throttled) publishes the block peak to level listeners. */
  const emitLevel = (block: ReadonlyArray<Float32Array>): void => {
    if (levelListeners.size === 0) return;
    let peak = 0;
    for (const channel of block) {
      for (let i = 0; i < channel.length; i++) {
        const value = Math.abs(channel[i]);
        if (value > peak) peak = value;
      }
    }
    if (peak > levelPeak) levelPeak = peak;
    const now = Date.now();
    if (now - lastLevelEmit < levelIntervalMs) return;
    lastLevelEmit = now;
    const emitted = levelPeak;
    levelPeak = 0;
    for (const listener of levelListeners) listener(emitted);
  };

  /** Consumes one tap block: level metering plus take assembly when recording. */
  const handleBlock = (block: ReadonlyArray<Float32Array>): void => {
    if (block.length === 0 || block[0].length === 0) return;
    emitLevel(block);
    const active = capture;
    if (!active) return;
    const frames = block[0].length;
    const blockStart = active.receivedFrames;
    active.receivedFrames += frames;
    if (active.keptFrames >= active.maxFrames) return;
    const offset = Math.max(0, active.skipFrames - blockStart);
    if (offset >= frames) return;
    if (active.channelCount === 0) active.channelCount = block.length;
    const keep = Math.min(frames - offset, active.maxFrames - active.keptFrames);
    const kept: Float32Array[] = [];
    for (let c = 0; c < active.channelCount; c++) {
      // A mid-take channel-count drop repeats the last available channel.
      const channel = block[Math.min(c, block.length - 1)];
      kept.push(channel.subarray(offset, offset + keep));
    }
    active.blocks.push(kept);
    active.keptFrames += keep;
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
    let boundTap: CaptureTap;
    try {
      if (disposed) throw new RecorderStateError('Recorder has been disposed');
      const createTap = options.createTap ?? createWorkletTap;
      boundTap = await createTap(handle.ctx, bound.source, streamChannelCount(stream), handleBlock);
    } catch (err) {
      bound.close();
      throw err;
    }
    if (disposed) {
      boundTap.close();
      bound.close();
      throw new RecorderStateError('Recorder has been disposed');
    }
    binding = bound;
    tap = boundTap;
    monitorNode = handle.ctx.createGain();
    monitorNode.gain.value = monitorOn ? monitorGainValue : 0;
    bound.source.connect(monitorNode);
    if (monitorOn) {
      monitorNode.connect(handle.ctx.destination);
      monitorConnected = true;
    }
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
    if (!monitorNode) return;
    monitorNode.gain.value = enabled ? monitorGainValue : 0;
    if (enabled && !monitorConnected) {
      monitorNode.connect(handle.ctx.destination);
      monitorConnected = true;
    } else if (!enabled && monitorConnected) {
      monitorNode.disconnect();
      monitorConnected = false;
    }
  };

  const start = (startOptions: StartRecordingOptions): void => {
    if (disposed) throw new RecorderStateError('Recorder has been disposed');
    if (capture) throw new RecorderStateError('Recording is already in progress');
    if (!binding || !tap) {
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
    const countInPpq = startOptions.countInPpq ?? 0;
    if (!Number.isFinite(countInPpq) || countInPpq < 0) {
      throw new RangeError(`Recording countInPpq must be finite and >= 0, got ${countInPpq}`);
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
    // Engine-side record path: arm capture and set the punch window. The
    // punch-out is the max-duration bound; stop() disarms earlier as needed.
    handle.engine.armRecord(engineTrackId(armedTrack), true);
    handle.engine.punch(startPpq, startPpq + (maxDurationSeconds * tempoBpm) / 60);
    capture = {
      trackId: armedTrack,
      startPpq,
      skipFrames:
        Math.round(ppqToSeconds(countInPpq, tempoBpm) * sampleRate) + Math.round(offsetSamples),
      maxFrames: Math.max(1, Math.round(maxDurationSeconds * sampleRate)),
      receivedFrames: 0,
      channelCount: 0,
      blocks: [],
      keptFrames: 0,
    };
  };

  const stop = (): RecordingResult | null => {
    const active = capture;
    if (!active) throw new RecorderStateError('No recording in progress');
    capture = null;
    handle.engine.armRecord(engineTrackId(active.trackId), false);
    if (active.keptFrames === 0 || active.channelCount === 0) return null;
    const channels: Float32Array[] = [];
    for (let c = 0; c < active.channelCount; c++) {
      const out = new Float32Array(active.keptFrames);
      let cursor = 0;
      for (const block of active.blocks) {
        out.set(block[c], cursor);
        cursor += block[c].length;
      }
      channels.push(out);
    }
    return { channels, sampleRate: handle.ctx.sampleRate, startPpq: active.startPpq };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (capture) {
      const active = capture;
      capture = null;
      handle.engine.armRecord(engineTrackId(active.trackId), false);
    }
    tap?.close();
    tap = null;
    if (monitorNode && monitorConnected) monitorNode.disconnect();
    monitorNode = null;
    monitorConnected = false;
    binding?.close();
    binding = null;
    micPromise = null;
    levelListeners.clear();
  };

  return {
    requestMicrophone,
    hasMicrophone: () => binding !== null,
    arm(trackId: number): void {
      if (capture) throw new RecorderStateError('Cannot change the armed track while recording');
      armedTrack = trackId;
    },
    disarm(): void {
      if (capture) throw new RecorderStateError('Cannot disarm while recording');
      armedTrack = null;
    },
    armedTrackId: () => armedTrack,
    isRecording: () => capture !== null,
    setMonitor,
    monitorEnabled: () => monitorOn,
    onLevel(listener: (peak: number) => void): () => void {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
    start,
    stop,
    dispose,
  };
}
