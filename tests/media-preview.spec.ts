import { describe, expect, it, vi } from 'vitest';
import {
  createAudioPreview,
  DEFAULT_PREVIEW_GAIN,
  previewStretchRate,
  stretchChannels,
} from '@/ui/media/preview';
import { asAudioContext, createFakeAudioContext } from './fake-audio-context';

/** Creates a preview wired to a fresh fake context. */
function setup(options: { state?: AudioContextState; gain?: number } = {}) {
  const context = createFakeAudioContext({ state: options.state });
  const factory = vi.fn(() => asAudioContext(context));
  const changes: Array<string | null> = [];
  const preview = createAudioPreview({
    contextFactory: factory,
    ...(options.gain !== undefined ? { gain: options.gain } : {}),
    onChange: (id) => changes.push(id),
  });
  return { context, factory, changes, preview };
}

const source = (frames = 4, channels = 2, sampleRate = 48000) => ({
  channels: Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_v, i) => c + i * 0.1),
  ),
  sampleRate,
});

describe('createAudioPreview', () => {
  it('creates the AudioContext lazily on first play only', () => {
    const { factory, preview } = setup();
    expect(factory).not.toHaveBeenCalled();
    preview.play('a', source());
    preview.play('b', source());
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('plays through a gain node at the default preview gain', () => {
    const { context, preview } = setup();
    preview.play('a', source(4, 2, 44100));
    expect(context.gains).toHaveLength(1);
    expect(context.gains[0].gain.value).toBe(DEFAULT_PREVIEW_GAIN);
    expect(context.gains[0].connections).toEqual([context.destination]);
    const node = context.sources[0];
    expect(node.started).toBe(true);
    expect(node.connections).toEqual([context.gains[0]]);
    expect(node.buffer?.numberOfChannels).toBe(2);
    expect(node.buffer?.length).toBe(4);
    expect(node.buffer?.sampleRate).toBe(44100);
    expect(node.buffer?.channelData[1]).toEqual(Float32Array.from([1, 1.1, 1.2, 1.3]));
    expect(preview.playingId()).toBe('a');
  });

  it('notifies onChange on play, stop and natural end', () => {
    const { context, changes, preview } = setup();
    preview.play('a', source());
    preview.stop();
    preview.play('b', source());
    context.sources[1].onended?.();
    expect(changes).toEqual(['a', null, 'b', null]);
    expect(preview.playingId()).toBeNull();
  });

  it('stops the previous source when a new one starts', () => {
    const { context, changes, preview } = setup();
    preview.play('a', source());
    preview.play('b', source());
    expect(context.sources[0].stopped).toBe(true);
    expect(context.sources[0].onended).toBeNull();
    expect(changes).toEqual(['a', 'b']);
    expect(preview.playingId()).toBe('b');
  });

  it('ignores a stale onended after the next play started', () => {
    const { context, changes, preview } = setup();
    preview.play('a', source());
    preview.play('b', source());
    context.sources[0].onended?.();
    expect(changes).toEqual(['a', 'b']);
    expect(preview.playingId()).toBe('b');
  });

  it('resumes a suspended context before starting', () => {
    const { context, preview } = setup({ state: 'suspended' });
    preview.play('a', source());
    expect(context.resumeCount).toBe(1);
  });

  it('does nothing for empty or invalid sources', () => {
    const { factory, changes, preview } = setup();
    preview.play('a', { channels: [], sampleRate: 48000 });
    preview.play('b', { channels: [new Float32Array(0)], sampleRate: 48000 });
    preview.play('c', { channels: [new Float32Array(4)], sampleRate: 0 });
    expect(factory).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
    expect(preview.playingId()).toBeNull();
  });

  it('stop is a no-op when nothing is playing', () => {
    const { changes, preview } = setup();
    preview.stop();
    expect(changes).toEqual([]);
  });

  it('dispose stops playback, closes the context and disables play', () => {
    const { context, factory, changes, preview } = setup();
    preview.play('a', source());
    preview.dispose();
    expect(context.sources[0].stopped).toBe(true);
    expect(context.sources[0].onended).toBeNull();
    expect(context.gains[0].disconnected).toBe(true);
    expect(context.closed).toBe(true);
    expect(changes).toEqual(['a', null]);
    preview.play('b', source());
    expect(factory).toHaveBeenCalledTimes(1);
    expect(preview.playingId()).toBeNull();
  });

  it('dispose before any play never creates a context', () => {
    const { factory, preview } = setup();
    preview.dispose();
    expect(factory).not.toHaveBeenCalled();
  });

  it('honors a custom gain', () => {
    const { context, preview } = setup({ gain: 0.5 });
    preview.play('a', source());
    expect(context.gains[0].gain.value).toBe(0.5);
  });
});

describe('previewStretchRate', () => {
  it('returns the target/asset tempo ratio', () => {
    expect(previewStretchRate(120, 60)).toBe(0.5);
    expect(previewStretchRate(90, 180)).toBe(2);
  });

  it('returns null for effectively equal tempos', () => {
    expect(previewStretchRate(120, 120)).toBeNull();
    expect(previewStretchRate(120, 120.05)).toBeNull();
  });

  it('returns null for unusable inputs', () => {
    expect(previewStretchRate(0, 120)).toBeNull();
    expect(previewStretchRate(120, 0)).toBeNull();
    expect(previewStretchRate(Number.NaN, 120)).toBeNull();
    expect(previewStretchRate(120, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('returns null outside the supported rate range', () => {
    expect(previewStretchRate(400, 80)).toBeNull();
    expect(previewStretchRate(30, 150)).toBeNull();
  });
});

describe('stretchChannels', () => {
  it('stretches each channel and keeps them equal-length', () => {
    const stretch = vi.fn((samples: Float32Array, _sr: number, rate: number) => {
      // Fake stretcher: output length scales with 1/rate; second channel one
      // sample longer to exercise the trim.
      const length = Math.round(samples.length / rate) + (samples[0] === 1 ? 1 : 0);
      return new Float32Array(length);
    });
    const channels = [Float32Array.from([0, 0, 0, 0]), Float32Array.from([1, 1, 1, 1])];
    const out = stretchChannels(stretch, channels, 48000, 0.5);
    expect(stretch).toHaveBeenCalledTimes(2);
    expect(stretch).toHaveBeenCalledWith(channels[0], 48000, 0.5);
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(8);
    expect(out[1].length).toBe(8);
  });

  it('returns an empty array for no channels', () => {
    expect(stretchChannels(() => new Float32Array(0), [], 48000, 2)).toEqual([]);
  });
});
