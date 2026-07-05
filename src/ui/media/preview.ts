/**
 * Decode-free audio preview for the media browser: plays stored planar
 * channel buffers through a plain AudioBufferSourceNode on a lazily-created
 * AudioContext that is fully independent of the engine (previewing never
 * requires "Start engine" and never touches the transport).
 *
 * The AudioContext is created through an injectable factory so tests (and
 * non-browser environments) can substitute a stub; nothing here runs until
 * the first `play()` call.
 */

/** Default preview output gain (linear). */
export const DEFAULT_PREVIEW_GAIN = 0.8;

/** Audio fed to {@link AudioPreview.play}; treat the channels as immutable. */
export interface PreviewSource {
  /** Planar channel buffers of equal length (>= 1 channel). */
  channels: ReadonlyArray<Float32Array>;
  /** Sample rate of the buffers in Hz (> 0). */
  sampleRate: number;
}

/** Creates the AudioContext used for preview playback (called lazily once). */
export type PreviewContextFactory = () => AudioContext;

/** Options for {@link createAudioPreview}. */
export interface AudioPreviewOptions {
  /** AudioContext factory; defaults to `() => new AudioContext()`. */
  contextFactory?: PreviewContextFactory;
  /** Output gain (linear); defaults to {@link DEFAULT_PREVIEW_GAIN}. */
  gain?: number;
  /** Notified whenever the playing asset changes (null = stopped). */
  onChange?: (playingId: string | null) => void;
}

/** One-at-a-time preview player. */
export interface AudioPreview {
  /** Id passed to the most recent `play()` still sounding, or null. */
  playingId(): string | null;
  /** Stops any current playback and starts the given source. */
  play(id: string, source: PreviewSource): void;
  /** Stops playback (no-op when nothing is playing). */
  stop(): void;
  /** Stops playback and closes the AudioContext (if one was created). */
  dispose(): void;
}

/**
 * Creates a preview player. The AudioContext (and its single gain node) is
 * created by `options.contextFactory` on the first `play()` call only.
 *
 * @param options - Context factory, gain and change-callback overrides.
 * @returns The preview player.
 */
export function createAudioPreview(options: AudioPreviewOptions = {}): AudioPreview {
  const factory = options.contextFactory ?? (() => new AudioContext());
  const gainValue = options.gain ?? DEFAULT_PREVIEW_GAIN;
  let context: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let current: { id: string; node: AudioBufferSourceNode } | null = null;
  let disposed = false;

  function ensureContext(): AudioContext {
    if (!context) {
      context = factory();
      gainNode = context.createGain();
      gainNode.gain.value = gainValue;
      gainNode.connect(context.destination);
    }
    return context;
  }

  /** Stops the active source without emitting a change notification. */
  function stopSilently(): void {
    if (!current) return;
    const { node } = current;
    current = null;
    node.onended = null;
    try {
      node.stop();
    } catch {
      // Already stopped or never started; nothing to do.
    }
    node.disconnect();
  }

  function stop(): void {
    if (!current) return;
    stopSilently();
    options.onChange?.(null);
  }

  function play(id: string, source: PreviewSource): void {
    if (disposed) return;
    const frames = source.channels[0]?.length ?? 0;
    if (source.channels.length === 0 || frames === 0 || !(source.sampleRate > 0)) return;
    const ctx = ensureContext();
    stopSilently();
    const buffer = ctx.createBuffer(source.channels.length, frames, source.sampleRate);
    for (let c = 0; c < source.channels.length; c++) {
      // Copy so wasm- or SharedArrayBuffer-backed channels are accepted.
      buffer.copyToChannel(new Float32Array(source.channels[c]), c);
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    if (gainNode) node.connect(gainNode);
    const entry = { id, node };
    current = entry;
    node.onended = () => {
      if (current === entry) {
        current = null;
        options.onChange?.(null);
      }
    };
    if (ctx.state === 'suspended') void ctx.resume();
    node.start();
    options.onChange?.(id);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stop();
    gainNode?.disconnect();
    gainNode = null;
    if (context) {
      const closing = context;
      context = null;
      void closing.close().catch(() => {
        // Closing an already-closed context is harmless.
      });
    }
  }

  return {
    playingId: () => current?.id ?? null,
    play,
    stop,
    dispose,
  };
}

/** Shape of the optional one-shot libsonare time stretcher. */
export type TimeStretchFunction = (
  samples: Float32Array,
  sampleRate: number,
  rate: number,
) => Float32Array;

/** Stretch rates outside this range are rejected as not preview-worthy. */
export const MIN_PREVIEW_STRETCH_RATE = 0.25;
export const MAX_PREVIEW_STRETCH_RATE = 4;

/**
 * Computes the time-stretch rate that plays an asset tagged at `assetBpm`
 * back at `targetBpm` (rate > 1 shortens, < 1 lengthens — matching the
 * libsonare `timeStretch` rate convention).
 *
 * @param assetBpm - The asset's BPM tag.
 * @param targetBpm - The project tempo to match.
 * @returns The rate, or null when the inputs are unusable, the tempos are
 *   effectively equal, or the rate falls outside the supported range.
 */
export function previewStretchRate(assetBpm: number, targetBpm: number): number | null {
  if (!Number.isFinite(assetBpm) || assetBpm <= 0) return null;
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) return null;
  const rate = targetBpm / assetBpm;
  if (Math.abs(rate - 1) < 1e-3) return null;
  if (rate < MIN_PREVIEW_STRETCH_RATE || rate > MAX_PREVIEW_STRETCH_RATE) return null;
  return rate;
}

/**
 * Applies a one-shot time stretch to every channel. Channels are stretched
 * independently and trimmed to the shortest result so they stay equal-length.
 *
 * @param timeStretch - The stretch function (e.g. libsonare `timeStretch`).
 * @param channels - Planar channel buffers (not mutated).
 * @param sampleRate - Sample rate of the buffers in Hz.
 * @param rate - Stretch rate (> 1 shortens, < 1 lengthens).
 * @returns New stretched channel buffers.
 */
export function stretchChannels(
  timeStretch: TimeStretchFunction,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  rate: number,
): Float32Array[] {
  const stretched = channels.map((channel) => timeStretch(channel, sampleRate, rate));
  const minLength = stretched.reduce(
    (shortest, channel) => Math.min(shortest, channel.length),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(minLength)) return [];
  return stretched.map((channel) =>
    channel.length === minLength ? channel : channel.subarray(0, minLength),
  );
}
