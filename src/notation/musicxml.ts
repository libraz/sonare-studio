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

import type { NoteArticulation, NoteDynamics } from '@/project/annotations';
import {
  type NotatedChordSymbol,
  type NotatedClef,
  type NotatedEvent,
  type NotatedMeasure,
  type NotatedPart,
  type NotatedScore,
  type NotatedTimeSig,
  type NotatedVoice,
  type NotatedVoiceNumber,
  ppqToDivisions,
  type ScoreMetadata,
} from './model';
import { type SpelledPitch, type Step, spellPitch } from './pitch-spelling';

/** Staff number within a grand staff (1 = treble, 2 = bass). */
type StaffNumber = 1 | 2;

/** MIDI split point between the staves of a grand staff (middle C / C4). */
const GRAND_STAFF_SPLIT_MIDI = 60;

/** MusicXML beam level per beammable note value. */
const BEAM_LEVEL_BY_BASE: Readonly<Record<string, number | undefined>> = {
  whole: undefined,
  half: undefined,
  quarter: undefined,
  eighth: 1,
  '16th': 2,
  '32nd': 3,
  '64th': 4,
};

/** Comparison tolerance for PPQ arithmetic on IEEE doubles. */
const PPQ_EPSILON = 1e-9;

/**
 * MusicXML `<kind>` values for libsonare audio-domain `ChordQuality`
 * ordinals (Major = 0, Minor = 1, ...). Qualities without a standard
 * MusicXML kind (Add9, MinorAdd9, Sus2Add4, Unknown) are absent and fall
 * back to `<kind text="...">other</kind>`.
 */
const CHORD_QUALITY_KIND: ReadonlyMap<number, string> = new Map([
  [0, 'major'],
  [1, 'minor'],
  [2, 'diminished'],
  [3, 'augmented'],
  [4, 'dominant'],
  [5, 'major-seventh'],
  [6, 'minor-seventh'],
  [7, 'suspended-second'],
  [8, 'suspended-fourth'],
  [12, 'diminished-seventh'],
  [13, 'half-diminished'],
  [14, 'major-ninth'],
  [15, 'dominant-ninth'],
]);

/** MusicXML articulation element name per annotation marking. */
const ARTICULATION_ELEMENT: Readonly<Record<NoteArticulation, string>> = {
  staccato: 'staccato',
  accent: 'accent',
  tenuto: 'tenuto',
  marcato: 'strong-accent',
};

/** Highest `<slur>` number-level allowed by MusicXML. */
const MAX_SLUR_NUMBER = 16;

/**
 * Display annotations resolved onto engraved events. Built once per
 * serialization from {@link NotatedScore.noteAnnotations}: each annotated
 * editor note id is mapped to its "attack" event (the first piece of a tie
 * chain carrying the id in `sourceIds`); ids without an attack event
 * (deleted notes, notes outside the notated window) are silently ignored.
 */
interface AnnotationIndex {
  /** Dynamics marking to emit as a `<direction>` right before the event. */
  dynamics: Map<NotatedEvent, NoteDynamics>;
  /** Articulation to emit inside the event's `<notations>`. */
  articulations: Map<NotatedEvent, NoteArticulation>;
  /** Slur numbers starting on the event. */
  slurStarts: Map<NotatedEvent, number[]>;
  /** Slur placement attributes keyed by start event and slur number. */
  slurStartPlacements: Map<NotatedEvent, Map<number, string>>;
  /** Slur numbers stopping on the event. */
  slurStops: Map<NotatedEvent, number[]>;
}

/** Beam marks keyed by event, one array entry per MusicXML beam level. */
type BeamIndex = ReadonlyMap<NotatedEvent, ReadonlyArray<string>>;

/** Explicit accidental text by event and pitch index within a note/chord. */
type AccidentalIndex = ReadonlyMap<NotatedEvent, ReadonlyMap<number, string>>;

/** Appends a value to a keyed list inside a map. */
function pushMapped<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Resolves score annotations onto events (see {@link AnnotationIndex}).
 *
 * Slurs are validated here: the target must resolve to a different event
 * that starts strictly after the source, otherwise the slur is dropped.
 * Overlapping slurs receive distinct MusicXML number-levels so start/stop
 * pairs match unambiguously.
 */
function buildAnnotationIndex(score: NotatedScore): AnnotationIndex {
  const index: AnnotationIndex = {
    dynamics: new Map(),
    articulations: new Map(),
    slurStarts: new Map(),
    slurStartPlacements: new Map(),
    slurStops: new Map(),
  };
  const annotations = score.noteAnnotations;
  if (annotations === undefined) return index;
  const attackByNoteId = new Map<number, NotatedEvent>();
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const voice of measure.voices) {
        for (const event of voice.events) {
          if (event.kind !== 'note' || event.tieStop || event.sourceIds === undefined) continue;
          for (const id of event.sourceIds) {
            if (!attackByNoteId.has(id)) attackByNoteId.set(id, event);
          }
        }
      }
    }
  }
  const slurs: Array<{ start: NotatedEvent; stop: NotatedEvent }> = [];
  for (const [idKey, annotation] of Object.entries(annotations)) {
    const event = attackByNoteId.get(Number(idKey));
    if (event === undefined) continue; // Orphaned annotation: ignore.
    if (annotation.dynamics !== undefined) index.dynamics.set(event, annotation.dynamics);
    if (annotation.articulation !== undefined) {
      index.articulations.set(event, annotation.articulation);
    }
    if (annotation.slurToNoteId !== undefined) {
      const target = attackByNoteId.get(annotation.slurToNoteId);
      if (
        target !== undefined &&
        target !== event &&
        target.startPpq > event.startPpq + PPQ_EPSILON
      ) {
        slurs.push({ start: event, stop: target });
      }
    }
  }
  slurs.sort((a, b) => a.start.startPpq - b.start.startPpq || a.stop.startPpq - b.stop.startPpq);
  const active: Array<{ endPpq: number; number: number }> = [];
  for (const slur of slurs) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endPpq <= slur.start.startPpq + PPQ_EPSILON) active.splice(i, 1);
    }
    let number = 1;
    while (active.some((entry) => entry.number === number) && number < MAX_SLUR_NUMBER) number++;
    active.push({ endPpq: slur.stop.startPpq, number });
    pushMapped(index.slurStarts, slur.start, number);
    const placements = index.slurStartPlacements.get(slur.start) ?? new Map<number, string>();
    placements.set(number, slurPlacement(slur.start));
    index.slurStartPlacements.set(slur.start, placements);
    pushMapped(index.slurStops, slur.stop, number);
  }
  return index;
}

/** Default slur placement by voice direction. */
function slurPlacement(event: NotatedEvent): string {
  return event.voice === 1 || event.voice === 3 ? 'above' : 'below';
}

/** Replacement table for XML-reserved characters. */
const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Escapes the five XML-reserved characters in text or attribute content.
 *
 * @param text Raw text.
 * @returns Escaped text safe for element and attribute content.
 */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

/** Software credit written into the MusicXML `<encoding>` block. */
const ENCODING_SOFTWARE = 'sonare studio';

/**
 * Appends the optional `<work>` / `<identification>` header.
 *
 * `<work-title>` is emitted only when a non-empty title is present; the
 * `<identification>` block carries the composer credit (when set) and always
 * records the encoding software so exported files are self-describing.
 *
 * @param lines Output line buffer.
 * @param metadata Optional score metadata.
 */
function appendScoreHeader(lines: string[], metadata: ScoreMetadata | undefined): void {
  const title = metadata?.title?.trim();
  const composer = metadata?.composer?.trim();
  if (title) {
    lines.push(`<work><work-title>${escapeXml(title)}</work-title></work>`);
  }
  lines.push('<identification>');
  if (composer) {
    lines.push(`<creator type="composer">${escapeXml(composer)}</creator>`);
  }
  lines.push(`<encoding><software>${escapeXml(ENCODING_SOFTWARE)}</software></encoding>`);
  lines.push('</identification>');
}

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
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
  ];
  appendScoreHeader(lines, score.metadata);
  lines.push('<part-list>');
  for (const part of score.parts) {
    lines.push(
      `<score-part id="${escapeXml(part.id)}"><part-name>${escapeXml(part.name)}</part-name></score-part>`,
    );
  }
  lines.push('</part-list>');
  const annotations = buildAnnotationIndex(score);
  score.parts.forEach((part, partIndex) => {
    const chordSymbols = partIndex === 0 ? (score.chordSymbols ?? []) : [];
    serializePart(lines, part, score, chordSymbols, annotations);
  });
  lines.push('</score-partwise>');
  return lines.join('\n');
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
): void {
  const staffMap = part.clef === 'grand' ? buildStaffMap(part) : undefined;
  const symbolsByMeasure = groupChordSymbolsByMeasure(chordSymbols, part.measures);
  lines.push(`<part id="${escapeXml(part.id)}">`);
  let prevTimeSig: NotatedTimeSig | undefined;
  for (const [measureIndex, measure] of part.measures.entries()) {
    serializeMeasure(
      lines,
      measure,
      part,
      score,
      prevTimeSig,
      symbolsByMeasure.get(measure.index) ?? [],
      staffMap,
      annotations,
      measureIndex === part.measures.length - 1,
    );
    prevTimeSig = measure.timeSig;
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
  part: NotatedPart,
  score: NotatedScore,
  prevTimeSig: NotatedTimeSig | undefined,
  chordSymbols: ReadonlyArray<NotatedChordSymbol>,
  staffMap: ReadonlyMap<NotatedEvent, StaffNumber> | undefined,
  annotations: AnnotationIndex,
  isLastMeasure: boolean,
): void {
  lines.push(`<measure number="${measure.index + 1}">`);
  const attributes = measureAttributesXml(measure, part.clef, score, prevTimeSig);
  if (attributes !== undefined) {
    lines.push(attributes);
  }
  const accidentals = buildAccidentalIndex(measure, score, staffMap);
  for (const symbol of chordSymbols) {
    const harmony = harmonyXml(symbol, measure, score);
    if (harmony !== undefined) {
      lines.push(harmony);
    }
  }
  const measureDivisions = ppqToDivisions(measure.lengthPpq, score.divisions);
  measure.voices.forEach((voice, voiceIndex) => {
    if (voiceIndex > 0) {
      lines.push(`<backup><duration>${measureDivisions}</duration></backup>`);
    }
    serializeVoice(lines, voice, measure, score, staffMap, annotations, accidentals);
  });
  if (isLastMeasure) {
    lines.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
  }
  lines.push('</measure>');
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
): string | undefined {
  const isFirst = prevTimeSig === undefined;
  const parts: string[] = [];
  if (isFirst) {
    parts.push(`<divisions>${score.divisions}</divisions>`);
    parts.push(`<key><fifths>${score.keyFifths}</fifths></key>`);
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
  if (isFirst) {
    parts.push(clefXml(clef));
  }
  return parts.length > 0 ? `<attributes>${parts.join('')}</attributes>` : undefined;
}

/**
 * Returns the clef (and staves, for grand staff) attribute fragment.
 */
function clefXml(clef: NotatedClef): string {
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
  accidentals: AccidentalIndex,
): void {
  const measureRest = isWholeMeasureRest(voice, measure);
  const beams = buildBeamIndex(voice, measure, staffMap);
  for (const event of voice.events) {
    const staff = staffMap?.get(event);
    if (event.kind === 'rest') {
      lines.push(restXml(event, measure, score, measureRest, staff));
    } else {
      const dynamics = annotations.dynamics.get(event);
      if (dynamics !== undefined) {
        // Dynamics are directions emitted right before the note they apply to.
        const staffXml = staff === undefined ? '' : `<staff>${staff}</staff>`;
        lines.push(
          `<direction placement="below"><direction-type><dynamics><${dynamics}/></dynamics></direction-type>${staffXml}</direction>`,
        );
      }
      pushNoteEvent(lines, event, measure, score, staff, annotations, beams, accidentals);
    }
  }
}

/** Builds explicit accidentals only when the visible pitch state changes. */
function buildAccidentalIndex(
  measure: NotatedMeasure,
  score: NotatedScore,
  staffMap: ReadonlyMap<NotatedEvent, StaffNumber> | undefined,
): AccidentalIndex {
  const accidentals = new Map<NotatedEvent, Map<number, string>>();
  const state = new Map<string, number>();
  const noteEvents = measure.voices
    .flatMap((voice) => voice.events)
    .filter((event) => event.kind === 'note')
    .sort((a, b) => a.startPpq - b.startPpq || a.voice - b.voice);
  for (const event of noteEvents) {
    const suppressDisplay = event.tieStop && !event.tieStart;
    const staff = staffMap?.get(event) ?? 1;
    event.pitches.forEach((midi, pitchIndex) => {
      const pitch = spellPitch(midi, score.keyFifths);
      const key = `${staff}:${pitch.step}:${pitch.octave}`;
      const current = state.get(key) ?? keySignatureAlter(pitch.step, score.keyFifths);
      if (!suppressDisplay && pitch.alter !== current) {
        const value = accidentalName(pitch.alter);
        const eventAccidentals = accidentals.get(event) ?? new Map<number, string>();
        eventAccidentals.set(pitchIndex, value);
        accidentals.set(event, eventAccidentals);
      }
      if (pitch.alter !== current) state.set(key, pitch.alter);
    });
  }
  return accidentals;
}

/** Key-signature alteration for a diatonic step. */
function keySignatureAlter(step: Step, fifths: number): number {
  const sharpSteps: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flatSteps: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0) return sharpSteps.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return flatSteps.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

/** MusicXML accidental name for supported spellings. */
function accidentalName(alter: number): string {
  if (alter > 0) return 'sharp';
  if (alter < 0) return 'flat';
  return 'natural';
}

/**
 * Computes explicit MusicXML beam markings for each voice. Consecutive
 * beammable notes are grouped within the same staff; rests and unbeammable
 * values break a group, leaving isolated short notes as flagged notes.
 */
function buildBeamIndex(
  voice: NotatedVoice,
  measure: NotatedMeasure,
  staffMap: ReadonlyMap<NotatedEvent, StaffNumber> | undefined,
): BeamIndex {
  const beams = new Map<NotatedEvent, string[]>();
  const groupLen = beatGroupPpq(measure.timeSig);
  let group: NotatedEvent[] = [];
  let groupStaff: StaffNumber | undefined;
  const flush = () => {
    if (group.length >= 2) assignBeams(group, beams);
    group = [];
    groupStaff = undefined;
  };
  for (const event of voice.events) {
    const staff = staffMap?.get(event);
    const startsNewBeatGroup =
      group.length > 0 && isBeatGroupBoundary(event.startPpq, measure.startPpq, groupLen);
    if (
      event.kind !== 'note' ||
      beamLevel(event) === 0 ||
      staff !== groupStaff ||
      startsNewBeatGroup
    ) {
      flush();
      if (event.kind === 'note' && beamLevel(event) > 0) {
        group = [event];
        groupStaff = staff;
      }
      continue;
    }
    group.push(event);
  }
  flush();
  return beams;
}

/**
 * Beat-group length used for beaming: denominator beats in simple meters and
 * dotted beats in compound meters such as 6/8.
 */
function beatGroupPpq(timeSig: NotatedTimeSig): number {
  const beatLen = 4 / timeSig.beatUnit;
  const compound = timeSig.beatUnit >= 8 && timeSig.beats % 3 === 0;
  return compound ? beatLen * 3 : beatLen;
}

/** Returns true for beat-group boundaries after the measure start. */
function isBeatGroupBoundary(ppq: number, measureStartPpq: number, groupLen: number): boolean {
  if (ppq <= measureStartPpq + PPQ_EPSILON) return false;
  const rel = (ppq - measureStartPpq) / groupLen;
  return Math.abs(rel - Math.round(rel)) < PPQ_EPSILON;
}

/** Returns the number of beams required by an event's notated value. */
function beamLevel(event: NotatedEvent): number {
  return BEAM_LEVEL_BY_BASE[event.value.base] ?? 0;
}

/** Assigns first-level beams plus secondary hook/continue marks for one group. */
function assignBeams(group: NotatedEvent[], beams: Map<NotatedEvent, string[]>): void {
  const maxLevel = Math.max(...group.map(beamLevel));
  for (let level = 1; level <= maxLevel; level++) {
    const members = group.filter((event) => beamLevel(event) >= level);
    if (members.length === 0) continue;
    for (const event of members) {
      const index = members.indexOf(event);
      const previous = members[index - 1];
      const next = members[index + 1];
      const previousAdjacent =
        previous !== undefined &&
        Math.abs(previous.startPpq + previous.durationPpq - event.startPpq) < PPQ_EPSILON;
      const nextAdjacent =
        next !== undefined &&
        Math.abs(event.startPpq + event.durationPpq - next.startPpq) < PPQ_EPSILON;
      let value: string;
      if (previousAdjacent && nextAdjacent) value = 'continue';
      else if (nextAdjacent) value = 'begin';
      else if (previousAdjacent) value = 'end';
      else value = index === 0 ? 'forward hook' : 'backward hook';
      const eventBeams = beams.get(event) ?? [];
      eventBeams[level - 1] = value;
      beams.set(event, eventBeams);
    }
  }
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
): string {
  const staffXml = staff === undefined ? '' : `<staff>${staff}</staff>`;
  if (isMeasureRest) {
    const duration = ppqToDivisions(measure.lengthPpq, score.divisions);
    return `<note><rest measure="yes"/><duration>${duration}</duration><voice>${event.voice}</voice>${staffXml}</note>`;
  }
  const duration = ppqToDivisions(event.durationPpq, score.divisions);
  const rest = restElementXml(event, measure, staff);
  const dots = '<dot/>'.repeat(event.value.dots);
  return `<note>${rest}<duration>${duration}</duration><voice>${event.voice}</voice><type>${event.value.base}</type>${dots}${staffXml}</note>`;
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
  beams: BeamIndex,
  accidentals: AccidentalIndex,
): void {
  const duration = ppqToDivisions(event.durationPpq, score.divisions);
  const ties = tieXml(event);
  const dots = '<dot/>'.repeat(event.value.dots);
  const stem = stemXml(event, measure);
  const staffXml = staff === undefined ? '' : `<staff>${staff}</staff>`;
  const beamMarks = beamXml(beams.get(event) ?? []);
  event.pitches.forEach((midi, pitchIndex) => {
    const chord = pitchIndex > 0 ? '<chord/>' : '';
    const pitch = pitchXml(spellPitch(midi, score.keyFifths));
    const accidental = accidentalXml(accidentals.get(event)?.get(pitchIndex));
    const notations = notationsXml(event, annotations, pitchIndex === 0);
    const beam = pitchIndex === 0 ? beamMarks : '';
    const stemMark = pitchIndex === 0 ? stem : '';
    lines.push(
      `<note>${chord}${pitch}<duration>${duration}</duration>${ties}<voice>${event.voice}</voice><type>${event.value.base}</type>${dots}${accidental}${stemMark}${staffXml}${beam}${notations}</note>`,
    );
  });
}

/** Builds an explicit MusicXML accidental element. */
function accidentalXml(accidental: string | undefined): string {
  return accidental === undefined ? '' : `<accidental>${accidental}</accidental>`;
}

/** Builds a stem direction for multi-voice measures, leaving single voices to engraver defaults. */
function stemXml(event: NotatedEvent, measure: NotatedMeasure): string {
  if (measure.voices.length < 2 || event.value.base === 'whole') return '';
  const direction = event.voice === 1 || event.voice === 3 ? 'up' : 'down';
  return `<stem>${direction}</stem>`;
}

/** Builds explicit MusicXML beam elements, or an empty string for flagged notes. */
function beamXml(beams: ReadonlyArray<string>): string {
  let xml = '';
  beams.forEach((value, index) => {
    if (value !== undefined) {
      xml += `<beam number="${index + 1}">${value}</beam>`;
    }
  });
  return xml;
}

/**
 * Builds the `<pitch>` element for a spelled pitch (alter omitted when 0).
 */
function pitchXml(pitch: SpelledPitch): string {
  const alter = pitch.alter === 0 ? '' : `<alter>${pitch.alter}</alter>`;
  return `<pitch><step>${pitch.step}</step>${alter}<octave>${pitch.octave}</octave></pitch>`;
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
): string {
  let inner = '';
  if (event.tieStop) {
    inner += '<tied type="stop"/>';
  }
  if (event.tieStart) {
    inner += '<tied type="start"/>';
  }
  if (isFirstPitch) {
    for (const number of annotations.slurStops.get(event) ?? []) {
      inner += `<slur type="stop" number="${number}"/>`;
    }
    for (const number of annotations.slurStarts.get(event) ?? []) {
      const placement = annotations.slurStartPlacements.get(event)?.get(number);
      const placementXml = placement === undefined ? '' : ` placement="${placement}"`;
      inner += `<slur type="start" number="${number}"${placementXml}/>`;
    }
    const articulation = annotations.articulations.get(event);
    if (articulation !== undefined) {
      inner += `<articulations>${articulationXml(articulation, event)}</articulations>`;
    }
  }
  return inner === '' ? '' : `<notations>${inner}</notations>`;
}

/** Builds a voice-aware articulation element. */
function articulationXml(articulation: NoteArticulation, event: NotatedEvent): string {
  return `<${ARTICULATION_ELEMENT[articulation]} placement="${slurPlacement(event)}"/>`;
}

/**
 * Builds one `<harmony>` element for a chord symbol, or undefined when the
 * symbol has no usable root pitch class (e.g. the 255 "unknown" sentinel).
 */
function harmonyXml(
  symbol: NotatedChordSymbol,
  measure: NotatedMeasure,
  score: NotatedScore,
): string | undefined {
  if (!isPitchClass(symbol.rootPc)) {
    return undefined;
  }
  const root = spellPitch(GRAND_STAFF_SPLIT_MIDI + symbol.rootPc, score.keyFifths);
  const rootAlter = root.alter === 0 ? '' : `<root-alter>${root.alter}</root-alter>`;
  const rootXml = `<root><root-step>${root.step}</root-step>${rootAlter}</root>`;
  const kindName =
    symbol.quality === undefined ? undefined : CHORD_QUALITY_KIND.get(symbol.quality);
  const kindXml =
    kindName === undefined
      ? `<kind text="${escapeXml(symbol.text)}">other</kind>`
      : `<kind>${kindName}</kind>`;
  let bassXml = '';
  if (isPitchClass(symbol.bassPc)) {
    const bass = spellPitch(GRAND_STAFF_SPLIT_MIDI + symbol.bassPc, score.keyFifths);
    const bassAlter = bass.alter === 0 ? '' : `<bass-alter>${bass.alter}</bass-alter>`;
    bassXml = `<bass><bass-step>${bass.step}</bass-step>${bassAlter}</bass>`;
  }
  const offset = ppqToDivisions(symbol.ppq - measure.startPpq, score.divisions);
  const offsetXml = offset === 0 ? '' : `<offset>${offset}</offset>`;
  return `<harmony>${rootXml}${kindXml}${bassXml}${offsetXml}</harmony>`;
}

/**
 * Narrows an optional pitch-class field to a valid 0-11 value (the libsonare
 * 255 "unknown" sentinel and any other out-of-range value fail).
 */
function isPitchClass(pc: number | undefined): pc is number {
  return pc !== undefined && Number.isInteger(pc) && pc >= 0 && pc <= 11;
}

/**
 * Groups chord symbols by the index of the measure containing them; symbols
 * outside the measure grid are dropped.
 */
function groupChordSymbolsByMeasure(
  symbols: ReadonlyArray<NotatedChordSymbol>,
  measures: ReadonlyArray<NotatedMeasure>,
): Map<number, NotatedChordSymbol[]> {
  const byMeasure = new Map<number, NotatedChordSymbol[]>();
  for (const symbol of symbols) {
    const measure = measures.find(
      (m) =>
        symbol.ppq >= m.startPpq - PPQ_EPSILON &&
        symbol.ppq < m.startPpq + m.lengthPpq - PPQ_EPSILON,
    );
    if (measure === undefined) {
      continue;
    }
    const list = byMeasure.get(measure.index);
    if (list === undefined) {
      byMeasure.set(measure.index, [symbol]);
    } else {
      list.push(symbol);
    }
  }
  return byMeasure;
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
function noteStaff(event: NotatedEvent): StaffNumber {
  if (event.pitches.length === 0) return 1;
  const mean = event.pitches.reduce((sum, pitch) => sum + pitch, 0) / event.pitches.length;
  return mean >= GRAND_STAFF_SPLIT_MIDI ? 1 : 2;
}

/**
 * Assigns a staff to every event of a grand-staff part. Notes split at
 * middle C by their mean pitch; rests inherit the staff of the preceding
 * note in the same voice (chained across measures), leading rests adopt the
 * first note's staff, and all-rest voices default to staff 1.
 */
function buildStaffMap(part: NotatedPart): Map<NotatedEvent, StaffNumber> {
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
        const staff = noteStaff(event);
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
