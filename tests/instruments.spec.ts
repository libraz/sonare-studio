import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPrerenderCache,
  MAX_PRERENDER_CACHE_ENTRIES,
  type MidiNote,
  makeDemoNotes,
  midiClipCacheKey,
  normalizeGain,
  noteEventsFromNotes,
  peakAmplitude,
  prerenderMidiClip,
} from '@/engine/instruments';
import { DEFAULT_SYNTH_PRESET } from '@/project/instrument';

const wasmMock = vi.hoisted(() => {
  const bounce = vi.fn(() => ({
    channels: [new Float32Array([0.25, 0.5, 0.75]), new Float32Array([-0.25, -0.5, -0.75])],
    sampleRate: 48000,
  }));
  const destroySpy = vi.fn();

  class MockProject
    implements Partial<InstanceType<typeof import('@libraz/libsonare')['Project']>>
  {
    setSampleRate = vi.fn();
    setTempoSegments = vi.fn();
    addMidiClip = vi.fn(() => ({ trackId: 1, clipId: 2 }));
    setMidiEvents = vi.fn();
    bounce = bounce;
    destroy = destroySpy;
  }

  const midiNoteOn = vi.fn(
    (r: { ppq: number; channel: number; note: number; velocity: number }) => ({
      ppq: r.ppq,
      word0: (0x2 << 28) | (9 << 20) | (r.channel << 16) | (r.note << 8) | r.velocity,
    }),
  );
  const midiNoteOff = vi.fn(
    (r: { ppq: number; channel: number; note: number; velocity?: number }) => ({
      ppq: r.ppq,
      word0: (0x2 << 28) | (8 << 20) | (r.channel << 16) | (r.note << 8) | (r.velocity ?? 0),
    }),
  );

  return { bounce, destroySpy, midiNoteOn, midiNoteOff, MockProject };
});

vi.mock('@/lib/wasm', () => ({
  ensureWasm: vi.fn(async () => ({
    Project: wasmMock.MockProject,
    midiNoteOn: wasmMock.midiNoteOn,
    midiNoteOff: wasmMock.midiNoteOff,
  })),
}));

const NOTES: MidiNote[] = [
  { note: 60, velocity: 100, startPpq: 0, durationPpq: 1 },
  { note: 64, velocity: 90, startPpq: 1, durationPpq: 0.5 },
];

const OPTS = { sampleRate: 48000 };

beforeEach(() => {
  clearPrerenderCache();
  wasmMock.bounce.mockClear();
  wasmMock.destroySpy.mockClear();
  wasmMock.midiNoteOn.mockClear();
  wasmMock.midiNoteOff.mockClear();
});

describe('midiClipCacheKey', () => {
  it('is deterministic for identical input', () => {
    expect(midiClipCacheKey(NOTES, OPTS)).toBe(midiClipCacheKey(NOTES, OPTS));
  });

  it('is insensitive to note order', () => {
    const reversed = [...NOTES].reverse();
    expect(midiClipCacheKey(reversed, OPTS)).toBe(midiClipCacheKey(NOTES, OPTS));
  });

  it('treats an omitted channel as channel 0', () => {
    const explicit = NOTES.map((n) => ({ ...n, channel: 0 }));
    expect(midiClipCacheKey(explicit, OPTS)).toBe(midiClipCacheKey(NOTES, OPTS));
  });

  it('changes when sample rate, tempo, or preset changes', () => {
    const base = midiClipCacheKey(NOTES, OPTS);
    expect(midiClipCacheKey(NOTES, { sampleRate: 44100 })).not.toBe(base);
    expect(midiClipCacheKey(NOTES, { ...OPTS, tempoBpm: 90 })).not.toBe(base);
    expect(midiClipCacheKey(NOTES, { ...OPTS, preset: 'sawLead' })).not.toBe(base);
  });

  it('changes when any note field changes', () => {
    const base = midiClipCacheKey(NOTES, OPTS);
    for (const patch of [
      { note: 61 },
      { velocity: 101 },
      { offVelocity: 32 },
      { startPpq: 0.5 },
      { durationPpq: 2 },
      { channel: 3 },
    ] as Partial<MidiNote>[]) {
      const mutated = [{ ...NOTES[0], ...patch }, NOTES[1]];
      expect(midiClipCacheKey(mutated, OPTS)).not.toBe(base);
    }
  });

  it('uses defaults equal to explicit tempo 120 and the default preset', () => {
    expect(midiClipCacheKey(NOTES, { ...OPTS, tempoBpm: 120, preset: DEFAULT_SYNTH_PRESET })).toBe(
      midiClipCacheKey(NOTES, OPTS),
    );
  });
});

describe('noteEventsFromNotes', () => {
  it('expands each note into an on/off pair at the correct PPQ', () => {
    const events = noteEventsFromNotes([
      { note: 60, velocity: 100, offVelocity: 42, startPpq: 1, durationPpq: 2 },
    ]);
    expect(events).toEqual([
      { ppq: 1, kind: 'on', note: 60, velocity: 100, channel: 0 },
      { ppq: 3, kind: 'off', note: 60, velocity: 42, channel: 0 },
    ]);
  });

  it('defaults omitted note-off velocity to 0', () => {
    const events = noteEventsFromNotes([{ note: 60, velocity: 100, startPpq: 0, durationPpq: 1 }]);
    expect(events[1]).toEqual({ ppq: 1, kind: 'off', note: 60, velocity: 0, channel: 0 });
  });

  it('sorts by PPQ with note-off before note-on at the same position', () => {
    const events = noteEventsFromNotes([
      { note: 60, velocity: 100, startPpq: 0, durationPpq: 1 },
      { note: 60, velocity: 100, startPpq: 1, durationPpq: 1 },
    ]);
    expect(events.map((e) => `${e.ppq}:${e.kind}`)).toEqual(['0:on', '1:off', '1:on', '2:off']);
  });

  it('rejects out-of-range fields', () => {
    expect(() =>
      noteEventsFromNotes([{ note: 128, velocity: 100, startPpq: 0, durationPpq: 1 }]),
    ).toThrow(RangeError);
    expect(() =>
      noteEventsFromNotes([{ note: 60, velocity: 0, startPpq: 0, durationPpq: 1 }]),
    ).toThrow(RangeError);
    expect(() =>
      noteEventsFromNotes([{ note: 60, velocity: 100, startPpq: -1, durationPpq: 1 }]),
    ).toThrow(RangeError);
    expect(() =>
      noteEventsFromNotes([{ note: 60, velocity: 100, startPpq: 0, durationPpq: 0 }]),
    ).toThrow(RangeError);
    expect(() =>
      noteEventsFromNotes([{ note: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 16 }]),
    ).toThrow(RangeError);
    expect(() =>
      noteEventsFromNotes([
        { note: 60, velocity: 100, offVelocity: 128, startPpq: 0, durationPpq: 1 },
      ]),
    ).toThrow(RangeError);
  });
});

describe('makeDemoNotes', () => {
  it('spans two 4/4 bars and stays in the C-major triad register', () => {
    const notes = makeDemoNotes();
    const cMajorPitches = new Set([60, 64, 67, 72, 76]);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(cMajorPitches.has(n.note)).toBe(true);
      expect(n.startPpq).toBeGreaterThanOrEqual(0);
      expect(n.startPpq + n.durationPpq).toBeLessThanOrEqual(8);
    }
    // Produces valid sorted events without throwing.
    expect(noteEventsFromNotes(notes).length).toBe(notes.length * 2);
  });
});

describe('prerenderMidiClip', () => {
  it('bounces once and serves identical requests from the cache', async () => {
    const first = await prerenderMidiClip(NOTES, OPTS);
    const second = await prerenderMidiClip(NOTES, OPTS);
    expect(wasmMock.bounce).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first).toHaveLength(2);
    expect(Array.from(first[0])).toEqual([0.25, 0.5, 0.75]);
    expect(Array.from(first[1])).toEqual([-0.25, -0.5, -0.75]);
    expect(wasmMock.destroySpy).toHaveBeenCalledTimes(1);
  });

  it('passes note-off velocity to the scratch project MIDI events', async () => {
    await prerenderMidiClip(
      [{ note: 60, velocity: 100, offVelocity: 37, startPpq: 0, durationPpq: 1 }],
      OPTS,
    );
    expect(wasmMock.midiNoteOff).toHaveBeenCalledWith({
      ppq: 1,
      group: 0,
      channel: 0,
      note: 60,
      velocity: 37,
    });
  });

  it('re-bounces when render-relevant options change', async () => {
    await prerenderMidiClip(NOTES, OPTS);
    await prerenderMidiClip(NOTES, { ...OPTS, tempoBpm: 90 });
    expect(wasmMock.bounce).toHaveBeenCalledTimes(2);
  });

  it('bounds the prerender cache and evicts the least-recently used render', async () => {
    const retained = await prerenderMidiClip(NOTES, { ...OPTS, tempoBpm: 60 });
    for (let i = 0; i < MAX_PRERENDER_CACHE_ENTRIES - 1; i++) {
      await prerenderMidiClip(NOTES, { ...OPTS, tempoBpm: 61 + i });
    }
    expect(wasmMock.bounce).toHaveBeenCalledTimes(MAX_PRERENDER_CACHE_ENTRIES);

    // Touch the oldest render so the next insert evicts the next-oldest key.
    expect(await prerenderMidiClip(NOTES, { ...OPTS, tempoBpm: 60 })).toBe(retained);
    await prerenderMidiClip(NOTES, { ...OPTS, tempoBpm: 200 });
    expect(wasmMock.bounce).toHaveBeenCalledTimes(MAX_PRERENDER_CACHE_ENTRIES + 1);

    expect(await prerenderMidiClip(NOTES, { ...OPTS, tempoBpm: 60 })).toBe(retained);
    expect(wasmMock.bounce).toHaveBeenCalledTimes(MAX_PRERENDER_CACHE_ENTRIES + 1);

    await prerenderMidiClip(NOTES, { ...OPTS, tempoBpm: 61 });
    expect(wasmMock.bounce).toHaveBeenCalledTimes(MAX_PRERENDER_CACHE_ENTRIES + 2);
  });

  it('returns empty stereo buffers for an empty phrase without bouncing', async () => {
    const channels = await prerenderMidiClip([], OPTS);
    expect(channels).toHaveLength(2);
    expect(channels[0].length).toBe(0);
    expect(channels[1].length).toBe(0);
    expect(wasmMock.bounce).not.toHaveBeenCalled();
  });
});

describe('peakAmplitude / normalizeGain', () => {
  it('returns the max absolute sample across channels', () => {
    const channels = [new Float32Array([0.1, -0.4, 0.2]), new Float32Array([0.05, 0.3, -0.25])];
    expect(peakAmplitude(channels)).toBeCloseTo(0.4, 6);
  });

  it('returns 0 for empty buffers', () => {
    expect(peakAmplitude([new Float32Array(0), new Float32Array(0)])).toBe(0);
  });

  it('computes the gain reaching the target peak', () => {
    expect(normalizeGain(0.25, 0.5)).toBeCloseTo(2, 6);
    expect(normalizeGain(1, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('caps the gain and falls back to unity on unusable peaks', () => {
    expect(normalizeGain(1e-9, 0.5)).toBe(24);
    expect(normalizeGain(0, 0.5)).toBe(1);
    expect(normalizeGain(Number.NaN, 0.5)).toBe(1);
  });
});
