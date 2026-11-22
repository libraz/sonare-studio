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
  gmProgramForPreset,
  instrumentCacheSegment,
  instrumentDedupeKey,
  instrumentEquals,
  isDefaultInstrument,
  loadInstrument,
  SF2_MUTE_GAIN,
  sf2ChannelProgram,
  sf2PlaybackConfig,
  type TrackInstrument,
  trackInstrument,
  validateTrackInstrument,
} from '@/project/instrument';

describe('gmProgramForPreset', () => {
  it('maps catalog voices to their GM address when switching modes or exporting SMF', () => {
    expect(
      [
        'ePiano',
        'electricGuitar',
        'brass',
        'violin',
        'cello',
        'clarinet',
        'trumpet',
        'concertFlute',
      ].map(gmProgramForPreset),
    ).toEqual([4, 26, 56, 40, 42, 71, 56, 73]);
  });
});

describe('instrumentDedupeKey', () => {
  it('keeps GM-enabled synth selections on separate destinations', () => {
    const plain = instrumentDedupeKey({ kind: 'synth-preset', preset: 'ePiano' });
    const gm = instrumentDedupeKey({
      kind: 'synth-preset',
      preset: 'ePiano',
      useGmPrograms: true,
      gmBank: 128,
      gmProgram: 25,
    });

    expect(gm).not.toBe(plain);
    expect(
      instrumentDedupeKey({
        kind: 'synth-preset',
        preset: 'ePiano',
        useGmPrograms: true,
        gmBank: 128,
        gmProgram: 26,
      }),
    ).not.toBe(gm);
    expect(
      instrumentDedupeKey({ kind: 'synth-preset', preset: 'ePiano', useGmPrograms: false }),
    ).toBe(plain);
  });

  it('keeps SF2 gain and polyphony variants on separate playback destinations', () => {
    const base = { kind: 'sf2', fontId: 'gm', bank: 0, program: 1 } as const;

    expect(instrumentDedupeKey({ ...base, gain: 0.5 })).not.toBe(
      instrumentDedupeKey({ ...base, gain: 1 }),
    );
    expect(instrumentDedupeKey({ ...base, polyphony: 24 })).not.toBe(
      instrumentDedupeKey({ ...base, polyphony: 48 }),
    );
    expect(instrumentDedupeKey({ ...base, preferModelForModeledFamilies: true })).not.toBe(
      instrumentDedupeKey({ ...base, preferModelForModeledFamilies: false }),
    );
    expect(instrumentDedupeKey({ ...base, gsEfxRealization: 'classic' })).not.toBe(
      instrumentDedupeKey({ ...base, gsEfxRealization: 'modern' }),
    );
  });
});

const wasmMock = vi.hoisted(() => {
  const bounce = vi.fn((request?: { sf2Instruments?: ReadonlyArray<unknown> }) => ({
    channels:
      request?.sf2Instruments !== undefined
        ? [new Float32Array([0.2, 0.4]), new Float32Array([-0.2, -0.4])]
        : [new Float32Array([0.25, 0.5, 0.75]), new Float32Array([-0.25, -0.5, -0.75])],
    sampleRate: 48000,
  }));
  const loadSoundFont = vi.fn();
  const setMidiEvents = vi.fn();
  const synthPresetNames = vi.fn(() => ['sine', 'sawLead', 'ePiano', 'acousticPiano', 'drumKit']);

  class MockProject implements Partial<InstanceType<typeof import('@/wasm/index.js')['Project']>> {
    setSampleRate = vi.fn();
    setTempoSegments = vi.fn();
    addMidiClip = vi.fn(() => ({ trackId: 1, clipId: 2 }));
    setMidiEvents = setMidiEvents;
    bounce = bounce;
    loadSoundFont = loadSoundFont;
    destroy = vi.fn();
  }

  const midi = {
    midiNoteOn: vi.fn((r: { ppq: number; channel: number; note: number; velocity: number }) => ({
      ppq: r.ppq,
      word0: (0x2 << 28) | (9 << 20) | (r.channel << 16) | (r.note << 8) | r.velocity,
    })),
    midiNoteOff: vi.fn((r: { ppq: number; channel: number; note: number }) => ({
      ppq: r.ppq,
      word0: (0x2 << 28) | (8 << 20) | (r.channel << 16) | (r.note << 8),
    })),
    midiProgram: vi.fn((r: { ppq: number; channel: number; program: number }) => ({
      ppq: r.ppq,
      word0: (0x2 << 28) | (0xc << 20) | (r.channel << 16) | (r.program << 8),
    })),
    midiBankProgram: vi.fn(
      (r: {
        ppq: number;
        channel: number;
        program: number;
        bank: { msb: number; lsb: number };
      }) => [
        { ppq: r.ppq, word0: (0x2 << 28) | (0xb << 20) | (r.channel << 16) | r.bank.msb },
        {
          ppq: r.ppq,
          word0: (0x2 << 28) | (0xb << 20) | (r.channel << 16) | (32 << 8) | r.bank.lsb,
        },
        { ppq: r.ppq, word0: (0x2 << 28) | (0xc << 20) | (r.channel << 16) | (r.program << 8) },
      ],
    ),
  };

  return { bounce, loadSoundFont, setMidiEvents, synthPresetNames, midi, MockProject };
});

vi.mock('@/lib/wasm', () => ({
  ensureWasm: vi.fn(async () => ({
    Project: wasmMock.MockProject,
    synthPresetNames: wasmMock.synthPresetNames,
    ...wasmMock.midi,
  })),
}));

const NOTES: MidiNote[] = [
  { note: 60, velocity: 100, startPpq: 0, durationPpq: 1 },
  { note: 64, velocity: 90, startPpq: 1, durationPpq: 0.5, channel: 3 },
];

const OPTS = { sampleRate: 48000 };

beforeEach(() => {
  clearPrerenderCache();
  wasmMock.bounce.mockClear();
  wasmMock.loadSoundFont.mockClear();
  wasmMock.setMidiEvents.mockClear();
});

describe('instrumentCacheSegment', () => {
  it('matches the historical preset segment for synth presets', () => {
    expect(instrumentCacheSegment({ kind: 'synth-preset', preset: 'ePiano' })).toBe(
      'preset=ePiano',
    );
  });

  it('keys GM-enabled synth presets by mode and initial selection', () => {
    const plain = instrumentCacheSegment({ kind: 'synth-preset', preset: 'ePiano' });
    const gm = instrumentCacheSegment({
      kind: 'synth-preset',
      preset: 'ePiano',
      useGmPrograms: true,
      gmBank: 128,
      gmProgram: 25,
    });

    expect(gm).toBe('preset=ePiano:gm=1:128:25');
    expect(gm).not.toBe(plain);
    expect(
      instrumentCacheSegment({
        kind: 'synth-preset',
        preset: 'ePiano',
        useGmPrograms: true,
        gmBank: 128,
        gmProgram: 26,
      }),
    ).not.toBe(gm);
    expect(
      instrumentCacheSegment({ kind: 'synth-preset', preset: 'ePiano', useGmPrograms: false }),
    ).toBe(plain);
  });

  it('hashes synth patches insensitively to field order', () => {
    const a = instrumentCacheSegment({
      kind: 'synth-patch',
      patch: { preset: 'sawLead', cutoffHz: 800, resonanceQ: 2 },
    });
    const b = instrumentCacheSegment({
      kind: 'synth-patch',
      patch: { resonanceQ: 2, cutoffHz: 800, preset: 'sawLead' },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^patch=[0-9a-f]{8}$/);
  });

  it('changes when any patch field changes', () => {
    const base = instrumentCacheSegment({
      kind: 'synth-patch',
      patch: { preset: 'sawLead', cutoffHz: 800 },
    });
    expect(
      instrumentCacheSegment({ kind: 'synth-patch', patch: { preset: 'sawLead', cutoffHz: 801 } }),
    ).not.toBe(base);
    expect(
      instrumentCacheSegment({
        kind: 'synth-patch',
        patch: { preset: 'sawLead', cutoffHz: 800, drive: 0.5 },
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

  it('separates the modelled-instrument preference so a cached bounce is not reused', () => {
    const sampled = instrumentCacheSegment({ kind: 'sf2', fontId: 'font-a', program: 40 });
    const modelled = instrumentCacheSegment({
      kind: 'sf2',
      fontId: 'font-a',
      program: 40,
      preferModelForModeledFamilies: true,
    });

    expect(modelled).not.toBe(sampled);
    // An explicit false is the engine default and must key the same as absent.
    expect(
      instrumentCacheSegment({
        kind: 'sf2',
        fontId: 'font-a',
        program: 40,
        preferModelForModeledFamilies: false,
      }),
    ).toBe(sampled);
  });

  it('separates classic GS EFX from the modern cache identity', () => {
    const modern = instrumentCacheSegment({ kind: 'sf2', fontId: 'font-a', program: 40 });
    const explicitModern = instrumentCacheSegment({
      kind: 'sf2',
      fontId: 'font-a',
      program: 40,
      gsEfxRealization: 'modern',
    });
    const classic = instrumentCacheSegment({
      kind: 'sf2',
      fontId: 'font-a',
      program: 40,
      gsEfxRealization: 'classic',
    });

    expect(explicitModern).toBe(modern);
    expect(classic).not.toBe(modern);
  });
});

describe('midiClipCacheKey with instruments', () => {
  it('treats the preset option and the synth-preset instrument as the same identity', () => {
    expect(
      midiClipCacheKey(NOTES, {
        ...OPTS,
        instrument: { kind: 'synth-preset', preset: 'sawLead' },
      }),
    ).toBe(midiClipCacheKey(NOTES, { ...OPTS, preset: 'sawLead' }));
  });

  it('defaults to the default preset identity', () => {
    expect(midiClipCacheKey(NOTES, OPTS)).toBe(
      midiClipCacheKey(NOTES, { ...OPTS, instrument: defaultTrackInstrument() }),
    );
  });

  it('separates preset, patch and sf2 identities', () => {
    const preset = midiClipCacheKey(NOTES, OPTS);
    const patch = midiClipCacheKey(NOTES, {
      ...OPTS,
      instrument: { kind: 'synth-patch', patch: { preset: 'ePiano' } },
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
        instrument: { kind: 'synth-preset', preset: 'drumKit' },
      }),
    ).toBe(midiClipCacheKey(NOTES, { ...OPTS, preset: 'drumKit' }));
  });
});

describe('instrument helpers', () => {
  it('trackInstrument falls back to the default preset', () => {
    expect(trackInstrument({})).toEqual({ kind: 'synth-preset', preset: 'acousticPiano' });
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

  it('loadInstrument returns a detached copy', () => {
    const current: TrackInstrument = {
      kind: 'synth-patch',
      patch: { filterModel: 'svf', cutoffHz: 800 },
    };
    const loaded = loadInstrument(current);
    expect(loaded).toEqual(current);
    expect(loaded).not.toBe(current);
  });

  it('isDefaultInstrument only accepts the default preset', () => {
    expect(isDefaultInstrument(defaultTrackInstrument())).toBe(true);
    expect(isDefaultInstrument({ kind: 'synth-preset', preset: 'sine' })).toBe(false);
    expect(isDefaultInstrument({ kind: 'sf2', fontId: 'gm' })).toBe(false);
  });

  it('validateTrackInstrument rejects malformed variants', () => {
    expect(() => validateTrackInstrument({ kind: 'synth-preset', preset: '' })).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({
        kind: 'synth-preset',
        preset: 'ePiano',
        useGmPrograms: 1 as unknown as boolean,
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateTrackInstrument({
        kind: 'synth-preset',
        preset: 'ePiano',
        useGmPrograms: true,
        gmBank: 128,
        gmProgram: 25,
      }),
    ).not.toThrow();
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', bank: -1 })).toThrow(
      RangeError,
    );
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm', program: 128 })).toThrow(
      RangeError,
    );
    for (const gain of [-0.1, 4.01, Number.NaN]) {
      expect(() => validateTrackInstrument({ kind: 'synth-patch', patch: { gain } })).toThrow(
        RangeError,
      );
    }
    for (const gain of [0, 4]) {
      expect(() => validateTrackInstrument({ kind: 'synth-patch', patch: { gain } })).not.toThrow();
    }
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
      gain: SF2_MUTE_GAIN,
    });
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', polyphony: 24 })).toEqual({
      polyphony: 24,
    });
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', gain: 0.8, polyphony: 16 })).toEqual({
      gain: 0.8,
      polyphony: 16,
    });
  });

  it('sf2PlaybackConfig forwards the modelled-instrument preference only when set', () => {
    expect(
      sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', preferModelForModeledFamilies: true }),
    ).toEqual({ preferModelForModeledFamilies: true });
    // False is the engine default; omitting it keeps the config minimal.
    expect(
      sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', preferModelForModeledFamilies: false }),
    ).toEqual({});
  });

  it('forwards classic GS EFX while omitting the modern engine default', () => {
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', gsEfxRealization: 'classic' })).toEqual({
      gsEfxRealization: 'classic',
    });
    expect(sf2PlaybackConfig({ kind: 'sf2', fontId: 'gm', gsEfxRealization: 'modern' })).toEqual(
      {},
    );
  });

  it('validateTrackInstrument rejects a non-boolean modelled-instrument preference', () => {
    expect(() =>
      validateTrackInstrument({
        kind: 'sf2',
        fontId: 'gm',
        preferModelForModeledFamilies: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateTrackInstrument({
        kind: 'sf2',
        fontId: 'gm',
        preferModelForModeledFamilies: 1 as unknown as boolean,
      }),
    ).toThrow(RangeError);
  });

  it('validateTrackInstrument accepts only named GS EFX realisations', () => {
    expect(() => validateTrackInstrument({ kind: 'sf2', fontId: 'gm' })).not.toThrow();
    expect(() =>
      validateTrackInstrument({ kind: 'sf2', fontId: 'gm', gsEfxRealization: 'modern' }),
    ).not.toThrow();
    expect(() =>
      validateTrackInstrument({ kind: 'sf2', fontId: 'gm', gsEfxRealization: 'classic' }),
    ).not.toThrow();
    expect(() =>
      validateTrackInstrument({
        kind: 'sf2',
        fontId: 'gm',
        gsEfxRealization: 'legacy' as unknown as 'modern',
      }),
    ).toThrow(RangeError);
  });
});

/** The synth patch of the single bounce binding the last prerender requested. */
function bouncedSynthPatch(): unknown {
  const request = wasmMock.bounce.mock.calls[0][0] as {
    synthInstruments?: Array<{ instrument: unknown }>;
  };
  return request.synthInstruments?.[0].instrument;
}

/** The SF2 config of the single bounce binding the last prerender requested. */
function bouncedSf2Config(): unknown {
  const request = wasmMock.bounce.mock.calls[0][0] as {
    sf2Instruments?: Array<{ instrument: unknown }>;
  };
  return request.sf2Instruments?.[0].instrument;
}

describe('prerenderMidiClip per instrument kind', () => {
  it('passes a synth patch object straight to the bounce', async () => {
    const patch = { preset: 'sawLead', cutoffHz: 900 };
    await prerenderMidiClip(NOTES, { ...OPTS, instrument: { kind: 'synth-patch', patch } });
    expect(wasmMock.bounce).toHaveBeenCalledTimes(1);
    expect(bouncedSynthPatch()).toEqual(patch);
  });

  it('degrades unknown preset names to the default preset via the catalog', async () => {
    await prerenderMidiClip(NOTES, { ...OPTS, preset: 'no-such-preset' });
    expect(bouncedSynthPatch()).toEqual({ preset: 'acousticPiano' });
  });

  it('keeps catalog-listed preset names as-is', async () => {
    await prerenderMidiClip(NOTES, { ...OPTS, preset: 'sawLead' });
    expect(bouncedSynthPatch()).toEqual({ preset: 'sawLead' });
  });

  it('prerenders a GM-enabled preset with its initial bank/program prelude', async () => {
    await prerenderMidiClip(NOTES, {
      ...OPTS,
      instrument: {
        kind: 'synth-preset',
        preset: 'sawLead',
        useGmPrograms: true,
        gmBank: 128,
        gmProgram: 25,
      },
    });

    expect(bouncedSynthPatch()).toEqual({
      preset: 'sawLead',
      useGmPrograms: true,
    });
    const events = wasmMock.setMidiEvents.mock.calls[0][1] as Array<{
      ppq: number;
      word0: number;
    }>;
    expect(events.slice(0, 6).map((event) => (event.word0 >>> 20) & 0xf)).toEqual([
      0xb, 0xb, 0xc, 0xb, 0xb, 0xc,
    ]);
    expect(events.slice(0, 6).every((event) => event.ppq === 0)).toBe(true);
    expect(events[6].ppq).toBeCloseTo(1 / 24000);
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
    expect(wasmMock.bounce).toHaveBeenCalledTimes(1);
    // No explicit gain/polyphony => empty config keeps the engine defaults.
    expect(bouncedSf2Config()).toEqual({});
    expect(
      (wasmMock.bounce.mock.calls[0][0] as { synthInstruments?: unknown }).synthInstruments,
    ).toBeUndefined();
  });

  it('forwards the SF2 master gain and voice cap to the bounce', async () => {
    const loadFont = vi.fn(async () => new Uint8Array([4]));
    await prerenderMidiClip(NOTES, {
      ...OPTS,
      instrument: { kind: 'sf2', fontId: 'my-font', gain: 1.5, polyphony: 24 },
      loadFont,
    });
    expect(bouncedSf2Config()).toEqual({ gain: 1.5, polyphony: 24 });
  });

  it('forwards classic GS EFX realisation to the prerender bounce', async () => {
    await prerenderMidiClip(NOTES, {
      ...OPTS,
      instrument: { kind: 'sf2', fontId: 'my-font', gsEfxRealization: 'classic' },
      loadFont: async () => new Uint8Array([4]),
    });
    expect(bouncedSf2Config()).toEqual({
      gsEfxRealization: 'classic',
    });
  });

  it('forwards a zero gain to the SF2 bounce as the mute gain, not the engine default', async () => {
    await prerenderMidiClip(NOTES, {
      ...OPTS,
      instrument: { kind: 'sf2', fontId: 'my-font', gain: 0 },
      loadFont: async () => new Uint8Array([4]),
    });

    expect(bouncedSf2Config()).toEqual({ gain: SF2_MUTE_GAIN });
  });

  it('prepends bank/program select events per used channel', async () => {
    const loadFont = vi.fn(async () => new Uint8Array([9]));
    await prerenderMidiClip(NOTES, {
      ...OPTS,
      instrument: { kind: 'sf2', fontId: 'gm', bank: 128, program: 25 },
      loadFont,
    });
    const events = wasmMock.setMidiEvents.mock.calls[0][1] as Array<{ word0: number }>;
    // NOTES uses channels 0 and 3: two bank+program triplets precede the notes.
    expect(events.length).toBe(NOTES.length * 2 + 2 * 3);
    const statusNibbles = events.slice(0, 6).map((e) => (e.word0 >>> 20) & 0xf);
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
    expect(wasmMock.bounce).toHaveBeenCalledTimes(1);
    await prerenderMidiClip(NOTES, {
      ...opts,
      instrument: { kind: 'sf2', fontId: 'gm', program: 4 },
    });
    expect(wasmMock.bounce).toHaveBeenCalledTimes(2);
  });
});
