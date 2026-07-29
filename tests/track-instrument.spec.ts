import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPrerenderCache,
  type MidiNote,
  midiClipCacheKey,
  prerenderMidiClip,
} from '@/engine/instruments';
import {
  cloneInstrument,
  defaultTrackInstrument,
  instrumentCacheSegment,
  instrumentDedupeKey,
  instrumentEquals,
  isDefaultInstrument,
  sf2ChannelProgram,
  sf2PlaybackConfig,
  type TrackInstrument,
  trackInstrument,
  validateTrackInstrument,
} from '@/project/instrument';

describe('instrumentDedupeKey', () => {
  it('keeps SF2 gain and polyphony variants on separate playback destinations', () => {
    const base = { kind: 'sf2', fontId: 'gm', bank: 0, program: 1 } as const;

    expect(instrumentDedupeKey({ ...base, gain: 0.5 })).not.toBe(
      instrumentDedupeKey({ ...base, gain: 1 }),
    );
    expect(instrumentDedupeKey({ ...base, polyphony: 24 })).not.toBe(
      instrumentDedupeKey({ ...base, polyphony: 48 }),
    );
  });
});

const wasmMock = vi.hoisted(() => {
  const bounceWithSynthInstrument = vi.fn(
    () => new Float32Array([0.25, -0.25, 0.5, -0.5, 0.75, -0.75]),
  );
  const bounceWithSf2Instrument = vi.fn(() => new Float32Array([0.2, -0.2, 0.4, -0.4]));
  const loadSoundFont = vi.fn();
  const setMidiEvents = vi.fn();
  const synthPresetNames = vi.fn(() => ['sine', 'saw-lead', 'e-piano', 'drum-kit']);

  class MockProject {
    setSampleRate = vi.fn();
    setTempoSegments = vi.fn();
    addMidiClip = vi.fn(() => ({ trackId: 1, clipId: 2 }));
    setMidiEvents = setMidiEvents;
    bounceWithSynthInstrument = bounceWithSynthInstrument;
    bounceWithSf2Instrument = bounceWithSf2Instrument;
    loadSoundFont = loadSoundFont;
    delete = vi.fn();
    static midiNoteOn = vi.fn((ppq: number, _g: number, ch: number, note: number, vel: number) => ({
      ppq,
      data0: (9 << 20) | (ch << 16) | (note << 8) | vel,
    }));
    static midiNoteOff = vi.fn((ppq: number, _g: number, ch: number, note: number) => ({
      ppq,
      data0: (8 << 20) | (ch << 16) | (note << 8),
    }));
    static midiProgram = vi.fn((ppq: number, _g: number, ch: number, program: number) => ({
      ppq,
      data0: (0xc << 20) | (ch << 16) | (program << 8),
    }));
    static midiBankProgram = vi.fn(
      (ppq: number, _g: number, ch: number, msb: number, lsb: number, program: number) => [
        { ppq, data0: (0xb << 20) | (ch << 16) | msb },
        { ppq, data0: (0xb << 20) | (ch << 16) | (32 << 8) | lsb },
        { ppq, data0: (0xc << 20) | (ch << 16) | (program << 8) },
      ],
    );
  }

  return {
    bounceWithSynthInstrument,
    bounceWithSf2Instrument,
    loadSoundFont,
    setMidiEvents,
    synthPresetNames,
    MockProject,
  };
});

vi.mock('@/lib/wasm', () => ({
  ensureWasm: vi.fn(async () => ({
    Project: wasmMock.MockProject,
    synthPresetNames: wasmMock.synthPresetNames,
  })),
}));

const NOTES: MidiNote[] = [
  { note: 60, velocity: 100, startPpq: 0, durationPpq: 1 },
  { note: 64, velocity: 90, startPpq: 1, durationPpq: 0.5, channel: 3 },
];

const OPTS = { sampleRate: 48000 };

beforeEach(() => {
  clearPrerenderCache();
  wasmMock.bounceWithSynthInstrument.mockClear();
  wasmMock.bounceWithSf2Instrument.mockClear();
  wasmMock.loadSoundFont.mockClear();
  wasmMock.setMidiEvents.mockClear();
});

describe('instrumentCacheSegment', () => {
  it('matches the historical preset segment for synth presets', () => {
    expect(instrumentCacheSegment({ kind: 'synth-preset', preset: 'e-piano' })).toBe(
      'preset=e-piano',
    );
  });

  it('hashes synth patches insensitively to field order', () => {
    const a = instrumentCacheSegment({
      kind: 'synth-patch',
      patch: { preset: 'saw-lead', cutoffHz: 800, resonanceQ: 2 },
    });
    const b = instrumentCacheSegment({
      kind: 'synth-patch',
      patch: { resonanceQ: 2, cutoffHz: 800, preset: 'saw-lead' },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^patch=[0-9a-f]{8}$/);
  });

  it('changes when any patch field changes', () => {
    const base = instrumentCacheSegment({
      kind: 'synth-patch',
      patch: { preset: 'saw-lead', cutoffHz: 800 },
    });
    expect(
      instrumentCacheSegment({ kind: 'synth-patch', patch: { preset: 'saw-lead', cutoffHz: 801 } }),
    ).not.toBe(base);
    expect(
      instrumentCacheSegment({
        kind: 'synth-patch',
        patch: { preset: 'saw-lead', cutoffHz: 800, drive: 0.5 },
      }),
    ).not.toBe(base);
  });

  it('identifies sf2 instruments by font, bank, program, gain and polyphony', () => {
    const base = instrumentCacheSegment({ kind: 'sf2', fontId: 'font-a', bank: 0, program: 12 });
    expect(base).toBe('sf2=font-a:0:12:-1:-1');
    expect(
      instrumentCacheSegment({ kind: 'sf2', fontId: 'font-b', bank: 0, program: 12 }),
    ).not.toBe(base);
    expect(
      instrumentCacheSegment({ kind: 'sf2', fontId: 'font-a', bank: 1, program: 12 }),
    ).not.toBe(base);
    expect(
      instrumentCacheSegment({ kind: 'sf2', fontId: 'font-a', bank: 0, program: 13 }),
    ).not.toBe(base);
    expect(
      instrumentCacheSegment({ kind: 'sf2', fontId: 'font-a', bank: 0, program: 12, gain: 1 }),
    ).not.toBe(base);
    expect(
      instrumentCacheSegment({
        kind: 'sf2',
        fontId: 'font-a',
        bank: 0,
        program: 12,
        polyphony: 32,
      }),
    ).not.toBe(base);
    expect(instrumentCacheSegment({ kind: 'sf2', fontId: 'font-a' })).toBe(
      'sf2=font-a:-1:-1:-1:-1',
    );
  });
});

describe('midiClipCacheKey with instruments', () => {
  it('treats the preset option and the synth-preset instrument as the same identity', () => {
    expect(
      midiClipCacheKey(NOTES, {
        ...OPTS,
        instrument: { kind: 'synth-preset', preset: 'saw-lead' },
      }),
    ).toBe(midiClipCacheKey(NOTES, { ...OPTS, preset: 'saw-lead' }));
  });

  it('defaults to the e-piano preset identity', () => {
    expect(midiClipCacheKey(NOTES, OPTS)).toBe(
      midiClipCacheKey(NOTES, { ...OPTS, instrument: defaultTrackInstrument() }),
    );
  });

  it('separates preset, patch and sf2 identities', () => {
    const preset = midiClipCacheKey(NOTES, OPTS);
    const patch = midiClipCacheKey(NOTES, {
      ...OPTS,
      instrument: { kind: 'synth-patch', patch: { preset: 'e-piano' } },
    });
    const sf2 = midiClipCacheKey(NOTES, {
      ...OPTS,
      instrument: { kind: 'sf2', fontId: 'gm' },
    });
    expect(new Set([preset, patch, sf2]).size).toBe(3);
  });

  it('instrument takes precedence over the preset option', () => {
    expect(
      midiClipCacheKey(NOTES, {
        ...OPTS,
        preset: 'sine',
        instrument: { kind: 'synth-preset', preset: 'drum-kit' },
      }),
    ).toBe(midiClipCacheKey(NOTES, { ...OPTS, preset: 'drum-kit' }));
  });
});

describe('instrument helpers', () => {
  it('trackInstrument falls back to the default preset', () => {
    expect(trackInstrument({})).toEqual({ kind: 'synth-preset', preset: 'e-piano' });
    const explicit: TrackInstrument = { kind: 'synth-preset', preset: 'sine' };
    expect(trackInstrument({ instrument: explicit })).toBe(explicit);
  });

  it('instrumentEquals compares structurally, cloneInstrument detaches', () => {
    const a: TrackInstrument = { kind: 'synth-patch', patch: { cutoffHz: 100, drive: 0.2 } };
    const b: TrackInstrument = { kind: 'synth-patch', patch: { drive: 0.2, cutoffHz: 100 } };
    expect(instrumentEquals(a, b)).toBe(true);
    const copy = cloneInstrument(a);
    expect(copy).not.toBe(a);
    expect(instrumentEquals(copy, a)).toBe(true);
  });

  it('isDefaultInstrument only accepts the default preset', () => {
    expect(isDefaultInstrument(defaultTrackInstrument())).toBe(true);
    expect(isDefaultInstrument({ kind: 'synth-preset', preset: 'sine' })).toBe(false);
    expect(isDefaultInstrument({ kind: 'sf2', fontId: 'gm' })).toBe(false);
  });

  it('validateTrackInstrument rejects malformed variants', () => {
    expect(() => validateTrackInstrument({ kind: 'synth-preset', preset: '' })).toThrow(RangeError);
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', bank: -1 })).toThrow(
      RangeError,
    );
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', program: 128 })).toThrow(
      RangeError,
    );
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: '' })).toThrow(RangeError);
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', program: 5 })).not.toThrow();
    // Zero gain is valid (mute): the UI allows it and sf2PlaybackConfig maps it
    // to the engine's smallest gain. Only negatives are rejected.
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', gain: 0 })).not.toThrow();
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', gain: -1 })).toThrow(
      RangeError,
    );
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', polyphony: 0 })).toThrow(
      RangeError,
    );
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', polyphony: 65 })).toThrow(
      RangeError,
    );
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', polyphony: 1.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      validateTrackInstrument({ kind: 'sf2', fontId: 'gm', gain: 1.5, polyphony: 32 }),
    ).not.toThrow();
  });

  it('validateTrackInstrument checks the SF2 channel map', () => {
    expect(() =>
      validateTrackInstrument({
        kind: 'sf2',
        fontId: 'gm',
        channelMap: [{ channel: 16, program: 0 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({
        kind: 'sf2',
        fontId: 'gm',
        channelMap: [{ channel: 0, bank: 16384 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({
        kind: 'sf2',
        fontId: 'gm',
        channelMap: [{ channel: 0, program: 128 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({
        kind: 'sf2',
        fontId: 'gm',
        channelMap: [
          { channel: 9, program: 0 },
          { channel: 9, program: 1 },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({
        kind: 'sf2',
        fontId: 'gm',
        channelMap: [
          { channel: 0, program: 40 },
          { channel: 9, bank: (120 << 7) | 1, program: 0 },
        ],
      }),
    ).not.toThrow();
  });

  it('sf2ChannelProgram resolves the map entry then the track default', () => {
    const instrument = {
      kind: 'sf2',
      fontId: 'gm',
      bank: 0,
      program: 5,
      channelMap: [
        { channel: 0, program: 40 },
        { channel: 9, bank: (120 << 7) | 1, program: 0 },
      ],
    } as const;
    // A mapped channel with only a program keeps its bank undefined.
    expect(sf2ChannelProgram(instrument, 0)).toEqual({ bank: undefined, program: 40 });
    // The drum channel carries the GM2 drum bank.
    expect(sf2ChannelProgram(instrument, 9)).toEqual({ bank: (120 << 7) | 1, program: 0 });
    // An unmapped channel falls back to the track-level bank/program.
    expect(sf2ChannelProgram(instrument, 3)).toEqual({ bank: 0, program: 5 });
    // With no map and no track program, no prelude is needed.
    expect(sf2ChannelProgram({ kind: 'sf2', fontId: 'gm' }, 0)).toBeNull();
  });

  it('validateTrackInstrument checks external-midi fields', () => {
    expect(() =>
      validateTrackInstrument({ kind: 'external-midi', outputPortId: '', channel: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({ kind: 'external-midi', outputPortId: 'out-1', channel: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({ kind: 'external-midi', outputPortId: 'out-1', channel: 16 }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({ kind: 'external-midi', outputPortId: 'out-1', channel: 1.5 }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({ kind: 'external-midi', outputPortId: 'out-1', channel: 9 }),
    ).not.toThrow();
    expect(() =>
      validateTrackInstrument({
        kind: 'external-midi',
        outputPortId: 'out-1',
        channel: 0,
        sendClock: true,
      }),
    ).not.toThrow();
  });

  it('instrumentCacheSegment distinguishes external-midi configurations', () => {
    const base = instrumentCacheSegment({
      kind: 'external-midi',
      outputPortId: 'out-1',
      channel: 0,
    });
    expect(base).toBe('ext=out-1:0:0');
    expect(
      instrumentCacheSegment({ kind: 'external-midi', outputPortId: 'out-2', channel: 0 }),
    ).not.toBe(base);
    expect(
      instrumentCacheSegment({ kind: 'external-midi', outputPortId: 'out-1', channel: 3 }),
    ).not.toBe(base);
    expect(
      instrumentCacheSegment({
        kind: 'external-midi',
        outputPortId: 'out-1',
        channel: 0,
        sendClock: true,
      }),
    ).toBe('ext=out-1:0:1');
  });

  it('sf2PlaybackConfig returns only explicitly-set gain/polyphony', () => {
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm' })).toEqual({});
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', bank: 1, program: 4 })).toEqual({});
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', gain: 1.25 })).toEqual({ gain: 1.25 });
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', gain: 0 })).toEqual({
      gain: 1e-6,
    });
    expect(
      Math.fround(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', gain: 0 }).gain ?? 0),
    ).toBeCloseTo(1e-6, 12);
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', polyphony: 24 })).toEqual({
      polyphony: 24,
    });
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', gain: 0.8, polyphony: 16 })).toEqual({
      gain: 0.8,
      polyphony: 16,
    });
  });
});

describe('prerenderMidiClip per instrument kind', () => {
  it('passes a synth patch object straight to bounceWithSynthInstrument', async () => {
    const patch = { preset: 'saw-lead', cutoffHz: 900 };
    await prerenderMidiClip(NOTES, { ...OPTS, instrument: { kind: 'synth-patch', patch } });
    expect(wasmMock.bounceWithSynthInstrument).toHaveBeenCalledTimes(1);
    expect(wasmMock.bounceWithSynthInstrument.mock.calls[0][0]).toEqual(patch);
  });

  it('degrades unknown preset names to the default preset via the catalog', async () => {
    await prerenderMidiClip(NOTES, { ...OPTS, preset: 'no-such-preset' });
    expect(wasmMock.bounceWithSynthInstrument.mock.calls[0][0]).toBe('e-piano');
  });

  it('keeps catalog-listed preset names as-is', async () => {
    await prerenderMidiClip(NOTES, { ...OPTS, preset: 'saw-lead' });
    expect(wasmMock.bounceWithSynthInstrument.mock.calls[0][0]).toBe('saw-lead');
  });

  it('loads the SoundFont and bounces through the SF2 player', async () => {
    const fontBytes = new Uint8Array([1, 2, 3]);
    const loadFont = vi.fn(async () => fontBytes);
    await prerenderMidiClip(NOTES, {
      ...OPTS,
      instrument: { kind: 'sf2', fontId: 'my-font' },
      loadFont,
    });
    expect(loadFont).toHaveBeenCalledWith('my-font');
    expect(wasmMock.loadSoundFont).toHaveBeenCalledWith(fontBytes);
    expect(wasmMock.bounceWithSf2Instrument).toHaveBeenCalledTimes(1);
    // No explicit gain/polyphony => empty config keeps the engine defaults.
    expect(wasmMock.bounceWithSf2Instrument.mock.calls[0][0]).toEqual({});
    expect(wasmMock.bounceWithSynthInstrument).not.toHaveBeenCalled();
  });

  it('forwards the SF2 master gain and voice cap to the bounce', async () => {
    const loadFont = vi.fn(async () => new Uint8Array([4]));
    await prerenderMidiClip(NOTES, {
      ...OPTS,
      instrument: { kind: 'sf2', fontId: 'my-font', gain: 1.5, polyphony: 24 },
      loadFont,
    });
    expect(wasmMock.bounceWithSf2Instrument.mock.calls[0][0]).toEqual({ gain: 1.5, polyphony: 24 });
  });

  it('forwards a float32-representable mute gain to the SF2 bounce', async () => {
    await prerenderMidiClip(NOTES, {
      ...OPTS,
      instrument: { kind: 'sf2', fontId: 'my-font', gain: 0 },
      loadFont: async () => new Uint8Array([4]),
    });

    expect(wasmMock.bounceWithSf2Instrument.mock.calls[0][0]).toEqual({ gain: 1e-6 });
  });

  it('prepends bank/program select events per used channel', async () => {
    const loadFont = vi.fn(async () => new Uint8Array([9]));
    await prerenderMidiClip(NOTES, {
      ...OPTS,
      instrument: { kind: 'sf2', fontId: 'gm', bank: 128, program: 25 },
      loadFont,
    });
    const events = wasmMock.setMidiEvents.mock.calls[0][1] as Array<{ data0: number }>;
    // NOTES uses channels 0 and 3: two bank+program triplets precede the notes.
    expect(events.length).toBe(NOTES.length * 2 + 2 * 3);
    const statusNibbles = events.slice(0, 6).map((e) => (e.data0 >>> 20) & 0xf);
    expect(statusNibbles).toEqual([0xb, 0xb, 0xc, 0xb, 0xb, 0xc]);
    // The PPQ-zero note starts one sample later than the bank/program prelude
    // so libsonare's unstable same-frame ordering cannot select the wrong patch.
    expect(events.slice(0, 6).every((event) => event.ppq === 0)).toBe(true);
    expect(events[6].ppq).toBeCloseTo(1 / 24000);
  });

  it('caches sf2 renders by font/bank/program identity', async () => {
    const loadFont = vi.fn(async () => new Uint8Array([9]));
    const opts = { ...OPTS, instrument: { kind: 'sf2', fontId: 'gm' } as const, loadFont };
    const first = await prerenderMidiClip(NOTES, opts);
    const second = await prerenderMidiClip(NOTES, opts);
    expect(second).toBe(first);
    expect(wasmMock.bounceWithSf2Instrument).toHaveBeenCalledTimes(1);
    await prerenderMidiClip(NOTES, {
      ...opts,
      instrument: { kind: 'sf2', fontId: 'gm', program: 4 },
    });
    expect(wasmMock.bounceWithSf2Instrument).toHaveBeenCalledTimes(2);
  });
});
