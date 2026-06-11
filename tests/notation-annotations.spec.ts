import { describe, expect, it } from 'vitest';
import type { NotatedEvent, NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { type QuantizeOptions, quantizeToScore } from '@/notation/quantize';
import type { ScoreNoteAnnotation } from '@/project/annotations';
import type { EditorNote } from '@/project/types';

/** Builds an EditorNote fixture with editor defaults. */
function makeNote(id: number, pitch: number, startPpq: number, durationPpq: number): EditorNote {
  return { id, pitch, velocity: 96, startPpq, durationPpq, channel: 0 };
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

/** Collects every note event of a score in document order. */
function noteEvents(score: NotatedScore): NotatedEvent[] {
  const out: NotatedEvent[] = [];
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const voice of measure.voices) {
        for (const event of voice.events) {
          if (event.kind === 'note') out.push(event);
        }
      }
    }
  }
  return out;
}

/** Quantizes notes, attaches annotations and serializes to MusicXML. */
function engrave(
  notes: EditorNote[],
  annotations: Record<number, ScoreNoteAnnotation>,
  overrides: Partial<QuantizeOptions> = {},
): string {
  const score = quantizeToScore(notes, baseOptions(overrides));
  score.noteAnnotations = annotations;
  return serializeMusicXml(score);
}

/** Parses serializer output and asserts well-formedness. */
function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc;
}

describe('quantizeToScore source ids', () => {
  it('threads editor note ids onto note events', () => {
    const score = quantizeToScore([makeNote(11, 60, 0, 1), makeNote(22, 64, 1, 1)], baseOptions());
    const events = noteEvents(score);
    expect(events.map((event) => event.sourceIds)).toEqual([[11], [22]]);
  });

  it('merges chord member ids into one event', () => {
    const score = quantizeToScore([makeNote(5, 60, 0, 1), makeNote(3, 64, 0, 1)], baseOptions());
    const events = noteEvents(score);
    expect(events).toHaveLength(1);
    expect(events[0].pitches).toEqual([60, 64]);
    expect(events[0].sourceIds).toEqual([3, 5]);
  });

  it('keeps the source ids on every tie piece, with one attack piece', () => {
    // Spans the barline at 4 PPQ, so it splits into two tied events.
    const score = quantizeToScore([makeNote(7, 60, 3, 2)], baseOptions());
    const events = noteEvents(score);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ tieStart: true, tieStop: false, sourceIds: [7] });
    expect(events[1]).toMatchObject({ tieStart: false, tieStop: true, sourceIds: [7] });
  });

  it('rests carry no source ids', () => {
    const score = quantizeToScore([makeNote(1, 60, 0, 1)], baseOptions());
    for (const part of score.parts) {
      for (const measure of part.measures) {
        for (const voice of measure.voices) {
          for (const event of voice.events) {
            if (event.kind === 'rest') expect(event.sourceIds).toBeUndefined();
          }
        }
      }
    }
  });
});

describe('quantizeToScore display transpose', () => {
  it('shifts engraved pitches without touching the input notes', () => {
    const note = makeNote(1, 60, 0, 1);
    const score = quantizeToScore([note], baseOptions({ displayTransposeSemitones: -12 }));
    expect(noteEvents(score)[0].pitches).toEqual([48]);
    expect(note.pitch).toBe(60); // The MIDI note is never modified.
    const doc = parse(serializeMusicXml(score));
    const pitch = doc.querySelector('note > pitch');
    expect(pitch?.querySelector('step')?.textContent).toBe('C');
    expect(pitch?.querySelector('octave')?.textContent).toBe('3');
  });

  it('transposes upward and keeps spelling in key', () => {
    const score = quantizeToScore(
      [makeNote(1, 61, 0, 1)],
      baseOptions({ displayTransposeSemitones: 12, keyFifths: -1 }),
    );
    expect(noteEvents(score)[0].pitches).toEqual([73]);
    const doc = parse(serializeMusicXml(score));
    const pitch = doc.querySelector('note > pitch');
    // Flat key: pc 1 spells as D flat; MIDI 73 sits in octave 5.
    expect(pitch?.querySelector('step')?.textContent).toBe('D');
    expect(pitch?.querySelector('alter')?.textContent).toBe('-1');
    expect(pitch?.querySelector('octave')?.textContent).toBe('5');
  });

  it('clamps shifted pitches to the MIDI range', () => {
    const score = quantizeToScore(
      [makeNote(1, 120, 0, 1), makeNote(2, 5, 1, 1)],
      baseOptions({ displayTransposeSemitones: 12 }),
    );
    const pitches = noteEvents(score).flatMap((event) => event.pitches);
    expect(pitches).toEqual([127, 17]);
  });

  it('rejects non-integer transpose values', () => {
    expect(() =>
      quantizeToScore([makeNote(1, 60, 0, 1)], baseOptions({ displayTransposeSemitones: 0.5 })),
    ).toThrow(RangeError);
  });
});

describe('serializeMusicXml dynamics', () => {
  it('emits a direction with the dynamics mark right before the note', () => {
    const xml = engrave([makeNote(1, 72, 0, 1), makeNote(2, 74, 1, 1)], { 1: { dynamics: 'f' } });
    parse(xml);
    const lines = xml.split('\n');
    const directionIndex = lines.findIndex((line) => line.includes('<dynamics><f/></dynamics>'));
    expect(directionIndex).toBeGreaterThan(-1);
    expect(lines[directionIndex]).toBe(
      '<direction placement="below"><direction-type><dynamics><f/></dynamics></direction-type></direction>',
    );
    expect(lines[directionIndex + 1]).toContain('<step>C</step>');
  });

  it('supports every dynamics marking as its own element', () => {
    for (const dynamics of ['pp', 'p', 'mp', 'mf', 'f', 'ff'] as const) {
      const xml = engrave([makeNote(1, 72, 0, 1)], { 1: { dynamics } });
      const doc = parse(xml);
      expect(doc.querySelector(`direction-type > dynamics > ${dynamics}`)).not.toBeNull();
    }
  });

  it('emits the dynamics direction with the bass staff on a grand staff', () => {
    const xml = engrave([makeNote(1, 40, 0, 1)], { 1: { dynamics: 'pp' } }, { clef: 'grand' });
    parse(xml);
    expect(xml).toContain(
      '<direction placement="below"><direction-type><dynamics><pp/></dynamics></direction-type><staff>2</staff></direction>',
    );
  });
});

describe('serializeMusicXml articulations', () => {
  it('maps each marking to its MusicXML articulation element', () => {
    const expected = {
      staccato: '<articulations><staccato/></articulations>',
      accent: '<articulations><accent/></articulations>',
      tenuto: '<articulations><tenuto/></articulations>',
      marcato: '<articulations><strong-accent/></articulations>',
    } as const;
    for (const [articulation, fragment] of Object.entries(expected)) {
      const xml = engrave([makeNote(1, 72, 0, 1)], {
        1: { articulation: articulation as keyof typeof expected },
      });
      parse(xml);
      expect(xml).toContain(`<notations>${fragment}</notations>`);
    }
  });

  it('emits chord articulations on the first chord note only', () => {
    const xml = engrave([makeNote(1, 60, 0, 1), makeNote(2, 64, 0, 1)], {
      1: { articulation: 'staccato' },
    });
    parse(xml);
    const noteLines = xml
      .split('\n')
      .filter((line) => line.startsWith('<note>') && line.includes('<pitch>'));
    expect(noteLines).toHaveLength(2);
    expect(noteLines[0]).toContain('<articulations><staccato/></articulations>');
    expect(noteLines[0]).not.toContain('<chord/>');
    expect(noteLines[1]).toContain('<chord/>');
    expect(noteLines[1]).not.toContain('<articulations>');
  });

  it('attaches the articulation to the attack of a tie chain only', () => {
    const xml = engrave([makeNote(1, 60, 3, 2)], { 1: { articulation: 'accent' } });
    parse(xml);
    const noteLines = xml.split('\n').filter((line) => line.startsWith('<note>'));
    const attack = noteLines.find((line) => line.includes('<tie type="start"/>'));
    const tail = noteLines.find((line) => line.includes('<tie type="stop"/>'));
    expect(attack).toContain('<articulations><accent/></articulations>');
    expect(tail).not.toContain('<articulations>');
  });
});

describe('serializeMusicXml slurs', () => {
  it('emits a matched start/stop pair with the same number', () => {
    const xml = engrave([makeNote(1, 60, 0, 1), makeNote(2, 64, 1, 1)], {
      1: { slurToNoteId: 2 },
    });
    parse(xml);
    const noteLines = xml.split('\n').filter((line) => line.startsWith('<note>'));
    expect(noteLines[0]).toContain('<notations><slur type="start" number="1"/></notations>');
    expect(noteLines[1]).toContain('<notations><slur type="stop" number="1"/></notations>');
  });

  it('gives overlapping slurs distinct numbers', () => {
    const xml = engrave(
      [makeNote(1, 60, 0, 1), makeNote(2, 64, 1, 1), makeNote(3, 67, 2, 1), makeNote(4, 72, 3, 1)],
      { 1: { slurToNoteId: 3 }, 2: { slurToNoteId: 4 } },
    );
    parse(xml);
    expect(xml).toContain('<slur type="start" number="1"/>');
    expect(xml).toContain('<slur type="start" number="2"/>');
    expect(xml).toContain('<slur type="stop" number="1"/>');
    expect(xml).toContain('<slur type="stop" number="2"/>');
  });

  it('reuses slur numbers once the previous slur has ended', () => {
    const xml = engrave(
      [makeNote(1, 60, 0, 1), makeNote(2, 64, 1, 1), makeNote(3, 67, 2, 1), makeNote(4, 72, 3, 1)],
      { 1: { slurToNoteId: 2 }, 3: { slurToNoteId: 4 } },
    );
    parse(xml);
    const slurs = xml.match(/<slur [^>]*\/>/g) ?? [];
    expect(slurs).toEqual([
      '<slur type="start" number="1"/>',
      '<slur type="stop" number="1"/>',
      '<slur type="start" number="1"/>',
      '<slur type="stop" number="1"/>',
    ]);
  });

  it('skips slurs whose target does not start after the source', () => {
    const xml = engrave([makeNote(1, 60, 2, 1), makeNote(2, 64, 0, 1)], {
      1: { slurToNoteId: 2 },
    });
    parse(xml);
    expect(xml).not.toContain('<slur');
  });

  it('skips slurs whose target note no longer exists', () => {
    const xml = engrave([makeNote(1, 60, 0, 1)], { 1: { slurToNoteId: 999 } });
    parse(xml);
    expect(xml).not.toContain('<slur');
  });
});

describe('serializeMusicXml orphaned annotations', () => {
  it('ignores annotations whose note id maps to no engraved event', () => {
    const xml = engrave([makeNote(1, 60, 0, 1)], {
      999: { dynamics: 'ff', articulation: 'staccato', slurToNoteId: 1 },
    });
    parse(xml);
    expect(xml).not.toContain('<dynamics>');
    expect(xml).not.toContain('<articulations>');
    expect(xml).not.toContain('<slur');
  });

  it('keeps output identical when the annotation record is empty', () => {
    const notes = [makeNote(1, 60, 0, 1), makeNote(2, 64, 1, 1)];
    const plain = serializeMusicXml(quantizeToScore(notes, baseOptions()));
    expect(engrave(notes, {})).toBe(plain);
  });
});
