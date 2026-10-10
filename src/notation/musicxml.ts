/**
 * MusicXML 4.0 serializer for the display-only notation pipeline.
 *
 * Converts a {@link NotatedScore} into a `score-partwise` document string.
 * The serializer is a pure, read-only consumer of the notation model: it
 * never mutates its input and nothing here writes back to MIDI data.
 *
 * Output is deterministic (stable element ordering, one structural element
 * per line) so it can be snapshot-tested and diffed; consumers must not rely
 * on any particular whitespace beyond well-formedness.
 */

import type {
  NoteArticulation,
  NoteDynamics,
  NoteLineSpan,
  NoteOrnament,
} from '@/project/annotations';
import { staffForMeanPitch } from './grand-staff';
import {
  measureHasMultiRestStructure,
  type NotatedBarlineStyle,
  type NotatedChordSymbol,
  type NotatedClef,
  type NotatedEvent,
  type NotatedLyric,
  type NotatedMeasure,
  type NotatedMeasureBreak,
  type NotatedMeasureText,
  type NotatedMultiMeasureRest,
  type NotatedPart,
  type NotatedRepeatMark,
  type NotatedScore,
  type NotatedTempoMark,
  type NotatedTempoText,
  type NotatedTimeSig,
  type NotatedVoice,
  type NotatedVoiceNumber,
  type NoteValue,
  ppqToDivisions,
  ppqToNoteValue,
  timeSigLengthPpq,
} from './model';
import {
  type AccidentalIndex,
  accidentalXml,
  activeKeyFifthsByMeasure,
  buildAccidentalIndex,
  buildPartPitchSpellingIndex,
  type PitchSpellingIndex,
  pitchXml,
} from './musicxml-accidentals';
import {
  type AnnotationIndex,
  buildAnnotationIndex,
  buildLyricIndex,
  type LineSpanRender,
  type LyricIndex,
  slurPlacement,
} from './musicxml-annotation-index';
import { type BeamIndex, beamXml, beatGroupPpq, buildBeamIndex } from './musicxml-beams';
import { groupChordSymbolsByMeasure, harmonyXml } from './musicxml-harmony';
import {
  eventUsesPercussionMap,
  GM_PERCUSSION_CHANNEL,
  noteheadXml,
  partUsesPercussionMap,
  percussionDisplay,
  percussionInstrumentDefinitions,
  percussionInstrumentId,
  percussionLegendDirectionXml,
  percussionTechnicalXml,
  unpitchedXml,
} from './musicxml-percussion';
import { PPQ_EPSILON, type ScoreInstrumentDefinition, type StaffNumber } from './musicxml-shared';
import {
  appendScoreCredits,
  appendScoreDefaults,
  appendScoreHeader,
  escapeXml,
} from './musicxml-xml';
import { type Step, spellPitchInKeySignature } from './pitch-spelling';
import { scoreNoteXmlId } from './source-identity';

/** MIDI split point between the staves of a grand staff (middle C / C4). */
const GRAND_STAFF_SPLIT_MIDI = 60;

/**
 * MusicXML articulation element name per annotation marking.
 *
 * A marking absent from this table has no element of its own in the format and
 * is written as `<other-articulation>` carrying its name, which is what the
 * schema provides for a technique it does not enumerate; a reader that knows
 * the name gets the intent, and one that does not still parses the file.
 */
const ARTICULATION_ELEMENT: Readonly<Partial<Record<NoteArticulation, string>>> = {
  staccato: 'staccato',
  accent: 'accent',
  tenuto: 'tenuto',
  marcato: 'strong-accent',
};

/**
 * Serializes a {@link NotatedScore} to a MusicXML 4.0 `score-partwise`
 * document.
 *
 * Layout decisions:
 * - `<divisions>`, `<key>` and `<clef>` are emitted in the first measure of
 *   each part only (they are score-constant in the model); `<time>` is
 *   re-emitted whenever it differs from the previous measure.
 * - Grand-staff parts (`clef: 'grand'`) get two staves; note events are
 *   assigned to staff 1 (treble) when their mean pitch is >= middle C
 *   (MIDI 60) and staff 2 (bass) otherwise. Rests inherit the staff of the
 *   nearest preceding note in the same voice (looking ahead to the first
 *   note when a voice starts with rests; all-rest voices default to staff 1).
 * - Voices are emitted in ascending order with a `<backup>` of one full
 *   measure between them (voices are gap-free by model contract).
 * - A voice consisting of a single rest spanning the measure is emitted as a
 *   whole-measure rest (`<rest measure="yes"/>`, no `<type>`).
 * - Chord symbols are attached to the first part only, emitted as
 *   `<harmony>` at the start of their containing measure with an `<offset>`
 *   for mid-measure positions. Symbols without a valid `rootPc` (0-11) and
 *   symbols outside the measure grid are skipped.
 * - Display annotations (`score.noteAnnotations`) resolve onto the attack
 *   event of each annotated note: dynamics become a `<direction>` right
 *   before the note, articulations and slurs go inside the first chord
 *   note's `<notations>`. Annotations whose note (or slur target) no longer
 *   maps to an event are skipped silently.
 *
 * @param score The display-only score to serialize.
 * @returns A complete MusicXML document string (newline-separated).
 */
export function serializeMusicXml(score: NotatedScore): string {
  validatePartIds(score);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
  ];
  appendScoreHeader(lines, score.metadata);
  appendScoreDefaults(lines);
  appendScoreCredits(lines, score.metadata);
  lines.push('<part-list>');
  for (const part of score.parts) {
    lines.push(scorePartXml(part));
  }
  lines.push('</part-list>');
  const annotations = buildAnnotationIndex(score);
  const lyrics = buildLyricIndex(score);
  score.parts.forEach((part, partIndex) => {
    const chordSymbols = partIndex === 0 ? (score.chordSymbols ?? []) : [];
    serializePart(lines, part, score, chordSymbols, annotations, lyrics);
  });
  lines.push('</score-partwise>');
  return lines.join('\n');
}

/**
 * MusicXML uses the part id as the global key joining `<score-part>` entries
 * in `<part-list>` to their corresponding `<part>` elements. Duplicate ids
 * therefore make an otherwise well-formed document ambiguous. Validate the
 * complete score before writing any XML so malformed input fails atomically.
 */
function validatePartIds(score: NotatedScore): void {
  const seen = new Set<string>();
  for (const part of score.parts) {
    if (seen.has(part.id)) {
      throw new RangeError(`MusicXML part ids must be unique: ${part.id}`);
    }
    seen.add(part.id);
  }
}

/**
 * Returns a new score containing one part, preserving shared score annotations
 * useful for a printed part. The input score is not mutated.
 */
export function extractPartScore(
  score: NotatedScore,
  partIdOrIndex: string | number,
): NotatedScore {
  const index =
    typeof partIdOrIndex === 'number'
      ? partIdOrIndex
      : score.parts.findIndex((part) => part.id === partIdOrIndex);
  const part = score.parts[index];
  if (part === undefined) {
    throw new RangeError(`Unknown score part: ${String(partIdOrIndex)}`);
  }
  return extractPartsScore(score, [index]);
}

/**
 * Returns a new score containing the selected parts in the requested order.
 *
 * The source score and all of its part/event objects are read only; only the
 * top-level score, metadata and parts array are copied. Shared score-level
 * notation data (annotations, lyrics, breaks, harmonies, and so on) remains
 * available to the serializer, which naturally ignores entries that do not
 * resolve onto a selected part.
 *
 * A one-part selection gets the selected part's name as `metadata.partName`,
 * matching {@link extractPartScore}; multi-part selections preserve the
 * source metadata unchanged.
 */
export function extractPartsScore(
  score: NotatedScore,
  indices: ReadonlyArray<number>,
): NotatedScore {
  if (indices.length === 0) {
    throw new RangeError('At least one score part must be selected');
  }
  const seenIndices = new Set<number>();
  const parts = indices.map((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= score.parts.length) {
      throw new RangeError(`Unknown score part index: ${String(index)}`);
    }
    if (seenIndices.has(index)) {
      throw new RangeError(`Score part indices must be unique: ${index}`);
    }
    seenIndices.add(index);
    return score.parts[index];
  });
  const metadata =
    parts.length === 1
      ? { ...score.metadata, partName: parts[0].name }
      : score.metadata === undefined
        ? undefined
        : { ...score.metadata };
  return { ...score, metadata, parts };
}

/** Builds a score-part entry with a deterministic abbreviation. */
function scorePartXml(part: NotatedPart): string {
  const name = escapeXml(part.name);
  const abbreviation = escapeXml(partAbbreviation(part.name));
  const instruments = scorePartInstrumentsXml(part);
  return `<score-part id="${escapeXml(part.id)}"><part-name>${name}</part-name><part-abbreviation>${abbreviation}</part-abbreviation>${instruments}</score-part>`;
}

/** Pitched MIDI channels explicitly carried by this part's note events. */
function pitchedChannels(part: NotatedPart): number[] {
  const channels = new Set<number>();
  for (const measure of part.measures) {
    for (const voice of measure.voices) {
      for (const event of voice.events) {
        if (event.kind !== 'note') continue;
        for (const channel of event.midiChannels ?? []) {
          if (channel !== GM_PERCUSSION_CHANNEL && channel >= 0 && channel <= 15) {
            channels.add(channel);
          }
        }
      }
    }
  }
  return [...channels].sort((a, b) => a - b);
}

function pitchedInstrumentId(partId: string, channel: number): string {
  return `${escapeXml(partId)}-C${channel + 1}`;
}

function pitchedInstrumentDefinitions(part: NotatedPart): ScoreInstrumentDefinition[] {
  return pitchedChannels(part).map((channel) => ({
    id: pitchedInstrumentId(part.id, channel),
    name: `${part.name || 'Part'} channel ${channel + 1}`,
    channel: channel + 1,
  }));
}

/**
 * MusicXML requires all `<score-instrument>` entries to precede every
 * `<midi-instrument>` entry inside a score-part. Keep that content-model order
 * even when a part carries several pitched channels or a drum map.
 */
function scorePartInstrumentsXml(part: NotatedPart): string {
  const definitions = [
    ...pitchedInstrumentDefinitions(part),
    ...(partUsesPercussionMap(part) ? percussionInstrumentDefinitions(part) : []),
  ];
  const scoreInstruments = definitions
    .map(
      ({ id, name }) =>
        `<score-instrument id="${id}"><instrument-name>${escapeXml(name)}</instrument-name></score-instrument>`,
    )
    .join('');
  const midiInstruments = definitions
    .map(({ id, channel, unpitched }) => {
      const midiUnpitched =
        unpitched === undefined ? '' : `<midi-unpitched>${unpitched}</midi-unpitched>`;
      return `<midi-instrument id="${id}"><midi-channel>${channel}</midi-channel>${midiUnpitched}</midi-instrument>`;
    })
    .join('');
  return scoreInstruments + midiInstruments;
}

/** Derives a compact part abbreviation when the model has no explicit one. */
function partAbbreviation(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '';
  const words = trimmed.split(/\s+/);
  if (words.length === 1) return trimmed.length <= 12 ? trimmed : `${trimmed.slice(0, 11)}.`;
  const initials = words
    .filter((word) => /[A-Za-z0-9]/.test(word))
    .map((word) => word[0].toUpperCase())
    .join('');
  return initials.length > 0 && initials.length <= 6 ? initials : `${trimmed.slice(0, 11)}.`;
}

/**
 * Appends one `<part>` element (all measures) to the output lines.
 */
function serializePart(
  lines: string[],
  part: NotatedPart,
  score: NotatedScore,
  chordSymbols: ReadonlyArray<NotatedChordSymbol>,
  annotations: AnnotationIndex,
  lyrics: LyricIndex,
): void {
  const staffMap =
    part.clef === 'grand' ? buildStaffMap(part, annotations.staffOverrides) : undefined;
  const percussion = partUsesPercussionMap(part);
  const symbolsByMeasure = groupChordSymbolsByMeasure(chordSymbols, part.measures);
  lines.push(`<part id="${escapeXml(part.id)}">`);
  let prevTimeSig: NotatedTimeSig | undefined;
  let prevClef: NotatedClef | undefined;
  const keyFifthsByMeasure = activeKeyFifthsByMeasure(part, score);
  const spellings = buildPartPitchSpellingIndex(part, keyFifthsByMeasure);
  // Percussion velocity directions are inferred display metadata. Keep the
  // previous value per voice across measure boundaries so a steady groove
  // does not print the same dynamic at the start of every measure.
  const inferredDynamicsByVoice = new Map<NotatedVoiceNumber, NoteDynamics>();
  for (const [measureIndex, measure] of part.measures.entries()) {
    // Drum notation keeps one percussion clef; MIDI pitches are drum-map
    // identities, not a reason to switch between pitched clefs per measure.
    const measureClef = percussion ? part.clef : clefForMeasure(part.clef, measure, prevClef);
    const keyFifths = score.measureKeyFifths?.[measure.index];
    const activeKeyFifths = keyFifthsByMeasure[measureIndex];
    const percussionLegend =
      percussion && measureIndex === 0 ? percussionLegendDirectionXml(part) : '';
    const legacyTempo = score.measureTempos?.[measure.index];
    const tempoMarks =
      score.measureTempoMarks?.[measure.index] ??
      (legacyTempo === undefined ? [] : [{ bpm: legacyTempo, offsetPpq: 0 }]);
    const tempoTextValue = score.measureTempoTexts?.[measure.index];
    const tempoTexts =
      tempoTextValue === undefined
        ? []
        : Array.isArray(tempoTextValue)
          ? tempoTextValue
          : [tempoTextValue];
    serializeMeasure(
      lines,
      measure,
      score,
      prevTimeSig,
      measureClef,
      prevClef,
      keyFifths,
      activeKeyFifths,
      percussion,
      percussionLegend,
      symbolsByMeasure.get(measure.index) ?? [],
      staffMap,
      spellings,
      annotations,
      lyrics,
      score.measureBarlines?.[measure.index] ??
        (measureIndex === part.measures.length - 1 ? 'final' : undefined),
      score.measureRepeats?.[measure.index],
      score.measureBreaks?.[measure.index],
      score.measureRehearsals?.[measure.index],
      tempoMarks,
      tempoTexts,
      score.measureTexts?.[measure.index],
      score.multiMeasureRests?.[measure.index],
      inferredDynamicsByVoice,
    );
    prevTimeSig = measure.timeSig;
    prevClef = measureClef;
  }
  lines.push('</part>');
}

/**
 * Appends one `<measure>` element (attributes, harmonies, voices) to the
 * output lines.
 */
function serializeMeasure(
  lines: string[],
  measure: NotatedMeasure,
  score: NotatedScore,
  prevTimeSig: NotatedTimeSig | undefined,
  measureClef: NotatedClef,
  prevClef: NotatedClef | undefined,
  keyFifths: number | undefined,
  activeKeyFifths: number,
  percussion: boolean,
  percussionLegend: string,
  chordSymbols: ReadonlyArray<NotatedChordSymbol>,
  staffMap: ReadonlyMap<NotatedEvent, StaffNumber> | undefined,
  spellings: PitchSpellingIndex,
  annotations: AnnotationIndex,
  lyrics: LyricIndex,
  rightBarline: NotatedBarlineStyle | undefined,
  repeat: NotatedRepeatMark | undefined,
  measureBreak: NotatedMeasureBreak | undefined,
  rehearsal: string | undefined,
  tempoMarks: ReadonlyArray<NotatedTempoMark>,
  tempoTexts: ReadonlyArray<NotatedTempoText>,
  measureTexts: ReadonlyArray<NotatedMeasureText> | undefined,
  multiMeasureRest: NotatedMultiMeasureRest | undefined,
  inferredDynamicsByVoice: Map<NotatedVoiceNumber, NoteDynamics>,
): void {
  const isPickup =
    measure.index === 0 && measure.lengthPpq < timeSigLengthPpq(measure.timeSig) - PPQ_EPSILON;
  const scoreHasOpeningPickup = score.parts.some((part) => {
    const firstMeasure = part.measures[0];
    return (
      firstMeasure !== undefined &&
      firstMeasure.index === 0 &&
      firstMeasure.lengthPpq < timeSigLengthPpq(firstMeasure.timeSig) - PPQ_EPSILON
    );
  });
  const measureNumber = measure.index + (scoreHasOpeningPickup ? 0 : 1);
  lines.push(
    isPickup ? '<measure number="0" implicit="yes">' : `<measure number="${measureNumber}">`,
  );
  const printXml = measurePrintXml(measureBreak, prevTimeSig === undefined);
  if (printXml !== '') {
    lines.push(printXml);
  }
  const attributes = measureAttributesXml(
    measure,
    measureClef,
    score,
    prevTimeSig,
    prevClef,
    keyFifths,
    percussion,
  );
  if (attributes !== undefined) {
    lines.push(attributes);
  }
  if (percussionLegend !== '') {
    lines.push(percussionLegend);
  }
  const rehearsalXml = rehearsalDirectionXml(rehearsal);
  if (rehearsalXml !== '') {
    lines.push(rehearsalXml);
  }
  for (const mark of tempoMarks) {
    const tempoXml = tempoDirectionXml(mark, measure.timeSig, score.divisions);
    if (tempoXml !== '') lines.push(tempoXml);
  }
  for (const mark of tempoTexts) {
    const tempoTextXml = tempoTextDirectionXml(mark, score.divisions);
    if (tempoTextXml !== '') lines.push(tempoTextXml);
  }
  for (const text of measureTexts ?? []) {
    const textXml = measureTextDirectionXml(text);
    if (textXml !== '') lines.push(textXml);
  }
  const leftRepeat = repeat === 'start' || repeat === 'start-end';
  if (leftRepeat) {
    lines.push(
      '<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>',
    );
  }
  const accidentals = buildAccidentalIndex(measure, activeKeyFifths, staffMap, spellings);
  for (const symbol of chordSymbols) {
    for (const harmony of harmonyXml(symbol, measure, score, activeKeyFifths)) {
      lines.push(harmony);
    }
  }
  const measureDivisions = ppqToDivisions(measure.lengthPpq, score.divisions);
  if (
    multiMeasureRest !== undefined &&
    isSerializableMultiMeasureRest(measure, multiMeasureRest, score)
  ) {
    lines.push(multiMeasureRestXml(measure, score, multiMeasureRest));
  } else {
    measure.voices.forEach((voice, voiceIndex) => {
      if (voiceIndex > 0) {
        lines.push(`<backup><duration>${measureDivisions}</duration></backup>`);
      }
      serializeVoice(
        lines,
        voice,
        measure,
        score,
        staffMap,
        annotations,
        lyrics,
        accidentals,
        spellings,
        percussion,
        activeKeyFifths,
        inferredDynamicsByVoice,
      );
    });
  }
  const rightRepeat = repeat === 'end' || repeat === 'start-end';
  const barline = barlineXml(rightBarline, rightRepeat);
  if (barline !== '') {
    lines.push(barline);
  }
  lines.push('</measure>');
}

/** Builds layout break and measure-numbering metadata before a measure. */
function measurePrintXml(
  measureBreak: NotatedMeasureBreak | undefined,
  firstMeasure: boolean,
): string {
  const numbering = firstMeasure ? '<measure-numbering>system</measure-numbering>' : '';
  switch (measureBreak) {
    case 'system':
      return `<print new-system="yes">${numbering}</print>`;
    case 'page':
      return `<print new-page="yes">${numbering}</print>`;
    case undefined:
      return numbering === '' ? '' : `<print>${numbering}</print>`;
  }
}

/** Builds a rehearsal mark direction for section labels. */
function rehearsalDirectionXml(label: string | undefined): string {
  const text = label?.trim();
  if (!text) return '';
  return `<direction placement="above"><direction-type><rehearsal default-y="40">${escapeXml(text)}</rehearsal></direction-type></direction>`;
}

/** Builds a metronome tempo direction plus playback tempo. */
function tempoDirectionXml(
  mark: NotatedTempoMark,
  timeSig: NotatedTimeSig,
  divisions: number,
): string {
  const { bpm } = mark;
  if (!Number.isFinite(bpm) || bpm <= 0) return '';
  const beatGroup = beatGroupPpq(timeSig);
  const perMinute = tempoText(bpm / beatGroup);
  const playbackTempo = tempoText(bpm);
  const offset = directionOffsetXml(mark.offsetPpq, divisions);
  return `<direction placement="above"><direction-type><metronome>${metronomeBeatUnitXml(beatGroup)}<per-minute>${perMinute}</per-minute></metronome></direction-type>${offset}<sound tempo="${playbackTempo}"/></direction>`;
}

/** Builds the metronome beat unit for a PPQ beat group. */
function metronomeBeatUnitXml(ppq: number): string {
  const value = ppqToNoteValue(ppq);
  return `<beat-unit>${value.base}</beat-unit>${'<beat-unit-dot/>'.repeat(value.dots)}`;
}

/** Builds a textual tempo directive such as rit., accel. or a tempo. */
function tempoTextDirectionXml(mark: NotatedTempoText, divisions: number): string {
  const text = mark.text.trim();
  if (!text) return '';
  const sound =
    mark.bpm !== undefined && Number.isFinite(mark.bpm) && mark.bpm > 0
      ? `<sound tempo="${tempoText(mark.bpm)}"/>`
      : '';
  const offset = directionOffsetXml(mark.offsetPpq ?? 0, divisions);
  return `<direction placement="above"><direction-type><words default-y="30" font-style="italic">${escapeXml(text)}</words></direction-type>${offset}${sound}</direction>`;
}

/** MusicXML direction offset, omitted at the containing measure start. */
function directionOffsetXml(offsetPpq: number, divisions: number): string {
  if (!Number.isFinite(offsetPpq) || offsetPpq <= PPQ_EPSILON) return '';
  return `<offset>${ppqToDivisions(offsetPpq, divisions)}</offset>`;
}

/** Builds a general text direction. */
function measureTextDirectionXml(mark: NotatedMeasureText): string {
  const text = mark.text.trim();
  if (!text) return '';
  const defaultY =
    mark.defaultY !== undefined && Number.isFinite(mark.defaultY)
      ? ` default-y="${mark.defaultY}"`
      : '';
  return `<direction placement="above"><direction-type><words${defaultY}>${escapeXml(text)}</words></direction-type></direction>`;
}

/** Formats BPM with at most one decimal place. */
function tempoText(bpm: number): string {
  const rounded = Math.round(bpm * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** True when the marked measure can safely represent a multi-measure rest. */
function isSerializableMultiMeasureRest(
  measure: NotatedMeasure,
  rest: NotatedMultiMeasureRest,
  score: NotatedScore,
): boolean {
  if (rest.count < 2) return false;
  const part = score.parts.find((entry) => entry.measures.includes(measure));
  const start = part?.measures.indexOf(measure) ?? -1;
  if (!part || start < 0 || start + rest.count > part.measures.length) return false;
  for (let index = start; index < start + rest.count; index += 1) {
    const candidate = part.measures[index];
    if (
      candidate.voices.length !== 1 ||
      !isWholeMeasureRest(candidate.voices[0], candidate) ||
      measureHasMultiRestStructure(score, part.measures, index)
    ) {
      return false;
    }
  }
  return true;
}

/** Builds a MusicXML multi-measure rest start measure. */
function multiMeasureRestXml(
  measure: NotatedMeasure,
  score: NotatedScore,
  rest: NotatedMultiMeasureRest,
): string {
  const duration = ppqToDivisions(measure.lengthPpq, score.divisions);
  return `<attributes><measure-style><multiple-rest>${rest.count}</multiple-rest></measure-style></attributes><note><rest measure="yes"/><duration>${duration}</duration><voice>1</voice></note>`;
}

/** Builds an explicit right barline. */
function barlineXml(style: NotatedBarlineStyle | undefined, repeatEnd: boolean): string {
  if (repeatEnd) {
    return '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>';
  }
  switch (style) {
    case 'regular':
      return '<barline location="right"><bar-style>regular</bar-style></barline>';
    case 'double':
      return '<barline location="right"><bar-style>light-light</bar-style></barline>';
    case 'final':
      return '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
    case undefined:
      return '';
  }
}

/**
 * Builds the `<attributes>` element for a measure, emitting only what
 * changed: divisions/key/clef in the first measure, time on every change.
 *
 * @returns The element string, or undefined when nothing needs emitting.
 */
function measureAttributesXml(
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
  return parts.length > 0 ? `<attributes>${parts.join('')}</attributes>` : undefined;
}

/** Chooses a conservative temporary clef for a single-staff measure. */
function clefForMeasure(
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

/**
 * Appends all events of one voice within one measure to the output lines.
 */
function serializeVoice(
  lines: string[],
  voice: NotatedVoice,
  measure: NotatedMeasure,
  score: NotatedScore,
  staffMap: ReadonlyMap<NotatedEvent, StaffNumber> | undefined,
  annotations: AnnotationIndex,
  lyrics: LyricIndex,
  accidentals: AccidentalIndex,
  spellings: PitchSpellingIndex,
  percussion: boolean,
  keyFifths: number,
  inferredDynamicsByVoice: Map<NotatedVoiceNumber, NoteDynamics>,
): void {
  const measureRest = isWholeMeasureRest(voice, measure);
  const beams = buildBeamIndex(voice, measure, staffMap);
  let lastInferredDynamic = inferredDynamicsByVoice.get(voice.voice);
  for (const event of voice.events) {
    const staff = staffMap?.get(event);
    if (event.kind === 'rest') {
      lines.push(restXml(event, measure, score, measureRest, staff, beams, percussion));
    } else {
      const staffXml = staff === undefined ? '' : `<staff>${staff}</staff>`;
      const placement = dynamicsPlacement(event, measure);
      for (const number of annotations.hairpinStops.get(event) ?? []) {
        lines.push(
          `<direction placement="${placement}"><direction-type><wedge type="stop" number="${number}"/></direction-type>${staffXml}</direction>`,
        );
      }
      for (const hairpin of annotations.hairpinStarts.get(event) ?? []) {
        lines.push(
          `<direction placement="${placement}"><direction-type><wedge type="${hairpin.type}" number="${hairpin.number}"/></direction-type>${staffXml}</direction>`,
        );
      }
      for (const lineSpan of annotations.lineSpanStops.get(event) ?? []) {
        if (lineSpan.type === 'glissando') continue;
        lines.push(
          lineSpanDirectionXml(
            lineSpan as LineSpanRender & { type: Exclude<NoteLineSpan, 'glissando'> },
            'stop',
            staffXml,
          ),
        );
      }
      for (const lineSpan of annotations.lineSpanStarts.get(event) ?? []) {
        if (lineSpan.type === 'glissando') continue;
        lines.push(
          lineSpanDirectionXml(
            lineSpan as LineSpanRender & { type: Exclude<NoteLineSpan, 'glissando'> },
            'start',
            staffXml,
          ),
        );
      }
      const dynamics = annotations.dynamics.get(event);
      if (dynamics !== undefined) {
        // Dynamics are directions emitted right before the note they apply to.
        lines.push(
          `<direction placement="${placement}"><direction-type><dynamics><${dynamics}/></dynamics></direction-type>${staffXml}</direction>`,
        );
      } else if (eventUsesPercussionMap(event, percussion)) {
        const inferred = inferredDynamics(event);
        if (inferred !== undefined && inferred !== lastInferredDynamic) {
          lines.push(
            `<direction placement="${placement}"><direction-type><dynamics><${inferred}/></dynamics></direction-type>${staffXml}</direction>`,
          );
          lastInferredDynamic = inferred;
          inferredDynamicsByVoice.set(voice.voice, inferred);
        }
      }
      pushNoteEvent(
        lines,
        event,
        measure,
        score,
        staff,
        annotations,
        lyrics,
        beams,
        accidentals,
        spellings,
        percussion,
        keyFifths,
      );
    }
  }
}

/** Coarse display dynamics inferred from note-on velocity for percussion parts. */
function inferredDynamics(event: NotatedEvent): NoteDynamics | undefined {
  const velocity = event.velocity;
  if (velocity === undefined) return undefined;
  if (velocity >= 120) return 'ff';
  if (velocity >= 108) return 'f';
  if (velocity >= 88) return 'mf';
  if (velocity >= 68) return 'mp';
  if (velocity >= 48) return 'p';
  return 'pp';
}

/** Places multi-voice dynamics with their voice; single-voice dynamics stay below. */
function dynamicsPlacement(event: NotatedEvent, measure: NotatedMeasure): string {
  if (measure.voices.length < 2) return 'below';
  return slurPlacement(event);
}

type OctaveLineSpan = Exclude<NoteLineSpan, 'pedal' | 'glissando'>;

/**
 * MusicXML octave-shift semantics for the four editor ottava markings.
 *
 * MusicXML's direction is relative to the true pitch in the note data, not
 * the visual direction of the printed 8va/8vb label: an 8va label moves the
 * written notes up, so its MusicXML shift is `down`; 8vb is the inverse.
 */
const OCTAVE_SHIFT_BY_LINE_SPAN: Readonly<
  Record<OctaveLineSpan, { placement: 'above' | 'below'; shift: 'up' | 'down'; size: 8 | 15 }>
> = {
  'ottava-up': { placement: 'above', shift: 'down', size: 8 },
  'ottava-down': { placement: 'below', shift: 'up', size: 8 },
  'ottava-15-up': { placement: 'above', shift: 'down', size: 15 },
  'ottava-15-down': { placement: 'below', shift: 'up', size: 15 },
};

function octaveShiftDirection(lineSpan: OctaveLineSpan): {
  placement: 'above' | 'below';
  shift: 'up' | 'down';
  size: 8 | 15;
} {
  return OCTAVE_SHIFT_BY_LINE_SPAN[lineSpan];
}

/** Builds non-glissando span directions. */
function lineSpanDirectionXml(
  lineSpan: LineSpanRender & { type: Exclude<NoteLineSpan, 'glissando'> },
  position: 'start' | 'stop',
  staffXml: string,
): string {
  if (lineSpan.type === 'pedal') {
    const line = lineSpan.pedalStyle === 'sign' ? 'no' : 'yes';
    const sign =
      lineSpan.pedalStyle === 'sign' ? ` sign="${position === 'start' ? 'yes' : 'no'}"` : '';
    return `<direction placement="below"><direction-type><pedal type="${position}" line="${line}"${sign} number="${lineSpan.number}"/></direction-type>${staffXml}</direction>`;
  }
  const { placement, shift, size } = octaveShiftDirection(lineSpan.type);
  const type = position === 'stop' ? 'stop' : shift;
  return `<direction placement="${placement}"><direction-type><octave-shift type="${type}" size="${size}" number="${lineSpan.number}"/></direction-type>${staffXml}</direction>`;
}

/**
 * Returns true when a voice's measure content is a single rest covering the
 * whole measure (rendered as a whole-measure rest).
 */
function isWholeMeasureRest(voice: NotatedVoice, measure: NotatedMeasure): boolean {
  if (voice.events.length !== 1) {
    return false;
  }
  const event = voice.events[0];
  return (
    event.kind === 'rest' &&
    Math.abs(event.startPpq - measure.startPpq) < PPQ_EPSILON &&
    Math.abs(event.durationPpq - measure.lengthPpq) < PPQ_EPSILON
  );
}

/**
 * Builds one `<note>` element containing a rest.
 */
function restXml(
  event: NotatedEvent,
  measure: NotatedMeasure,
  score: NotatedScore,
  isMeasureRest: boolean,
  staff: StaffNumber | undefined,
  beams: BeamIndex,
  percussion: boolean,
): string {
  const printObject =
    percussion && measure.voices.length > 1 && event.voice > 1 ? ' print-object="no"' : '';
  const staffXml = staff === undefined ? '' : `<staff>${staff}</staff>`;
  if (isMeasureRest) {
    const duration = ppqToDivisions(measure.lengthPpq, score.divisions);
    return `<note${printObject}><rest measure="yes"/><duration>${duration}</duration><voice>${event.voice}</voice>${staffXml}</note>`;
  }
  const duration = ppqToDivisions(event.durationPpq, score.divisions);
  const rest = restElementXml(event, measure, staff);
  const dots = '<dot/>'.repeat(event.value.dots);
  const timeModification = timeModificationXml(event.value);
  const beamMarks = beamXml(beams.get(event) ?? []);
  const tupletNotations = tupletBracketXml(event, measure);
  const notations = tupletNotations === '' ? '' : `<notations>${tupletNotations}</notations>`;
  return `<note${printObject}>${rest}<duration>${duration}</duration><voice>${event.voice}</voice><type>${event.value.base}</type>${dots}${timeModification}${staffXml}${beamMarks}${notations}</note>`;
}

/** Builds a rest element, positioning multi-voice rests away from the staff center. */
function restElementXml(
  event: NotatedEvent,
  measure: NotatedMeasure,
  staff: StaffNumber | undefined,
): string {
  if (measure.voices.length < 2) return '<rest/>';
  const position = restDisplayPitch(event.voice, staff ?? 1);
  return `<rest><display-step>${position.step}</display-step><display-octave>${position.octave}</display-octave></rest>`;
}

/** Display pitch used only to move rests vertically in multi-voice notation. */
function restDisplayPitch(
  voice: NotatedVoiceNumber,
  staff: StaffNumber,
): Readonly<{ step: Step; octave: number }> {
  const upperVoice = voice === 1 || voice === 3;
  if (staff === 2) {
    return upperVoice ? { step: 'D', octave: 3 } : { step: 'F', octave: 2 };
  }
  return upperVoice ? { step: 'B', octave: 4 } : { step: 'D', octave: 4 };
}

/**
 * Appends the `<note>` elements of a note/chord event. Stacked pitches after
 * the first carry `<chord/>`; tie flags are emitted on every pitch of a
 * chord (ties are per-event in the model). Annotation notations (slurs and
 * articulations) are emitted on the first chord note only.
 */
function pushNoteEvent(
  lines: string[],
  event: NotatedEvent,
  measure: NotatedMeasure,
  score: NotatedScore,
  staff: StaffNumber | undefined,
  annotations: AnnotationIndex,
  lyrics: LyricIndex,
  beams: BeamIndex,
  accidentals: AccidentalIndex,
  spellings: PitchSpellingIndex,
  percussion: boolean,
  keyFifths: number,
): void {
  const duration = ppqToDivisions(event.durationPpq, score.divisions);
  const ties = tieXml(event);
  const dots = '<dot/>'.repeat(event.value.dots);
  const timeModification = timeModificationXml(event.value);
  const staffXml = staff === undefined ? '' : `<staff>${staff}</staff>`;
  const beamMarks = beamXml(beams.get(event) ?? []);
  const eventPercussion = eventUsesPercussionMap(event, percussion);
  const pitchedChannel =
    !eventPercussion && event.midiChannels?.length === 1 ? event.midiChannels[0] : undefined;
  const dynamicsAttribute =
    event.velocity !== undefined
      ? ` dynamics="${tempoText((clampMidiVelocity(event.velocity) * 100) / 90)}"`
      : '';
  event.pitches.forEach((midi, pitchIndex) => {
    const chord = pitchIndex > 0 ? '<chord/>' : '';
    const display = eventPercussion ? percussionDisplay(midi) : undefined;
    const instrument = eventPercussion
      ? `<instrument id="${percussionInstrumentId(scorePartIdForEvent(score, event), midi)}"/>`
      : pitchedChannel !== undefined
        ? `<instrument id="${pitchedInstrumentId(scorePartIdForEvent(score, event), pitchedChannel)}"/>`
        : '';
    const pitch = eventPercussion
      ? unpitchedXml(display ?? percussionDisplay(midi))
      : pitchXml(spellings.get(event)?.[pitchIndex] ?? spellPitchInKeySignature(midi, keyFifths));
    const accidental = eventPercussion
      ? ''
      : accidentalXml(accidentals.get(event)?.get(pitchIndex));
    const notehead = eventPercussion ? noteheadXml(display ?? percussionDisplay(midi), event) : '';
    const notations = notationsXml(
      event,
      annotations,
      pitchIndex === 0,
      eventPercussion,
      midi,
      measure,
      pitchIndex,
    );
    const lyricXml = pitchIndex === 0 ? lyricsXml(lyrics.get(event) ?? []) : '';
    const beam = pitchIndex === 0 ? beamMarks : '';
    const stemMark = pitchIndex === 0 ? stemXml(event, measure, eventPercussion) : '';
    const xmlId = scoreNoteXmlId(event.sourceIdentities ?? [], event.startPpq, pitchIndex);
    const idAttribute = xmlId ? ` xml:id="${xmlId}"` : '';
    lines.push(
      `<note${idAttribute}${dynamicsAttribute}>${chord}${pitch}<duration>${duration}</duration>${ties}${instrument}<voice>${event.voice}</voice><type>${event.value.base}</type>${dots}${accidental}${timeModification}${stemMark}${notehead}${staffXml}${beam}${notations}${lyricXml}</note>`,
    );
  });
}

function clampMidiVelocity(value: number): number {
  return Math.min(127, Math.max(1, Math.round(value)));
}

/** Builds MusicXML lyric elements for one note event. */
function lyricsXml(lyrics: ReadonlyArray<NotatedLyric>): string {
  return lyrics
    .map((lyric, index) => {
      const number = lyric.verse ?? index + 1;
      const syllabic = lyric.syllabic ?? 'single';
      const extend = lyric.extend === true ? '<extend/>' : '';
      return `<lyric number="${number}"><syllabic>${syllabic}</syllabic><text>${escapeXml(lyric.text)}</text>${extend}</lyric>`;
    })
    .join('');
}

/** Serializes MusicXML tuplet timing for one note value. */
function timeModificationXml(value: NoteValue): string {
  if (!value.tuplet) return '';
  return `<time-modification><actual-notes>${value.tuplet.actual}</actual-notes><normal-notes>${value.tuplet.normal}</normal-notes></time-modification>`;
}

/** Finds the owning part id for an event. */
function scorePartIdForEvent(score: NotatedScore, event: NotatedEvent): string {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const voice of measure.voices) {
        if (voice.events.includes(event)) return part.id;
      }
    }
  }
  return score.parts[0]?.id ?? 'P1';
}

/** Builds a stem direction for multi-voice measures, leaving single voices to engraver defaults. */
function stemXml(event: NotatedEvent, measure: NotatedMeasure, percussion = false): string {
  if (measure.voices.length < 2 || event.value.base === 'whole') return '';
  const direction =
    percussion && event.voice === 2
      ? 'down'
      : event.voice === 1 || event.voice === 3
        ? 'up'
        : 'down';
  return `<stem>${direction}</stem>`;
}

/**
 * Builds the `<tie>` sound elements for an event (stop before start).
 */
function tieXml(event: NotatedEvent): string {
  let xml = '';
  if (event.tieStop) {
    xml += '<tie type="stop"/>';
  }
  if (event.tieStart) {
    xml += '<tie type="start"/>';
  }
  return xml;
}

/**
 * Builds the `<notations>` element of one `<note>`, or an empty string when
 * there is nothing to notate. Tied marks appear on every chord note; slurs
 * and articulations only on the first chord note (`isFirstPitch`).
 */
function notationsXml(
  event: NotatedEvent,
  annotations: AnnotationIndex,
  isFirstPitch: boolean,
  percussion = false,
  midi?: number,
  measure?: NotatedMeasure,
  pitchIndex = 0,
): string {
  let inner = '';
  if (event.tieStop) {
    inner += '<tied type="stop"/>';
  }
  if (event.tieStart) {
    inner += '<tied type="start"/>';
  }
  if (isFirstPitch) {
    inner += tupletBracketXml(event, measure);
    for (const number of annotations.slurStops.get(event) ?? []) {
      inner += `<slur type="stop" number="${number}"/>`;
    }
    for (const number of annotations.slurStarts.get(event) ?? []) {
      const placement = annotations.slurStartPlacements.get(event)?.get(number);
      const placementXml = placement === undefined ? '' : ` placement="${placement}"`;
      inner += `<slur type="start" number="${number}"${placementXml}/>`;
    }
    for (const lineSpan of annotations.lineSpanStops.get(event) ?? []) {
      if (lineSpan.type === 'glissando') {
        const lineType =
          lineSpan.glissandoLineType === undefined
            ? ''
            : ` line-type="${lineSpan.glissandoLineType}"`;
        inner += `<glissando type="stop" number="${lineSpan.number}"${lineType}/>`;
      }
    }
    for (const lineSpan of annotations.lineSpanStarts.get(event) ?? []) {
      if (lineSpan.type === 'glissando') {
        const lineType =
          lineSpan.glissandoLineType === undefined
            ? ''
            : ` line-type="${lineSpan.glissandoLineType}"`;
        inner +=
          lineSpan.glissandoText === undefined
            ? `<glissando type="start" number="${lineSpan.number}"${lineType}/>`
            : `<glissando type="start" number="${lineSpan.number}"${lineType}>${escapeXml(lineSpan.glissandoText)}</glissando>`;
      }
    }
    const articulation = annotations.articulations.get(event);
    if (articulation !== undefined) {
      inner += `<articulations>${articulationXml(articulation, event)}</articulations>`;
    } else if (percussion && event.velocity !== undefined && event.velocity >= 112) {
      inner += `<articulations><accent placement="${slurPlacement(event)}"/></articulations>`;
    }
    const ornament = annotations.ornaments.get(event);
    if (ornament !== undefined) {
      inner += ornamentXml(ornament);
    }
  }
  if (!percussion) {
    // Fingering is per-note: each chord pitch carries its own finger number.
    const fingering = event.fingering?.[pitchIndex];
    if (fingering !== undefined) {
      inner += `<technical><fingering>${fingering}</fingering></technical>`;
    }
  }
  if (percussion && midi !== undefined) {
    const technical = percussionTechnicalXml(midi);
    if (technical !== '') inner += technical;
    if (measure !== undefined && isPercussionRoll(event, measure, midi, annotations)) {
      inner += '<ornaments><tremolo type="single">3</tremolo></ornaments>';
    }
  }
  return inner === '' ? '' : `<notations>${inner}</notations>`;
}

/** Emits tuplet bracket start/stop marks for the first and last event in a group. */
function tupletBracketXml(event: NotatedEvent, measure: NotatedMeasure | undefined): string {
  if (!event.value.tuplet || measure === undefined) return '';
  const voice = measure.voices.find((entry) => entry.voice === event.voice);
  if (!voice) return '';
  const index = voice.events.indexOf(event);
  if (index < 0) return '';
  const prev = voice.events[index - 1];
  const next = voice.events[index + 1];
  const sameGroup = (candidate: NotatedEvent | undefined): boolean =>
    candidate !== undefined &&
    (event.tupletGroupId !== undefined
      ? candidate.tupletGroupId === event.tupletGroupId
      : candidate.tupletGroupId === undefined && sameTuplet(candidate, event));
  const hasPrev =
    sameGroup(prev) && Math.abs(prev.startPpq + prev.durationPpq - event.startPpq) < PPQ_EPSILON;
  const hasNext =
    sameGroup(next) && Math.abs(event.startPpq + event.durationPpq - next.startPpq) < PPQ_EPSILON;
  let xml = '';
  if (!hasPrev) xml += '<tuplet type="start"/>';
  if (!hasNext) xml += '<tuplet type="stop"/>';
  return xml;
}

/** True when two events belong to the same simple tuplet ratio. */
function sameTuplet(a: NotatedEvent, b: NotatedEvent): boolean {
  const left = a.value.tuplet;
  const right = b.value.tuplet;
  return (
    left !== undefined &&
    right !== undefined &&
    left.actual === right.actual &&
    left.normal === right.normal &&
    a.value.base === b.value.base
  );
}

/**
 * Returns true when repeated short drum notes should carry a roll/tremolo mark.
 *
 * The reading is of the figure, not of one note: four sixteenths on the snare
 * inside a beat read as a roll only together. So a technique written on any of
 * them stands the guess down for all of them — the figure has been described,
 * and a run of ghost notes marked as a roll would contradict what it says.
 */
function isPercussionRoll(
  event: NotatedEvent,
  measure: NotatedMeasure,
  midi: number,
  annotations: AnnotationIndex,
): boolean {
  if (!isRollCandidate(midi) || event.durationPpq > 0.25 + PPQ_EPSILON) return false;
  const groupLen = beatGroupPpq(measure.timeSig);
  const groupIndex = Math.floor((event.startPpq - measure.startPpq) / groupLen + PPQ_EPSILON);
  let count = 0;
  for (const voice of measure.voices) {
    for (const candidate of voice.events) {
      if (
        candidate.kind !== 'note' ||
        candidate.voice !== event.voice ||
        candidate.durationPpq > 0.25 + PPQ_EPSILON ||
        !candidate.pitches.includes(midi)
      ) {
        continue;
      }
      const candidateGroup = Math.floor(
        (candidate.startPpq - measure.startPpq) / groupLen + PPQ_EPSILON,
      );
      if (candidateGroup !== groupIndex) continue;
      if (annotations.articulations.has(candidate)) return false;
      count++;
    }
  }
  return count >= 3;
}

/** Drum notes for which rapid repeated hits are conventionally roll-like. */
function isRollCandidate(midi: number): boolean {
  return [37, 38, 40, 41, 43, 45, 47, 48, 50].includes(midi);
}

/** Builds a voice-aware articulation element. */
function articulationXml(articulation: NoteArticulation, event: NotatedEvent): string {
  const placement = slurPlacement(event);
  const element = ARTICULATION_ELEMENT[articulation];
  return element === undefined
    ? `<other-articulation placement="${placement}">${escapeXml(articulation)}</other-articulation>`
    : `<${element} placement="${placement}"/>`;
}

/** Builds a MusicXML ornament or expression notation. */
function ornamentXml(ornament: NoteOrnament): string {
  switch (ornament) {
    case 'trill':
      return '<ornaments><trill-mark/></ornaments>';
    case 'turn':
      return '<ornaments><turn/></ornaments>';
    case 'mordent':
      return '<ornaments><mordent/></ornaments>';
    case 'fermata':
      return '<fermata type="upright"/>';
  }
}

/**
 * Returns the staff a note event belongs to in a grand staff: treble when the
 * chord's mean pitch reaches middle C, bass otherwise.
 *
 * Using the centre of mass rather than the lowest pitch keeps a chord whose
 * body sits above middle C on the treble staff even when its lowest note dips
 * just below the split, which matches how a player reads a right-hand voicing.
 * A single note reduces to comparing that pitch against the split point.
 */
function noteStaff(
  event: NotatedEvent,
  overrides: ReadonlyMap<NotatedEvent, StaffNumber>,
): StaffNumber {
  const override = overrides.get(event);
  if (override !== undefined) return override;
  if (event.staff === 1 || event.staff === 2) return event.staff;
  if (event.pitches.length === 0) return 1;
  const mean = event.pitches.reduce((sum, pitch) => sum + pitch, 0) / event.pitches.length;
  return staffForMeanPitch(mean, GRAND_STAFF_SPLIT_MIDI);
}

/**
 * Assigns a staff to every event of a grand-staff part. Notes split at
 * middle C by their mean pitch; rests inherit the staff of the preceding
 * note in the same voice (chained across measures), leading rests adopt the
 * first note's staff, and all-rest voices default to staff 1.
 */
function buildStaffMap(
  part: NotatedPart,
  overrides: ReadonlyMap<NotatedEvent, StaffNumber> = new Map(),
): Map<NotatedEvent, StaffNumber> {
  const staffMap = new Map<NotatedEvent, StaffNumber>();
  const eventsByVoice = new Map<NotatedVoiceNumber, NotatedEvent[]>();
  for (const measure of part.measures) {
    for (const voice of measure.voices) {
      const list = eventsByVoice.get(voice.voice);
      if (list === undefined) {
        eventsByVoice.set(voice.voice, [...voice.events]);
      } else {
        list.push(...voice.events);
      }
    }
  }
  for (const events of eventsByVoice.values()) {
    let current: StaffNumber | undefined;
    const leadingRests: NotatedEvent[] = [];
    for (const event of events) {
      if (event.kind === 'note') {
        const staff = noteStaff(event, overrides);
        for (const rest of leadingRests) {
          staffMap.set(rest, staff);
        }
        leadingRests.length = 0;
        staffMap.set(event, staff);
        current = staff;
      } else if (current === undefined) {
        leadingRests.push(event);
      } else {
        staffMap.set(event, current);
      }
    }
    for (const rest of leadingRests) {
      staffMap.set(rest, 1);
    }
  }
  return staffMap;
}
