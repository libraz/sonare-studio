import { clamp } from '@/lib/math';
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

/** Result of monitor-only loudness matching between two preview variants. */
export interface PreviewLevelMatch {
  /** True when both integrated-LUFS measurements can be compared. */
  available: boolean;
  /** Monitor attenuation applied to the processed variant, in dB. */
  processedGainDb: number;
  /** Monitor attenuation applied to the bypassed variant, in dB. */
  bypassedGainDb: number;
}

/**
 * Computes monitor attenuation for a processed/bypassed A/B preview pair.
 *
 * The quieter valid render is the reference. Only the louder render is
 * attenuated, and the returned dB values are intended for one common gain
 * node so the stereo image is preserved. Missing, infinite or otherwise
 * unusable LUFS measurements deliberately fall back to unity.
 */
export function calculatePreviewLevelMatch(
  processedLufs: number | undefined,
  bypassedLufs: number | undefined,
): PreviewLevelMatch {
  if (!Number.isFinite(processedLufs) || !Number.isFinite(bypassedLufs)) {
    return { available: false, processedGainDb: 0, bypassedGainDb: 0 };
  }
  const processed = processedLufs as number;
  const bypassed = bypassedLufs as number;
  if (processed > bypassed) {
    return { available: true, processedGainDb: bypassed - processed, bypassedGainDb: 0 };
  }
  if (bypassed > processed) {
    return { available: true, processedGainDb: 0, bypassedGainDb: processed - bypassed };
  }
  return { available: true, processedGainDb: 0, bypassedGainDb: 0 };
}

/** Audio fed to {@link AudioPreview.play}; treat the channels as immutable. */
export interface PreviewSource {
  /** Planar channel buffers of equal length (>= 1 channel). */
  channels: ReadonlyArray<Float32Array>;
  /** Sample rate of the buffers in Hz (> 0). */
  sampleRate: number;
}

function validPreviewSource(source: PreviewSource): boolean {
  const frames = source.channels[0]?.length ?? 0;
  return source.channels.length > 0 && frames > 0 && source.sampleRate > 0;
}

/** Copies planar channels into a new AudioBuffer so wasm- or SharedArrayBuffer-backed input is accepted. */
function copyPreviewBuffer(context: AudioContext, source: PreviewSource): AudioBuffer {
  const frames = source.channels[0]?.length ?? 0;
  const buffer = context.createBuffer(source.channels.length, frames, source.sampleRate);
  for (let c = 0; c < source.channels.length; c++) {
    buffer.copyToChannel(new Float32Array(source.channels[c]), c);
  }
  return buffer;
}

/** Context clock in seconds, 0 when the host reports a non-finite time. */
function audioTime(ctx: AudioContext): number {
  const value = ctx.currentTime;
  return Number.isFinite(value) ? value : 0;
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
  /** Current playback position in seconds, or zero when stopped. */
  position(): number;
  /** Stops any current playback and starts the given source at an optional offset. */
  play(id: string, source: PreviewSource, offsetSeconds?: number): void;
  /** Seeks the current preview to an offset in seconds without changing its id. */
  seek(positionSeconds: number): void;
  /** Sets the monitor output gain (linear); does not alter the source audio. */
  setGain(gain: number): void;
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
  let gainValue = options.gain ?? DEFAULT_PREVIEW_GAIN;
  let context: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let current: {
    id: string;
    node: AudioBufferSourceNode;
    buffer: AudioBuffer;
    duration: number;
    offsetSeconds: number;
    startedAt: number;
  } | null = null;
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

  function position(): number {
    const entry = current;
    if (!entry || !context) return 0;
    const elapsed = Math.max(0, audioTime(context) - entry.startedAt);
    return Math.min(entry.duration, entry.offsetSeconds + elapsed);
  }

  function createSource(
    id: string,
    buffer: AudioBuffer,
    offsetSeconds: number,
    notify: boolean,
  ): void {
    const ctx = ensureContext();
    const duration = buffer.length / buffer.sampleRate;
    const offset = clamp(offsetSeconds, 0, duration);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    if (gainNode) node.connect(gainNode);
    const entry = {
      id,
      node,
      buffer,
      duration,
      offsetSeconds: offset,
      startedAt: audioTime(ctx),
    };
    current = entry;
    node.onended = () => {
      if (current === entry) {
        current = null;
        options.onChange?.(null);
      }
    };
    if (ctx.state === 'suspended') void ctx.resume();
    node.start(0, offset);
    if (notify) options.onChange?.(id);
  }

  function play(id: string, source: PreviewSource, offsetSeconds = 0): void {
    if (disposed) return;
    if (!validPreviewSource(source)) return;
    const ctx = ensureContext();
    stopSilently();
    createSource(id, copyPreviewBuffer(ctx, source), offsetSeconds, true);
  }

  function seek(positionSeconds: number): void {
    const entry = current;
    if (!entry || !Number.isFinite(positionSeconds)) return;
    const nextPosition = clamp(positionSeconds, 0, entry.duration);
    stopSilently();
    createSource(entry.id, entry.buffer, nextPosition, false);
  }

  function setGain(gain: number): void {
    if (!Number.isFinite(gain) || gain < 0) return;
    gainValue = gain;
    if (gainNode) gainNode.gain.value = gain;
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
    position,
    play,
    seek,
    setGain,
    stop,
    dispose,
  };
}

/** The two variants used by a mastering A/B monitor. */
export type PreviewVariant = 'processed' | 'bypassed';

/** Source buffers kept in sync by {@link createABAudioPreview}. */
export interface ABPreviewSources {
  processed: PreviewSource;
  bypassed: PreviewSource;
}

/** Absolute monitor gains for the two A/B variants (linear). */
export interface ABPreviewGains {
  processed: number;
  bypassed: number;
}

/** Options for the synchronized mastering A/B monitor. */
export interface ABAudioPreviewOptions {
  /** AudioContext factory; defaults to `() => new AudioContext()`. */
  contextFactory?: PreviewContextFactory;
  /** Initial gain used for each variant before the first level-match update. */
  gain?: number;
  /** Crossfade duration in seconds; defaults to a short clickless ramp. */
  rampSeconds?: number;
  /** Notified when the synchronized pair starts or stops. */
  onChange?: (playingId: string | null) => void;
}

/** Synchronized, dual-source monitor used by the mastering A/B preview. */
export interface ABAudioPreview {
  /** Id passed to the active `play()` call, or null when stopped. */
  playingId(): string | null;
  /** Selected monitor variant. */
  variant(): PreviewVariant;
  /** Current synchronized playback position in seconds, or zero when stopped. */
  position(): number;
  /** Starts both variants at one audio time and opens the selected side. */
  play(
    id: string,
    sources: ABPreviewSources,
    variant: PreviewVariant,
    gains: ABPreviewGains,
    offsetSeconds?: number,
  ): void;
  /** Crossfades to the other already-running source without restarting it. */
  selectVariant(variant: PreviewVariant): void;
  /** Updates both monitor targets and ramps the currently selected output. */
  setGains(gains: ABPreviewGains): void;
  /** Stops both sources (no-op when nothing is playing). */
  stop(): void;
  /** Stops playback and closes the AudioContext. */
  dispose(): void;
}

/** Default short A/B crossfade, long enough to avoid a hard discontinuity. */
export const DEFAULT_AB_PREVIEW_RAMP_SECONDS = 0.015;

/** Lead time before an A/B start so both gain envelopes are scheduled ahead of the sources. */
const AB_PREVIEW_START_LEAD_SECONDS = 0.01;

/** Schedules a short linear gain ramp where the host exposes AudioParam timing. */
function schedulePreviewGain(node: GainNode, target: number, now: number, duration: number): void {
  const param = node.gain as AudioParam & { value: number };
  if (
    typeof param.setValueAtTime === 'function' &&
    typeof param.linearRampToValueAtTime === 'function'
  ) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      // Preserve the interpolated value when a second A/B switch lands in an
      // existing ramp. A read of `param.value` alone only exposes the last
      // committed value in several Web Audio implementations.
      param.cancelAndHoldAtTime(now);
    } else if (typeof param.cancelScheduledValues === 'function') {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
    } else {
      param.value = target;
      return;
    }
    param.linearRampToValueAtTime(target, now + duration);
  } else {
    param.value = target;
  }
}

/** Sets an initial gain at a common future source start time. */
function setPreviewGainAtStart(node: GainNode, target: number, when: number): void {
  const param = node.gain as AudioParam & { value: number };
  if (typeof param.setValueAtTime === 'function') {
    if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(when);
    param.setValueAtTime(target, when);
  } else {
    param.value = target;
  }
}

/**
 * Creates a mastering A/B monitor with both renders running in lockstep.
 * Switching variants only ramps their separate gain nodes, so the source
 * position and phase relationship never jump. This is intentionally separate
 * from the generic one-source media preview API.
 */
export function createABAudioPreview(options: ABAudioPreviewOptions = {}): ABAudioPreview {
  const factory = options.contextFactory ?? (() => new AudioContext());
  const rampSeconds =
    Number.isFinite(options.rampSeconds) && (options.rampSeconds ?? 0) >= 0
      ? (options.rampSeconds as number)
      : DEFAULT_AB_PREVIEW_RAMP_SECONDS;
  let gainTargets: ABPreviewGains = {
    processed: options.gain ?? DEFAULT_PREVIEW_GAIN,
    bypassed: options.gain ?? DEFAULT_PREVIEW_GAIN,
  };
  let context: AudioContext | null = null;
  let gainNodes: Record<PreviewVariant, GainNode> | null = null;
  let current: {
    id: string;
    variant: PreviewVariant;
    sources: Record<PreviewVariant, AudioBufferSourceNode>;
    durations: Record<PreviewVariant, number>;
    offsetSeconds: number;
    startedAt: number;
  } | null = null;
  let selectedVariant: PreviewVariant = 'processed';
  let disposed = false;

  function ensureContext(): AudioContext {
    if (!context) {
      context = factory();
      gainNodes = {
        processed: context.createGain(),
        bypassed: context.createGain(),
      };
      gainNodes.processed.gain.value = gainTargets.processed;
      gainNodes.bypassed.gain.value = 0;
      gainNodes.processed.connect(context.destination);
      gainNodes.bypassed.connect(context.destination);
    }
    return context;
  }

  function selectedTarget(variant: PreviewVariant): number {
    return variant === selectedVariant ? gainTargets[variant] : 0;
  }

  function stopSilently(): void {
    const entry = current;
    if (!entry) return;
    current = null;
    for (const variant of ['processed', 'bypassed'] as const) {
      const node = entry.sources[variant];
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Already stopped or never started; nothing to do.
      }
      node.disconnect();
    }
  }

  function stop(): void {
    if (!current) return;
    stopSilently();
    options.onChange?.(null);
  }

  function position(): number {
    if (!current || !context) return 0;
    const elapsed = Math.max(0, audioTime(context) - current.startedAt);
    const duration = Math.max(current.durations.processed, current.durations.bypassed);
    return Math.min(duration, current.offsetSeconds + elapsed);
  }

  function play(
    id: string,
    sources: ABPreviewSources,
    variant: PreviewVariant,
    gains: ABPreviewGains,
    offsetSeconds = 0,
  ): void {
    if (
      disposed ||
      !validPreviewSource(sources.processed) ||
      !validPreviewSource(sources.bypassed)
    ) {
      return;
    }
    const ctx = ensureContext();
    stopSilently();
    gainTargets = { ...gains };
    selectedVariant = variant;
    const buffers = {
      processed: copyPreviewBuffer(ctx, sources.processed),
      bypassed: copyPreviewBuffer(ctx, sources.bypassed),
    };
    const durations = {
      processed: buffers.processed.length / buffers.processed.sampleRate,
      bypassed: buffers.bypassed.length / buffers.bypassed.sampleRate,
    };
    const offset = Math.max(
      0,
      Math.min(offsetSeconds, Math.max(durations.processed, durations.bypassed)),
    );
    const now = audioTime(ctx);
    const when = now + AB_PREVIEW_START_LEAD_SECONDS;
    const nodes = {
      processed: ctx.createBufferSource(),
      bypassed: ctx.createBufferSource(),
    };
    nodes.processed.buffer = buffers.processed;
    nodes.bypassed.buffer = buffers.bypassed;
    nodes.processed.connect(gainNodes!.processed);
    nodes.bypassed.connect(gainNodes!.bypassed);
    setPreviewGainAtStart(gainNodes!.processed, selectedTarget('processed'), when);
    setPreviewGainAtStart(gainNodes!.bypassed, selectedTarget('bypassed'), when);
    const entry = {
      id,
      variant,
      sources: nodes,
      durations,
      offsetSeconds: offset,
      startedAt: when,
    };
    current = entry;
    for (const source of Object.values(nodes)) {
      source.onended = () => {
        if (current !== entry) return;
        // The selected source owns the audible end of the preview. The other
        // source may be shorter, but ending it must not cut off the selected
        // variant while it is still sounding.
        if (source === entry.sources[entry.variant]) {
          stopSilently();
          options.onChange?.(null);
        }
      };
    }
    if (ctx.state === 'suspended') void ctx.resume();
    nodes.processed.start(when, offset);
    nodes.bypassed.start(when, offset);
    options.onChange?.(id);
  }

  function selectVariant(next: PreviewVariant): void {
    selectedVariant = next;
    const ctx = context;
    const nodes = gainNodes;
    if (!current || !ctx || !nodes || current.variant === next) {
      if (current) current.variant = next;
      return;
    }
    current.variant = next;
    const now = audioTime(ctx);
    schedulePreviewGain(nodes.processed, selectedTarget('processed'), now, rampSeconds);
    schedulePreviewGain(nodes.bypassed, selectedTarget('bypassed'), now, rampSeconds);
  }

  function setGains(next: ABPreviewGains): void {
    gainTargets = { ...next };
    if (!current || !context || !gainNodes) return;
    const now = audioTime(context);
    schedulePreviewGain(gainNodes.processed, selectedTarget('processed'), now, rampSeconds);
    schedulePreviewGain(gainNodes.bypassed, selectedTarget('bypassed'), now, rampSeconds);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stop();
    gainNodes?.processed.disconnect();
    gainNodes?.bypassed.disconnect();
    gainNodes = null;
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
    variant: () => selectedVariant,
    position,
    play,
    selectVariant,
    setGains,
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
