import { beforeEach, describe, expect, it } from 'vitest';
import { type NotatedScore, noteValueToPpq } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import {
  assignGrandStaffUnits,
  type QuantizeOptions,
  quantizeToScore,
  splitUnitAcrossStaves,
  staffForMeanPitch,
  type VoiceUnit,
} from '@/notation/quantize';
import { scoreSourceIdentitiesFromXmlId } from '@/notation/source-identity';
import type { EditorNote } from '@/project/types';

let nextId = 1;

beforeEach(() => {
  nextId = 1;
});

/** Builds an EditorNote fixture with editor defaults. */
function makeNote(
  pitch: number,
  startPpq: number,
  durationPpq: number,
  id = nextId++,
  overrides: Partial<EditorNote> = {},
): EditorNote {
  return { id, pitch, velocity: 96, startPpq, durationPpq, channel: 0, ...overrides };
}

/** Default options: 16th grid, 4/4, C major, two measures (0..8). */
function baseOptions(overrides: Partial<QuantizeOptions> = {}): QuantizeOptions {
  return {
    divisionPpq: 0.25,
    timeSig: { beats: 4, beatUnit: 4 },
    keyFifths: 0,
    clipStartPpq: 0,
    clipLengthPpq: 8,
    ...overrides,
  };
}

/** Asserts the structural invariants every quantized score must satisfy. */
function assertInvariants(score: NotatedScore): void {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      expect(measure.voices.length).toBeGreaterThan(0);
      let prevVoice = 0;
      for (const voice of measure.voices) {
        // Voices are listed in ascending order without duplicates.
        expect(voice.voice).toBeGreaterThan(prevVoice);
        prevVoice = voice.voice;
        let cursor = measure.startPpq;
        for (const event of voice.events) {
          expect(event.voice).toBe(voice.voice);
          // Gap-free: each event starts where the previous one ended.
          expect(event.startPpq).toBeCloseTo(cursor, 6);
          // Stored duration normally matches the notated value. A full-measure
          // rest may use a placeholder value because MusicXML writes it as
          // `<rest measure="yes"/>` without a `<type>`.
          const measureRest =
            event.kind === 'rest' &&
            voice.events.length === 1 &&
            event.startPpq === measure.startPpq &&
            event.durationPpq === measure.lengthPpq;
          if (!measureRest) {
            expect(event.durationPpq).toBeCloseTo(noteValueToPpq(event.value), 9);
          }
          if (event.kind === 'note') {
            expect(event.pitches.length).toBeGreaterThan(0);
            for (let i = 1; i < event.pitches.length; i++) {
              expect(event.pitches[i]).toBeGreaterThan(event.pitches[i - 1]);
            }
          } else {
            expect(event.pitches).toEqual([]);
            expect(event.tieStart).toBe(false);
            expect(event.tieStop).toBe(false);
          }
          cursor += event.durationPpq;
        }
        // Gap-free: the voice covers the measure exactly.
        expect(cursor).toBeCloseTo(measure.startPpq + measure.lengthPpq, 6);
      }
    }
  }
}

/** Quantizes and checks invariants in one step. */
function quantize(notes: EditorNote[], options: QuantizeOptions): NotatedScore {
  const score = quantizeToScore(notes, options);
  assertInvariants(score);
  return score;
}

type Tie = 'none' | 'start' | 'stop' | 'both';

interface SimpleEvent {
  kind: 'note' | 'rest';
  pitches: number[];
  start: number;
  dur: number;
  value: string;
  tie: Tie;
}

/** Shorthand for an expected rest event. */
function r(start: number, dur: number, value: string): SimpleEvent {
  return { kind: 'rest', pitches: [], start, dur, value, tie: 'none' };
}

/** Shorthand for an expected note/chord event. */
function n(
  pitches: number[],
  start: number,
  dur: number,
  value: string,
  tie: Tie = 'none',
): SimpleEvent {
  return { kind: 'note', pitches, start, dur, value, tie };
}

/** Extracts a voice's events in comparable form ('quarter.' = dotted quarter). */
function voiceEvents(score: NotatedScore, measureIndex: number, voiceNo: number): SimpleEvent[] {
  const measure = score.parts[0].measures[measureIndex];
  const voice = measure.voices.find((v) => v.voice === voiceNo);
  if (!voice) throw new Error(`voice ${voiceNo} missing in measure ${measureIndex}`);
  return voice.events.map((e) => ({
    kind: e.kind,
    pitches: e.pitches,
    start: e.startPpq,
    dur: e.durationPpq,
    value: `${e.value.base}${'.'.repeat(e.value.dots)}${
      e.value.tuplet ? `t${e.value.tuplet.actual}:${e.value.tuplet.normal}` : ''
    }`,
    tie: e.tieStart && e.tieStop ? 'both' : e.tieStart ? 'start' : e.tieStop ? 'stop' : 'none',
  }));
}

describe('quantizeToScore: score shell', () => {
  it('renders empty input as whole-measure rests', () => {
    const score = quantize([], baseOptions());
    expect(score.parts).toHaveLength(1);
    expect(score.parts[0].measures).toHaveLength(2);
    expect(voiceEvents(score, 0, 1)).toEqual([r(0, 4, 'whole')]);
    expect(voiceEvents(score, 1, 1)).toEqual([r(4, 4, 'whole')]);
  });

  it('uses one measure rest for an unrepresentable 5/4 empty measure', () => {
    const score = quantize(
      [],
      baseOptions({ timeSig: { beats: 5, beatUnit: 4 }, clipLengthPpq: 5 }),
    );

    expect(voiceEvents(score, 0, 1)).toEqual([r(0, 5, 'whole')]);
  });

  it('passes through keyFifths, divisions, part id/name, and time signature', () => {
    const score = quantize([], baseOptions({ keyFifths: -3, partId: 'P7', partName: 'Cello' }));
    expect(score.keyFifths).toBe(-3);
    expect(score.divisions).toBe(960);
    expect(score.parts[0].id).toBe('P7');
    expect(score.parts[0].name).toBe('Cello');
    expect(score.parts[0].measures[0].timeSig).toEqual({ beats: 4, beatUnit: 4 });
  });

  it('carries source MIDI channels onto notated events', () => {
    const score = quantize(
      [
        makeNote(36, 0, 0.5, nextId++, { channel: 9 }),
        makeNote(38, 0, 0.5, nextId++, { channel: 9 }),
      ],
      baseOptions({ clipLengthPpq: 4 }),
    );
    const event = score.parts[0].measures[0].voices[0].events[0];
    expect(event.kind).toBe('note');
    expect(event.midiChannels).toEqual([9]);
  });

  it('keeps representative velocity on notated events', () => {
    const score = quantize(
      [makeNote(60, 0, 1, nextId++, { velocity: 118 })],
      baseOptions({ clipLengthPpq: 4 }),
    );
    expect(score.parts[0].measures[0].voices[0].events[0].velocity).toBe(118);
  });

  it('uses defaults for part id and name', () => {
    const score = quantize([], baseOptions());
    expect(score.parts[0].id).toBe('P1');
    expect(score.parts[0].name).toBe('');
  });

  it('lays out the measure grid from the time signature', () => {
    const score = quantize(
      [],
      baseOptions({ timeSig: { beats: 3, beatUnit: 4 }, clipLengthPpq: 9 }),
    );
    expect(score.parts[0].measures.map((m) => [m.startPpq, m.lengthPpq])).toEqual([
      [0, 3],
      [3, 3],
      [6, 3],
    ]);
  });

  it('keeps an opening pickup as a short first measure before full bars', () => {
    const score = quantize(
      [makeNote(60, 0, 1), makeNote(62, 1, 4)],
      baseOptions({ clipLengthPpq: 5, pickupLengthPpq: 1 }),
    );
    expect(score.parts[0].measures.map((measure) => [measure.startPpq, measure.lengthPpq])).toEqual(
      [
        [0, 1],
        [1, 4],
      ],
    );
  });

  it('lays out measures from a project time-signature map', () => {
    const score = quantize(
      [],
      baseOptions({
        clipLengthPpq: 10,
        timeSignatures: [
          { startPpq: 0, numerator: 4, denominator: 4 },
          { startPpq: 4, numerator: 3, denominator: 4 },
        ],
      }),
    );

    expect(score.parts[0].measures.map((m) => [m.startPpq, m.lengthPpq, m.timeSig])).toEqual([
      [0, 4, { beats: 4, beatUnit: 4 }],
      [4, 3, { beats: 3, beatUnit: 4 }],
      [7, 3, { beats: 3, beatUnit: 4 }],
    ]);
  });
});

describe('quantizeToScore: grid quantization', () => {
  it('snaps starts and ends to the grid and notates the result', () => {
    const score = quantize([makeNote(60, 0.13, 0.9)], baseOptions());
    expect(voiceEvents(score, 0, 1)).toEqual([
      r(0, 0.25, '16th'),
      n([60], 0.25, 0.75, 'eighth.'),
      r(1, 1, 'quarter'),
      r(2, 1, 'quarter'),
      r(3, 1, 'quarter'),
    ]);
  });

  it('keeps notes that quantize to zero length at one grid step', () => {
    const score = quantize([makeNote(60, 0.6, 0.01)], baseOptions());
    expect(voiceEvents(score, 0, 1)[1]).toEqual(n([60], 0.5, 0.25, '16th'));
  });

  it('supports the finest grid (64th notes)', () => {
    const score = quantize([makeNote(60, 0, 0.01)], baseOptions({ divisionPpq: 0.0625 }));
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([60], 0, 0.0625, '64th'));
  });

  it('supports eighth-note triplet quantization', () => {
    const score = quantize(
      [makeNote(60, 0, 1 / 3), makeNote(62, 1 / 3, 1 / 3), makeNote(64, 2 / 3, 1 / 3)],
      baseOptions({ divisionPpq: 1 / 3, clipLengthPpq: 4 }),
    );

    const events = voiceEvents(score, 0, 1);
    expect(events.map((event) => [event.kind, event.pitches, event.value])).toEqual([
      ['note', [60], 'eightht3:2'],
      ['note', [62], 'eightht3:2'],
      ['note', [64], 'eightht3:2'],
      ['rest', [], 'quarter'],
      ['rest', [], 'quarter'],
      ['rest', [], 'quarter'],
    ]);
    expect(events[0].start).toBeCloseTo(0, 9);
    expect(events[1].start).toBeCloseTo(1 / 3, 9);
    expect(events[2].start).toBeCloseTo(2 / 3, 9);
    expect(events[0].dur).toBeCloseTo(1 / 3, 9);
    expect(events[1].dur).toBeCloseTo(1 / 3, 9);
    expect(events[2].dur).toBeCloseTo(1 / 3, 9);
  });

  it('does not mutate the input notes', () => {
    const notes = [makeNote(60, 0.13, 0.9), makeNote(64, 3.7, 2.2)];
    const before = structuredClone(notes);
    quantize(notes, baseOptions());
    expect(notes).toEqual(before);
  });

  it('is deterministic regardless of input order', () => {
    const notes = [
      makeNote(60, 0, 1),
      makeNote(72, 0.5, 2),
      makeNote(64, 0, 1),
      makeNote(48, 3, 2),
    ];
    const forward = quantize(notes, baseOptions());
    const reversed = quantize([...notes].reverse(), baseOptions());
    expect(reversed).toEqual(forward);
  });
});

describe('quantizeToScore: clip window clamping', () => {
  const opts = baseOptions({ clipStartPpq: 4, clipLengthPpq: 4 });

  it('drops notes that end at or before the clip start', () => {
    const score = quantize([makeNote(60, 1, 2)], opts);
    expect(voiceEvents(score, 0, 1)).toEqual([r(4, 4, 'whole')]);
  });

  it('clamps notes that begin before the clip start but sound into it', () => {
    const score = quantize([makeNote(60, 3, 2)], opts);
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([60], 4, 1, 'quarter'));
  });

  it('clamps notes that sound past the clip end', () => {
    const score = quantize([makeNote(60, 7.5, 2)], opts);
    const events = voiceEvents(score, 0, 1);
    expect(events[events.length - 1]).toEqual(n([60], 7.5, 0.5, 'eighth'));
  });

  it('drops notes that start at or after the clip end', () => {
    const score = quantize([makeNote(60, 8, 1), makeNote(62, 8.2, 1)], opts);
    expect(voiceEvents(score, 0, 1)).toEqual([r(4, 4, 'whole')]);
  });
});

describe('quantizeToScore: chords', () => {
  it('merges equal start/duration notes within an octave into one chord, pitches ascending', () => {
    const score = quantize(
      [makeNote(67, 0, 1), makeNote(60, 0, 1), makeNote(64, 0, 1)],
      baseOptions(),
    );
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([60, 64, 67], 0, 1, 'quarter'));
    expect(score.parts[0].measures[0].voices).toHaveLength(1);
  });

  it('deduplicates identical pitches inside a chord', () => {
    const score = quantize(
      [makeNote(60, 0, 1), makeNote(60, 0, 1), makeNote(64, 0, 1)],
      baseOptions(),
    );
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([60, 64], 0, 1, 'quarter'));
  });

  it('separates simultaneous kick and upper-kit notes into drum voices', () => {
    const score = quantize(
      [
        makeNote(36, 0, 0.5, nextId++, { channel: 9 }),
        makeNote(38, 0, 0.5, nextId++, { channel: 9 }),
        makeNote(42, 0, 0.5, nextId++, { channel: 9 }),
      ],
      baseOptions({ clipLengthPpq: 4 }),
    );
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([38, 42], 0, 0.5, 'eighth'));
    expect(voiceEvents(score, 0, 2)[0]).toEqual(n([36], 0, 0.5, 'eighth'));
  });

  it('uses single-staff voices for percussion requested with a grand staff', () => {
    const score = quantize(
      [
        makeNote(36, 0, 0.5, nextId++, { channel: 9 }),
        makeNote(42, 0, 0.5, nextId++, { channel: 9 }),
      ],
      baseOptions({ clef: 'grand', clipLengthPpq: 4 }),
    );

    expect(score.parts[0].clef).toBe('treble');
    expect(score.parts[0].measures[0].voices.map((voice) => voice.voice)).toEqual([1, 2]);
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([42], 0, 0.5, 'eighth'));
    expect(voiceEvents(score, 0, 2)[0]).toEqual(n([36], 0, 0.5, 'eighth'));
  });

  it('keeps kicks in voice 2 even when they do not overlap upper-kit notes', () => {
    const score = quantize(
      [
        makeNote(36, 0, 0.5, nextId++, { channel: 9 }),
        makeNote(42, 1, 0.5, nextId++, { channel: 9 }),
      ],
      baseOptions({ clipLengthPpq: 4 }),
    );

    expect(voiceEvents(score, 0, 1)).toContainEqual(n([42], 1, 0.5, 'eighth'));
    expect(voiceEvents(score, 0, 2)).toContainEqual(n([36], 0, 0.5, 'eighth'));
  });

  it('splits simultaneous notes wider than an octave into voices', () => {
    const score = quantize([makeNote(48, 0, 1), makeNote(72, 0, 1)], baseOptions());
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([72], 0, 1, 'quarter'));
    expect(voiceEvents(score, 0, 2)[0]).toEqual(n([48], 0, 1, 'quarter'));
  });

  it('ties every pitch of a chord across a barline (per-event ties)', () => {
    const score = quantize([makeNote(60, 3, 2), makeNote(64, 3, 2)], baseOptions());
    expect(voiceEvents(score, 0, 1)[3]).toEqual(n([60, 64], 3, 1, 'quarter', 'start'));
    expect(voiceEvents(score, 1, 1)[0]).toEqual(n([60, 64], 4, 1, 'quarter', 'stop'));
  });
});

describe('quantizeToScore: voice separation', () => {
  it('keeps a single melody in voice 1', () => {
    const score = quantize([makeNote(60, 0, 1), makeNote(62, 1, 1)], baseOptions());
    expect(score.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1]);
  });

  it('assigns the higher simultaneous note to voice 1 (same start, different durations)', () => {
    const score = quantize([makeNote(60, 0, 1), makeNote(64, 0, 2)], baseOptions());
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([64], 0, 2, 'half'));
    expect(voiceEvents(score, 0, 2)[0]).toEqual(n([60], 0, 1, 'quarter'));
  });

  it('routes overlapping later onsets to a free voice and pads it with rests', () => {
    const score = quantize([makeNote(72, 0, 2), makeNote(60, 1, 2)], baseOptions());
    expect(voiceEvents(score, 0, 1)).toEqual([
      n([72], 0, 2, 'half'),
      r(2, 1, 'quarter'),
      r(3, 1, 'quarter'),
    ]);
    expect(voiceEvents(score, 0, 2)).toEqual([
      r(0, 1, 'quarter'),
      n([60], 1, 2, 'half'),
      r(3, 1, 'quarter'),
    ]);
  });

  it('omits higher voices from measures where they have no notes', () => {
    const score = quantize([makeNote(72, 0, 2), makeNote(60, 1, 2)], baseOptions());
    expect(score.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1, 2]);
    expect(score.parts[0].measures[1].voices.map((v) => v.voice)).toEqual([1]);
  });

  it('merges a later overflow onset into the nearest busy voice by truncation', () => {
    // Voices 1 and 2 both sound at t=1; the new 65 is nearer 72 than 48,
    // so voice 1's held note is cut at the new onset.
    const score = quantize(
      [makeNote(72, 0, 2), makeNote(48, 0, 2), makeNote(65, 1, 1)],
      baseOptions(),
    );
    expect(voiceEvents(score, 0, 1)).toEqual([
      n([72], 0, 1, 'quarter'),
      n([65], 1, 1, 'quarter'),
      r(2, 1, 'quarter'),
      r(3, 1, 'quarter'),
    ]);
    expect(voiceEvents(score, 0, 2)).toEqual([
      n([48], 0, 2, 'half'),
      r(2, 1, 'quarter'),
      r(3, 1, 'quarter'),
    ]);
  });

  it('merges same-onset overflow into the nearest voice as a chord (longer end wins)', () => {
    // Three simultaneous units with distinct durations exceed maxVoices=2;
    // 60 is nearest 66, so voice 2 becomes the chord [60, 66].
    const score = quantize(
      [makeNote(72, 0, 2), makeNote(66, 0, 1.5), makeNote(60, 0, 1)],
      baseOptions(),
    );
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([72], 0, 2, 'half'));
    expect(voiceEvents(score, 0, 2)).toEqual([
      n([60, 66], 0, 1.5, 'quarter.'),
      r(1.5, 0.5, 'eighth'),
      r(2, 1, 'quarter'),
      r(3, 1, 'quarter'),
    ]);
  });

  it('forces everything into one monophonic line when maxVoices is 1', () => {
    const score = quantize([makeNote(72, 0, 2), makeNote(60, 1, 2)], baseOptions({ maxVoices: 1 }));
    expect(score.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1]);
    expect(voiceEvents(score, 0, 1)).toEqual([
      n([72], 0, 1, 'quarter'),
      n([60], 1, 2, 'half'),
      r(3, 1, 'quarter'),
    ]);
  });

  it('assigns grand-staff upper and lower notes to independent voice pools', () => {
    const score = quantize(
      [makeNote(72, 0, 2), makeNote(48, 0, 2), makeNote(52, 1, 1)],
      baseOptions({ clef: 'grand' }),
    );

    expect(score.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1, 3, 4]);
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([72], 0, 2, 'half'));
    expect(voiceEvents(score, 0, 3)[0]).toEqual(n([48], 0, 2, 'half'));
    expect(voiceEvents(score, 0, 4)).toEqual([
      r(0, 1, 'quarter'),
      n([52], 1, 1, 'quarter'),
      r(2, 1, 'quarter'),
      r(3, 1, 'quarter'),
    ]);
  });

  it('omits empty secondary grand-staff voices in later measures', () => {
    const score = quantize(
      [
        makeNote(72, 0, 2),
        makeNote(76, 1, 1),
        makeNote(48, 0, 2),
        makeNote(52, 1, 1),
        makeNote(74, 4, 1),
        makeNote(50, 4, 1),
      ],
      baseOptions({ clef: 'grand' }),
    );

    expect(score.parts[0].measures[0].voices.map((voice) => voice.voice)).toEqual([1, 2, 3, 4]);
    expect(score.parts[0].measures[1].voices.map((voice) => voice.voice)).toEqual([1, 3]);
  });

  it('keeps voice 1 present when a grand-staff measure only contains lower staff notes', () => {
    const score = quantize([makeNote(43, 0, 1)], baseOptions({ clef: 'grand' }));

    expect(score.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1, 3]);
    expect(voiceEvents(score, 0, 1)).toEqual([r(0, 4, 'whole')]);
    expect(voiceEvents(score, 0, 3)[0]).toEqual(n([43], 0, 1, 'quarter'));
    expect(
      score.parts[0].measures[0].voices.find((voice) => voice.voice === 1)?.events[0].staff,
    ).toBe(1);
  });

  it('fills the silent lower staff with a rest voice in an upper-only grand-staff score', () => {
    const score = quantize([makeNote(72, 0, 1)], baseOptions({ clef: 'grand' }));

    expect(score.parts[0].measures[0].voices.map((voice) => voice.voice)).toEqual([1, 3]);
    expect(voiceEvents(score, 0, 3)).toEqual([r(0, 4, 'whole')]);
    expect(
      score.parts[0].measures[0].voices.find((voice) => voice.voice === 3)?.events[0].staff,
    ).toBe(2);
  });

  it('uses the configured grand-staff split pitch for voice and staff assignment', () => {
    const defaultSplit = quantize([makeNote(55, 0, 1)], baseOptions({ clef: 'grand' }));
    expect(defaultSplit.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1, 3]);
    expect(voiceEvents(defaultSplit, 0, 3)[0]).toEqual(n([55], 0, 1, 'quarter'));
    expect(defaultSplit.parts[0].measures[0].voices[1].events[0].staff).toBe(2);

    const lowerSplit = quantize(
      [makeNote(55, 0, 1)],
      baseOptions({ clef: 'grand', grandStaffSplitPitch: 50 }),
    );
    expect(lowerSplit.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1, 3]);
    expect(voiceEvents(lowerSplit, 0, 1)[0]).toEqual(n([55], 0, 1, 'quarter'));
    expect(lowerSplit.parts[0].measures[0].voices[0].events[0].staff).toBe(1);
  });

  it('keeps split-near right-hand motion on the upper staff by continuity', () => {
    const score = quantize(
      [makeNote(72, 0, 1), makeNote(58, 1, 1)],
      baseOptions({ clef: 'grand' }),
    );

    expect(score.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1, 3]);
    expect(voiceEvents(score, 0, 1).slice(0, 2)).toEqual([
      n([72], 0, 1, 'quarter'),
      n([58], 1, 1, 'quarter'),
    ]);
    expect(score.parts[0].measures[0].voices[0].events[1].staff).toBe(1);
  });

  it('keeps split-near left-hand motion on the lower staff by continuity', () => {
    const score = quantize(
      [makeNote(48, 0, 1), makeNote(62, 1, 1)],
      baseOptions({ clef: 'grand' }),
    );

    expect(score.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1, 3]);
    expect(voiceEvents(score, 0, 1)).toEqual([r(0, 4, 'whole')]);
    expect(voiceEvents(score, 0, 3).slice(0, 2)).toEqual([
      n([48], 0, 1, 'quarter'),
      n([62], 1, 1, 'quarter'),
    ]);
    expect(score.parts[0].measures[0].voices[1].events[1].staff).toBe(2);
  });

  it('does not let simultaneous grand-staff notes bias each other at the same onset', () => {
    const score = quantize(
      [makeNote(72, 0, 1), makeNote(55, 0, 1)],
      baseOptions({ clef: 'grand' }),
    );

    expect(score.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1, 3]);
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([72], 0, 1, 'quarter'));
    expect(voiceEvents(score, 0, 3)[0]).toEqual(n([55], 0, 1, 'quarter'));
  });

  it('uses separated MIDI channels as a grand-staff hand bias when their ranges diverge', () => {
    const score = quantize(
      [
        makeNote(72, 0, 1, undefined, { channel: 0 }),
        makeNote(58, 1, 1, undefined, { channel: 0 }),
        makeNote(45, 0, 1, undefined, { channel: 1 }),
        makeNote(65, 1, 1, undefined, { channel: 1 }),
      ],
      baseOptions({ clef: 'grand' }),
    );

    expect(score.parts[0].measures[0].voices.map((v) => v.voice)).toEqual([1, 3]);
    expect(voiceEvents(score, 0, 1).slice(0, 2)).toEqual([
      n([72], 0, 1, 'quarter'),
      n([58], 1, 1, 'quarter'),
    ]);
    expect(voiceEvents(score, 0, 3).slice(0, 2)).toEqual([
      n([45], 0, 1, 'quarter'),
      n([65], 1, 1, 'quarter'),
    ]);
    expect(score.parts[0].measures[0].voices[0].events[1].staff).toBe(1);
    expect(score.parts[0].measures[0].voices[1].events[1].staff).toBe(2);
  });

  it('keeps a fast right-hand figure over a sustained bass on the treble staff', () => {
    const score = quantize(
      [
        makeNote(52, 0, 4), // sustained inner voice on the lower staff
        makeNote(80, 0, 0.25), // right-hand interval on the downbeat
        makeNote(66, 0, 0.25),
        makeNote(62, 0.25, 0.25), // fast right-hand figure near the split
        makeNote(61, 0.5, 0.25),
        makeNote(63, 0.75, 0.25),
      ],
      baseOptions({ clef: 'grand', clipLengthPpq: 4 }),
    );

    const noteEvents = score.parts[0].measures[0].voices.flatMap((v) =>
      v.events.filter((e) => e.kind === 'note'),
    );
    const staffOf = (pitch: number) => noteEvents.find((e) => e.pitches.includes(pitch))?.staff;
    // A running group mean would drag the figure below the sustained bass and
    // flip it to the lower staff; per-voice continuity keeps it on the treble.
    expect(staffOf(62)).toBe(1);
    expect(staffOf(61)).toBe(1);
    expect(staffOf(63)).toBe(1);
    expect(staffOf(52)).toBe(2);
  });
});

describe('grand-staff split helpers', () => {
  /** Builds a chord unit fixture with ascending, deduplicated pitches. */
  function makeUnit(pitches: number[], overrides: Partial<VoiceUnit> = {}): VoiceUnit {
    return {
      pitches: [...pitches].sort((a, b) => a - b),
      startPpq: 0,
      endPpq: 2,
      channels: [0],
      velocity: 96,
      ids: [1],
      ...overrides,
    };
  }

  it('places a mean pitch at or above the split on the upper staff', () => {
    expect(staffForMeanPitch(60, 60)).toBe(1);
    expect(staffForMeanPitch(72, 60)).toBe(1);
    expect(staffForMeanPitch(59, 60)).toBe(2);
    expect(staffForMeanPitch(48, 50)).toBe(2);
  });

  it('splits an oversized chord that straddles the split across both staves', () => {
    const split = splitUnitAcrossStaves(makeUnit([48, 52, 64, 72]), 60);
    expect(split).toBeDefined();
    expect(split?.upper.pitches).toEqual([64, 72]);
    expect(split?.lower.pitches).toEqual([48, 52]);
    // Both halves keep the source unit's timing and identity.
    expect(split?.upper.startPpq).toBe(0);
    expect(split?.lower.ids).toEqual([1]);
  });

  it('keeps a hand-sized straddling chord on one staff', () => {
    expect(splitUnitAcrossStaves(makeUnit([59, 71]), 60)).toBeUndefined(); // octave
    expect(splitUnitAcrossStaves(makeUnit([56, 64]), 60)).toBeUndefined(); // minor sixth
  });

  it('does not split a wide chord that sits entirely on one side of the split', () => {
    expect(splitUnitAcrossStaves(makeUnit([62, 84]), 60)).toBeUndefined();
    expect(splitUnitAcrossStaves(makeUnit([36, 58]), 60)).toBeUndefined();
  });

  it('assigns the halves of a split two-hand cluster to the upper and lower pools', () => {
    const { upper, lower } = assignGrandStaffUnits([makeUnit([40, 48, 67, 79])], 60);
    expect(upper.map((u) => u.pitches)).toEqual([[67, 79]]);
    expect(lower.map((u) => u.pitches)).toEqual([[40, 48]]);
  });
});

describe('quantizeToScore: barlines and ties', () => {
  it('splits a note crossing one barline into two tied events', () => {
    const score = quantize([makeNote(60, 3, 2)], baseOptions());
    expect(voiceEvents(score, 0, 1)[3]).toEqual(n([60], 3, 1, 'quarter', 'start'));
    expect(voiceEvents(score, 1, 1)[0]).toEqual(n([60], 4, 1, 'quarter', 'stop'));
  });

  it('chains ties across three or more measures', () => {
    const score = quantize([makeNote(60, 0, 12)], baseOptions({ clipLengthPpq: 12 }));
    expect(voiceEvents(score, 0, 1)).toEqual([n([60], 0, 4, 'whole', 'start')]);
    expect(voiceEvents(score, 1, 1)).toEqual([n([60], 4, 4, 'whole', 'both')]);
    expect(voiceEvents(score, 2, 1)).toEqual([n([60], 8, 4, 'whole', 'stop')]);
  });
});

describe('quantizeToScore: duration decomposition', () => {
  it('keeps a non-binary pickup on the display grid without mixing tuplets into rests', () => {
    const score = quantize(
      [],
      baseOptions({ divisionPpq: 1 / 6, clipLengthPpq: 5, pickupLengthPpq: 0.6875 }),
    );

    expect(score.parts[0].measures.map((measure) => measure.lengthPpq)).toEqual([
      2 / 3,
      4,
      expect.closeTo(1 / 3, 12),
    ]);
    expect(voiceEvents(score, 0, 1)).toEqual([r(0, 2 / 3, 'quartert3:2')]);
  });

  it('keeps exactly representable dotted durations whole', () => {
    const score = quantize([makeNote(60, 0, 3)], baseOptions());
    expect(voiceEvents(score, 0, 1)[0]).toEqual(n([60], 0, 3, 'half.'));
  });

  it('ties an off-beat half note across the 4/4 middle beat', () => {
    const score = quantize([makeNote(60, 0.5, 2)], baseOptions());

    expect(voiceEvents(score, 0, 1).slice(1, 3)).toEqual([
      n([60], 0.5, 1.5, 'quarter.', 'start'),
      n([60], 2, 0.5, 'eighth', 'stop'),
    ]);
  });

  it('splits five 16ths into quarter + 16th at the beat boundary', () => {
    const score = quantize([makeNote(60, 0, 1.25)], baseOptions());
    expect(voiceEvents(score, 0, 1).slice(0, 2)).toEqual([
      n([60], 0, 1, 'quarter', 'start'),
      n([60], 1, 0.25, '16th', 'stop'),
    ]);
  });

  it('prefers the beat boundary for off-beat unrepresentable durations', () => {
    const score = quantize([makeNote(60, 0.5, 1.25)], baseOptions());
    expect(voiceEvents(score, 0, 1)).toEqual([
      r(0, 0.5, 'eighth'),
      n([60], 0.5, 0.5, 'eighth', 'start'),
      n([60], 1, 0.75, 'eighth.', 'stop'),
      r(1.75, 0.25, '16th'),
      r(2, 1, 'quarter'),
      r(3, 1, 'quarter'),
    ]);
  });

  it('keeps exactly representable syncopations whole across beats', () => {
    const score = quantize([makeNote(60, 0.5, 1)], baseOptions());
    expect(voiceEvents(score, 0, 1)[1]).toEqual(n([60], 0.5, 1, 'quarter'));
  });
});

describe('quantizeToScore: rest filling', () => {
  it('splits rests at beat boundaries instead of syncopating them', () => {
    const score = quantize([makeNote(60, 0.5, 1)], baseOptions());
    // The trailing gap 1.5..4 splits at beats 2 and 3.
    expect(voiceEvents(score, 0, 1).slice(2)).toEqual([
      r(1.5, 0.5, 'eighth'),
      r(2, 1, 'quarter'),
      r(3, 1, 'quarter'),
    ]);
  });

  it('uses a single rest for a whole 3/4 measure', () => {
    const score = quantize(
      [],
      baseOptions({ timeSig: { beats: 3, beatUnit: 4 }, clipLengthPpq: 3 }),
    );
    expect(voiceEvents(score, 0, 1)).toEqual([r(0, 3, 'half.')]);
  });

  it('uses a single rest for a whole 6/8 measure', () => {
    const score = quantize(
      [],
      baseOptions({ timeSig: { beats: 6, beatUnit: 8 }, clipLengthPpq: 3 }),
    );
    expect(voiceEvents(score, 0, 1)).toEqual([r(0, 3, 'half.')]);
  });

  it('splits 6/8 rests at the dotted-quarter group boundary', () => {
    const score = quantize(
      [makeNote(60, 2, 1)],
      baseOptions({ timeSig: { beats: 6, beatUnit: 8 }, clipLengthPpq: 3 }),
    );
    expect(voiceEvents(score, 0, 1)).toEqual([
      r(0, 1.5, 'quarter.'),
      r(1.5, 0.5, 'eighth'),
      n([60], 2, 1, 'quarter'),
    ]);
  });
});

describe('quantizeToScore: incomplete final measure', () => {
  it('shortens the final measure when the clip is not a whole number of measures', () => {
    const score = quantize([], baseOptions({ clipLengthPpq: 6 }));
    expect(score.parts[0].measures.map((m) => [m.startPpq, m.lengthPpq])).toEqual([
      [0, 4],
      [4, 2],
    ]);
    expect(voiceEvents(score, 1, 1)).toEqual([r(4, 2, 'half')]);
  });

  it('ties notes into the short final measure and pads it with rests', () => {
    const score = quantize([makeNote(60, 3, 2)], baseOptions({ clipLengthPpq: 6 }));
    expect(voiceEvents(score, 1, 1)).toEqual([
      n([60], 4, 1, 'quarter', 'stop'),
      r(5, 1, 'quarter'),
    ]);
  });
});

describe('quantizeToScore: clef selection', () => {
  it('defaults to treble for empty input', () => {
    expect(quantize([], baseOptions()).parts[0].clef).toBe('treble');
  });

  it('picks bass when the pitch-range midpoint is below middle C', () => {
    const score = quantize([makeNote(36, 0, 1), makeNote(48, 1, 1)], baseOptions());
    expect(score.parts[0].clef).toBe('bass');
  });

  it('picks treble when the pitch-range midpoint is at or above middle C', () => {
    const score = quantize([makeNote(48, 0, 1), makeNote(72, 1, 1)], baseOptions());
    expect(score.parts[0].clef).toBe('treble');
  });

  it('honours an explicit clef override', () => {
    const score = quantize([makeNote(36, 0, 1)], baseOptions({ clef: 'grand' }));
    expect(score.parts[0].clef).toBe('grand');
  });
});

describe('quantizeToScore: option validation', () => {
  const invalid: Array<[string, Partial<QuantizeOptions>]> = [
    ['zero grid', { divisionPpq: 0 }],
    ['negative grid', { divisionPpq: -0.25 }],
    ['grid finer than a 64th', { divisionPpq: 0.03 }],
    ['grid not a 64th multiple', { divisionPpq: 0.1 }],
    ['non-finite grid', { divisionPpq: Number.NaN }],
    ['zero beats', { timeSig: { beats: 0, beatUnit: 4 } }],
    ['fractional beats', { timeSig: { beats: 2.5, beatUnit: 4 } }],
    ['non-power-of-two beat unit', { timeSig: { beats: 4, beatUnit: 3 } }],
    ['keyFifths out of range', { keyFifths: 8 }],
    ['fractional keyFifths', { keyFifths: 0.5 }],
    ['negative clip start', { clipStartPpq: -1 }],
    ['zero clip length', { clipLengthPpq: 0 }],
    ['negative clip length', { clipLengthPpq: -2 }],
    ['clip length rounding to zero', { clipLengthPpq: 0.01 }],
    ['maxVoices too small', { maxVoices: 0 }],
    ['maxVoices too large', { maxVoices: 5 }],
    ['fractional maxVoices', { maxVoices: 1.5 }],
    ['negative grand staff split', { grandStaffSplitPitch: -1 }],
    ['grand staff split too high', { grandStaffSplitPitch: 128 }],
    ['fractional grand staff split', { grandStaffSplitPitch: 60.5 }],
  ];

  it.each(invalid)('throws RangeError for %s', (_label, overrides) => {
    expect(() => quantizeToScore([], baseOptions(overrides))).toThrow(RangeError);
  });
});

describe('quantizeToScore: structural invariants on a dense fixture', () => {
  it('keeps every voice gap-free with value-consistent durations', () => {
    const notes = [
      makeNote(60, 0.13, 0.9),
      makeNote(64, 0.13, 0.9),
      makeNote(67, 0.13, 0.9),
      makeNote(72, 1, 3.3),
      makeNote(50, 1.4, 2.2),
      makeNote(65, 2, 0.05),
      makeNote(48, 3.5, 5),
      makeNote(74, 3.5, 1.25),
      makeNote(61, 3.5, 0.75),
      makeNote(59, 7.9, 4),
    ];
    // quantize() asserts the invariants internally.
    const score = quantize(notes, baseOptions({ clipLengthPpq: 10 }));
    expect(score.parts[0].measures).toHaveLength(3);
  });
});

describe('quantizeToScore: same-onset overflow identities', () => {
  it('keeps every merged note identity on the engraved noteheads', () => {
    const notes = [makeNote(60, 0, 4, 1), makeNote(64, 0, 2, 2), makeNote(67, 0, 1, 3)].map(
      (note) => ({
        ...note,
        scoreSourceIdentity: { clipId: 1, noteId: note.id, occurrence: 0 },
      }),
    );
    const score = quantizeToScore(notes, baseOptions({ maxVoices: 1 }));
    const events = score.parts[0].measures[0].voices.flatMap((v) => v.events);
    const note = events.find((e) => e.kind === 'note');
    expect(note?.sourceIds).toEqual([1, 2, 3]);
    expect(note?.sourceIdentities?.map((identity) => identity.noteId).sort()).toEqual([1, 2, 3]);
    const xml = serializeMusicXml(score);
    const ids = [...xml.matchAll(/xml:id="(sonare-note-[^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(
        scoreSourceIdentitiesFromXmlId(id)
          .map((identity) => identity.noteId)
          .sort(),
      ).toEqual([1, 2, 3]);
    }
  });
});
