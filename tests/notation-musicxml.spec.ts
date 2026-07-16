import { describe, expect, it } from 'vitest';
import type {
  NotatedEvent,
  NotatedMeasure,
  NotatedScore,
  NotatedVoiceNumber,
  NoteValue,
} from '@/notation/model';
import { escapeXml, extractPartScore, serializeMusicXml } from '@/notation/musicxml';
import { quantizeToScore } from '@/notation/quantize';

/** Builds a note/chord event with sensible defaults. */
function note(
  pitches: number[],
  voice: NotatedVoiceNumber,
  startPpq: number,
  durationPpq: number,
  value: NoteValue,
  ties: { tieStart?: boolean; tieStop?: boolean } = {},
  sourceIds?: number[],
): NotatedEvent {
  return {
    kind: 'note',
    pitches,
    voice,
    startPpq,
    durationPpq,
    value,
    tieStart: ties.tieStart ?? false,
    tieStop: ties.tieStop ?? false,
    sourceIds,
  };
}

/** Builds a rest event with sensible defaults. */
function rest(
  voice: NotatedVoiceNumber,
  startPpq: number,
  durationPpq: number,
  value: NoteValue,
): NotatedEvent {
  return {
    kind: 'rest',
    pitches: [],
    voice,
    startPpq,
    durationPpq,
    value,
    tieStart: false,
    tieStop: false,
  };
}

/** Parses serializer output and asserts well-formedness. */
function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc;
}

/** querySelector that throws on a missing element. */
function q(root: ParentNode, selector: string): Element {
  const el = root.querySelector(selector);
  if (el === null) {
    throw new Error(`missing element: ${selector}`);
  }
  return el;
}

/** querySelectorAll as a plain array. */
function qa(root: ParentNode, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const NOTE_CHILD_ORDER = new Map(
  [
    'grace',
    'cue',
    'chord',
    'pitch',
    'unpitched',
    'rest',
    'duration',
    'tie',
    'instrument',
    'voice',
    'type',
    'dot',
    'accidental',
    'time-modification',
    'stem',
    'notehead',
    'staff',
    'beam',
    'notations',
    'lyric',
  ].map((name, index) => [name, index]),
);

function expectValidMusicXmlNoteOrder(doc: Document): void {
  for (const noteEl of qa(doc, 'note')) {
    let previous = -1;
    const tags = Array.from(noteEl.children).map((child) => child.tagName);
    for (const tag of tags) {
      const order = NOTE_CHILD_ORDER.get(tag);
      if (order === undefined) throw new Error(`unknown MusicXML note child: ${tag}`);
      expect(order, `<note> children out of order: ${tags.join(' > ')}`).toBeGreaterThanOrEqual(
        previous,
      );
      previous = order;
    }
  }
}

/**
 * Two-measure grand-staff fixture in G major with two voices, a chord, a tie
 * across the barline, a whole-measure rest and four chord symbols.
 */
function grandStaffFixture(): NotatedScore {
  const quarter: NoteValue = { base: 'quarter', dots: 0 };
  const half: NoteValue = { base: 'half', dots: 0 };
  const whole: NoteValue = { base: 'whole', dots: 0 };
  const measures: NotatedMeasure[] = [
    {
      index: 0,
      startPpq: 0,
      lengthPpq: 4,
      timeSig: { beats: 4, beatUnit: 4 },
      voices: [
        {
          voice: 1,
          events: [
            note([67, 71], 1, 0, 1, quarter),
            note([69], 1, 1, 1, quarter),
            note([71], 1, 2, 2, half, { tieStart: true }),
          ],
        },
        {
          voice: 2,
          events: [note([48], 2, 0, 2, half), rest(2, 2, 2, half)],
        },
      ],
    },
    {
      index: 1,
      startPpq: 4,
      lengthPpq: 4,
      timeSig: { beats: 4, beatUnit: 4 },
      voices: [
        {
          voice: 1,
          events: [note([71], 1, 4, 2, half, { tieStop: true }), rest(1, 6, 2, half)],
        },
        {
          voice: 2,
          events: [rest(2, 4, 4, whole)],
        },
      ],
    },
  ];
  return {
    parts: [{ id: 'P1', name: 'Piano', clef: 'grand', measures }],
    keyFifths: 1,
    divisions: 960,
    chordSymbols: [
      { ppq: 0, text: 'G', rootPc: 7, quality: 0 },
      { ppq: 2, text: 'Cmaj7', rootPc: 0, quality: 5 },
      { ppq: 4, text: 'Bm(add9)', rootPc: 11, quality: 11 },
      { ppq: 6, text: 'D/F#', rootPc: 2, quality: 0, bassPc: 6 },
    ],
  };
}

describe('serializeMusicXml metadata header', () => {
  it('keeps note children in MusicXML content-model order', () => {
    const eighthTriplet: NoteValue = {
      base: 'eighth',
      dots: 0,
      tuplet: { actual: 3, normal: 2 },
    };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([61], 1, 0, 1 / 3, eighthTriplet, { tieStart: true }, [1]),
                    note([61], 1, 1 / 3, 1 / 3, eighthTriplet, { tieStop: true }, [2]),
                    rest(1, 2 / 3, 1 / 3, eighthTriplet),
                  ],
                },
              ],
            },
          ],
        },
      ],
      divisions: 960,
      keyFifths: 0,
      noteAnnotations: {
        1: { dynamics: 'mf', articulation: 'accent', slurToNoteId: 2 },
        2: { lyric: { text: 'la', syllabic: 'single' } },
      },
    };

    expectValidMusicXmlNoteOrder(parse(serializeMusicXml(score)));
  });

  it('always records the encoding software', () => {
    const doc = parse(serializeMusicXml(grandStaffFixture()));
    expect(q(doc, 'identification > encoding > software').textContent).toBe('sonare studio');
  });

  it('omits work-title when no title is set', () => {
    const doc = parse(serializeMusicXml(grandStaffFixture()));
    expect(doc.querySelector('work')).toBeNull();
  });

  it('emits work-title and composer when present, escaping markup', () => {
    const score = { ...grandStaffFixture(), metadata: { title: 'A & B', composer: 'Me <x>' } };
    const doc = parse(serializeMusicXml(score));
    expect(q(doc, 'work > work-title').textContent).toBe('A & B');
    expect(q(doc, 'identification > creator[type="composer"]').textContent).toBe('Me <x>');
    expect(q(doc, 'credit-type').textContent).toBe('title');
    expect(q(doc, 'credit-words').textContent).toBe('A & B');
  });

  it('treats a blank title as absent', () => {
    const score = { ...grandStaffFixture(), metadata: { title: '   ' } };
    const doc = parse(serializeMusicXml(score));
    expect(doc.querySelector('work')).toBeNull();
  });

  it('places the header before the part-list', () => {
    const score = { ...grandStaffFixture(), metadata: { title: 'Song' } };
    const xml = serializeMusicXml(score);
    expect(xml.indexOf('<work>')).toBeLessThan(xml.indexOf('<part-list>'));
    expect(xml.indexOf('<identification>')).toBeLessThan(xml.indexOf('<part-list>'));
  });

  it('emits A4 print-layout defaults before the part-list', () => {
    const xml = serializeMusicXml(grandStaffFixture());
    const doc = parse(xml);
    const defaults = q(doc, 'defaults');
    expect(xml.indexOf('<defaults>')).toBeLessThan(xml.indexOf('<part-list>'));
    expect(q(defaults, 'scaling > millimeters').textContent).toBe('7');
    expect(q(defaults, 'scaling > tenths').textContent).toBe('40');
    expect(q(defaults, 'page-layout > page-height').textContent).toBe('1697');
    expect(q(defaults, 'page-layout > page-width').textContent).toBe('1200');
    expect(q(defaults, 'page-margins[type="both"] > left-margin').textContent).toBe('70');
    expect(q(defaults, 'system-layout > system-distance').textContent).toBe('150');
    expect(q(defaults, 'staff-layout > staff-distance').textContent).toBe('80');
    expect(q(defaults, 'appearance > line-width[type="staff"]').textContent).toBe('1.1');
  });
});

describe('serializeMusicXml structure', () => {
  const xml = serializeMusicXml(grandStaffFixture());
  const doc = parse(xml);

  it('emits the MusicXML 4.0 header and root element', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"',
    );
    expect(doc.documentElement.tagName).toBe('score-partwise');
    expect(doc.documentElement.getAttribute('version')).toBe('4.0');
  });

  it('emits a part-list entry per part', () => {
    const scoreParts = qa(doc, 'part-list > score-part');
    expect(scoreParts).toHaveLength(1);
    expect(scoreParts[0].getAttribute('id')).toBe('P1');
    expect(q(scoreParts[0], 'part-name').textContent).toBe('Piano');
    expect(q(scoreParts[0], 'part-abbreviation').textContent).toBe('Piano');
  });

  it('derives compact part abbreviations for long multi-word names', () => {
    const score = grandStaffFixture();
    score.parts = [{ ...score.parts[0], name: 'Electric Grand Piano' }];
    const scorePart = q(parse(serializeMusicXml(score)), 'part-list > score-part');
    expect(q(scorePart, 'part-name').textContent).toBe('Electric Grand Piano');
    expect(q(scorePart, 'part-abbreviation').textContent).toBe('EGP');
  });

  it('emits all measures with 1-based numbers', () => {
    const measures = qa(doc, 'part[id="P1"] > measure');
    expect(measures).toHaveLength(2);
    expect(measures.map((m) => m.getAttribute('number'))).toEqual(['1', '2']);
  });

  it('marks the final measure with a final barline', () => {
    const [first, second] = qa(doc, 'part[id="P1"] > measure');
    expect(first.querySelector('barline')).toBeNull();
    const barline = q(second, 'barline[location="right"]');
    expect(q(barline, 'bar-style').textContent).toBe('light-heavy');
  });

  it('emits section rehearsal marks and explicit double barlines', () => {
    const score = grandStaffFixture();
    score.measureRehearsals = { 0: 'Verse & A', 1: 'Chorus' };
    score.measureBarlines = { 0: 'double' };
    const [first, second] = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');
    expect(q(first, 'direction rehearsal').textContent).toBe('Verse & A');
    expect(q(first, 'barline[location="right"] > bar-style').textContent).toBe('light-light');
    expect(q(second, 'direction rehearsal').textContent).toBe('Chorus');
    expect(q(second, 'barline[location="right"] > bar-style').textContent).toBe('light-heavy');
  });

  it('emits forward and backward repeat barlines', () => {
    const score = grandStaffFixture();
    score.measureRepeats = { 0: 'start', 1: 'end' };
    const [first, second] = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');
    const startRepeat = q(first, 'barline[location="left"]');
    expect(q(startRepeat, 'bar-style').textContent).toBe('heavy-light');
    expect(q(startRepeat, 'repeat').getAttribute('direction')).toBe('forward');
    const endRepeat = q(second, 'barline[location="right"]');
    expect(q(endRepeat, 'bar-style').textContent).toBe('light-heavy');
    expect(q(endRepeat, 'repeat').getAttribute('direction')).toBe('backward');
  });

  it('emits metronome tempo marks with playback tempo', () => {
    const score = grandStaffFixture();
    score.measureTempos = { 0: 120, 1: 96.5 };
    const [first, second] = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');
    expect(q(first, 'metronome > beat-unit').textContent).toBe('quarter');
    expect(q(first, 'metronome > per-minute').textContent).toBe('120');
    expect(q(first, 'direction sound').getAttribute('tempo')).toBe('120');
    expect(q(second, 'metronome > per-minute').textContent).toBe('96.5');
    expect(q(second, 'direction sound').getAttribute('tempo')).toBe('96.5');
  });

  it('emits mid-measure tempo and text directions with division offsets', () => {
    const score = grandStaffFixture();
    score.measureTempoMarks = {
      0: [
        { bpm: 120, offsetPpq: 0 },
        { bpm: 84, offsetPpq: 1.5 },
      ],
    };
    score.measureTempoTexts = {
      0: [{ text: 'rit.', bpm: 84, offsetPpq: 1.5 }],
    };
    const first = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure')[0];
    const directions = qa(first, 'direction').filter((direction) =>
      direction.querySelector('sound'),
    );
    expect(
      directions.map((direction) => direction.querySelector('offset')?.textContent ?? null),
    ).toEqual([null, '1440', '1440']);
    expect(directions.map((direction) => q(direction, 'sound').getAttribute('tempo'))).toEqual([
      '120',
      '84',
      '84',
    ]);
  });

  it('uses dotted-quarter metronome marks for compound meter', () => {
    const score: NotatedScore = {
      ...grandStaffFixture(),
      parts: [
        {
          id: 'P1',
          name: 'Piano',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 3,
              timeSig: { beats: 6, beatUnit: 8 },
              voices: [
                {
                  voice: 1,
                  events: [rest(1, 0, 3, { base: 'half', dots: 1 })],
                },
              ],
            },
          ],
        },
      ],
      measureTempos: { 0: 120 },
    };

    const first = q(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');

    expect(q(first, 'metronome > beat-unit').textContent).toBe('quarter');
    expect(q(first, 'metronome > beat-unit-dot')).not.toBeNull();
    expect(q(first, 'metronome > per-minute').textContent).toBe('80');
    expect(q(first, 'direction sound').getAttribute('tempo')).toBe('120');
  });

  it('emits textual tempo-change directions with optional playback tempo', () => {
    const score = grandStaffFixture();
    score.measureTempoTexts = {
      0: { text: 'rit.', bpm: 120 },
      1: { text: 'a tempo' },
    };
    const [first, second] = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');
    expect(q(first, 'direction words').textContent).toBe('rit.');
    expect(q(first, 'direction sound').getAttribute('tempo')).toBe('120');
    expect(q(second, 'direction words').textContent).toBe('a tempo');
  });

  it('emits general measure text directions with vertical offsets', () => {
    const score = grandStaffFixture();
    score.measureTexts = { 0: [{ text: 'Solo', defaultY: 24 }] };
    const first = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure')[0];
    const words = q(first, 'direction words');
    expect(words.textContent).toBe('Solo');
    expect(words.getAttribute('default-y')).toBe('24');
  });

  it('emits measure-level key changes after the opening key signature', () => {
    const score = grandStaffFixture();
    score.measureKeyFifths = { 1: -3 };
    const [first, second] = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');
    expect(q(first, 'attributes > key > fifths').textContent).toBe('1');
    expect(q(second, 'attributes > key > fifths').textContent).toBe('-3');
  });

  it('uses measure-level key changes for pitch spelling and accidentals', () => {
    const quarter: NoteValue = { base: 'quarter', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([70], 1, 0, 1, quarter)] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      measureKeyFifths: { 0: -1 },
      divisions: 960,
    };
    const noteEl = q(parse(serializeMusicXml(score)), 'note');
    expect(q(noteEl, 'pitch > step').textContent).toBe('B');
    expect(q(noteEl, 'pitch > alter').textContent).toBe('-1');
    expect(noteEl.querySelector('accidental')).toBeNull();
  });

  it('carries measure-level key changes forward for later pitch spelling', () => {
    const quarter: NoteValue = { base: 'quarter', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [0, 1, 2].map((index) => ({
            index,
            startPpq: index,
            lengthPpq: 1,
            timeSig: { beats: 1, beatUnit: 4 },
            voices: [{ voice: 1, events: [note([index === 0 ? 60 : 63], 1, 0, 1, quarter)] }],
          })),
        },
      ],
      keyFifths: 0,
      measureKeyFifths: { 1: -3 },
      divisions: 960,
    };
    const [, , third] = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');
    const noteEl = q(third, 'note');
    expect(q(noteEl, 'pitch > step').textContent).toBe('E');
    expect(q(noteEl, 'pitch > alter').textContent).toBe('-1');
    expect(noteEl.querySelector('accidental')).toBeNull();
  });

  it('emits explicit system and page breaks before measures', () => {
    const score = grandStaffFixture();
    score.measureBreaks = { 0: 'page', 1: 'system' };
    const [first, second] = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');
    expect(q(first, 'print').getAttribute('new-page')).toBe('yes');
    expect(q(second, 'print').getAttribute('new-system')).toBe('yes');
  });

  it('emits multi-measure rest measure-style on the start measure', () => {
    const whole: NoteValue = { base: 'whole', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([60], 1, 0, 4, whole)] }],
            },
            ...[1, 2].map((index) => ({
              index,
              startPpq: index * 4,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1 as const, events: [rest(1, index * 4, 4, whole)] }],
            })),
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    score.multiMeasureRests = { 1: { count: 2 } };
    const second = qa(parse(serializeMusicXml(score)), 'part[id="P1"] > measure')[1];
    expect(q(second, 'measure-style > multiple-rest').textContent).toBe('2');
  });

  it('rejects a stale multi-measure rest span that crosses score structure', () => {
    const whole: NoteValue = { base: 'whole', dots: 0 };
    const measures: NotatedMeasure[] = [0, 1, 2].map((index) => ({
      index,
      startPpq: index * 4,
      lengthPpq: 4,
      timeSig: { beats: 4, beatUnit: 4 },
      voices: [{ voice: 1, events: [rest(1, index * 4, 4, whole)] }],
    }));
    const score: NotatedScore = {
      parts: [{ id: 'P1', name: 'Lead', clef: 'treble', measures }],
      keyFifths: 0,
      divisions: 960,
      measureBreaks: { 2: 'system' },
      multiMeasureRests: { 1: { count: 2 } },
    };

    expect(qa(parse(serializeMusicXml(score)), 'measure-style > multiple-rest')).toEqual([]);
  });

  it('extracts a single part score while preserving shared notation metadata', () => {
    const score = grandStaffFixture();
    score.parts.push({
      id: 'P2',
      name: 'Violin',
      clef: 'treble',
      measures: score.parts[0].measures,
    });
    const partScore = extractPartScore(score, 'P2');
    expect(partScore.parts).toHaveLength(1);
    expect(partScore.parts[0].id).toBe('P2');
    expect(partScore.metadata?.partName).toBe('Violin');
    const doc = parse(serializeMusicXml(partScore));
    expect(qa(doc, 'part-list > score-part')).toHaveLength(1);
    expect(q(doc, 'credit-type').textContent).toBe('part name');
  });

  it('emits divisions, key, time and grand-staff clefs in the first measure only', () => {
    const [first, second] = qa(doc, 'measure');
    const attrs = q(first, 'attributes');
    expect(q(attrs, 'divisions').textContent).toBe('960');
    expect(q(attrs, 'key > fifths').textContent).toBe('1');
    expect(q(first, 'print > measure-numbering').textContent).toBe('system');
    expect(attrs.querySelector('measure-numbering')).toBeNull();
    expect(q(attrs, 'time > beats').textContent).toBe('4');
    expect(q(attrs, 'time > beat-type').textContent).toBe('4');
    expect(q(attrs, 'staves').textContent).toBe('2');
    const partSymbol = q(attrs, 'part-symbol');
    expect(partSymbol.textContent).toBe('brace');
    expect(partSymbol.getAttribute('top-staff')).toBe('1');
    expect(partSymbol.getAttribute('bottom-staff')).toBe('2');
    const clefs = qa(attrs, 'clef');
    expect(clefs).toHaveLength(2);
    expect(q(clefs[0], 'sign').textContent).toBe('G');
    expect(q(clefs[0], 'line').textContent).toBe('2');
    expect(q(clefs[1], 'sign').textContent).toBe('F');
    expect(q(clefs[1], 'line').textContent).toBe('4');
    // Nothing changed in measure 2, so it has no attributes element at all.
    expect(second.querySelector('attributes')).toBeNull();
  });

  it('marks stacked pitches with chord elements', () => {
    const chordNotes = qa(doc, 'note > chord');
    expect(chordNotes).toHaveLength(1);
    const firstMeasureNotes = qa(qa(doc, 'measure')[0], 'note');
    // G4 + B4 chord: second note carries <chord/> and both share the duration.
    expect(q(firstMeasureNotes[0], 'pitch > step').textContent).toBe('G');
    expect(firstMeasureNotes[0].querySelector('chord')).toBeNull();
    expect(q(firstMeasureNotes[1], 'pitch > step').textContent).toBe('B');
    expect(firstMeasureNotes[1].querySelector('chord')).not.toBeNull();
    expect(q(firstMeasureNotes[1], 'duration').textContent).toBe(
      q(firstMeasureNotes[0], 'duration').textContent,
    );
  });

  it('emits matching tie and tied pairs across the barline', () => {
    const [first, second] = qa(doc, 'measure');
    const tieStartNote = q(first, 'note:has(tie[type="start"])');
    expect(q(tieStartNote, 'pitch > step').textContent).toBe('B');
    expect(tieStartNote.querySelector('notations > tied[type="start"]')).not.toBeNull();
    const tieStopNote = q(second, 'note:has(tie[type="stop"])');
    expect(q(tieStopNote, 'pitch > step').textContent).toBe('B');
    expect(tieStopNote.querySelector('notations > tied[type="stop"]')).not.toBeNull();
    expect(qa(doc, 'tie')).toHaveLength(2);
    expect(qa(doc, 'tied')).toHaveLength(2);
  });

  it('separates voices with a full-measure backup', () => {
    const backups = qa(doc, 'backup');
    expect(backups).toHaveLength(2);
    for (const backup of backups) {
      expect(q(backup, 'duration').textContent).toBe('3840');
    }
  });

  it('renders a voice-spanning rest as a whole-measure rest', () => {
    const second = qa(doc, 'measure')[1];
    const measureRest = q(second, 'note > rest[measure="yes"]');
    const restNote = measureRest.parentElement as Element;
    expect(q(restNote, 'duration').textContent).toBe('3840');
    expect(q(restNote, 'voice').textContent).toBe('2');
    expect(restNote.querySelector('type')).toBeNull();
    // The plain half rest in voice 1 keeps its type.
    const halfRest = q(second, 'note:has(rest:not([measure]))');
    expect(q(halfRest, 'type').textContent).toBe('half');
  });

  it('splits grand-staff events at middle C and lets rests follow their voice', () => {
    const [first, second] = qa(doc, 'measure');
    const v1Staffs = qa(first, 'note')
      .filter((n) => q(n, 'voice').textContent === '1')
      .map((n) => q(n, 'staff').textContent);
    expect(v1Staffs).toEqual(['1', '1', '1', '1']);
    const v2Notes = qa(first, 'note').filter((n) => q(n, 'voice').textContent === '2');
    expect(v2Notes.map((n) => q(n, 'staff').textContent)).toEqual(['2', '2']);
    // The whole-measure rest in voice 2 inherits staff 2 from the C3 note.
    const measureRestNote = q(second, 'note > rest[measure="yes"]').parentElement as Element;
    expect(q(measureRestNote, 'staff').textContent).toBe('2');
  });

  it('assigns chords to a grand staff by their mean pitch, not the lowest note', () => {
    const half: NoteValue = { base: 'half', dots: 0 };
    const measure: NotatedMeasure = {
      index: 0,
      startPpq: 0,
      lengthPpq: 4,
      timeSig: { beats: 4, beatUnit: 4 },
      voices: [
        {
          voice: 1,
          events: [
            // B3 + E5: lowest note dips below middle C but the body is treble.
            note([59, 76], 1, 0, 2, half),
            // C3 + G4: a high top note must not pull a bass-centred chord up.
            note([48, 67], 1, 2, 2, half),
          ],
        },
      ],
    };
    const score: NotatedScore = {
      parts: [{ id: 'P1', name: 'Piano', clef: 'grand', measures: [measure] }],
      keyFifths: 0,
      divisions: 960,
    };
    const measureEl = q(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');
    const staffs = qa(measureEl, 'note')
      .filter((n) => n.querySelector('chord') === null)
      .map((n) => q(n, 'staff').textContent);
    expect(staffs).toEqual(['1', '2']);
  });

  it('honours explicit grand-staff assignments from the quantizer', () => {
    const score = quantizeToScore(
      [{ id: 1, pitch: 55, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
      {
        divisionPpq: 1,
        timeSig: { beats: 4, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 4,
        clef: 'grand',
        grandStaffSplitPitch: 50,
      },
    );
    const measureEl = q(parse(serializeMusicXml(score)), 'part[id="P1"] > measure');
    const notes = qa(measureEl, 'note').filter((n) => q(n, 'voice').textContent === '1');

    expect(notes.map((n) => q(n, 'staff').textContent)).toEqual(['1', '1', '1', '1']);
  });

  it('emits harmony elements at their measure offsets', () => {
    const [first, second] = qa(doc, 'measure');
    const firstHarmonies = qa(first, 'harmony');
    expect(firstHarmonies).toHaveLength(2);
    expect(q(firstHarmonies[0], 'root > root-step').textContent).toBe('G');
    expect(q(firstHarmonies[0], 'kind').textContent).toBe('major');
    expect(firstHarmonies[0].querySelector('offset')).toBeNull();
    expect(q(firstHarmonies[1], 'root > root-step').textContent).toBe('C');
    expect(q(firstHarmonies[1], 'kind').textContent).toBe('major-seventh');
    expect(q(firstHarmonies[1], 'kind').getAttribute('text')).toBe('maj7');
    expect(q(firstHarmonies[1], 'offset').textContent).toBe('1920');
    expect(qa(second, 'harmony')).toHaveLength(2);
  });

  it('serializes add9 qualities as a base kind plus an added degree', () => {
    const second = qa(doc, 'measure')[1];
    const add9 = qa(second, 'harmony')[0];
    const kind = q(add9, 'kind');
    expect(kind.textContent).toBe('minor');
    expect(kind.getAttribute('text')).toBe('m(add9)');
    expect(q(add9, 'root > root-step').textContent).toBe('B');
    expect(q(add9, 'degree > degree-value').textContent).toBe('9');
    expect(q(add9, 'degree > degree-alter').textContent).toBe('0');
    expect(q(add9, 'degree > degree-type').textContent).toBe('add');
  });

  it('spells slash-chord basses with the key signature', () => {
    const second = qa(doc, 'measure')[1];
    const slash = qa(second, 'harmony')[1];
    expect(q(slash, 'root > root-step').textContent).toBe('D');
    expect(q(slash, 'bass > bass-step').textContent).toBe('F');
    expect(q(slash, 'bass > bass-alter').textContent).toBe('1');
    expect(q(slash, 'offset').textContent).toBe('1920');
  });

  it('preserves roman numerals as alternate functional harmony', () => {
    const score: NotatedScore = {
      ...grandStaffFixture(),
      chordSymbols: [{ ppq: 0, text: 'G7', rootPc: 7, quality: 4, romanNumeral: 'V<&>7' }],
    };
    const [primary, alternate] = qa(
      parse(serializeMusicXml(score)),
      'measure:first-of-type harmony',
    );
    expect(primary.getAttribute('type')).toBeNull();
    expect(q(primary, 'root > root-step').textContent).toBe('G');
    expect(q(primary, 'kind').textContent).toBe('dominant');
    expect(alternate.getAttribute('type')).toBe('alternate');
    expect(q(alternate, 'function').textContent).toBe('V<&>7');
    expect(q(alternate, 'kind').textContent).toBe('dominant');
    expect(alternate.querySelector('root')).toBeNull();
  });

  it('attaches lyrics to matching note attacks', () => {
    const score: NotatedScore = {
      ...grandStaffFixture(),
      lyrics: [
        { ppq: 0, text: 'Hel<&>lo' },
        { ppq: 2, text: 'world' },
      ],
    };
    const lyrics = qa(parse(serializeMusicXml(score)), 'lyric');
    expect(lyrics).toHaveLength(2);
    expect(q(lyrics[0], 'syllabic').textContent).toBe('single');
    expect(q(lyrics[0], 'text').textContent).toBe('Hel<&>lo');
    expect(q(lyrics[1], 'text').textContent).toBe('world');
  });

  it('normalizes an arbitrary lyric PPQ to the nearest note attack', () => {
    const score: NotatedScore = {
      ...grandStaffFixture(),
      lyrics: [{ ppq: 1.6, text: 'nearest' }],
    };
    const lyric = q(parse(serializeMusicXml(score)), 'lyric');
    expect(q(lyric, 'text').textContent).toBe('nearest');
    const note = lyric.closest('note');
    expect(note).not.toBeNull();
    expect(q(note as Element, 'pitch > step').textContent).toBe('B');
  });

  it('emits lyric verse numbers, syllabic values and melisma extends', () => {
    const score: NotatedScore = {
      ...grandStaffFixture(),
      lyrics: [
        { ppq: 0, text: 'glo', verse: 2, syllabic: 'begin', extend: true },
        { ppq: 1, text: 'ri', verse: 2, syllabic: 'middle', extend: true },
        { ppq: 2, text: 'a', verse: 2, syllabic: 'end' },
      ],
    };
    const lyrics = qa(parse(serializeMusicXml(score)), 'lyric');
    expect(lyrics.map((lyric) => lyric.getAttribute('number'))).toEqual(['2', '2', '2']);
    expect(lyrics.map((lyric) => q(lyric, 'syllabic').textContent)).toEqual([
      'begin',
      'middle',
      'end',
    ]);
    expect(lyrics.map((lyric) => q(lyric, 'text').textContent)).toEqual(['glo', 'ri', 'a']);
    expect(lyrics[0].querySelector('extend')).not.toBeNull();
    expect(lyrics[1].querySelector('extend')).not.toBeNull();
    expect(lyrics[2].querySelector('extend')).toBeNull();
  });
});

describe('serializeMusicXml attribute changes and clefs', () => {
  it('re-emits time on a time-signature change and uses F4 for bass clef', () => {
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Bass',
          clef: 'bass',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [rest(1, 0, 4, { base: 'whole', dots: 0 })] }],
            },
            {
              index: 1,
              startPpq: 4,
              lengthPpq: 3,
              timeSig: { beats: 3, beatUnit: 4 },
              voices: [{ voice: 1, events: [rest(1, 4, 3, { base: 'half', dots: 1 })] }],
            },
          ],
        },
      ],
      keyFifths: -2,
      divisions: 960,
    };
    const doc = parse(serializeMusicXml(score));
    const [first, second] = qa(doc, 'measure');
    const firstClef = q(first, 'attributes > clef');
    expect(firstClef.getAttribute('number')).toBeNull();
    expect(q(firstClef, 'sign').textContent).toBe('F');
    expect(q(firstClef, 'line').textContent).toBe('4');
    expect(q(first, 'attributes > key > fifths').textContent).toBe('-2');
    const secondAttrs = q(second, 'attributes');
    expect(q(secondAttrs, 'time > beats').textContent).toBe('3');
    expect(q(secondAttrs, 'time > beat-type').textContent).toBe('4');
    expect(secondAttrs.querySelector('divisions')).toBeNull();
    expect(secondAttrs.querySelector('key')).toBeNull();
    expect(secondAttrs.querySelector('clef')).toBeNull();
    // Both rests cover their measure and render as whole-measure rests.
    expect(qa(doc, 'rest[measure="yes"]')).toHaveLength(2);
  });

  it('does not emit part-symbol for single-staff parts', () => {
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [rest(1, 0, 4, { base: 'whole', dots: 0 })] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    expect(parse(serializeMusicXml(score)).querySelector('part-symbol')).toBeNull();
  });

  it('emits conservative temporary clef changes for extreme single-staff ranges', () => {
    const whole: NoteValue = { base: 'whole', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Cello',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([72], 1, 0, 4, whole)] }],
            },
            {
              index: 1,
              startPpq: 4,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([40], 1, 4, 4, whole)] }],
            },
            {
              index: 2,
              startPpq: 8,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [rest(1, 8, 4, whole)] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const measures = qa(parse(serializeMusicXml(score)), 'measure');
    expect(q(measures[0], 'attributes > clef > sign').textContent).toBe('G');
    expect(q(measures[1], 'attributes > clef > sign').textContent).toBe('F');
    expect(measures[2].querySelector('attributes > clef')).toBeNull();
  });

  it('escapes XML-reserved characters in names and harmony text', () => {
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Strings & "Pad" <Lead>',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [rest(1, 0, 4, { base: 'whole', dots: 0 })] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
      chordSymbols: [{ ppq: 0, text: 'C<&>7', rootPc: 0, quality: 16 }],
    };
    const xml = serializeMusicXml(score);
    expect(xml).toContain('Strings &amp; &quot;Pad&quot; &lt;Lead&gt;');
    const doc = parse(xml);
    expect(q(doc, 'part-name').textContent).toBe('Strings & "Pad" <Lead>');
    expect(q(doc, 'harmony > kind').getAttribute('text')).toBe('C<&>7');
  });

  it('sanitizes XML 1.0 forbidden control characters in every escaped field', () => {
    const score = grandStaffFixture();
    score.metadata = { title: 'Bad\u0000Title\u000bEnd' };
    score.parts[0].name = 'Lead\u0001Name';
    const xml = serializeMusicXml(score);
    expect([0, 1, 11].some((code) => xml.includes(String.fromCharCode(code)))).toBe(false);
    expect(xml).toContain('\ufffd');
    expect(q(parse(xml), 'work-title').textContent).toBe('Bad\ufffdTitle\ufffdEnd');
  });

  it('is a read-only serializer even when annotations override grand-staff placement', () => {
    const score = grandStaffFixture();
    const event = score.parts[0].measures[0].voices
      .flatMap((voice) => voice.events)
      .find((candidate) => candidate.kind === 'note');
    expect(event).toBeDefined();
    (event as NotatedEvent).sourceIds = [99];
    score.noteAnnotations = { 99: { staffOverride: 2 } };
    const before = structuredClone(score);
    deepFreeze(score);

    expect(() => serializeMusicXml(score)).not.toThrow();
    expect(score).toEqual(before);
  });

  it('skips chord symbols without a usable root or outside the measure grid', () => {
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [rest(1, 0, 4, { base: 'whole', dots: 0 })] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
      chordSymbols: [
        { ppq: 0, text: 'N.C.', rootPc: 255, quality: 9 },
        { ppq: 1, text: 'C', rootPc: 0, quality: 0 },
        { ppq: 99, text: 'G', rootPc: 7, quality: 0 },
      ],
    };
    const doc = parse(serializeMusicXml(score));
    const harmonies = qa(doc, 'harmony');
    expect(harmonies).toHaveLength(1);
    expect(q(harmonies[0], 'root > root-step').textContent).toBe('C');
  });
});

describe('serializeMusicXml beams', () => {
  it('emits explicit beams for consecutive eighth notes grouped by beat', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 2,
              timeSig: { beats: 2, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([60], 1, 0, 0.5, eighth),
                    note([62], 1, 0.5, 0.5, eighth),
                    note([64], 1, 1, 0.5, eighth),
                    note([65], 1, 1.5, 0.5, eighth),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const doc = parse(serializeMusicXml(score));
    const beams = qa(doc, 'beam[number="1"]').map((beam) => beam.textContent);
    expect(beams).toEqual(['begin', 'end', 'begin', 'end']);
  });

  it('emits triplet time-modification and bracket notations', () => {
    const triplet: NoteValue = { base: 'eighth', dots: 0, tuplet: { actual: 3, normal: 2 } };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Triplets',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([60], 1, 0, 1 / 3, triplet),
                    note([62], 1, 1 / 3, 1 / 3, triplet),
                    note([64], 1, 2 / 3, 1 / 3, triplet),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const doc = parse(serializeMusicXml(score));
    expect(qa(doc, 'note > duration').map((el) => el.textContent)).toEqual(['320', '320', '320']);
    expect(qa(doc, 'time-modification > actual-notes').map((el) => el.textContent)).toEqual([
      '3',
      '3',
      '3',
    ]);
    expect(qa(doc, 'time-modification > normal-notes').map((el) => el.textContent)).toEqual([
      '2',
      '2',
      '2',
    ]);
    expect(qa(doc, 'tuplet').map((el) => el.getAttribute('type'))).toEqual(['start', 'stop']);
  });

  it('keeps adjacent triplets as distinct bracket groups', () => {
    const score = quantizeToScore(
      Array.from({ length: 6 }, (_, index) => ({
        id: index + 1,
        pitch: 60 + index,
        velocity: 96,
        startPpq: index / 3,
        durationPpq: 1 / 3,
        channel: 0,
      })),
      {
        divisionPpq: 1 / 3,
        timeSig: { beats: 2, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 2,
      },
    );
    const events = score.parts[0].measures[0].voices[0].events.filter(
      (event) => event.kind === 'note',
    );
    expect(new Set(events.slice(0, 3).map((event) => event.tupletGroupId)).size).toBe(1);
    expect(new Set(events.slice(3).map((event) => event.tupletGroupId)).size).toBe(1);
    expect(events[0].tupletGroupId).not.toBe(events[3].tupletGroupId);
    expect(
      qa(parse(serializeMusicXml(score)), 'tuplet').map((element) => element.getAttribute('type')),
    ).toEqual(['start', 'stop', 'start', 'stop']);
  });

  it('emits balanced triplet bracket notations when rests start or end the group', () => {
    const triplet: NoteValue = { base: 'eighth', dots: 0, tuplet: { actual: 3, normal: 2 } };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Triplet rests',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    rest(1, 0, 1 / 3, triplet),
                    note([62], 1, 1 / 3, 1 / 3, triplet),
                    note([64], 1, 2 / 3, 1 / 3, triplet),
                  ],
                },
              ],
            },
            {
              index: 1,
              startPpq: 1,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([65], 1, 1, 1 / 3, triplet),
                    note([67], 1, 4 / 3, 1 / 3, triplet),
                    rest(1, 5 / 3, 1 / 3, triplet),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    const doc = parse(serializeMusicXml(score));
    const notes = qa(doc, 'note');
    expect(q(notes[0], 'rest')).not.toBeNull();
    expect(q(notes[0], 'notations > tuplet').getAttribute('type')).toBe('start');
    expect(q(notes[5], 'rest')).not.toBeNull();
    expect(q(notes[5], 'notations > tuplet').getAttribute('type')).toBe('stop');
    expect(qa(doc, 'tuplet').map((el) => el.getAttribute('type'))).toEqual([
      'start',
      'stop',
      'start',
      'stop',
    ]);
  });

  it('emits secondary beams for sixteenth-note runs', () => {
    const sixteenth: NoteValue = { base: '16th', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([60], 1, 0, 0.25, sixteenth),
                    note([62], 1, 0.25, 0.25, sixteenth),
                    note([64], 1, 0.5, 0.25, sixteenth),
                    note([65], 1, 0.75, 0.25, sixteenth),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const doc = parse(serializeMusicXml(score));
    expect(qa(doc, 'beam[number="1"]').map((beam) => beam.textContent)).toEqual([
      'begin',
      'continue',
      'continue',
      'end',
    ]);
    expect(qa(doc, 'beam[number="2"]').map((beam) => beam.textContent)).toEqual([
      'begin',
      'continue',
      'continue',
      'end',
    ]);
  });

  it('emits beams on the first pitch of a chord only', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [note([60, 64], 1, 0, 0.5, eighth), note([62], 1, 0.5, 0.5, eighth)],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const notes = qa(parse(serializeMusicXml(score)), 'note');
    expect(notes[0].querySelector('beam[number="1"]')?.textContent).toBe('begin');
    expect(notes[1].querySelector('chord')).not.toBeNull();
    expect(notes[1].querySelector('beam')).toBeNull();
    expect(notes[2].querySelector('beam[number="1"]')?.textContent).toBe('end');
  });

  it('uses dotted-beat groups in compound meters', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 3,
              timeSig: { beats: 6, beatUnit: 8 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([60], 1, 0, 0.5, eighth),
                    note([62], 1, 0.5, 0.5, eighth),
                    note([64], 1, 1, 0.5, eighth),
                    note([65], 1, 1.5, 0.5, eighth),
                    note([67], 1, 2, 0.5, eighth),
                    note([69], 1, 2.5, 0.5, eighth),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const beams = qa(parse(serializeMusicXml(score)), 'beam[number="1"]').map(
      (beam) => beam.textContent,
    );
    expect(beams).toEqual(['begin', 'continue', 'end', 'begin', 'continue', 'end']);
  });

  it('keeps a short rest inside a beamed beat group', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1.5,
              timeSig: { beats: 3, beatUnit: 8 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([60], 1, 0, 0.5, eighth),
                    rest(1, 0.5, 0.5, eighth),
                    note([62], 1, 1, 0.5, eighth),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    const beams = qa(parse(serializeMusicXml(score)), 'beam[number="1"]').map(
      (beam) => beam.textContent,
    );
    expect(beams).toEqual(['begin', 'continue', 'end']);
  });
});

describe('serializeMusicXml percussion', () => {
  it('splits pitched and channel-10 material into separate score parts', () => {
    const score = quantizeToScore(
      [
        { id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
        { id: 2, pitch: 36, velocity: 110, startPpq: 1, durationPpq: 1, channel: 9 },
      ],
      {
        divisionPpq: 0.5,
        timeSig: { beats: 2, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 2,
        partId: 'P1',
        partName: 'Hybrid',
        clef: 'treble',
      },
    );
    expect(score.parts.map((part) => [part.id, part.name])).toEqual([
      ['P1', 'Hybrid'],
      ['P1-percussion', 'Hybrid Percussion'],
    ]);

    const parts = qa(parse(serializeMusicXml(score)), 'score-partwise > part');
    expect(q(parts[0], 'clef > sign').textContent).toBe('G');
    expect(qa(parts[0], 'pitch')).toHaveLength(1);
    expect(q(parts[1], 'clef > sign').textContent).toBe('percussion');
    expect(qa(parts[1], 'unpitched')).toHaveLength(1);
  });

  it('uses MIDI channel 10 to emit unpitched noteheads with a percussion clef', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Track 1',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1.5,
              timeSig: { beats: 3, beatUnit: 8 },
              voices: [
                {
                  voice: 1,
                  events: [
                    { ...note([36], 1, 0, 0.5, eighth), midiChannels: [9] },
                    { ...note([38], 1, 0.5, 0.5, eighth), midiChannels: [9] },
                    { ...note([42], 1, 1, 0.5, eighth), midiChannels: [9] },
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    const doc = parse(serializeMusicXml(score));
    expect(q(doc, 'clef > sign').textContent).toBe('percussion');
    expect(qa(doc, 'pitch')).toHaveLength(0);
    expect(qa(doc, 'unpitched')).toHaveLength(3);
    expect(qa(doc, 'notehead').map((notehead) => notehead.textContent)).toEqual([
      'normal',
      'normal',
      'x',
    ]);
    expect(qa(doc, 'score-instrument instrument-name').map((el) => el.textContent)).toEqual([
      'Bass Drum 1',
      'Acoustic Snare',
      'Closed Hi-Hat',
    ]);
    expect(qa(doc, 'note instrument').map((el) => el.getAttribute('id'))).toEqual([
      'P1-I36',
      'P1-I38',
      'P1-I42',
    ]);
    const firstNoteXml = serializeMusicXml(score)
      .split('\n')
      .find((line) => line.startsWith('<note><unpitched>'));
    expect(firstNoteXml).toContain(
      '</unpitched><duration>480</duration><instrument id="P1-I36"/><voice>1</voice>',
    );
    expect(q(doc, 'direction words').textContent).toContain('Drum map:');
  });

  it('does not turn a named drum part into percussion when MIDI channel data says melodic', () => {
    const quarter: NoteValue = { base: 'quarter', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Drums',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [{ ...note([60], 1, 0, 1, quarter), midiChannels: [0] }],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    const doc = parse(serializeMusicXml(score));
    expect(q(doc, 'clef > sign').textContent).toBe('G');
    expect(qa(doc, 'pitch')).toHaveLength(1);
    expect(qa(doc, 'unpitched')).toHaveLength(0);
  });

  it('emits drum accents from high velocity and ghost noteheads from low velocity', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Kit',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 2, beatUnit: 8 },
              voices: [
                {
                  voice: 1,
                  events: [
                    { ...note([38], 1, 0, 0.5, eighth), midiChannels: [9], velocity: 120 },
                    { ...note([38], 1, 0.5, 0.5, eighth), midiChannels: [9], velocity: 36 },
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    const doc = parse(serializeMusicXml(score));
    expect(qa(doc, 'articulations > accent')).toHaveLength(1);
    expect(q(doc, 'dynamics > ff')).toBeTruthy();
    expect(q(doc, 'dynamics > pp')).toBeTruthy();
    expect(qa(doc, 'notehead').map((el) => el.getAttribute('parentheses'))).toEqual([null, 'yes']);
  });

  it('emits open and closed hi-hat technique markings', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Kit',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 2, beatUnit: 8 },
              voices: [
                {
                  voice: 1,
                  events: [
                    { ...note([42], 1, 0, 0.5, eighth), midiChannels: [9] },
                    { ...note([46], 1, 0.5, 0.5, eighth), midiChannels: [9] },
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    const doc = parse(serializeMusicXml(score));
    expect(qa(doc, 'technical > stopped')).toHaveLength(1);
    expect(qa(doc, 'technical > open-string')).toHaveLength(1);
  });

  it('marks rapid snare repetitions as percussion rolls', () => {
    const sixteenth: NoteValue = { base: '16th', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Kit',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    { ...note([38], 1, 0, 0.25, sixteenth), midiChannels: [9] },
                    { ...note([38], 1, 0.25, 0.25, sixteenth), midiChannels: [9] },
                    { ...note([38], 1, 0.5, 0.25, sixteenth), midiChannels: [9] },
                    { ...note([38], 1, 0.75, 0.25, sixteenth), midiChannels: [9] },
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    const tremolos = qa(parse(serializeMusicXml(score)), 'ornaments > tremolo');
    expect(tremolos).toHaveLength(4);
    expect(tremolos.map((el) => el.getAttribute('type'))).toEqual([
      'single',
      'single',
      'single',
      'single',
    ]);
  });

  it('hides lower drum-voice rests while preserving their durations', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Kit',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 2, beatUnit: 8 },
              voices: [
                {
                  voice: 1,
                  events: [
                    { ...note([42], 1, 0, 0.5, eighth), midiChannels: [9] },
                    { ...note([42], 1, 0.5, 0.5, eighth), midiChannels: [9] },
                  ],
                },
                {
                  voice: 2,
                  events: [
                    { ...note([36], 2, 0, 0.5, eighth), midiChannels: [9] },
                    rest(2, 0.5, 0.5, eighth),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    const hiddenRest = qa(parse(serializeMusicXml(score)), 'note[print-object="no"]').find(
      (el) => el.querySelector('rest') !== null,
    );
    expect(hiddenRest).toBeDefined();
    expect(q(hiddenRest as Element, 'duration').textContent).toBe('480');
  });
});

describe('serializeMusicXml stems', () => {
  it('emits explicit stem directions for multi-voice measures', () => {
    const doc = parse(serializeMusicXml(grandStaffFixture()));
    const [first] = qa(doc, 'measure');
    const notes = qa(first, 'note').filter(
      (noteEl) => noteEl.querySelector('pitch') !== null && noteEl.querySelector('chord') === null,
    );
    const stemsByVoice = notes.map((noteEl) => ({
      voice: q(noteEl, 'voice').textContent,
      stem: q(noteEl, 'stem').textContent,
    }));
    expect(stemsByVoice).toEqual([
      { voice: '1', stem: 'up' },
      { voice: '1', stem: 'up' },
      { voice: '1', stem: 'up' },
      { voice: '2', stem: 'down' },
    ]);
  });

  it('leaves single-voice stems to the engraver', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [note([60], 1, 0, 0.5, eighth), note([62], 1, 0.5, 0.5, eighth)],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    expect(qa(parse(serializeMusicXml(score)), 'stem')).toHaveLength(0);
  });
});

describe('serializeMusicXml rests', () => {
  it('positions multi-voice rests away from the staff center', () => {
    const half: NoteValue = { base: 'half', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [
                { voice: 1, events: [rest(1, 0, 2, half), note([72], 1, 2, 2, half)] },
                { voice: 2, events: [note([48], 2, 0, 2, half), rest(2, 2, 2, half)] },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const rests = qa(parse(serializeMusicXml(score)), 'note > rest:not([measure])');
    expect(rests).toHaveLength(2);
    expect(q(rests[0], 'display-step').textContent).toBe('B');
    expect(q(rests[0], 'display-octave').textContent).toBe('4');
    expect(q(rests[1], 'display-step').textContent).toBe('D');
    expect(q(rests[1], 'display-octave').textContent).toBe('4');
  });

  it('leaves single-voice rests and measure rests unpositioned', () => {
    const eighth: NoteValue = { base: 'eighth', dots: 0 };
    const singleVoiceScore: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [
                { voice: 1, events: [rest(1, 0, 0.5, eighth), note([60], 1, 0.5, 0.5, eighth)] },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const singleRest = q(parse(serializeMusicXml(singleVoiceScore)), 'note > rest:not([measure])');
    expect(singleRest.querySelector('display-step')).toBeNull();

    const [, second] = qa(parse(serializeMusicXml(grandStaffFixture())), 'measure');
    const measureRest = q(second, 'note > rest[measure="yes"]');
    expect(measureRest.querySelector('display-step')).toBeNull();
  });
});

describe('serializeMusicXml slurs', () => {
  it('places slur starts above upper voices and below lower voices', () => {
    const half: NoteValue = { base: 'half', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [note([72], 1, 0, 2, half, {}, [1]), note([74], 1, 2, 2, half, {}, [2])],
                },
                {
                  voice: 2,
                  events: [note([48], 2, 0, 2, half, {}, [3]), note([50], 2, 2, 2, half, {}, [4])],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
      noteAnnotations: {
        1: { slurToNoteId: 2 },
        3: { slurToNoteId: 4 },
      },
    };
    const slurStarts = qa(parse(serializeMusicXml(score)), 'slur[type="start"]');
    expect(slurStarts).toHaveLength(2);
    expect(slurStarts.map((slur) => slur.getAttribute('placement'))).toEqual(['above', 'below']);
  });

  it('leaves slur stops without placement', () => {
    const half: NoteValue = { base: 'half', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([60], 1, 0, 2, half, {}, [10]),
                    note([62], 1, 2, 2, half, {}, [11]),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
      noteAnnotations: { 10: { slurToNoteId: 11 } },
    };
    const doc = parse(serializeMusicXml(score));
    expect(q(doc, 'slur[type="start"]').getAttribute('placement')).toBe('above');
    expect(q(doc, 'slur[type="stop"]').getAttribute('placement')).toBeNull();
  });
});

describe('serializeMusicXml articulations', () => {
  it('places articulations above upper voices and below lower voices', () => {
    const half: NoteValue = { base: 'half', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 2,
              timeSig: { beats: 2, beatUnit: 4 },
              voices: [
                { voice: 1, events: [note([72], 1, 0, 2, half, {}, [1])] },
                { voice: 2, events: [note([48], 2, 0, 2, half, {}, [2])] },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
      noteAnnotations: {
        1: { articulation: 'accent' },
        2: { articulation: 'staccato' },
      },
    };
    const doc = parse(serializeMusicXml(score));
    expect(q(doc, 'accent').getAttribute('placement')).toBe('above');
    expect(q(doc, 'staccato').getAttribute('placement')).toBe('below');
  });
});

describe('serializeMusicXml dynamics', () => {
  it('keeps single-voice dynamics below the staff', () => {
    const quarter: NoteValue = { base: 'quarter', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([72], 1, 0, 1, quarter, {}, [1])] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
      noteAnnotations: { 1: { dynamics: 'f' } },
    };
    expect(q(parse(serializeMusicXml(score)), 'direction').getAttribute('placement')).toBe('below');
  });

  it('places multi-voice dynamics with their voices', () => {
    const half: NoteValue = { base: 'half', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 2,
              timeSig: { beats: 2, beatUnit: 4 },
              voices: [
                { voice: 1, events: [note([72], 1, 0, 2, half, {}, [1])] },
                { voice: 2, events: [note([48], 2, 0, 2, half, {}, [2])] },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
      noteAnnotations: {
        1: { dynamics: 'f' },
        2: { dynamics: 'p' },
      },
    };
    const directions = qa(parse(serializeMusicXml(score)), 'direction');
    expect(directions.map((direction) => direction.getAttribute('placement'))).toEqual([
      'above',
      'below',
    ]);
  });
});

describe('serializeMusicXml accidentals', () => {
  it('emits accidentals when a pitch leaves and returns to the measure state', () => {
    const quarter: NoteValue = { base: 'quarter', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([61], 1, 0, 1, quarter),
                    note([61], 1, 1, 1, quarter),
                    note([60], 1, 2, 1, quarter),
                    note([60], 1, 3, 1, quarter),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    expect(qa(parse(serializeMusicXml(score)), 'accidental').map((el) => el.textContent)).toEqual([
      'sharp',
      'natural',
    ]);
  });

  it('places accidentals after type and dots in MusicXML note order', () => {
    const quarter: NoteValue = { base: 'quarter', dots: 1 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1.5,
              timeSig: { beats: 3, beatUnit: 8 },
              voices: [{ voice: 1, events: [note([61], 1, 0, 1.5, quarter)] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const noteXml = serializeMusicXml(score)
      .split('\n')
      .find((line) => line.startsWith('<note><pitch>'));
    expect(noteXml).toContain(
      '<duration>1440</duration><voice>1</voice><type>quarter</type><dot/><accidental>sharp</accidental>',
    );
  });

  it('places accidentals before time-modification for tuplets', () => {
    const triplet: NoteValue = { base: 'eighth', dots: 0, tuplet: { actual: 3, normal: 2 } };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 1, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([61], 1, 0, 1 / 3, triplet)] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const noteXml = serializeMusicXml(score)
      .split('\n')
      .find((line) => line.startsWith('<note><pitch>'));
    expect(noteXml).toContain(
      '<type>eighth</type><accidental>sharp</accidental><time-modification>',
    );
  });

  it('honors key-signature accidentals and naturals', () => {
    const quarter: NoteValue = { base: 'quarter', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 3,
              timeSig: { beats: 3, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([66], 1, 0, 1, quarter),
                    note([65], 1, 1, 1, quarter),
                    note([66], 1, 2, 1, quarter),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 1,
      divisions: 960,
    };
    expect(qa(parse(serializeMusicXml(score)), 'accidental').map((el) => el.textContent)).toEqual([
      'natural',
      'sharp',
    ]);
  });

  it('does not restate accidentals on tied continuations', () => {
    const half: NoteValue = { base: 'half', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 2,
              timeSig: { beats: 2, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([61], 1, 0, 2, half, { tieStart: true })] }],
            },
            {
              index: 1,
              startPpq: 2,
              lengthPpq: 2,
              timeSig: { beats: 2, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([61], 1, 2, 2, half, { tieStop: true })] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    expect(qa(parse(serializeMusicXml(score)), 'accidental').map((el) => el.textContent)).toEqual([
      'sharp',
    ]);
  });

  it('uses tied continuations to seed the measure accidental state', () => {
    const half: NoteValue = { base: 'half', dots: 0 };
    const quarter: NoteValue = { base: 'quarter', dots: 0 };
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 2,
              timeSig: { beats: 2, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([61], 1, 0, 2, half, { tieStart: true })] }],
            },
            {
              index: 1,
              startPpq: 2,
              lengthPpq: 2,
              timeSig: { beats: 2, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([61], 1, 2, 1, quarter, { tieStop: true }),
                    note([61], 1, 3, 1, quarter),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    expect(qa(parse(serializeMusicXml(score)), 'accidental').map((el) => el.textContent)).toEqual([
      'sharp',
    ]);
  });
});

describe('escapeXml', () => {
  it('escapes all five reserved characters and leaves the rest alone', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(escapeXml('Cmaj7')).toBe('Cmaj7');
  });
});

describe('serializeMusicXml golden output', () => {
  it('matches the expected document for a minimal single-voice score', () => {
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [
                {
                  voice: 1,
                  events: [
                    note([60], 1, 0, 2, { base: 'half', dots: 0 }),
                    note([62], 1, 2, 1.5, { base: 'quarter', dots: 1 }),
                    rest(1, 3.5, 0.5, { base: 'eighth', dots: 0 }),
                  ],
                },
              ],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const expected = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
      '<score-partwise version="4.0">',
      '<identification>',
      '<encoding><software>sonare studio</software></encoding>',
      '</identification>',
      '<defaults>',
      '<scaling><millimeters>7</millimeters><tenths>40</tenths></scaling>',
      '<page-layout><page-height>1697</page-height><page-width>1200</page-width><page-margins type="both"><left-margin>70</left-margin><right-margin>70</right-margin><top-margin>70</top-margin><bottom-margin>70</bottom-margin></page-margins></page-layout>',
      '<system-layout><system-margins><left-margin>0</left-margin><right-margin>0</right-margin></system-margins><system-distance>150</system-distance><top-system-distance>100</top-system-distance></system-layout>',
      '<staff-layout><staff-distance>80</staff-distance></staff-layout>',
      '<appearance><line-width type="beam">5</line-width><line-width type="bracket">4</line-width><line-width type="dashes">1</line-width><line-width type="enclosure">1</line-width><line-width type="ending">1.2</line-width><line-width type="extend">1</line-width><line-width type="heavy barline">5</line-width><line-width type="leger">1.6</line-width><line-width type="light barline">1.6</line-width><line-width type="octave shift">1.2</line-width><line-width type="pedal">1.2</line-width><line-width type="slur middle">1.6</line-width><line-width type="slur tip">0.5</line-width><line-width type="staff">1.1</line-width><line-width type="stem">1</line-width><line-width type="tie middle">1.6</line-width><line-width type="tie tip">0.5</line-width><note-size type="cue">60</note-size><note-size type="grace">60</note-size></appearance>',
      '</defaults>',
      '<part-list>',
      '<score-part id="P1"><part-name>Lead</part-name><part-abbreviation>Lead</part-abbreviation></score-part>',
      '</part-list>',
      '<part id="P1">',
      '<measure number="1">',
      '<print><measure-numbering>system</measure-numbering></print>',
      '<attributes><divisions>960</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>',
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1920</duration><voice>1</voice><type>half</type></note>',
      '<note><pitch><step>D</step><octave>4</octave></pitch><duration>1440</duration><voice>1</voice><type>quarter</type><dot/></note>',
      '<note><rest/><duration>480</duration><voice>1</voice><type>eighth</type></note>',
      '<barline location="right"><bar-style>light-heavy</bar-style></barline>',
      '</measure>',
      '</part>',
      '</score-partwise>',
    ].join('\n');
    expect(serializeMusicXml(score)).toBe(expected);
  });

  it('golden smoke: the two-voice grand-staff fixture serializes deterministically', () => {
    const a = serializeMusicXml(grandStaffFixture());
    const b = serializeMusicXml(grandStaffFixture());
    expect(a).toBe(b);
    // Spot-check exact lines that exercise chords, ties, staves and harmony.
    const lines = a.split('\n');
    expect(lines).toContain(
      '<note><pitch><step>G</step><octave>4</octave></pitch><duration>960</duration><voice>1</voice><type>quarter</type><stem>up</stem><staff>1</staff></note>',
    );
    expect(lines).toContain(
      '<note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>960</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>',
    );
    expect(lines).toContain(
      '<note><pitch><step>B</step><octave>4</octave></pitch><duration>1920</duration><tie type="start"/><voice>1</voice><type>half</type><stem>up</stem><staff>1</staff><notations><tied type="start"/></notations></note>',
    );
    expect(lines).toContain(
      '<note><pitch><step>B</step><octave>4</octave></pitch><duration>1920</duration><tie type="stop"/><voice>1</voice><type>half</type><stem>up</stem><staff>1</staff><notations><tied type="stop"/></notations></note>',
    );
    expect(lines).toContain(
      '<note><rest measure="yes"/><duration>3840</duration><voice>2</voice><staff>2</staff></note>',
    );
    expect(lines).toContain(
      '<harmony><root><root-step>D</root-step></root><kind>major</kind><bass><bass-step>F</bass-step><bass-alter>1</bass-alter></bass><offset>1920</offset></harmony>',
    );
  });
});
