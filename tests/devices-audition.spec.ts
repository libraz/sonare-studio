import { describe, expect, it, vi } from 'vitest';
import type { TrackInstrument } from '@/project/instrument';
import {
  createPatchAudition,
  DEFAULT_AUDITION_NOTE,
  DEFAULT_AUDITION_VELOCITY,
} from '@/ui/devices/audition';
import { asAudioContext, createFakeAudioContext } from './fake-audio-context';

const INSTRUMENT: TrackInstrument = { kind: 'synth-patch', patch: { preset: 'saw-lead' } };

/** Builds an audition wired to a fake context and a deterministic renderer. */
function setup(channels?: Float32Array[]) {
  const context = createFakeAudioContext();
  const factory = vi.fn(() => asAudioContext(context));
  const render = vi.fn(
    async () => channels ?? [new Float32Array([0.25, -0.25]), new Float32Array([0.25, -0.25])],
  );
  const audition = createPatchAudition({ contextFactory: factory, render, sampleRate: 44100 });
  return { context, factory, render, audition };
}

describe('createPatchAudition', () => {
  it('allocates nothing until the first play call', () => {
    const { factory, render } = setup();
    expect(factory).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('renders a single default note through the instrument and plays it', async () => {
    const { context, render, audition } = setup();
    await audition.play(INSTRUMENT);
    expect(render).toHaveBeenCalledTimes(1);
    const [notes, options] = render.mock.calls[0] as unknown as [
      Array<{ note: number; velocity: number; startPpq: number; durationPpq: number }>,
      { sampleRate: number; instrument?: TrackInstrument },
    ];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      note: DEFAULT_AUDITION_NOTE,
      velocity: DEFAULT_AUDITION_VELOCITY,
      startPpq: 0,
    });
    expect(options).toMatchObject({ sampleRate: 44100, instrument: INSTRUMENT });
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].started).toBe(true);
    expect(context.sources[0].buffer?.sampleRate).toBe(44100);
  });

  it('normalizes the playback peak without mutating the cached render', async () => {
    const cached = [new Float32Array([0.25, -0.25]), new Float32Array([0.25, -0.25])];
    const { context, audition } = setup(cached);
    await audition.play(INSTRUMENT);
    // Peak 0.25 normalized to the 0.5 default target => gain 2.
    expect(context.sources[0].buffer?.channelData[0][0]).toBeCloseTo(0.5);
    expect(cached[0][0]).toBeCloseTo(0.25);
  });

  it('preserves the rendered peak when normalization is disabled', async () => {
    const { context, audition } = setup([new Float32Array([0.25, -0.25])]);
    await audition.play(INSTRUMENT, undefined, undefined, { normalize: false });
    expect(context.sources[0].buffer?.channelData[0][0]).toBeCloseTo(0.25);
  });

  it('plays a custom pitch when given', async () => {
    const { render, audition } = setup();
    await audition.play(INSTRUMENT, 72, 64);
    const [notes] = render.mock.calls[0] as unknown as [Array<{ note: number; velocity: number }>];
    expect(notes[0]).toMatchObject({ note: 72, velocity: 64 });
  });

  it('ignores empty renders', async () => {
    const { context, audition } = setup([new Float32Array(0), new Float32Array(0)]);
    await audition.play(INSTRUMENT);
    expect(context.sources).toHaveLength(0);
  });

  it('dispose closes the lazily created context', async () => {
    const { context, audition } = setup();
    await audition.play(INSTRUMENT);
    audition.dispose();
    expect(context.closed).toBe(true);
  });

  it('ignores a stale render that resolves after a newer audition', async () => {
    const context = createFakeAudioContext();
    const renders: Array<(channels: Float32Array[]) => void> = [];
    const render = vi.fn(
      () =>
        new Promise<Float32Array[]>((resolve) => {
          renders.push(resolve);
        }),
    );
    const audition = createPatchAudition({
      contextFactory: () => asAudioContext(context),
      render,
      sampleRate: 44100,
    });

    const first = audition.play(INSTRUMENT, 60);
    const second = audition.play(INSTRUMENT, 72);
    renders[1]([new Float32Array([0.5])]);
    await second;
    renders[0]([new Float32Array([0.25])]);
    await first;

    expect(context.sources).toHaveLength(1);
    expect(render.mock.calls.map(([notes]) => notes[0].note)).toEqual([60, 72]);
  });

  it('does not play a render that resolves after dispose', async () => {
    const context = createFakeAudioContext();
    let resolveRender!: (channels: Float32Array[]) => void;
    const render = vi.fn(
      () =>
        new Promise<Float32Array[]>((resolve) => {
          resolveRender = resolve;
        }),
    );
    const audition = createPatchAudition({
      contextFactory: () => asAudioContext(context),
      render,
      sampleRate: 44100,
    });

    const pending = audition.play(INSTRUMENT);
    audition.dispose();
    resolveRender([new Float32Array([0.5])]);
    await pending;

    expect(context.sources).toHaveLength(0);
  });
});
