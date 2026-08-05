import { describe, expect, it } from 'vitest';
import type {
  NotatedEvent,
  NotatedMeasure,
  NotatedScore,
  NotatedVoiceNumber,
  NoteValue,
} from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import {
  DEFAULT_MUSICXML_IMPORT_LIMITS,
  importMusicXml,
  importMusicXmlWithReport,
  MusicXmlImportError,
} from '@/notation/musicxml-import';
import { quantizeToScore } from '@/notation/quantize';
import type { DocumentNote } from '@/project/serialization';

const QUARTER: NoteValue = { base: 'quarter', dots: 0 };
const HALF: NoteValue = { base: 'half', dots: 0 };
const WHOLE: NoteValue = { base: 'whole', dots: 0 };

/** Builds a note/chord event with sensible defaults. */
function note(
  pitches: number[],
  voice: NotatedVoiceNumber,
  startPpq: number,
  durationPpq: number,
  value: NoteValue,
  ties: { tieStart?: boolean; tieStop?: boolean } = {},
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

/** Returns the notes of the first clip of a track, sorted by onset then pitch. */
function trackNotes(doc: ReturnType<typeof importMusicXml>, trackIndex: number): DocumentNote[] {
  return doc.tracks[trackIndex].clips[0].notes;
}

/** Minimal two-PPQ part carrying start and optional offset tempo directions. */
function tempoPart(id: string, startBpm: number, midBpm?: number): string {
  return (
    `<part id="${id}"><measure number="1">` +
    '<attributes><divisions>2</divisions></attributes>' +
    `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${startBpm + 30}</per-minute></metronome></direction-type>` +
    `<sound tempo="${startBpm}"/></direction>` +
    '<forward><duration>2</duration></forward>' +
    (midBpm === undefined
      ? ''
      : `<direction><offset>1</offset><sound tempo="${midBpm}"/></direction>`) +
    '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note>' +
    '</measure></part>'
  );
}

function tempoScore(parts: string): string {
  return (
    '<score-partwise version="4.0"><part-list>' +
    '<score-part id="P1"><part-name>One</part-name></score-part>' +
    '<score-part id="P2"><part-name>Two</part-name></score-part>' +
    `</part-list>${parts}</score-partwise>`
  );
}

describe('importMusicXml error handling', () => {
  it('rejects malformed XML', () => {
    expect(() => importMusicXml('<score-partwise><part')).toThrow(MusicXmlImportError);
  });

  it('rejects a non-score root element', () => {
    expect(() => importMusicXml('<html><body/></html>')).toThrow(MusicXmlImportError);
  });

  it('rejects score-timewise documents', () => {
    expect(() => importMusicXml('<score-timewise version="4.0"></score-timewise>')).toThrow(
      MusicXmlImportError,
    );
  });

  it('returns an empty-but-valid project for a score with no parts', () => {
    const doc = importMusicXml('<score-partwise version="4.0"><part-list/></score-partwise>');
    expect(doc.tracks).toEqual([]);
    expect(doc.tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
    expect(doc.timeSignatures).toEqual([]);
  });

  it('does not throw on a part with an empty measure', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1">' +
      '<part-name>Empty</part-name></score-part></part-list>' +
      '<part id="P1"><measure number="1"/></part></score-partwise>';
    const doc = importMusicXml(xml);
    expect(doc.tracks).toHaveLength(1);
    expect(trackNotes(doc, 0)).toEqual([]);
  });

  it('enforces byte, element-depth, semantic-count and numeric limits before traversal', () => {
    const empty = '<score-partwise version="4.0"><part-list/></score-partwise>';
    expect(() => importMusicXmlWithReport(empty, undefined, { maxBytes: 10 })).toThrow(/byte/);
    expect(() => importMusicXmlWithReport(empty, undefined, { maxDepth: 1 })).toThrow(/depth/);
    const noteXml =
      '<score-partwise><part-list/><part id="P1"><measure><note><rest/><duration>1</duration></note></measure></part></score-partwise>';
    expect(() => importMusicXmlWithReport(noteXml, undefined, { maxNotes: 0 })).toThrow(
      /note limit/,
    );
    const huge = noteXml.replace('<duration>1</duration>', '<duration>999999999999</duration>');
    expect(() => importMusicXml(huge)).toThrow(/numeric value/);
    const strictNumeric = noteXml.replace('<duration>1</duration>', '<duration>11</duration>');
    expect(() => importMusicXmlWithReport(strictNumeric, undefined, { maxNumericAbs: 10 })).toThrow(
      /numeric value/,
    );
    const dynamics =
      '<score-partwise><part-list/><part id="P1"><measure><attributes><divisions>1</divisions>' +
      '</attributes><note dynamics="11"><pitch><step>C</step><octave>4</octave></pitch>' +
      '<duration>1</duration></note></measure></part></score-partwise>';
    expect(
      trackNotes(importMusicXmlWithReport(dynamics, undefined, { maxNumericAbs: 10 }).document, 0),
    ).toEqual([{ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }]);
  });

  it('allows large scores by default and reports a friendly complexity limit', () => {
    expect(DEFAULT_MUSICXML_IMPORT_LIMITS.maxElements).toBe(5_000_000);
    const xml = '<score-partwise><part-list/></score-partwise>';
    expect(() => importMusicXmlWithReport(xml, undefined, { maxElements: 1 })).toThrow(
      /too complex to import/,
    );
  });

  it('collects nested loss-report elements without recursive traversal', () => {
    const wrappers = '<wrapper>'.repeat(100);
    const closes = '</wrapper>'.repeat(100);
    const xml =
      '<score-partwise><part-list/><part id="P1"><measure><direction>' +
      `${wrappers}<harmony/>${closes}` +
      '</direction></measure></part></score-partwise>';

    expect(importMusicXmlWithReport(xml).report.issues).toContainEqual({
      feature: 'harmony',
      count: 1,
    });
  });
});

describe('importMusicXml note timing', () => {
  it('maps pitch, octave, alter and divisions-based durations to PPQ', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1">' +
      '<part-name>Lead</part-name></score-part></part-list>' +
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note>' +
      '<note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration></note>' +
      '<note><rest/><duration>2</duration></note>' +
      '<note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>2</duration></note>' +
      '</measure></part></score-partwise>';
    const notes = trackNotes(importMusicXml(xml), 0);
    expect(notes).toEqual([
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 66, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 },
      { pitch: 58, velocity: 96, startPpq: 3, durationPpq: 1, channel: 0 },
    ]);
  });

  it('stacks chord notes at a single onset', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>1</divisions></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>' +
      '<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>' +
      '<note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note>' +
      '</measure></part></score-partwise>';
    const notes = trackNotes(importMusicXml(xml), 0);
    expect(notes.map((n) => n.pitch)).toEqual([60, 64, 67]);
    expect(notes.every((n) => n.startPpq === 0 && n.durationPpq === 4)).toBe(true);
  });

  it('preserves score-part metadata when the optional part ids are absent', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part><part-name>Lead</part-name></score-part></part-list>' +
      '<part><measure number="1"><attributes><divisions>1</divisions></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>' +
      '</measure></part></score-partwise>';

    const doc = importMusicXml(xml);

    expect(doc.tracks[0].name).toBe('Lead');
    expect(doc.tracks[0].musicXmlPartId).toBe('P1');
  });

  it('merges tied notes into one sustained note', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1">' +
      '<measure number="1"><attributes><divisions>1</divisions>' +
      '<time><beats>4</beats><beat-type>4</beat-type></time></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>' +
      '<tie type="start"/></note></measure>' +
      '<measure number="2">' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>' +
      '<tie type="stop"/></note></measure>' +
      '</part></score-partwise>';
    const notes = trackNotes(importMusicXml(xml), 0);
    expect(notes).toEqual([{ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 8, channel: 0 }]);
  });

  it('applies backup to layer a second voice at the measure start', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>1</divisions></attributes>' +
      '<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice></note>' +
      '<backup><duration>4</duration></backup>' +
      '<note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice></note>' +
      '</measure></part></score-partwise>';
    const notes = trackNotes(importMusicXml(xml), 0);
    expect(notes).toEqual([
      { pitch: 48, velocity: 96, startPpq: 0, durationPpq: 4, channel: 0 },
      { pitch: 72, velocity: 96, startPpq: 0, durationPpq: 4, channel: 0 },
    ]);
  });

  it('advances the cursor for forward elements', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>1</divisions></attributes>' +
      '<forward><duration>2</duration></forward>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note>' +
      '</measure></part></score-partwise>';
    const notes = trackNotes(importMusicXml(xml), 0);
    expect(notes).toEqual([{ pitch: 60, velocity: 96, startPpq: 2, durationPpq: 2, channel: 0 }]);
  });
});

describe('importMusicXml global maps', () => {
  it('applies chromatic transpose to recover concert pitch for a B-flat clarinet', () => {
    const xml =
      '<score-partwise><part-list><score-part id="P1"><part-name>Clarinet in Bb</part-name></score-part></part-list>' +
      '<part id="P1"><measure><attributes><divisions>1</divisions>' +
      '<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>' +
      '</measure></part></score-partwise>';
    expect(trackNotes(importMusicXml(xml), 0)[0].pitch).toBe(58);
  });

  it('applies octave-change together with chromatic transpose', () => {
    const xml =
      '<score-partwise><part-list><score-part id="P1"><part-name>Piccolo</part-name></score-part></part-list>' +
      '<part id="P1"><measure><attributes><divisions>1</divisions>' +
      '<transpose><chromatic>0</chromatic><octave-change>1</octave-change></transpose></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>' +
      '</measure></part></score-partwise>';
    expect(trackNotes(importMusicXml(xml), 0)[0].pitch).toBe(72);
  });

  it('applies octave transpose for guitar and bass written pitch', () => {
    const xml =
      '<score-partwise><part-list>' +
      '<score-part id="G"><part-name>Guitar</part-name></score-part>' +
      '<score-part id="B"><part-name>Bass</part-name></score-part>' +
      '</part-list>' +
      '<part id="G"><measure><attributes><divisions>1</divisions>' +
      '<transpose><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>' +
      '</attributes><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note>' +
      '</measure></part>' +
      '<part id="B"><measure><attributes><divisions>1</divisions>' +
      '<transpose><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>' +
      '</attributes><note><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration></note>' +
      '</measure></part></score-partwise>';

    const doc = importMusicXml(xml);
    expect(trackNotes(doc, 0)[0]?.pitch).toBe(52);
    expect(trackNotes(doc, 1)[0]?.pitch).toBe(40);
  });

  it('preserves empty and trailing-rest measures in the imported clip length', () => {
    const xml =
      '<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">' +
      '<measure number="1"><attributes><divisions>1</divisions>' +
      '<time><beats>4</beats><beat-type>4</beat-type></time></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>' +
      '<note><rest/><duration>3</duration></note></measure>' +
      '<measure number="2"><note><rest/><duration>4</duration></note></measure>' +
      '</part></score-partwise>';
    const clip = importMusicXml(xml).tracks[0].clips[0];
    expect(clip.notes).toHaveLength(1);
    expect(clip.lengthPpq).toBe(8);
  });

  it('preserves an implicit opening pickup length and following measure origin', () => {
    const xml =
      '<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">' +
      '<measure number="0" implicit="yes"><attributes><divisions>1</divisions>' +
      '<time><beats>4</beats><beat-type>4</beat-type></time></attributes>' +
      '<note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure>' +
      '<measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch>' +
      '<duration>4</duration></note></measure></part></score-partwise>';
    const doc = importMusicXml(xml);
    expect(doc.pickupLengthPpq).toBe(1);
    expect(trackNotes(doc, 0).map((note) => note.startPpq)).toEqual([0, 1]);
  });

  it('reads pitched MIDI channel mappings and note/direction dynamics', () => {
    const xml =
      '<score-partwise><part-list><score-part id="P1"><part-name>Lead</part-name>' +
      '<score-instrument id="P1-C3"><instrument-name>Lead</instrument-name></score-instrument>' +
      '<midi-instrument id="P1-C3"><midi-channel>3</midi-channel></midi-instrument>' +
      '</score-part></part-list><part id="P1"><measure><attributes><divisions>1</divisions></attributes>' +
      '<direction><sound dynamics="50"/></direction>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>' +
      '<instrument id="P1-C3"/></note>' +
      '<note dynamics="100"><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration>' +
      '<instrument id="P1-C3"/></note></measure></part></score-partwise>';
    expect(trackNotes(importMusicXml(xml), 0)).toEqual([
      { pitch: 60, velocity: 45, startPpq: 0, durationPpq: 1, channel: 2 },
      { pitch: 62, velocity: 90, startPpq: 1, durationPpq: 1, channel: 2 },
    ]);
  });

  it('imports MIDI program, volume, and pan into the track strip', () => {
    const xml =
      '<score-partwise><part-list><score-part id="P1"><part-name>Organ</part-name>' +
      '<midi-instrument id="P1-I1"><midi-channel>2</midi-channel><midi-program>20</midi-program>' +
      '<volume>75</volume><pan>-45</pan></midi-instrument></score-part></part-list>' +
      '<part id="P1"><measure><attributes><divisions>1</divisions></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>' +
      '<instrument id="P1-I1"/></note></measure></part></score-partwise>';

    const [track] = importMusicXml(xml).tracks;
    expect(track).toMatchObject({
      volume: 0.75,
      pan: -0.5,
      instrument: { kind: 'synth-preset', preset: 'organ', gmProgram: 19 },
    });
  });

  it('reads tempo from a sound direction and time signature from attributes', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>' +
      '<direction><sound tempo="90"/></direction>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>3</duration></note>' +
      '</measure></part></score-partwise>';
    const doc = importMusicXml(xml);
    expect(doc.tempoSegments).toEqual([{ startPpq: 0, bpm: 90 }]);
    expect(doc.timeSignatures).toEqual([{ startPpq: 0, numerator: 3, denominator: 4 }]);
  });

  it('sums MusicXML additive meter pairs with a common denominator', () => {
    const xml =
      '<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">' +
      '<measure number="1"><attributes><divisions>1</divisions><time>' +
      '<beats>3+2</beats><beat-type>8</beat-type></time></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>5</duration></note>' +
      '</measure></part></score-partwise>';

    const doc = importMusicXml(xml);
    expect(doc.timeSignatures).toEqual([{ startPpq: 0, numerator: 5, denominator: 8 }]);
  });

  it('sums multiple MusicXML beats and beat-type pairs with a common denominator', () => {
    const xml =
      '<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">' +
      '<measure number="1"><attributes><divisions>1</divisions><time>' +
      '<beats>3</beats><beat-type>8</beat-type><beats>2</beats><beat-type>8</beat-type>' +
      '</time></attributes><note><pitch><step>C</step><octave>4</octave></pitch>' +
      '<duration>5</duration></note></measure></part></score-partwise>';

    expect(importMusicXml(xml).timeSignatures).toEqual([
      { startPpq: 0, numerator: 5, denominator: 8 },
    ]);
  });

  it('derives tempo from a metronome mark with a dotted beat unit', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>1</divisions></attributes>' +
      '<direction><direction-type><metronome><beat-unit>quarter</beat-unit>' +
      '<beat-unit-dot/><per-minute>80</per-minute></metronome></direction-type></direction>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>' +
      '</measure></part></score-partwise>';
    expect(importMusicXml(xml).tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
  });

  it('uses only the first part as the global tempo source and reports later conflicts', () => {
    const p1First = importMusicXmlWithReport(
      tempoScore(tempoPart('P1', 90) + tempoPart('P2', 140)),
    );
    expect(p1First.document.tempoSegments).toEqual([{ startPpq: 0, bpm: 90 }]);
    expect(p1First.report.issues).toEqual([{ feature: 'tempo-conflicts', count: 1 }]);

    const p2First = importMusicXmlWithReport(
      tempoScore(tempoPart('P2', 140) + tempoPart('P1', 90)),
    );
    expect(p2First.document.tempoSegments).toEqual([{ startPpq: 0, bpm: 140 }]);
    expect(p2First.report.issues).toEqual([{ feature: 'tempo-conflicts', count: 1 }]);
  });

  it('deduplicates equal later-part tempo and preserves offset timing', () => {
    const imported = importMusicXmlWithReport(
      tempoScore(tempoPart('P1', 90, 100) + tempoPart('P2', 90, 100)),
    );
    expect(imported.document.tempoSegments).toEqual([
      { startPpq: 0, bpm: 90 },
      { startPpq: 1.5, bpm: 100 },
    ]);
    expect(imported.report.issues).toEqual([]);
  });

  it('reports but does not apply a later-part mid-measure tempo conflict', () => {
    const imported = importMusicXmlWithReport(
      tempoScore(tempoPart('P1', 90, 100) + tempoPart('P2', 90, 110)),
    );
    expect(imported.document.tempoSegments).toEqual([
      { startPpq: 0, bpm: 90 },
      { startPpq: 1.5, bpm: 100 },
    ]);
    expect(imported.report.issues).toEqual([{ feature: 'tempo-conflicts', count: 1 }]);
  });

  it('records the key signature as a marker', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>1</divisions><key><fifths>-3</fifths></key></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>' +
      '</measure></part></score-partwise>';
    expect(importMusicXml(xml).markers).toEqual([{ ppq: 0, name: 'Key: Eb major' }]);
  });

  it('advances a full bar for an underfilled non-pickup measure', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>' +
      '<part id="P1">' +
      '<measure number="1">' +
      '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' +
      // Only a half note fills this 4/4 bar; trailing rests were omitted.
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note>' +
      '</measure>' +
      '<measure number="2">' +
      '<attributes><key><fifths>1</fifths></key></attributes>' +
      '<note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration></note>' +
      '</measure></part></score-partwise>';
    const doc = importMusicXml(xml);
    // Measure 2 starts one full bar in (PPQ 4), not at the content end (PPQ 2),
    // so its key marker and note stay aligned to the barline.
    expect(doc.markers).toEqual([{ ppq: 4, name: 'Key: G major' }]);
    expect(trackNotes(doc, 0)).toEqual([
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 2, channel: 0 },
      { pitch: 62, velocity: 96, startPpq: 4, durationPpq: 4, channel: 0 },
    ]);
  });

  it('advances a non-opening implicit split measure by its actual partial length', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list><part id="P1">' +
      '<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure>' +
      '<measure number="2" implicit="yes">' +
      '<note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note></measure>' +
      '<measure number="3"><attributes><key><fifths>1</fifths></key></attributes>' +
      '<note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note></measure>' +
      '</part></score-partwise>';

    const doc = importMusicXml(xml);

    expect(doc.markers).toEqual([{ ppq: 5, name: 'Key: G major' }]);
    expect(trackNotes(doc, 0).map((note) => note.startPpq)).toEqual([0, 4, 5]);
  });

  it('maps an unpitched note onto the percussion channel', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1">' +
      '<part-name>Drums</part-name>' +
      '<midi-instrument id="P1-I37"><midi-channel>10</midi-channel>' +
      '<midi-unpitched>37</midi-unpitched></midi-instrument></score-part></part-list>' +
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>1</divisions></attributes>' +
      '<note><unpitched><display-step>E</display-step><display-octave>4</display-octave></unpitched>' +
      '<duration>1</duration><instrument id="P1-I37"/></note>' +
      '</measure></part></score-partwise>';
    const notes = trackNotes(importMusicXml(xml), 0);
    expect(notes).toEqual([{ pitch: 36, velocity: 96, startPpq: 0, durationPpq: 1, channel: 9 }]);
  });

  it('uses the display-position drum map without midi-unpitched metadata', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Drums</part-name></score-part></part-list>' +
      '<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>' +
      '<note><unpitched><display-step>G</display-step><display-octave>5</display-octave></unpitched>' +
      '<duration>1</duration></note></measure></part></score-partwise>';

    expect(trackNotes(importMusicXml(xml), 0)).toEqual([
      { pitch: 42, velocity: 96, startPpq: 0, durationPpq: 1, channel: 9 },
    ]);
  });
});

describe('importMusicXml multi-part', () => {
  it('creates one track per part', () => {
    const xml =
      '<score-partwise version="4.0"><part-list>' +
      '<score-part id="P1"><part-name>Flute</part-name></score-part>' +
      '<score-part id="P2"><part-name>Cello</part-name></score-part></part-list>' +
      '<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>' +
      '<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note></measure></part>' +
      '<part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>' +
      '<note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note></measure></part>' +
      '</score-partwise>';
    const doc = importMusicXml(xml);
    expect(doc.tracks.map((t) => t.name)).toEqual(['Flute', 'Cello']);
    expect(doc.tracks.map((t) => t.musicXmlPartId)).toEqual(['P1', 'P2']);
    expect(trackNotes(doc, 0)[0].pitch).toBe(72);
    expect(trackNotes(doc, 1)[0].pitch).toBe(48);
  });
});

describe('importMusicXml round-trip with the serializer', () => {
  it('engraves and re-exports an imported pickup on a triplet display grid', () => {
    const xml =
      '<score-partwise version="4.0"><part-list><score-part id="P1"/></part-list><part id="P1">' +
      '<measure number="0" implicit="yes"><attributes><divisions>48</divisions>' +
      '<time><beats>4</beats><beat-type>4</beat-type></time></attributes>' +
      '<note><pitch><step>G</step><octave>4</octave></pitch><duration>33</duration></note></measure>' +
      '<measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch>' +
      '<duration>192</duration></note></measure></part></score-partwise>';
    const document = importMusicXml(xml);
    const clip = document.tracks[0].clips[0];
    const score = quantizeToScore(clip.notes, {
      divisionPpq: 1 / 6,
      timeSig: { beats: 4, beatUnit: 4 },
      keyFifths: 0,
      clipStartPpq: 0,
      clipLengthPpq: clip.lengthPpq,
      pickupLengthPpq: document.pickupLengthPpq,
    });

    expect(() => serializeMusicXml(score)).not.toThrow();
    expect(score.parts[0].measures[0].lengthPpq).toBeCloseTo(2 / 3, 12);
  });

  it('round-trips Sonare pitched channel and velocity metadata', () => {
    const score = quantizeToScore(
      [
        { id: 1, pitch: 60, velocity: 45, startPpq: 0, durationPpq: 1, channel: 2 },
        { id: 2, pitch: 67, velocity: 108, startPpq: 1, durationPpq: 1, channel: 5 },
      ],
      {
        divisionPpq: 0.25,
        timeSig: { beats: 2, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 2,
        partName: 'Lead',
      },
    );
    expect(trackNotes(importMusicXml(serializeMusicXml(score)), 0)).toEqual([
      { pitch: 60, velocity: 45, startPpq: 0, durationPpq: 1, channel: 2 },
      { pitch: 67, velocity: 108, startPpq: 1, durationPpq: 1, channel: 5 },
    ]);
  });

  it('returns structured loss counts for unsupported notation', () => {
    const xml =
      '<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure>' +
      '<attributes><divisions>1</divisions></attributes>' +
      '<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>' +
      '<note><grace/><pitch><step>D</step><octave>4</octave></pitch>' +
      '<notations><articulations><accent/></articulations><technical><fingering>2</fingering></technical></notations>' +
      '<lyric><text>la</text></lyric></note>' +
      '<barline><repeat direction="backward"/></barline></measure></part></score-partwise>';
    expect(importMusicXmlWithReport(xml).report.issues).toEqual([
      { feature: 'harmony', count: 1 },
      { feature: 'lyrics', count: 1 },
      { feature: 'repeats', count: 1 },
      { feature: 'fingering', count: 1 },
      { feature: 'annotations', count: 1 },
      { feature: 'grace-notes', count: 1 },
    ]);
  });

  it('recovers pitches, onsets and durations from serialized output', () => {
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
              note([60, 64, 67], 1, 0, 1, QUARTER),
              note([62], 1, 1, 1, QUARTER),
              note([64], 1, 2, 2, HALF, { tieStart: true }),
            ],
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
            events: [note([64], 1, 4, 2, HALF, { tieStop: true }), rest(1, 6, 2, HALF)],
          },
        ],
      },
    ];
    const score: NotatedScore = {
      parts: [{ id: 'P1', name: 'Piano', clef: 'treble', measures }],
      keyFifths: 0,
      divisions: 960,
    };
    const doc = importMusicXml(serializeMusicXml(score));
    expect(doc.tracks).toHaveLength(1);
    expect(trackNotes(doc, 0)).toEqual([
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 67, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 62, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 96, startPpq: 2, durationPpq: 4, channel: 0 },
    ]);
  });

  it('round-trips a whole-measure rest to an empty but valid clip', () => {
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Rest',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [rest(1, 0, 4, WHOLE)] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };
    const doc = importMusicXml(serializeMusicXml(score));
    expect(trackNotes(doc, 0)).toEqual([]);
  });

  it('marks an opening pickup implicit so its following measure keeps its timing', () => {
    const score: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Pickup',
          clef: 'treble',
          measures: [
            {
              index: 0,
              startPpq: 0,
              lengthPpq: 1,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([67], 1, 0, 1, QUARTER)] }],
            },
            {
              index: 1,
              startPpq: 1,
              lengthPpq: 4,
              timeSig: { beats: 4, beatUnit: 4 },
              voices: [{ voice: 1, events: [note([60], 1, 1, 4, WHOLE)] }],
            },
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    const xml = serializeMusicXml(score);
    expect(xml).toContain('<measure number="0" implicit="yes">');
    expect(xml).toContain('<measure number="1">');
    const doc = importMusicXml(xml);
    expect(doc.pickupLengthPpq).toBe(1);
    expect(trackNotes(doc, 0).map((event) => event.startPpq)).toEqual([0, 1]);
  });
});
