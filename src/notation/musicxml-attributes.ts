/**
 * A measure's `<attributes>`: divisions, key, time, clef and transposition,
 * written only where they change.
 */

import type { NotatedClef, NotatedMeasure, NotatedScore, NotatedTimeSig } from './model';

/**
 * Builds the `<attributes>` element for a measure, emitting only what
 * changed: divisions/key/clef in the first measure, time on every change.
 *
 * @returns The element string, or undefined when nothing needs emitting.
 */
export function measureAttributesXml(
  measure: NotatedMeasure,
  clef: NotatedClef,
  score: NotatedScore,
  prevTimeSig: NotatedTimeSig | undefined,
  prevClef: NotatedClef | undefined,
  keyFifths: number | undefined,
  percussion: boolean,
): string | undefined {
  const isFirst = prevTimeSig === undefined;
  const parts: string[] = [];
  if (isFirst) {
    parts.push(`<divisions>${score.divisions}</divisions>`);
    parts.push(`<key><fifths>${keyFifths ?? score.keyFifths}</fifths></key>`);
  } else if (keyFifths !== undefined) {
    parts.push(`<key><fifths>${keyFifths}</fifths></key>`);
  }
  const timeChanged =
    prevTimeSig === undefined ||
    prevTimeSig.beats !== measure.timeSig.beats ||
    prevTimeSig.beatUnit !== measure.timeSig.beatUnit;
  if (timeChanged) {
    parts.push(
      `<time><beats>${measure.timeSig.beats}</beats><beat-type>${measure.timeSig.beatUnit}</beat-type></time>`,
    );
  }
  if (isFirst || clef !== prevClef) {
    parts.push(clefXml(clef, percussion));
  }
  if (isFirst && !percussion) parts.push(transposeXml(score.transposeSemitones ?? 0));
  return parts.length > 0 ? `<attributes>${parts.join('')}</attributes>` : undefined;
}

/** Chooses a conservative temporary clef for a single-staff measure. */
export function clefForMeasure(
  partClef: NotatedClef,
  measure: NotatedMeasure,
  prevClef: NotatedClef | undefined,
): NotatedClef {
  if (partClef === 'grand') return 'grand';
  const pitches = measure.voices.flatMap((voice) =>
    voice.events.flatMap((event) => (event.kind === 'note' ? event.pitches : [])),
  );
  if (pitches.length === 0) return prevClef ?? partClef;
  const mean = pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length;
  if (partClef === 'treble' && mean < 52) return 'bass';
  if (partClef === 'bass' && mean >= 67) return 'treble';
  return partClef;
}

/**
 * Returns the `<transpose>` that maps written pitches back to sounding ones
 * for an engraving shifted up by `semitones`, or '' when there is no shift.
 */
function transposeXml(semitones: number): string {
  if (semitones === 0) return '';
  const octaves = Math.trunc(-semitones / 12);
  const chromatic = -semitones - octaves * 12;
  return `<transpose><chromatic>${chromatic}</chromatic>${
    octaves === 0 ? '' : `<octave-change>${octaves}</octave-change>`
  }</transpose>`;
}

/**
 * Returns the clef (and staves, for grand staff) attribute fragment.
 */
function clefXml(clef: NotatedClef, percussion = false): string {
  if (percussion) return '<clef><sign>percussion</sign></clef>';
  switch (clef) {
    case 'treble':
      return '<clef><sign>G</sign><line>2</line></clef>';
    case 'bass':
      return '<clef><sign>F</sign><line>4</line></clef>';
    case 'grand':
      return (
        '<staves>2</staves>' +
        '<part-symbol top-staff="1" bottom-staff="2">brace</part-symbol>' +
        '<clef number="1"><sign>G</sign><line>2</line></clef>' +
        '<clef number="2"><sign>F</sign><line>4</line></clef>'
      );
  }
}
