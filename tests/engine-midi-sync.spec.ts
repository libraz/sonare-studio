import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { buildMidiClipSchedules, createMidiSync } from '@/engine/midi-sync';
import { instrumentAutomationParam } from '@/project/automation';
import { DEFAULT_SYNTH_PRESET } from '@/project/instrument';
import { DEFAULT_MIDI_FX_CONFIG, midiFxConfigJson } from '@/project/midi-fx';
import type { EditorClip, EditorNote, EditorTrack, TempoSegment } from '@/project/types';
import type { SynthPatch } from '@/wasm/index.js';

/** Render rate of the mock engine context. */
const SAMPLE_RATE = 48000;

/** Default test tempo; at 48 kHz one quarter-note PPQ is 24000 samples. */
const BPM = 120;

/** Samples per PPQ at the default test tempo and rate. */
const SPP = 24000;

/** Constant default-tempo map. */
const TEMPO_120: TempoSegment[] = [{ startPpq: 0, bpm: BPM }];

/** Constant 60 BPM map; at 48 kHz one quarter-note PPQ is 48000 samples. */
const TEMPO_60: TempoSegment[] = [{ startPpq: 0, bpm: 60 }];

/** Expected UMP MIDI 1.0 channel-voice word for a note-on. */
function noteOnWord(channel: number, pitch: number, velocity: number): number {
  return (0x2 << 28) | (0x9 << 20) | (channel << 16) | (pitch << 8) | velocity;
}

/** Expected UMP MIDI 1.0 channel-voice word for a note-off. */
function noteOffWord(channel: number, pitch: number, velocity = 0): number {
  return (0x2 << 28) | (0x8 << 20) | (channel << 16) | (pitch << 8) | velocity;
}

/** Expected UMP MIDI 1.0 channel-voice word for a control change. */
function ccWord(channel: number, controller: number, value: number): number {
  return (0x2 << 28) | (0xb << 20) | (channel << 16) | (controller << 8) | value;
}

/** Expected UMP MIDI 1.0 channel-voice word for polyphonic key pressure. */
function polyPressureWord(channel: number, pitch: number, value: number): number {
  return (0x2 << 28) | (0xa << 20) | (channel << 16) | (pitch << 8) | value;
}

/** Expected UMP MIDI 1.0 channel-voice word for a program change. */
function pcWord(channel: number, program: number): number {
  return (0x2 << 28) | (0xc << 20) | (channel << 16) | (program << 8);
}

/** Expected UMP MIDI 1.0 channel-voice word for channel pressure. */
function channelPressureWord(channel: number, value: number): number {
  return (0x2 << 28) | (0xd << 20) | (channel << 16) | (value << 8);
}

/** Expected UMP MIDI 1.0 channel-voice word for pitch bend. */
function pitchBendWord(channel: number, value: number): number {
  return (0x2 << 28) | (0xe << 20) | (channel << 16) | ((value & 0x7f) << 8) | (value >> 7);
}

/** Builds a track mirror entry with overridable fields. */
function makeTrack(id: number, overrides: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
    ...overrides,
  };
}

/** Builds a note with overridable fields. */
function makeNote(overrides: Partial<EditorNote> = {}): EditorNote {
  return { id: 1, pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0, ...overrides };
}

/** Builds a MIDI clip mirror entry with one default note. */
function makeClip(id: number, trackId: number, overrides: Partial<EditorClip> = {}): EditorClip {
  return {
    id,
    trackId,
    name: `Clip ${id}`,
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [makeNote()],
    ...overrides,
  };
}

/** EngineHandle stub capturing the MIDI clip and instrument commands. */
function makeHandle(): {
  handle: EngineHandle;
  engine: {
    setMidiClips: ReturnType<typeof vi.fn>;
    setSynthInstrument: ReturnType<typeof vi.fn>;
    loadSoundFont: ReturnType<typeof vi.fn>;
    setSf2Instrument: ReturnType<typeof vi.fn>;
    clearMidiFx: ReturnType<typeof vi.fn>;
    setMidiFx: ReturnType<typeof vi.fn>;
    setMidiDestinationExternal: ReturnType<typeof vi.fn>;
    setExternalMidiClockEnabled: ReturnType<typeof vi.fn>;
  };
} {
  const engine = {
    setMidiClips: vi.fn(),
    setSynthInstrument: vi.fn(),
    loadSoundFont: vi.fn(),
    setSf2Instrument: vi.fn(),
    clearMidiFx: vi.fn(),
    setMidiFx: vi.fn(),
    setMidiDestinationExternal: vi.fn(),
    setExternalMidiClockEnabled: vi.fn(),
  };
  const handle = { ctx: { sampleRate: SAMPLE_RATE }, engine } as unknown as EngineHandle;
  return { handle, engine };
}

describe('buildMidiClipSchedules', () => {
  it('rejects a non-finite or non-positive sample rate', () => {
    expect(() => buildMidiClipSchedules([], [], TEMPO_120, 0)).toThrow(RangeError);
    expect(() => buildMidiClipSchedules([], [], TEMPO_120, -1)).toThrow(RangeError);
    expect(() => buildMidiClipSchedules([], [], TEMPO_120, Number.NaN)).toThrow(RangeError);
    expect(() => buildMidiClipSchedules([], [], TEMPO_120, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it('falls back to a constant 120 BPM when the tempo map is empty', () => {
    const clip = makeClip(1, 1, { startPpq: 2 });
    const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], [], SAMPLE_RATE);
    expect(schedule.startSample).toBe(2 * SPP);
  });

  it('bakes clip and note PPQ to absolute samples at the given tempo', () => {
    const clip = makeClip(10, 1, { startPpq: 2, lengthPpq: 4 });
    const schedules = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);

    expect(schedules).toHaveLength(1);
    const schedule = schedules[0];
    expect(schedule.id).toBe(10);
    expect(schedule.trackId).toBe(1);
    expect(schedule.destinationId).toBe(1);
    expect(schedule.startPpq).toBe(2);
    expect(schedule.startSample).toBe(2 * SPP);
    expect(schedule.lengthSamples).toBe(4 * SPP);
    expect(schedule.events).toEqual([
      { renderFrame: 48000, word0: noteOnWord(0, 60, 100), wordCount: 1 },
      { renderFrame: 48000 + SPP - 1, word0: noteOffWord(0, 60), wordCount: 1 },
    ]);
  });

  it('bakes exact frames across a tempo-segment boundary', () => {
    // 120 BPM until ppq 4 (2 s), then 60 BPM (1 s per PPQ).
    const segments: TempoSegment[] = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 60 },
    ];
    const clip = makeClip(1, 1, { startPpq: 4, lengthPpq: 4 });
    const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], segments, SAMPLE_RATE);

    expect(schedule.startSample).toBe(96000); // ppq 4 = 2 s.
    // Clip end at ppq 8 = 6 s = 288000 samples; length is end minus start.
    expect(schedule.lengthSamples).toBe(288000 - 96000);
    expect(schedule.events).toEqual([
      { renderFrame: 96000, word0: noteOnWord(0, 60, 100), wordCount: 1 },
      { renderFrame: 96000 + 48000 - 1, word0: noteOffWord(0, 60), wordCount: 1 },
    ]);
  });

  it('encodes the exact channel-voice words', () => {
    // (0x2 << 28) | (status << 20) | (channel << 16) | (data0 << 8) | data1.
    expect(noteOnWord(0, 60, 100)).toBe(0x20903c64);
    expect(noteOffWord(0, 60)).toBe(0x20803c00);
    expect(ccWord(0, 32, 1)).toBe(0x20b02001);
    expect(pcWord(0, 5)).toBe(0x20c00500);

    const clip = makeClip(1, 1, { notes: [makeNote({ pitch: 60, velocity: 100, channel: 3 })] });
    const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
    expect(schedule.events[0].word0).toBe(noteOnWord(3, 60, 100));
    expect(schedule.events[1].word0).toBe(noteOffWord(3, 60));
  });

  it('scales note-on velocities by the clip gain, clamped to [1, 127]', () => {
    const velocityFor = (gain: number): number => {
      const clip = makeClip(1, 1, { gain });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      return (schedule.events[0].word0 as number) & 0x7f;
    };
    expect(velocityFor(0.5)).toBe(50);
    expect(velocityFor(2)).toBe(127);
    expect(velocityFor(0.001)).toBe(1);
  });

  it('encodes note-off velocity without scaling it by clip gain', () => {
    const clip = makeClip(1, 1, {
      gain: 0.5,
      notes: [makeNote({ velocity: 100, offVelocity: 45 })],
    });
    const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
    expect(schedule.events).toEqual([
      { renderFrame: 0, word0: noteOnWord(0, 60, 50), wordCount: 1 },
      { renderFrame: SPP - 1, word0: noteOffWord(0, 60, 45), wordCount: 1 },
    ]);
  });

  it('loops a clip by expanding the audible window into absolute events', () => {
    const clip = makeClip(1, 1, {
      startPpq: 0,
      lengthPpq: 8,
      loopEnabled: true,
      loopLengthPpq: 2,
      notes: [
        makeNote({ id: 1, pitch: 60, startPpq: 0, durationPpq: 1 }),
        makeNote({ id: 2, pitch: 64, startPpq: 3, durationPpq: 1 }), // outside the loop region
      ],
    });
    const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
    expect(schedule.loop).toBeUndefined();
    expect(schedule.lengthSamples).toBe(8 * SPP);
    expect(schedule.loopLengthSamples).toBeUndefined();
    // Only the note inside the 2-PPQ loop region is repeated; the hidden note is absent.
    expect(schedule.events).toEqual([
      { renderFrame: 0, word0: noteOnWord(0, 60, 100), wordCount: 1 },
      { renderFrame: SPP - 1, word0: noteOffWord(0, 60), wordCount: 1 },
      { renderFrame: 2 * SPP, word0: noteOnWord(0, 60, 100), wordCount: 1 },
      { renderFrame: 3 * SPP - 1, word0: noteOffWord(0, 60), wordCount: 1 },
      { renderFrame: 4 * SPP, word0: noteOnWord(0, 60, 100), wordCount: 1 },
      { renderFrame: 5 * SPP - 1, word0: noteOffWord(0, 60), wordCount: 1 },
      { renderFrame: 6 * SPP, word0: noteOnWord(0, 60, 100), wordCount: 1 },
      { renderFrame: 7 * SPP - 1, word0: noteOffWord(0, 60), wordCount: 1 },
    ]);
  });

  it('treats loopEnabled with no loop length as one whole-clip occurrence', () => {
    const clip = makeClip(1, 1, { lengthPpq: 4, loopEnabled: true, loopLengthPpq: 0 });
    const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
    expect(schedule.loop).toBeUndefined();
    expect(schedule.loopLengthSamples).toBeUndefined();
    expect(schedule.lengthSamples).toBe(4 * SPP);
  });

  it('maps every loop occurrence through a variable tempo map without sample drift', () => {
    const clip = makeClip(1, 1, {
      lengthPpq: 6,
      loopEnabled: true,
      loopLengthPpq: 2,
      notes: [makeNote({ startPpq: 0, durationPpq: 1 })],
    });
    const tempo: TempoSegment[] = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 2, bpm: 60 },
    ];
    const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], tempo, SAMPLE_RATE);

    expect(schedule.events.map((event) => event.renderFrame)).toEqual([
      0,
      24_000 - 1,
      48_000,
      96_000 - 1,
      144_000,
      192_000 - 1,
    ]);
  });

  it('omits loop fields for non-looping clips', () => {
    const [schedule] = buildMidiClipSchedules(
      [makeTrack(1)],
      [makeClip(1, 1)],
      TEMPO_120,
      SAMPLE_RATE,
    );
    expect(schedule.loop).toBeUndefined();
    expect(schedule.loopLengthSamples).toBeUndefined();
  });

  it('skips clips with no audible content or no MIDI home', () => {
    const tracks = [makeTrack(1), makeTrack(2, { kind: 'audio' })];
    const clips = [
      makeClip(1, 1, { gain: 0 }),
      makeClip(2, 1, { notes: [] }),
      makeClip(3, 1, { kind: 'audio' }),
      makeClip(4, 2),
      makeClip(5, 99),
    ];
    expect(buildMidiClipSchedules(tracks, clips, TEMPO_120, SAMPLE_RATE)).toEqual([]);
  });

  it('skips clips on a frozen track (the baked render plays instead)', () => {
    const tracks = [makeTrack(1, { frozen: { assetId: 'baked-1' } }), makeTrack(2)];
    const clips = [makeClip(1, 1), makeClip(2, 2)];
    const schedules = buildMidiClipSchedules(tracks, clips, TEMPO_120, SAMPLE_RATE);
    // Only the unfrozen track's clip schedules; the frozen one is silent.
    expect(schedules.map((schedule) => schedule.id)).toEqual([2]);
    expect(schedules[0].trackId).toBe(2);
  });

  it('clamps the note end to the clip window', () => {
    const clip = makeClip(1, 1, {
      lengthPpq: 2,
      notes: [makeNote({ startPpq: 1, durationPpq: 10 })],
    });
    const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
    expect(schedule.events[0].renderFrame).toBe(SPP);
    expect(schedule.events[1].renderFrame).toBe(2 * SPP - 1);
  });

  it('keeps the note-off at least one sample after the note-on', () => {
    const clip = makeClip(1, 1, {
      lengthPpq: 2,
      notes: [makeNote({ startPpq: 1, durationPpq: 0.00001 })],
    });
    const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
    expect(schedule.events[0].renderFrame).toBe(SPP);
    expect(schedule.events[1].renderFrame).toBe(SPP + 1);
  });

  it('returns the schedules sorted by clip id', () => {
    const clips = [makeClip(7, 1), makeClip(3, 1), makeClip(5, 1)];
    const schedules = buildMidiClipSchedules([makeTrack(1)], clips, TEMPO_120, SAMPLE_RATE);
    expect(schedules.map((schedule) => schedule.id)).toEqual([3, 5, 7]);
  });

  describe('cc lanes', () => {
    it('bakes each CC breakpoint into a control-change event at its frame', () => {
      const clip = makeClip(1, 1, {
        notes: [],
        ccLanes: [
          {
            controller: 1,
            channel: 0,
            points: [
              { ppq: 0, value: 0 },
              { ppq: 2, value: 127 },
            ],
          },
        ],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events).toEqual([
        { renderFrame: 0, word0: ccWord(0, 1, 0), wordCount: 1 },
        { renderFrame: 2 * SPP, word0: ccWord(0, 1, 127), wordCount: 1 },
      ]);
    });

    it('expands linear CC segments into intermediate control-change events', () => {
      const clip = makeClip(1, 1, {
        notes: [],
        ccLanes: [
          {
            controller: 1,
            channel: 0,
            points: [
              { ppq: 0, value: 0, curve: 'linear' },
              { ppq: 1, value: 127 },
            ],
          },
        ],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events.length).toBeGreaterThan(2);
      expect(schedule.events).toContainEqual({
        renderFrame: SPP / 2,
        word0: ccWord(0, 1, 64),
        wordCount: 1,
      });
      expect(schedule.events.at(-1)).toEqual({
        renderFrame: SPP,
        word0: ccWord(0, 1, 127),
        wordCount: 1,
      });
    });

    it('honors the lane channel and drops points outside the clip window', () => {
      const clip = makeClip(1, 1, {
        lengthPpq: 2,
        notes: [],
        ccLanes: [
          {
            controller: 11,
            channel: 2,
            points: [
              { ppq: 1, value: 64 },
              { ppq: 3, value: 100 },
            ],
          },
        ],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events).toEqual([
        { renderFrame: SPP, word0: ccWord(2, 11, 64), wordCount: 1 },
      ]);
    });

    it('still sends CC from a muted (gain 0) clip, with no notes', () => {
      const clip = makeClip(1, 1, {
        gain: 0,
        ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 1, value: 64 }] }],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events).toEqual([
        { renderFrame: SPP, word0: ccWord(0, 1, 64), wordCount: 1 },
      ]);
    });

    it('merges CC events with notes, keeping the event list sorted by frame', () => {
      const clip = makeClip(1, 1, {
        notes: [makeNote({ startPpq: 0, durationPpq: 1 })],
        ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 2, value: 100 }] }],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      const frames = schedule.events.map((event) => event.renderFrame);
      expect(frames).toEqual([...frames].sort((a, b) => a - b));
      expect(schedule.events.at(-1)).toEqual({
        renderFrame: 2 * SPP,
        word0: ccWord(0, 1, 100),
        wordCount: 1,
      });
    });
  });

  describe('pitch-bend lanes', () => {
    it('bakes each pitch-bend point into a 14-bit pitch-bend event at its frame', () => {
      const clip = makeClip(1, 1, {
        notes: [],
        pitchBendLanes: [
          {
            channel: 2,
            points: [
              { ppq: 0, value: 8192 },
              { ppq: 1, value: 4096 },
            ],
          },
        ],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events).toEqual([
        { renderFrame: 0, word0: pitchBendWord(2, 8192), wordCount: 1 },
        { renderFrame: SPP, word0: pitchBendWord(2, 4096), wordCount: 1 },
      ]);
    });

    it('keeps pitch bend from muted clips and drops points outside the clip window', () => {
      const clip = makeClip(1, 1, {
        gain: 0,
        lengthPpq: 1,
        pitchBendLanes: [
          {
            channel: 0,
            points: [
              { ppq: 0.5, value: 16383 },
              { ppq: 2, value: 0 },
            ],
          },
        ],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events).toEqual([
        { renderFrame: SPP / 2, word0: pitchBendWord(0, 16383), wordCount: 1 },
      ]);
    });
  });

  describe('aftertouch lanes', () => {
    it('bakes program-change lanes into MIDI events', () => {
      const clip = makeClip(1, 1, {
        notes: [],
        programChangeLanes: [{ channel: 2, points: [{ ppq: 0.5, program: 12 }] }],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events).toEqual([
        { renderFrame: SPP / 2, word0: pcWord(2, 12), wordCount: 1 },
      ]);
    });

    it('bakes channel pressure and poly key pressure into MIDI events', () => {
      const clip = makeClip(1, 1, {
        notes: [],
        channelPressureLanes: [{ channel: 1, points: [{ ppq: 0.5, value: 70 }] }],
        polyPressureLanes: [{ channel: 1, pitch: 64, points: [{ ppq: 1, value: 90 }] }],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events).toEqual([
        { renderFrame: SPP / 2, word0: channelPressureWord(1, 70), wordCount: 1 },
        { renderFrame: SPP, word0: polyPressureWord(1, 64, 90), wordCount: 1 },
      ]);
    });

    it('keeps aftertouch from muted clips and drops points outside the clip window', () => {
      const clip = makeClip(1, 1, {
        gain: 0,
        lengthPpq: 1,
        channelPressureLanes: [
          {
            channel: 0,
            points: [
              { ppq: 0.25, value: 30 },
              { ppq: 2, value: 100 },
            ],
          },
        ],
      });
      const [schedule] = buildMidiClipSchedules([makeTrack(1)], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events).toEqual([
        { renderFrame: SPP / 4, word0: channelPressureWord(0, 30), wordCount: 1 },
      ]);
    });
  });

  describe('sf2 program prelude', () => {
    const sf2Track = (bank?: number, program?: number): EditorTrack =>
      makeTrack(1, { instrument: { kind: 'sf2', fontId: 'font-a', bank, program } });

    it('emits bank-select CCs and the program change before a frame-0 clip', () => {
      const clip = makeClip(1, 1, { startPpq: 0 });
      const [schedule] = buildMidiClipSchedules([sf2Track(1, 5)], [clip], TEMPO_120, SAMPLE_RATE);
      // The prelude occupies frame 0, so the clip's frame-0 note-on moves to
      // frame 1 to stay strictly after it.
      expect(schedule.events).toEqual([
        { renderFrame: 0, word0: ccWord(0, 0, 1 >> 7), wordCount: 1 },
        { renderFrame: 0, word0: ccWord(0, 32, 1 & 0x7f), wordCount: 1 },
        { renderFrame: 0, word0: pcWord(0, 5), wordCount: 1 },
        { renderFrame: 1, word0: noteOnWord(0, 60, 100), wordCount: 1 },
        { renderFrame: SPP - 1, word0: noteOffWord(0, 60), wordCount: 1 },
      ]);
    });

    it('sits one sample before the clip start when the clip starts later', () => {
      const clip = makeClip(1, 1, { startPpq: 2 });
      // At 60 BPM and 48 kHz one PPQ is 48000 samples.
      const [schedule] = buildMidiClipSchedules([sf2Track(1, 5)], [clip], TEMPO_60, SAMPLE_RATE);
      expect(schedule.startSample).toBe(96000);
      expect(schedule.events.slice(0, 3).map((event) => event.renderFrame)).toEqual([
        95999, 95999, 95999,
      ]);
      expect(schedule.events[3]).toEqual({
        renderFrame: 96000,
        word0: noteOnWord(0, 60, 100),
        wordCount: 1,
      });
    });

    it('emits only the program change when the bank is undefined', () => {
      const clip = makeClip(1, 1, { startPpq: 2 });
      const [schedule] = buildMidiClipSchedules(
        [sf2Track(undefined, 5)],
        [clip],
        TEMPO_120,
        SAMPLE_RATE,
      );
      expect(schedule.events[0]).toEqual({
        renderFrame: 2 * SPP - 1,
        word0: pcWord(0, 5),
        wordCount: 1,
      });
      expect(schedule.events).toHaveLength(3);
    });

    it('emits no prelude when neither bank nor program is set', () => {
      const clip = makeClip(1, 1, { startPpq: 2 });
      const [schedule] = buildMidiClipSchedules([sf2Track()], [clip], TEMPO_120, SAMPLE_RATE);
      expect(schedule.events).toHaveLength(2);
      expect(schedule.events[0].renderFrame).toBe(2 * SPP);
    });

    it('emits the prelude once per distinct note channel', () => {
      const clip = makeClip(1, 1, {
        startPpq: 2,
        notes: [makeNote({ channel: 0 }), makeNote({ id: 2, pitch: 64, channel: 2 })],
      });
      const [schedule] = buildMidiClipSchedules(
        [sf2Track(undefined, 5)],
        [clip],
        TEMPO_120,
        SAMPLE_RATE,
      );
      const preludes = schedule.events.filter((event) => event.renderFrame === 2 * SPP - 1);
      expect(preludes.map((event) => event.word0)).toEqual([pcWord(0, 5), pcWord(2, 5)]);
    });

    describe('multi-timbral channel map', () => {
      // Bank 15361 = GM2 drum-set bank (MSB 120) + kit LSB 1 for channel 9.
      const drumBank = (120 << 7) | 1;
      const multiTrack = makeTrack(1, {
        instrument: {
          kind: 'sf2',
          fontId: 'font-a',
          bank: 0,
          program: 5,
          channelMap: [
            { channel: 0, program: 40 },
            { channel: 9, bank: drumBank, program: 0 },
          ],
        },
      });

      it('emits each mapped channel its own bank/program prelude', () => {
        const clip = makeClip(1, 1, {
          startPpq: 2,
          notes: [makeNote({ channel: 0 }), makeNote({ id: 2, pitch: 38, channel: 9 })],
        });
        const [schedule] = buildMidiClipSchedules([multiTrack], [clip], TEMPO_120, SAMPLE_RATE);
        const preludes = schedule.events
          .filter((event) => event.renderFrame === 2 * SPP - 1)
          .map((event) => event.word0);
        // Channel 0: program 40 (map entry has no bank -> program change only).
        // Channel 9: bank-select MSB 120 + LSB 1, then program 0.
        expect(preludes).toEqual([
          pcWord(0, 40),
          ccWord(9, 0, 120),
          ccWord(9, 32, 1),
          pcWord(9, 0),
        ]);
      });

      it('falls back to the track-level bank/program for an unmapped channel', () => {
        const clip = makeClip(1, 1, {
          startPpq: 2,
          notes: [makeNote({ id: 3, pitch: 64, channel: 3 })],
        });
        const [schedule] = buildMidiClipSchedules([multiTrack], [clip], TEMPO_120, SAMPLE_RATE);
        const preludes = schedule.events
          .filter((event) => event.renderFrame === 2 * SPP - 1)
          .map((event) => event.word0);
        // Channel 3 is absent from the map -> track-level bank 0 + program 5.
        expect(preludes).toEqual([ccWord(3, 0, 0), ccWord(3, 32, 0), pcWord(3, 5)]);
      });
    });
  });
});

describe('createMidiSync', () => {
  it('binds the default synth preset to instrument-less midi tracks only', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);

    await sync.sync([makeTrack(1), makeTrack(2, { kind: 'audio' })], [], TEMPO_120);
    expect(engine.setSynthInstrument).toHaveBeenCalledTimes(1);
    expect(engine.setSynthInstrument).toHaveBeenCalledWith(1, DEFAULT_SYNTH_PRESET);
  });

  it('routes an external-midi track externally without binding an internal synth', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const track = makeTrack(1, {
      instrument: { kind: 'external-midi', outputPortId: 'out-1', channel: 2 },
    });

    await sync.sync([track], [], TEMPO_120);
    expect(engine.setMidiDestinationExternal).toHaveBeenCalledWith(1, true);
    expect(engine.setSynthInstrument).not.toHaveBeenCalled();
    expect(engine.setSf2Instrument).not.toHaveBeenCalled();
  });

  it('routes a project-inherited external-midi track externally', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const track = makeTrack(1, {
      externalMidiMode: 'project',
      instrument: { kind: 'synth-preset', preset: 'saw-lead' },
    });

    await sync.sync([track], [], TEMPO_120, {
      kind: 'external-midi',
      outputPortId: 'out-1',
      channel: 2,
      sendClock: true,
    });
    expect(engine.setMidiDestinationExternal).toHaveBeenCalledWith(1, true);
    expect(engine.setSynthInstrument).not.toHaveBeenCalled();
    expect(engine.setExternalMidiClockEnabled).toHaveBeenCalledWith(true);
  });

  it('clears external routing for an internal track and toggles the clock with sendClock', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);

    await sync.sync([makeTrack(1)], [], TEMPO_120);
    expect(engine.setMidiDestinationExternal).toHaveBeenCalledWith(1, false);
    // No external track opted into clock, so it stays disabled.
    expect(engine.setExternalMidiClockEnabled).toHaveBeenCalledWith(false);

    engine.setExternalMidiClockEnabled.mockClear();
    await sync.sync(
      [
        makeTrack(1, {
          instrument: { kind: 'external-midi', outputPortId: 'out-1', channel: 0, sendClock: true },
        }),
      ],
      [],
      TEMPO_120,
    );
    expect(engine.setExternalMidiClockEnabled).toHaveBeenCalledWith(true);
  });

  it('applies the preset resolver to preset names', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle, { resolvePreset: (preset) => `va:${preset}` });

    const track = makeTrack(1, { instrument: { kind: 'synth-preset', preset: 'saw-lead' } });
    await sync.sync([track], [], TEMPO_120);
    expect(engine.setSynthInstrument).toHaveBeenCalledWith(1, 'va:saw-lead');
  });

  it('falls back to the default synth when an imported preset fails to bind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { handle, engine } = makeHandle();
      engine.setSynthInstrument.mockImplementationOnce(() => {
        throw new Error('failed to bind MIDI instrument');
      });
      const sync = createMidiSync(handle);
      const track = makeTrack(1, {
        instrument: { kind: 'synth-preset', preset: 'acoustic-piano' },
      });

      await sync.sync([track], [], TEMPO_120);

      expect(engine.setSynthInstrument).toHaveBeenNthCalledWith(1, 1, 'acoustic-piano');
      expect(engine.setSynthInstrument).toHaveBeenNthCalledWith(2, 1, DEFAULT_SYNTH_PRESET);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'synth-preset:acoustic-piano failed to bind on track 1 (Track 1) destination 1',
        ),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('reports the track and instrument when MIDI instrument fallback also fails', async () => {
    const { handle, engine } = makeHandle();
    engine.setSynthInstrument.mockImplementation(() => {
      throw new Error('failed to bind MIDI instrument');
    });
    const sync = createMidiSync(handle);
    const track = makeTrack(1, { instrument: { kind: 'synth-preset', preset: 'acoustic-piano' } });

    await expect(sync.sync([track], [], TEMPO_120)).rejects.toThrow(
      'Failed to bind MIDI instrument for track 1 (Track 1) destination 1: synth-preset:acoustic-piano',
    );
  });

  it('reuses an existing destination after the internal instrument limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { handle, engine } = makeHandle();
      const sync = createMidiSync(handle);
      const tracks = Array.from({ length: 17 }, (_, index) =>
        makeTrack(index + 1, {
          instrument: { kind: 'synth-preset', preset: 'acoustic-piano' },
        }),
      );
      const clips = tracks.map((track) => makeClip(track.id, track.id));

      await sync.sync(tracks, clips, TEMPO_120);

      expect(engine.setSynthInstrument).toHaveBeenCalledTimes(16);
      expect(engine.setSynthInstrument).toHaveBeenNthCalledWith(16, 16, 'acoustic-piano');
      const schedules = engine.setMidiClips.mock.calls[0][0];
      expect(schedules[15]).toMatchObject({ trackId: 16, destinationId: 16 });
      expect(schedules[16]).toMatchObject({ trackId: 17, destinationId: 1 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('passes a synth patch object through unchanged', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const patch: SynthPatch = { preset: 'saw-lead', cutoffHz: 800 };

    await sync.sync([makeTrack(1, { instrument: { kind: 'synth-patch', patch } })], [], TEMPO_120);
    expect(engine.setSynthInstrument).toHaveBeenCalledTimes(1);
    expect(engine.setSynthInstrument.mock.calls[0]).toEqual([1, patch]);
    expect(engine.setSynthInstrument.mock.calls[0][1]).toBe(patch);
  });

  it('applies enabled instrument automation to synth patches at the sync PPQ', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const patch: SynthPatch = { preset: 'saw-lead', cutoffHz: 400, resonance: 0.1 };
    const track = makeTrack(1, { instrument: { kind: 'synth-patch', patch } });

    await sync.sync(
      [track],
      [],
      TEMPO_120,
      undefined,
      [
        {
          target: 1,
          param: instrumentAutomationParam('cutoffHz'),
          enabled: true,
          points: [
            { ppq: 0, value: 400 },
            { ppq: 4, value: 1200 },
          ],
        },
        {
          target: 1,
          param: instrumentAutomationParam('resonance'),
          enabled: false,
          points: [{ ppq: 0, value: 0.8 }],
        },
      ],
      2,
    );

    expect(engine.setSynthInstrument).toHaveBeenCalledTimes(1);
    expect(engine.setSynthInstrument).toHaveBeenCalledWith(1, {
      preset: 'saw-lead',
      cutoffHz: 800,
      resonance: 0.1,
    });
    expect(engine.setSynthInstrument.mock.calls[0][1]).not.toBe(patch);
  });

  it('rebinds synth patches when only instrument automation value changes', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const track = makeTrack(1, {
      instrument: { kind: 'synth-patch', patch: { preset: 'saw-lead', cutoffHz: 400 } },
    });
    const lanes = [
      {
        target: 1,
        param: instrumentAutomationParam('cutoffHz'),
        enabled: true,
        points: [
          { ppq: 0, value: 400 },
          { ppq: 4, value: 1200 },
        ],
      },
    ];

    await sync.sync([track], [], TEMPO_120, undefined, lanes, 0);
    await sync.sync([track], [], TEMPO_120, undefined, lanes, 4);

    expect(engine.setSynthInstrument).toHaveBeenCalledTimes(2);
    expect(engine.setSynthInstrument).toHaveBeenNthCalledWith(1, 1, {
      preset: 'saw-lead',
      cutoffHz: 400,
    });
    expect(engine.setSynthInstrument).toHaveBeenNthCalledWith(2, 1, {
      preset: 'saw-lead',
      cutoffHz: 1200,
    });
  });

  it('installs, dedupes and clears live MIDI-FX per track', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const midiFx = { ...DEFAULT_MIDI_FX_CONFIG, transposeSemitones: 12 };
    const expectedJson = midiFxConfigJson(midiFx);

    await sync.sync([makeTrack(1, { midiFx })], [], TEMPO_120);
    expect(engine.setMidiFx).toHaveBeenCalledWith(1, expectedJson);
    expect(engine.clearMidiFx).not.toHaveBeenCalled();

    await sync.sync([makeTrack(1, { midiFx })], [], TEMPO_120);
    expect(engine.setMidiFx).toHaveBeenCalledTimes(1);

    await sync.sync([makeTrack(1)], [], TEMPO_120);
    expect(engine.clearMidiFx).toHaveBeenCalledWith(1);
  });

  it('installs MIDI-FX on the deduped MIDI destination used by schedules', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { handle, engine } = makeHandle();
      const sync = createMidiSync(handle);
      const midiFx = { ...DEFAULT_MIDI_FX_CONFIG, transposeSemitones: 12 };
      const expectedJson = midiFxConfigJson(midiFx);
      const tracks = Array.from({ length: 17 }, (_, index) =>
        makeTrack(index + 1, {
          instrument: { kind: 'synth-preset', preset: 'acoustic-piano' },
          ...(index === 16 ? { midiFx } : {}),
        }),
      );
      const clips = tracks.map((track) => makeClip(track.id, track.id));

      await sync.sync(tracks, clips, TEMPO_120);

      const schedules = engine.setMidiClips.mock.calls[0][0];
      expect(schedules[16]).toMatchObject({ trackId: 17, destinationId: 1 });
      expect(engine.setMidiFx).toHaveBeenCalledWith(1, expectedJson);
      expect(engine.setMidiFx).not.toHaveBeenCalledWith(17, expectedJson);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not install MIDI-FX for frozen tracks', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const midiFx = { ...DEFAULT_MIDI_FX_CONFIG, transposeSemitones: 12 };

    await sync.sync([makeTrack(1, { frozen: { assetId: 'baked-1' }, midiFx })], [], TEMPO_120);

    expect(engine.setMidiFx).not.toHaveBeenCalled();
    expect(engine.clearMidiFx).not.toHaveBeenCalled();
  });

  it('loads a SoundFont once per font id and binds each sf2 track', async () => {
    const { handle, engine } = makeHandle();
    const bytes = new Uint8Array([1, 2, 3]);
    const loadFont = vi.fn(async () => bytes);
    const sync = createMidiSync(handle, { loadFont });
    const tracks = [
      makeTrack(1, { instrument: { kind: 'sf2', fontId: 'font-a' } }),
      makeTrack(2, { instrument: { kind: 'sf2', fontId: 'font-a' } }),
    ];

    await sync.sync(tracks, [], TEMPO_120);
    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(loadFont).toHaveBeenCalledWith('font-a');
    expect(engine.loadSoundFont).toHaveBeenCalledTimes(1);
    expect(engine.loadSoundFont).toHaveBeenCalledWith(bytes);
    expect(engine.setSf2Instrument).toHaveBeenCalledTimes(2);
    expect(engine.setSf2Instrument).toHaveBeenNthCalledWith(1, 1, {});
    expect(engine.setSf2Instrument).toHaveBeenNthCalledWith(2, 2, {});

    // A second sync with the same font reloads nothing.
    await sync.sync(tracks, [], TEMPO_120);
    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(engine.loadSoundFont).toHaveBeenCalledTimes(1);
    expect(engine.setSf2Instrument).toHaveBeenCalledTimes(2);
  });

  it('forwards the SF2 master gain and voice cap when binding the track', async () => {
    const { handle, engine } = makeHandle();
    const loadFont = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const sync = createMidiSync(handle, { loadFont });
    const tracks = [
      makeTrack(1, { instrument: { kind: 'sf2', fontId: 'font-a', gain: 1.5, polyphony: 24 } }),
      makeTrack(2, { instrument: { kind: 'sf2', fontId: 'font-a' } }),
    ];

    await sync.sync(tracks, [], TEMPO_120);
    // Track 1 carries explicit gain/polyphony; track 2 keeps the engine defaults.
    expect(engine.setSf2Instrument).toHaveBeenNthCalledWith(1, 1, { gain: 1.5, polyphony: 24 });
    expect(engine.setSf2Instrument).toHaveBeenNthCalledWith(2, 2, {});
  });

  it('does not load a font or bind an instrument for a frozen SF2 track', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { handle, engine } = makeHandle();
      const loadFont = vi.fn(async () => new Uint8Array([1]));
      const sync = createMidiSync(handle, { loadFont });
      const tracks = [
        // A live SF2 track plus a frozen one requesting a different font: the
        // frozen track must neither load its font nor trip the contention warn.
        makeTrack(1, { instrument: { kind: 'sf2', fontId: 'font-a' } }),
        makeTrack(2, {
          instrument: { kind: 'sf2', fontId: 'font-b' },
          frozen: { assetId: 'baked-1' },
        }),
      ];

      await sync.sync(tracks, [], TEMPO_120);
      expect(loadFont).toHaveBeenCalledTimes(1);
      expect(loadFont).toHaveBeenCalledWith('font-a');
      expect(engine.setSf2Instrument).toHaveBeenCalledTimes(1);
      expect(engine.setSf2Instrument).toHaveBeenCalledWith(1, {});
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('clears MIDI schedules when a track freezes and restores them when it unfreezes', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const live = makeTrack(1);
    const frozen = makeTrack(1, { frozen: { assetId: 'baked-1' } });
    const clips = [makeClip(1, 1)];

    await sync.sync([live], clips, TEMPO_120);
    expect(engine.setMidiClips).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 1, trackId: 1 }),
    ]);
    expect(sync.scheduledClipCount()).toBe(1);

    await sync.sync([frozen], clips, TEMPO_120);
    expect(engine.setMidiClips).toHaveBeenLastCalledWith([]);
    expect(sync.scheduledClipCount()).toBe(0);

    await sync.sync([live], clips, TEMPO_120);
    expect(engine.setMidiClips).toHaveBeenCalledTimes(3);
    expect(engine.setMidiClips).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 1, trackId: 1 }),
    ]);
    expect(sync.scheduledClipCount()).toBe(1);
  });

  it('warns on distinct SoundFonts and loads only the last track in order', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { handle, engine } = makeHandle();
      const loadFont = vi.fn(async (fontId: string) => new Uint8Array([fontId.length]));
      const sync = createMidiSync(handle, { loadFont });
      const tracks = [
        makeTrack(1, { instrument: { kind: 'sf2', fontId: 'font-a' } }),
        makeTrack(2, { instrument: { kind: 'sf2', fontId: 'font-b' } }),
      ];

      await sync.sync(tracks, [], TEMPO_120);
      expect(warn).toHaveBeenCalledTimes(1);
      // Only the winning font (the last SF2 track in order) loads into the
      // single global slot, deterministically and matching the offline render.
      expect(loadFont).toHaveBeenCalledTimes(1);
      expect(loadFont).toHaveBeenCalledWith('font-b');
      expect(engine.loadSoundFont).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the winning font fixed when a non-last SF2 track is edited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { handle } = makeHandle();
      const loadFont = vi.fn(async (fontId: string) => new Uint8Array([fontId.length]));
      const sync = createMidiSync(handle, { loadFont });
      const tracks = [
        makeTrack(1, { instrument: { kind: 'sf2', fontId: 'font-a' } }),
        makeTrack(2, { instrument: { kind: 'sf2', fontId: 'font-b' } }),
      ];
      await sync.sync(tracks, [], TEMPO_120);
      expect(loadFont).toHaveBeenLastCalledWith('font-b');

      // Editing the first (non-winning) track must not steal the global slot:
      // the last track in order still wins, so live stays consistent.
      const edited = [
        makeTrack(1, { instrument: { kind: 'sf2', fontId: 'font-c' } }),
        makeTrack(2, { instrument: { kind: 'sf2', fontId: 'font-b' } }),
      ];
      await sync.sync(edited, [], TEMPO_120);
      // font-b is already the loaded winner, so no extra font load happens.
      expect(loadFont).toHaveBeenCalledTimes(1);
      expect(loadFont).toHaveBeenLastCalledWith('font-b');
    } finally {
      warn.mockRestore();
    }
  });

  it('dedupes unchanged state and re-sends on note edits', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const tracks = [makeTrack(1)];
    const clip = makeClip(1, 1, { startPpq: 2 });

    await sync.sync(tracks, [clip], TEMPO_120);
    expect(engine.setMidiClips).toHaveBeenCalledTimes(1);
    expect(engine.setSynthInstrument).toHaveBeenCalledTimes(1);

    // An identical second sync sends nothing.
    await sync.sync(tracks, [makeClip(1, 1, { startPpq: 2 })], TEMPO_120);
    expect(engine.setMidiClips).toHaveBeenCalledTimes(1);
    expect(engine.setSynthInstrument).toHaveBeenCalledTimes(1);

    // A note edit re-sends the full clip set with the new schedule.
    const edited = makeClip(1, 1, { startPpq: 2, notes: [makeNote({ velocity: 64 })] });
    await sync.sync(tracks, [edited], TEMPO_120);
    expect(engine.setMidiClips).toHaveBeenCalledTimes(2);
    const resent = engine.setMidiClips.mock.calls[1][0];
    expect(resent[0].events[0].word0).toBe(noteOnWord(0, 60, 64));
  });

  it('re-sends when only note-off velocity changes', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const tracks = [makeTrack(1)];

    await sync.sync(
      tracks,
      [makeClip(1, 1, { notes: [makeNote({ offVelocity: 16 })] })],
      TEMPO_120,
    );
    await sync.sync(
      tracks,
      [makeClip(1, 1, { notes: [makeNote({ offVelocity: 96 })] })],
      TEMPO_120,
    );

    expect(engine.setMidiClips).toHaveBeenCalledTimes(2);
    const resent = engine.setMidiClips.mock.calls[1][0];
    expect(resent[0].events[1].word0).toBe(noteOffWord(0, 60, 96));
  });

  it('re-sends when only MIDI expression lanes change', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const tracks = [makeTrack(1)];
    const base = makeClip(1, 1, {
      notes: [],
      ccLanes: [{ controller: 11, channel: 0, points: [{ ppq: 0, value: 64 }] }],
      pitchBendLanes: [{ channel: 0, points: [{ ppq: 1, value: 8192 }] }],
      programChangeLanes: [{ channel: 0, points: [{ ppq: 1.5, program: 8 }] }],
      channelPressureLanes: [{ channel: 0, points: [{ ppq: 2, value: 32 }] }],
      polyPressureLanes: [{ channel: 0, pitch: 60, points: [{ ppq: 3, value: 48 }] }],
    });
    const edited = makeClip(1, 1, {
      notes: [],
      ccLanes: [{ controller: 11, channel: 0, points: [{ ppq: 0, value: 96 }] }],
      pitchBendLanes: [{ channel: 0, points: [{ ppq: 1, value: 4096 }] }],
      programChangeLanes: [{ channel: 0, points: [{ ppq: 1.5, program: 10 }] }],
      channelPressureLanes: [{ channel: 0, points: [{ ppq: 2, value: 64 }] }],
      polyPressureLanes: [{ channel: 0, pitch: 60, points: [{ ppq: 3, value: 80 }] }],
    });

    await sync.sync(tracks, [base], TEMPO_120);
    await sync.sync(tracks, [edited], TEMPO_120);

    expect(engine.setMidiClips).toHaveBeenCalledTimes(2);
    const events = engine.setMidiClips.mock.calls[1][0][0].events;
    expect(events).toEqual([
      { renderFrame: 0, word0: ccWord(0, 11, 96), wordCount: 1 },
      { renderFrame: SPP, word0: pitchBendWord(0, 4096), wordCount: 1 },
      { renderFrame: 1.5 * SPP, word0: pcWord(0, 10), wordCount: 1 },
      { renderFrame: 2 * SPP, word0: channelPressureWord(0, 64), wordCount: 1 },
      { renderFrame: 3 * SPP, word0: polyPressureWord(0, 60, 80), wordCount: 1 },
    ]);
  });

  it('re-bakes and re-sends the clip frames after a tempo-map change', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const tracks = [makeTrack(1)];
    const clips = [makeClip(1, 1, { startPpq: 2 })];

    await sync.sync(tracks, clips, TEMPO_120);
    expect(engine.setMidiClips.mock.calls[0][0][0].startSample).toBe(2 * SPP);

    // At 90 BPM one PPQ is 60/90 s = 32000 samples at 48 kHz.
    await sync.sync(tracks, clips, [{ startPpq: 0, bpm: 90 }]);
    expect(engine.setMidiClips).toHaveBeenCalledTimes(2);
    expect(engine.setMidiClips.mock.calls[1][0][0].startSample).toBe(2 * 32000);
  });

  it('reports the schedule count of the last send', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle);
    const tracks = [makeTrack(1)];

    expect(sync.scheduledClipCount()).toBe(0);
    await sync.sync(tracks, [makeClip(1, 1), makeClip(2, 1, { startPpq: 8 })], TEMPO_120);
    expect(sync.scheduledClipCount()).toBe(2);

    await sync.sync(tracks, [], TEMPO_120);
    expect(engine.setMidiClips).toHaveBeenLastCalledWith([]);
    expect(sync.scheduledClipCount()).toBe(0);
  });
});
