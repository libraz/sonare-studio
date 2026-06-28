import { describe, expect, it } from 'vitest';
import type {
  NotatedEvent,
  NotatedMeasure,
  NotatedScore,
  NotatedVoiceNumber,
  NoteValue,
} from '@/notation/model';
import { escapeXml, serializeMusicXml } from '@/notation/musicxml';

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
  });

  it('emits all measures with 1-based numbers', () => {
    const measures = qa(doc, 'part[id="P1"] > measure');
    expect(measures).toHaveLength(2);
    expect(measures.map((m) => m.getAttribute('number'))).toEqual(['1', '2']);
  });

  it('emits divisions, key, time and grand-staff clefs in the first measure only', () => {
    const [first, second] = qa(doc, 'measure');
    const attrs = q(first, 'attributes');
    expect(q(attrs, 'divisions').textContent).toBe('960');
    expect(q(attrs, 'key > fifths').textContent).toBe('1');
    expect(q(attrs, 'time > beats').textContent).toBe('4');
    expect(q(attrs, 'time > beat-type').textContent).toBe('4');
    expect(q(attrs, 'staves').textContent).toBe('2');
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

  it('emits harmony elements at their measure offsets', () => {
    const [first, second] = qa(doc, 'measure');
    const firstHarmonies = qa(first, 'harmony');
    expect(firstHarmonies).toHaveLength(2);
    expect(q(firstHarmonies[0], 'root > root-step').textContent).toBe('G');
    expect(q(firstHarmonies[0], 'kind').textContent).toBe('major');
    expect(firstHarmonies[0].querySelector('offset')).toBeNull();
    expect(q(firstHarmonies[1], 'root > root-step').textContent).toBe('C');
    expect(q(firstHarmonies[1], 'kind').textContent).toBe('major-seventh');
    expect(q(firstHarmonies[1], 'offset').textContent).toBe('1920');
    expect(qa(second, 'harmony')).toHaveLength(2);
  });

  it('falls back to kind other with the display text for exotic qualities', () => {
    const second = qa(doc, 'measure')[1];
    const exotic = qa(second, 'harmony')[0];
    const kind = q(exotic, 'kind');
    expect(kind.textContent).toBe('other');
    expect(kind.getAttribute('text')).toBe('Bm(add9)');
    expect(q(exotic, 'root > root-step').textContent).toBe('B');
  });

  it('spells slash-chord basses with the key signature', () => {
    const second = qa(doc, 'measure')[1];
    const slash = qa(second, 'harmony')[1];
    expect(q(slash, 'root > root-step').textContent).toBe('D');
    expect(q(slash, 'bass > bass-step').textContent).toBe('F');
    expect(q(slash, 'bass > bass-alter').textContent).toBe('1');
    expect(q(slash, 'offset').textContent).toBe('1920');
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
      '<part-list>',
      '<score-part id="P1"><part-name>Lead</part-name></score-part>',
      '</part-list>',
      '<part id="P1">',
      '<measure number="1">',
      '<attributes><divisions>960</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>',
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1920</duration><voice>1</voice><type>half</type></note>',
      '<note><pitch><step>D</step><octave>4</octave></pitch><duration>1440</duration><voice>1</voice><type>quarter</type><dot/></note>',
      '<note><rest/><duration>480</duration><voice>1</voice><type>eighth</type></note>',
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
      '<note><pitch><step>G</step><octave>4</octave></pitch><duration>960</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>',
    );
    expect(lines).toContain(
      '<note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>960</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>',
    );
    expect(lines).toContain(
      '<note><pitch><step>B</step><octave>4</octave></pitch><duration>1920</duration><tie type="start"/><voice>1</voice><type>half</type><staff>1</staff><notations><tied type="start"/></notations></note>',
    );
    expect(lines).toContain(
      '<note><pitch><step>B</step><octave>4</octave></pitch><duration>1920</duration><tie type="stop"/><voice>1</voice><type>half</type><staff>1</staff><notations><tied type="stop"/></notations></note>',
    );
    expect(lines).toContain(
      '<note><rest measure="yes"/><duration>3840</duration><voice>2</voice><staff>2</staff></note>',
    );
    expect(lines).toContain(
      '<harmony><root><root-step>D</root-step></root><kind>major</kind><bass><bass-step>F</bass-step><bass-alter>1</bass-alter></bass><offset>1920</offset></harmony>',
    );
  });
});
