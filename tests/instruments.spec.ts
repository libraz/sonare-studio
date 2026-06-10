import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import {
  clearPrerenderCache,
  deinterleave,
  type MidiNote,
  makeDemoNotes,
  midiClipCacheKey,
  noteEventsFromNotes,
  prerenderMidiClip,
  scheduleMidiClip,
} from '@/engine/instruments';

const wasmMock = vi.hoisted(() => {
  const bounceWithSynthInstrument = vi.fn(
    () => new Float32Array([0.25, -0.25, 0.5, -0.5, 0.75, -0.75]),
  );
  const deleteSpy = vi.fn();

  class MockProject {
    setSampleRate = vi.fn();
    setTempoSegments = vi.fn();
    addMidiClip = vi.fn(() => ({ trackId: 1, clipId: 2 }));
    setMidiEvents = vi.fn();
    bounceWithSynthInstrument = bounceWithSynthInstrument;
    delete = deleteSpy;
    static midiNoteOn = vi.fn((ppq: number, _g: number, ch: number, note: number, vel: number) => ({
      ppq,
      data0: (9 << 20) | (ch << 16) | (note << 8) | vel,
    }));
    static midiNoteOff = vi.fn((ppq: number, _g: number, ch: number, note: number) => ({
      ppq,
      data0: (8 << 20) | (ch << 16) | (note << 8),
    }));
  }

  return { bounceWithSynthInstrument, deleteSpy, MockProject };
});

vi.mock('@/lib/wasm', () => ({
  ensureWasm: vi.fn(async () => ({ Project: wasmMock.MockProject })),
}));

const NOTES: MidiNote[] = [
  { note: 60, velocity: 100, startPpq: 0, durationPpq: 1 },
  { note: 64, velocity: 90, startPpq: 1, durationPpq: 0.5 },
];

const OPTS = { sampleRate: 48000 };

beforeEach(() => {
  clearPrerenderCache();
  wasmMock.bounceWithSynthInstrument.mockClear();
  wasmMock.deleteSpy.mockClear();
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
    expect(midiClipCacheKey(NOTES, { ...OPTS, preset: 'saw-lead' })).not.toBe(base);
  });

  it('changes when any note field changes', () => {
    const base = midiClipCacheKey(NOTES, OPTS);
    for (const patch of [
      { note: 61 },
      { velocity: 101 },
      { startPpq: 0.5 },
      { durationPpq: 2 },
      { channel: 3 },
    ] as Partial<MidiNote>[]) {
      const mutated = [{ ...NOTES[0], ...patch }, NOTES[1]];
      expect(midiClipCacheKey(mutated, OPTS)).not.toBe(base);
    }
  });

  it('uses defaults equal to explicit tempo 120 and preset e-piano', () => {
    expect(midiClipCacheKey(NOTES, { ...OPTS, tempoBpm: 120, preset: 'e-piano' })).toBe(
      midiClipCacheKey(NOTES, OPTS),
    );
  });
});

describe('noteEventsFromNotes', () => {
  it('expands each note into an on/off pair at the correct PPQ', () => {
    const events = noteEventsFromNotes([{ note: 60, velocity: 100, startPpq: 1, durationPpq: 2 }]);
    expect(events).toEqual([
      { ppq: 1, kind: 'on', note: 60, velocity: 100, channel: 0 },
      { ppq: 3, kind: 'off', note: 60, velocity: 0, channel: 0 },
    ]);
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
  });
});

describe('deinterleave', () => {
  it('splits interleaved stereo into planar channels', () => {
    const planar = deinterleave(new Float32Array([1, -1, 2, -2, 3, -3]), 2);
    expect(planar).toHaveLength(2);
    expect(Array.from(planar[0])).toEqual([1, 2, 3]);
    expect(Array.from(planar[1])).toEqual([-1, -2, -3]);
  });

  it('rejects a non-positive channel count', () => {
    expect(() => deinterleave(new Float32Array(4), 0)).toThrow(RangeError);
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
    expect(wasmMock.bounceWithSynthInstrument).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first).toHaveLength(2);
    expect(Array.from(first[0])).toEqual([0.25, 0.5, 0.75]);
    expect(Array.from(first[1])).toEqual([-0.25, -0.5, -0.75]);
    expect(wasmMock.deleteSpy).toHaveBeenCalledTimes(1);
  });

  it('re-bounces when render-relevant options change', async () => {
    await prerenderMidiClip(NOTES, OPTS);
    await prerenderMidiClip(NOTES, { ...OPTS, tempoBpm: 90 });
    expect(wasmMock.bounceWithSynthInstrument).toHaveBeenCalledTimes(2);
  });

  it('returns empty stereo buffers for an empty phrase without bouncing', async () => {
    const channels = await prerenderMidiClip([], OPTS);
    expect(channels).toHaveLength(2);
    expect(channels[0].length).toBe(0);
    expect(channels[1].length).toBe(0);
    expect(wasmMock.bounceWithSynthInstrument).not.toHaveBeenCalled();
  });
});

describe('scheduleMidiClip', () => {
  it('prerenders at the context sample rate and forwards to engine.addClip', async () => {
    const addClip = vi.fn(() => 42);
    const handle = {
      ctx: { sampleRate: 48000 },
      engine: { addClip },
    } as unknown as EngineHandle;

    const clipId = await scheduleMidiClip(handle, 'track-1', NOTES, 4);
    expect(clipId).toBe(42);
    expect(addClip).toHaveBeenCalledTimes(1);
    const [trackId, channels, startPpq] = addClip.mock.calls[0] as unknown as [
      string,
      Float32Array[],
      number,
    ];
    expect(trackId).toBe('track-1');
    expect(channels).toHaveLength(2);
    expect(channels[0]).toBeInstanceOf(Float32Array);
    expect(startPpq).toBe(4);
  });
});
