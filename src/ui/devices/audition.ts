/**
 * One-note instrument audition for the device rack / patch editor.
 *
 * The note is prerendered through the shared offline instrument bounce (so
 * repeats hit the content-addressed cache) and played as a one-shot buffer on
 * a lazy AudioContext that is fully independent of the realtime engine: the
 * engine stays silent and the transport is never touched.
 */

import {
  type MidiNote,
  normalizeGain,
  peakAmplitude,
  prerenderMidiClip,
} from '@/engine/instruments';
import type { TrackInstrument } from '@/project/instrument';
import { createAudioPreview, type PreviewContextFactory } from '@/ui/media/preview';

/** Default audition pitch (middle C). */
export const DEFAULT_AUDITION_NOTE = 60;

/** Default audition velocity. */
export const DEFAULT_AUDITION_VELOCITY = 100;

/** Default audition note length in PPQ (a quarter note). */
export const DEFAULT_AUDITION_DURATION_PPQ = 1;

/** Peak the audition playback is normalized to (-6 dBFS). */
export const DEFAULT_AUDITION_TARGET_PEAK = 0.5;

/** Render sample rate when none is supplied. */
const DEFAULT_AUDITION_SAMPLE_RATE = 48000;

/** Renders an audition phrase to planar buffers (injectable for tests). */
export type AuditionRenderer = (
  notes: ReadonlyArray<MidiNote>,
  options: { sampleRate: number; instrument?: TrackInstrument },
) => Promise<Float32Array[]>;

/** Options for {@link createPatchAudition}. */
export interface PatchAuditionOptions {
  /** AudioContext factory; defaults to `() => new AudioContext()`. */
  contextFactory?: PreviewContextFactory;
  /** Phrase renderer; defaults to the shared prerenderMidiClip. */
  render?: AuditionRenderer;
  /** Render/playback sample rate (default 48000). */
  sampleRate?: number;
  /** Normalization peak (default 0.5 = -6 dBFS). */
  targetPeak?: number;
}

/** One-shot audition player. */
export interface PatchAudition {
  /** Renders and plays a single note through the instrument. */
  play(instrument: TrackInstrument, note?: number, velocity?: number): Promise<void>;
  /** Stops any sounding audition. */
  stop(): void;
  /** Stops and releases the AudioContext (if one was created). */
  dispose(): void;
}

/**
 * Creates an audition player. Nothing (including the AudioContext) is
 * allocated until the first `play()` call.
 *
 * @param options Renderer/context overrides for tests and custom hosts.
 * @returns The audition player.
 */
export function createPatchAudition(options: PatchAuditionOptions = {}): PatchAudition {
  const render = options.render ?? prerenderMidiClip;
  const sampleRate = options.sampleRate ?? DEFAULT_AUDITION_SAMPLE_RATE;
  const targetPeak = options.targetPeak ?? DEFAULT_AUDITION_TARGET_PEAK;
  const preview = createAudioPreview({
    gain: 1,
    ...(options.contextFactory ? { contextFactory: options.contextFactory } : {}),
  });

  async function play(
    instrument: TrackInstrument,
    note = DEFAULT_AUDITION_NOTE,
    velocity = DEFAULT_AUDITION_VELOCITY,
  ): Promise<void> {
    const phrase: MidiNote[] = [
      { note, velocity, startPpq: 0, durationPpq: DEFAULT_AUDITION_DURATION_PPQ },
    ];
    const channels = await render(phrase, { sampleRate, instrument });
    if (channels.length === 0 || channels[0].length === 0) return;
    const gain = normalizeGain(peakAmplitude(channels), targetPeak);
    // Scale a copy: the renderer's buffers are shared via the prerender cache.
    const scaled = channels.map((channel) => {
      const out = new Float32Array(channel.length);
      for (let i = 0; i < channel.length; i++) out[i] = channel[i] * gain;
      return out;
    });
    preview.play('patch-audition', { channels: scaled, sampleRate });
  }

  return {
    play,
    stop: () => preview.stop(),
    dispose: () => preview.dispose(),
  };
}
