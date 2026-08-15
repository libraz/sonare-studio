/**
 * Engraved output at the key signatures the notation layer stresses hardest:
 * the extremes where the diatonic set includes E#/B# or Cb/Fb, and a line whose
 * upward resolution forces a double sharp.
 */

import { describe, expect, it } from 'vitest';
import type { NotatedEvent, NotatedScore, NoteValue } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';

const QUARTER: NoteValue = { base: 'quarter', dots: 0 };

function note(pitch: number, startPpq: number): NotatedEvent {
  return {
    kind: 'note',
    pitches: [pitch],
    voice: 1,
    startPpq,
    durationPpq: 1,
    value: QUARTER,
    tieStart: false,
    tieStop: false,
  };
}

/**
 * A single-voice line, one quarter note per measure. Isolating each note means
 * no neighbour supplies melodic context, so the writer spells purely from the
 * key signature.
 */
function score(pitches: number[], keyFifths: number): NotatedScore {
  return {
    parts: [
      {
        id: 'P1',
        name: 'Lead',
        clef: 'treble',
        measures: pitches.map((pitch, index) => ({
          index,
          startPpq: index,
          lengthPpq: 1,
          timeSig: { beats: 1, beatUnit: 4 },
          voices: [{ voice: 1 as const, events: [note(pitch, index)] }],
        })),
      },
    ],
    keyFifths,
    divisions: 960,
  };
}

/** A single-voice line inside one measure, so neighbours supply context. */
function phrase(pitches: number[], keyFifths: number): NotatedScore {
  return {
    parts: [
      {
        id: 'P1',
        name: 'Lead',
        clef: 'treble',
        measures: [
          {
            index: 0,
            startPpq: 0,
            lengthPpq: pitches.length,
            timeSig: { beats: pitches.length, beatUnit: 4 },
            voices: [{ voice: 1 as const, events: pitches.map(note) }],
          },
        ],
      },
    ],
    keyFifths,
    divisions: 960,
  };
}

function parse(xml: string): Document {
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  expect(document.querySelector('parsererror')).toBeNull();
  return document;
}

/** Every engraved pitch as `step alter octave`, e.g. `E#4`. */
function engravedPitches(xml: string): string[] {
  return Array.from(parse(xml).querySelectorAll('note > pitch')).map((pitch) => {
    const step = pitch.querySelector('step')?.textContent ?? '';
    const alter = Number(pitch.querySelector('alter')?.textContent ?? '0');
    const octave = pitch.querySelector('octave')?.textContent ?? '';
    const accidental = alter === 0 ? '' : alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter);
    return `${step}${accidental}${octave}`;
  });
}

function engravedAccidentals(xml: string): string[] {
  return Array.from(parse(xml).querySelectorAll('accidental')).map(
    (element) => element.textContent ?? '',
  );
}

/** The chromatic octave from middle C. */
const CHROMATIC = [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71];

describe('MusicXML engraving at extreme key signatures', () => {
  it('writes B# and E# in C# major', () => {
    const xml = serializeMusicXml(score(CHROMATIC, 7));
    expect(xml).toContain('<key><fifths>7</fifths></key>');
    expect(engravedPitches(xml)).toEqual([
      'B#3',
      'C#4',
      'D4',
      'D#4',
      'E4',
      'E#4',
      'F#4',
      'G4',
      'G#4',
      'A4',
      'A#4',
      'B4',
    ]);
  });

  it('writes Cb and Fb in Cb major', () => {
    const xml = serializeMusicXml(score(CHROMATIC, -7));
    expect(xml).toContain('<key><fifths>-7</fifths></key>');
    expect(engravedPitches(xml)).toEqual([
      'C4',
      'Db4',
      'D4',
      'Eb4',
      'Fb4',
      'F4',
      'Gb4',
      'G4',
      'Ab4',
      'A4',
      'Bb4',
      'Cb5',
    ]);
  });

  it('keeps a chromatic tone on the flat side of a flat signature', () => {
    // B natural in Bb major is a raised tonic spelled B, never Cb.
    const xml = serializeMusicXml(score([70, 71, 72], -2));
    expect(engravedPitches(xml)).toEqual(['Bb4', 'B4', 'C5']);
    expect(engravedAccidentals(xml)).toEqual(['natural']);
  });

  it('engraves a double sharp when a raised degree resolves upward', () => {
    // B major: F## rises to G#, so the accidental is a double sharp.
    const xml = serializeMusicXml(phrase([67, 68], 5));
    expect(engravedPitches(xml)).toEqual(['F##4', 'G#4']);
    expect(engravedAccidentals(xml)).toEqual(['double-sharp']);
  });

  it('spells a leading tone into the tonic of an extreme flat key', () => {
    // Cb major: the leading tone below Cb5 is Bb4, and the tonic keeps its
    // Cb spelling rather than collapsing to B natural.
    const xml = serializeMusicXml(phrase([70, 71], -7));
    expect(engravedPitches(xml)).toEqual(['Bb4', 'Cb5']);
  });
});
