import type { EngineHandle } from '@/engine/engine.js';

/**
 * Web Audio analyser tap on the engine's master output.
 *
 * The realtime engine publishes meter telemetry (peak/RMS/LUFS/correlation)
 * but not spectrum or per-sample waveform data, so the master spectrum analyzer
 * and goniometer are fed from standard `AnalyserNode`s connected to the engine
 * output node instead. The bridge owns those nodes and pulls the latest frame
 * on demand (the UI drives reads from its own animation loop); it never copies
 * data until asked, so an unmounted display costs nothing.
 *
 * This covers the master bus only. Per-strip spectrum would require the engine
 * to expose internal strip outputs, which it does not yet do.
 */
export interface AnalyserBridge {
  /** Audio sample rate in Hz. */
  readonly sampleRate: number;
  /** FFT window length used for the spectrum analyser. */
  readonly fftSize: number;
  /** Number of frequency bins (`fftSize / 2`). */
  readonly frequencyBinCount: number;
  /** Number of time-domain samples a scope read returns. */
  readonly scopeSize: number;
  /** True when the underlying AudioContext provides analyser nodes. */
  readonly available: boolean;
  /**
   * Fills `out` with the master spectrum magnitudes in dBFS (one per bin).
   *
   * @param out Destination of length >= {@link frequencyBinCount}.
   * @returns True when data was written; false on an unavailable bridge.
   */
  readSpectrum(out: Float32Array): boolean;
  /**
   * Fills `left`/`right` with the master output's most recent time-domain
   * samples (range roughly [-1, 1]) for the goniometer.
   *
   * @param left Left-channel destination of length >= {@link scopeSize}.
   * @param right Right-channel destination of length >= {@link scopeSize}.
   * @returns True when data was written; false on an unavailable bridge.
   */
  readScope(left: Float32Array, right: Float32Array): boolean;
  /** Disconnects the analyser nodes from the engine output. Idempotent. */
  dispose(): void;
}

/** Options for {@link createAnalyserBridge}. */
export interface AnalyserBridgeOptions {
  /** Spectrum FFT window length (power of two, 32..32768). Default 4096. */
  fftSize?: number;
  /** Time-domain window length for the goniometer scope. Default 2048. */
  scopeSize?: number;
  /** Spectrum temporal smoothing in [0, 1]. Default 0.6. */
  smoothing?: number;
}

/** A no-op bridge used where the AudioContext has no analyser support. */
function unavailableBridge(sampleRate: number, fftSize: number, scopeSize: number): AnalyserBridge {
  return {
    sampleRate,
    fftSize,
    frequencyBinCount: fftSize / 2,
    scopeSize,
    available: false,
    readSpectrum: () => false,
    readScope: () => false,
    dispose: () => undefined,
  };
}

/**
 * Creates a master-output analyser bridge for a running engine.
 *
 * Taps {@link EngineHandle.engine}'s output node with one frequency-domain
 * analyser (spectrum) and a channel splitter feeding two time-domain analysers
 * (left/right goniometer). The taps fan out from the output node and do not
 * connect onward, so they observe the signal without altering the audible path.
 *
 * @param handle The engine handle returned by `createEngine`.
 * @param options Optional FFT/scope sizing and smoothing overrides.
 * @returns A bridge exposing spectrum/scope reads plus dispose. When the
 *   context cannot create analyser nodes, an unavailable no-op bridge.
 */
export function createAnalyserBridge(
  handle: EngineHandle,
  options: AnalyserBridgeOptions = {},
): AnalyserBridge {
  const { ctx } = handle;
  const node = handle.engine.node;
  const fftSize = options.fftSize ?? 4096;
  const scopeSize = options.scopeSize ?? 2048;

  if (typeof ctx.createAnalyser !== 'function' || typeof ctx.createChannelSplitter !== 'function') {
    return unavailableBridge(ctx.sampleRate, fftSize, scopeSize);
  }

  const spectrum = ctx.createAnalyser();
  spectrum.fftSize = fftSize;
  spectrum.smoothingTimeConstant = options.smoothing ?? 0.6;
  spectrum.minDecibels = -100;
  spectrum.maxDecibels = 0;
  node.connect(spectrum);

  // A goniometer needs the L/R channels separately; AnalyserNode otherwise
  // downmixes its inputs to mono before analysis.
  const splitter = ctx.createChannelSplitter(2);
  const scopeL = ctx.createAnalyser();
  const scopeR = ctx.createAnalyser();
  scopeL.fftSize = scopeSize;
  scopeR.fftSize = scopeSize;
  scopeL.smoothingTimeConstant = 0;
  scopeR.smoothingTimeConstant = 0;
  node.connect(splitter);
  splitter.connect(scopeL, 0);
  splitter.connect(scopeR, 1);

  let disposed = false;

  return {
    sampleRate: ctx.sampleRate,
    fftSize,
    frequencyBinCount: spectrum.frequencyBinCount,
    scopeSize,
    available: true,
    readSpectrum(out: Float32Array): boolean {
      if (disposed) return false;
      // The DOM signature narrows to a non-shared backing buffer; our callers
      // always pass plain (non-shared) arrays.
      spectrum.getFloatFrequencyData(out as Float32Array<ArrayBuffer>);
      return true;
    },
    readScope(left: Float32Array, right: Float32Array): boolean {
      if (disposed) return false;
      scopeL.getFloatTimeDomainData(left as Float32Array<ArrayBuffer>);
      scopeR.getFloatTimeDomainData(right as Float32Array<ArrayBuffer>);
      return true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      node.disconnect(spectrum);
      node.disconnect(splitter);
      splitter.disconnect();
      spectrum.disconnect();
      scopeL.disconnect();
      scopeR.disconnect();
    },
  };
}
