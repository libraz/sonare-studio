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

import { clamp } from '@/lib/math';
import type { NoteDynamics, NoteLineSpan } from '@/project/annotations';
import {
  isPickupMeasure,
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
import { clefForMeasure, measureAttributesXml } from './musicxml-attributes';
import { type BeamIndex, beamXml, buildBeamIndex } from './musicxml-beams';
import {
  lineSpanDirectionXml,
  measureTextDirectionXml,
  rehearsalDirectionXml,
  tempoDirectionXml,
  tempoTextDirectionXml,
} from './musicxml-directions';
import { groupChordSymbolsByMeasure, harmonyXml } from './musicxml-harmony';
import { notationsXml, tupletBracketXml } from './musicxml-notations';
import { pitchedInstrumentId, scorePartXml } from './musicxml-part-list';
import {
  eventUsesPercussionMap,
  noteheadXml,
  partUsesPercussionMap,
  percussionDisplay,
  percussionInstrumentId,
  percussionLegendDirectionXml,
  unpitchedXml,
} from './musicxml-percussion';
import { PPQ_EPSILON, type StaffNumber, tempoText } from './musicxml-shared';
import { buildStaffMap } from './musicxml-staves';
import {
  appendScoreCredits,
  appendScoreDefaults,
  appendScoreHeader,
  escapeXml,
} from './musicxml-xml';
import { type Step, spellPitchInKeySignature } from './pitch-spelling';
import { scoreNoteXmlId } from './source-identity';

export {
  inspectMusicXmlExportLoss,
  MUSICXML_EXPORT_LOSS_KINDS,
  type MusicXmlExportLossKind,
} from './musicxml-export-loss';
export { extractPartScore, extractPartsScore } from './score-parts';

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
      part.id,
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
  partId: string,
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
  // A bar shorter than its meter is an opening pickup or a bar cut by a meter
  // change; `implicit` tells a reader to advance by its content, not a full bar.
  const isShort = measure.lengthPpq < timeSigLengthPpq(measure.timeSig) - PPQ_EPSILON;
  const isPickup = isPickupMeasure(measure);
  const scoreHasOpeningPickup = score.parts.some((part) => {
    const firstMeasure = part.measures[0];
    return firstMeasure !== undefined && isPickupMeasure(firstMeasure);
  });
  const measureNumber = measure.index + (scoreHasOpeningPickup ? 0 : 1);
  lines.push(
    isPickup
      ? '<measure number="0" implicit="yes">'
      : isShort
        ? `<measure number="${measureNumber}" implicit="yes">`
        : `<measure number="${measureNumber}">`,
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
        partId,
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
 * Appends all events of one voice within one measure to the output lines.
 */
function serializeVoice(
  lines: string[],
  voice: NotatedVoice,
  measure: NotatedMeasure,
  score: NotatedScore,
  partId: string,
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
        partId,
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
  partId: string,
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
      ? `<instrument id="${percussionInstrumentId(partId, midi)}"/>`
      : pitchedChannel !== undefined
        ? `<instrument id="${pitchedInstrumentId(partId, pitchedChannel)}"/>`
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
  return clamp(Math.round(value), 1, 127);
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
