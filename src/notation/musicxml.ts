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
  GlissandoLineType,
  NoteArticulation,
  NoteDynamics,
  NoteHairpin,
  NoteLineSpan,
  NoteOrnament,
  PedalLineSpanStyle,
} from '@/project/annotations';
import { scoreAnnotationLineSpans } from '@/project/annotations';
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
  type ScoreMetadata,
  timeSigLengthPpq,
} from './model';
import { type SpelledPitch, type Step, spellPitch } from './pitch-spelling';
import { staffForMeanPitch } from './quantize';
import { scoreNoteXmlId } from './source-identity';

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

/** Display suffixes preserved on MusicXML `<kind text="...">` where useful. */
const CHORD_QUALITY_TEXT: ReadonlyMap<number, string> = new Map([
  [1, 'm'],
  [2, 'dim'],
  [3, 'aug'],
  [4, '7'],
  [5, 'maj7'],
  [6, 'm7'],
  [7, 'sus2'],
  [8, 'sus4'],
  [10, 'add9'],
  [11, 'm(add9)'],
  [12, 'dim7'],
  [13, 'm7b5'],
  [14, 'maj9'],
  [15, '9'],
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

/** General MIDI percussion channel (MIDI channel 10, stored as 0-based 9). */
const GM_PERCUSSION_CHANNEL = 9;

/**
 * Display annotations resolved onto engraved events. Built once per
 * serialization from {@link NotatedScore.noteAnnotations}: each annotated
 * editor note id is mapped to its "attack" event (the first piece of a tie
 * chain carrying the id in `sourceIds`); ids without an attack event
 * (deleted notes, notes outside the notated window) are silently ignored.
 */
interface AnnotationIndex {
  /** Engraving-only staff overrides without mutating the source event model. */
  staffOverrides: Map<NotatedEvent, StaffNumber>;
  /** Dynamics marking to emit as a `<direction>` right before the event. */
  dynamics: Map<NotatedEvent, NoteDynamics>;
  /** Articulation to emit inside the event's `<notations>`. */
  articulations: Map<NotatedEvent, NoteArticulation>;
  /** Ornament to emit inside the event's `<notations>`. */
  ornaments: Map<NotatedEvent, NoteOrnament>;
  /** Slur numbers starting on the event. */
  slurStarts: Map<NotatedEvent, number[]>;
  /** Slur placement attributes keyed by start event and slur number. */
  slurStartPlacements: Map<NotatedEvent, Map<number, string>>;
  /** Slur numbers stopping on the event. */
  slurStops: Map<NotatedEvent, number[]>;
  /** Hairpin wedges starting on the event. */
  hairpinStarts: Map<NotatedEvent, Array<{ number: number; type: NoteHairpin }>>;
  /** Hairpin wedge numbers stopping on the event. */
  hairpinStops: Map<NotatedEvent, number[]>;
  /** Other line/span markings starting on the event. */
  lineSpanStarts: Map<NotatedEvent, LineSpanRender[]>;
  /** Other line/span markings stopping on the event. */
  lineSpanStops: Map<NotatedEvent, LineSpanRender[]>;
}

interface LineSpanRender {
  number: number;
  type: NoteLineSpan;
  pedalStyle?: PedalLineSpanStyle;
  glissandoLineType?: GlissandoLineType;
  glissandoText?: string;
}

/** Beam marks keyed by event, one array entry per MusicXML beam level. */
type BeamIndex = ReadonlyMap<NotatedEvent, ReadonlyArray<string>>;

/** Explicit accidental text by event and pitch index within a note/chord. */
type AccidentalIndex = ReadonlyMap<NotatedEvent, ReadonlyMap<number, string>>;

/** Lyric syllables resolved onto note attack events. */
type LyricIndex = ReadonlyMap<NotatedEvent, ReadonlyArray<NotatedLyric>>;

interface PercussionDisplay {
  step: Step;
  octave: number;
  notehead?: string;
  name: string;
}

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
    staffOverrides: new Map(),
    dynamics: new Map(),
    articulations: new Map(),
    ornaments: new Map(),
    slurStarts: new Map(),
    slurStartPlacements: new Map(),
    slurStops: new Map(),
    hairpinStarts: new Map(),
    hairpinStops: new Map(),
    lineSpanStarts: new Map(),
    lineSpanStops: new Map(),
  };
  const annotations = score.noteAnnotations;
  if (annotations === undefined) return index;
  const attackByNoteId = new Map<number, NotatedEvent>();
  const eventsByNoteId = new Map<number, NotatedEvent[]>();
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const voice of measure.voices) {
        for (const event of voice.events) {
          if (event.kind !== 'note' || event.sourceIds === undefined) continue;
          for (const id of event.sourceIds) {
            const events = eventsByNoteId.get(id) ?? [];
            events.push(event);
            eventsByNoteId.set(id, events);
            if (!event.tieStop && !attackByNoteId.has(id)) attackByNoteId.set(id, event);
          }
        }
      }
    }
  }
  const slurs: Array<{ start: NotatedEvent; stop: NotatedEvent }> = [];
  const hairpins: Array<{ start: NotatedEvent; stop: NotatedEvent; type: NoteHairpin }> = [];
  const lineSpans: Array<
    { start: NotatedEvent; stop: NotatedEvent } & Omit<LineSpanRender, 'number'>
  > = [];
  for (const [idKey, annotation] of Object.entries(annotations)) {
    const event = attackByNoteId.get(Number(idKey));
    if (event === undefined) continue; // Orphaned annotation: ignore.
    if (annotation.staffOverride === 1 || annotation.staffOverride === 2) {
      for (const sourceEvent of eventsByNoteId.get(Number(idKey)) ?? []) {
        index.staffOverrides.set(sourceEvent, annotation.staffOverride);
      }
    }
    if (annotation.dynamics !== undefined) index.dynamics.set(event, annotation.dynamics);
    if (annotation.articulation !== undefined) {
      index.articulations.set(event, annotation.articulation);
    }
    if (annotation.ornament !== undefined) index.ornaments.set(event, annotation.ornament);
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
    if (annotation.hairpin !== undefined && annotation.hairpinToNoteId !== undefined) {
      const target = attackByNoteId.get(annotation.hairpinToNoteId);
      if (
        target !== undefined &&
        target !== event &&
        target.startPpq > event.startPpq + PPQ_EPSILON
      ) {
        hairpins.push({ start: event, stop: target, type: annotation.hairpin });
      }
    }
    for (const span of scoreAnnotationLineSpans(annotation)) {
      const target = attackByNoteId.get(span.lineSpanToNoteId);
      if (
        target !== undefined &&
        target !== event &&
        target.startPpq > event.startPpq + PPQ_EPSILON
      ) {
        lineSpans.push({
          start: event,
          stop: target,
          type: span.lineSpan,
          ...(span.pedalStyle !== undefined ? { pedalStyle: span.pedalStyle } : {}),
          ...(span.glissandoLineType !== undefined
            ? { glissandoLineType: span.glissandoLineType }
            : {}),
          ...(span.glissandoText !== undefined ? { glissandoText: span.glissandoText } : {}),
        });
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
  hairpins.sort((a, b) => a.start.startPpq - b.start.startPpq || a.stop.startPpq - b.stop.startPpq);
  active.length = 0;
  for (const hairpin of hairpins) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endPpq <= hairpin.start.startPpq + PPQ_EPSILON) active.splice(i, 1);
    }
    let number = 1;
    while (active.some((entry) => entry.number === number) && number < MAX_SLUR_NUMBER) number++;
    active.push({ endPpq: hairpin.stop.startPpq, number });
    const starts = index.hairpinStarts.get(hairpin.start) ?? [];
    starts.push({ number, type: hairpin.type });
    index.hairpinStarts.set(hairpin.start, starts);
    pushMapped(index.hairpinStops, hairpin.stop, number);
  }
  lineSpans.sort(
    (a, b) => a.start.startPpq - b.start.startPpq || a.stop.startPpq - b.stop.startPpq,
  );
  active.length = 0;
  for (const lineSpan of lineSpans) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endPpq <= lineSpan.start.startPpq + PPQ_EPSILON) active.splice(i, 1);
    }
    let number = 1;
    while (active.some((entry) => entry.number === number) && number < MAX_SLUR_NUMBER) number++;
    active.push({ endPpq: lineSpan.stop.startPpq, number });
    const render: LineSpanRender = {
      number,
      type: lineSpan.type,
      ...(lineSpan.pedalStyle !== undefined ? { pedalStyle: lineSpan.pedalStyle } : {}),
      ...(lineSpan.glissandoLineType !== undefined
        ? { glissandoLineType: lineSpan.glissandoLineType }
        : {}),
      ...(lineSpan.glissandoText !== undefined ? { glissandoText: lineSpan.glissandoText } : {}),
    };
    const starts = index.lineSpanStarts.get(lineSpan.start) ?? [];
    starts.push(render);
    index.lineSpanStarts.set(lineSpan.start, starts);
    const stops = index.lineSpanStops.get(lineSpan.stop) ?? [];
    stops.push(render);
    index.lineSpanStops.set(lineSpan.stop, stops);
  }
  return index;
}

/** Resolves score-level lyric entries onto the nearest matching note attack. */
function buildLyricIndex(score: NotatedScore): LyricIndex {
  const lyrics = score.lyrics;
  if (lyrics === undefined || lyrics.length === 0) return new Map();
  const events: Array<{ partId: string; event: NotatedEvent }> = [];
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const voice of measure.voices) {
        for (const event of voice.events) {
          if (event.kind === 'note' && !event.tieStop) events.push({ partId: part.id, event });
        }
      }
    }
  }
  const index = new Map<NotatedEvent, NotatedLyric[]>();
  for (const lyric of [...lyrics].sort(compareLyrics)) {
    const text = lyric.text.trim();
    if (text === '') continue;
    const candidates = events.filter(
      ({ partId }) => lyric.partId === undefined || lyric.partId === partId,
    );
    const match = candidates.reduce<(typeof candidates)[number] | undefined>(
      (nearest, candidate) => {
        if (nearest === undefined) return candidate;
        return Math.abs(candidate.event.startPpq - lyric.ppq) <
          Math.abs(nearest.event.startPpq - lyric.ppq)
          ? candidate
          : nearest;
      },
      undefined,
    );
    if (match === undefined) continue;
    const list = index.get(match.event) ?? [];
    list.push({ ...lyric, text });
    index.set(match.event, list);
  }
  return index;
}

function compareLyrics(a: NotatedLyric, b: NotatedLyric): number {
  return a.ppq - b.ppq || (a.verse ?? 1) - (b.verse ?? 1) || a.text.localeCompare(b.text);
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
  return sanitizeXml10(text).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

/** Replaces code points forbidden by XML 1.0 with the replacement character. */
export function sanitizeXml10(text: string): string {
  let out = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const valid =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    out += valid ? character : '\ufffd';
  }
  return out;
}

/** Software credit written into the MusicXML `<encoding>` block. */
const ENCODING_SOFTWARE = 'sonare studio';

/** MusicXML tenths per millimeter under the default 40 tenths / 7 mm scaling. */
const TENTHS_PER_MM = 40 / 7;

/** A4 portrait page geometry in millimeters. */
const A4_PAGE_MM = { width: 210, height: 297 } as const;

/** Conservative printable margins in MusicXML tenths. */
const PAGE_MARGIN_TENTHS = {
  left: 70,
  right: 70,
  top: 70,
  bottom: 70,
} as const;

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

/** Appends stable print-layout defaults for MusicXML importers. */
function appendScoreDefaults(lines: string[]): void {
  const pageWidth = Math.round(A4_PAGE_MM.width * TENTHS_PER_MM);
  const pageHeight = Math.round(A4_PAGE_MM.height * TENTHS_PER_MM);
  lines.push('<defaults>');
  lines.push('<scaling><millimeters>7</millimeters><tenths>40</tenths></scaling>');
  lines.push(
    '<page-layout>' +
      `<page-height>${pageHeight}</page-height>` +
      `<page-width>${pageWidth}</page-width>` +
      '<page-margins type="both">' +
      `<left-margin>${PAGE_MARGIN_TENTHS.left}</left-margin>` +
      `<right-margin>${PAGE_MARGIN_TENTHS.right}</right-margin>` +
      `<top-margin>${PAGE_MARGIN_TENTHS.top}</top-margin>` +
      `<bottom-margin>${PAGE_MARGIN_TENTHS.bottom}</bottom-margin>` +
      '</page-margins>' +
      '</page-layout>',
  );
  lines.push(
    '<system-layout>' +
      '<system-margins><left-margin>0</left-margin><right-margin>0</right-margin></system-margins>' +
      '<system-distance>150</system-distance>' +
      '<top-system-distance>100</top-system-distance>' +
      '</system-layout>',
  );
  lines.push('<staff-layout><staff-distance>80</staff-distance></staff-layout>');
  lines.push(
    '<appearance>' +
      '<line-width type="beam">5</line-width>' +
      '<line-width type="bracket">4</line-width>' +
      '<line-width type="dashes">1</line-width>' +
      '<line-width type="enclosure">1</line-width>' +
      '<line-width type="ending">1.2</line-width>' +
      '<line-width type="extend">1</line-width>' +
      '<line-width type="heavy barline">5</line-width>' +
      '<line-width type="leger">1.6</line-width>' +
      '<line-width type="light barline">1.6</line-width>' +
      '<line-width type="octave shift">1.2</line-width>' +
      '<line-width type="pedal">1.2</line-width>' +
      '<line-width type="slur middle">1.6</line-width>' +
      '<line-width type="slur tip">0.5</line-width>' +
      '<line-width type="staff">1.1</line-width>' +
      '<line-width type="stem">1</line-width>' +
      '<line-width type="tie middle">1.6</line-width>' +
      '<line-width type="tie tip">0.5</line-width>' +
      '<note-size type="cue">60</note-size>' +
      '<note-size type="grace">60</note-size>' +
      '</appearance>',
  );
  lines.push('</defaults>');
}

/** Appends printable title/composer/part credits when metadata is present. */
function appendScoreCredits(lines: string[], metadata: ScoreMetadata | undefined): void {
  const title = metadata?.title?.trim();
  const composer = metadata?.composer?.trim();
  const partName = metadata?.partName?.trim();
  if (title) {
    lines.push(
      `<credit page="1"><credit-type>title</credit-type><credit-words justify="center" valign="top" default-y="1600" font-size="18">${escapeXml(title)}</credit-words></credit>`,
    );
  }
  if (composer) {
    lines.push(
      `<credit page="1"><credit-type>composer</credit-type><credit-words justify="right" valign="top" default-y="1560" font-size="11">${escapeXml(composer)}</credit-words></credit>`,
    );
  }
  if (partName) {
    lines.push(
      `<credit page="1"><credit-type>part name</credit-type><credit-words justify="left" valign="top" default-y="1560" font-size="12">${escapeXml(partName)}</credit-words></credit>`,
    );
  }
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
  return {
    ...score,
    metadata: {
      ...score.metadata,
      partName: part.name,
    },
    parts: [part],
  };
}

/** Builds a score-part entry with a deterministic abbreviation. */
function scorePartXml(part: NotatedPart): string {
  const name = escapeXml(part.name);
  const abbreviation = escapeXml(partAbbreviation(part.name));
  const instruments = scorePartInstrumentsXml(part);
  return `<score-part id="${escapeXml(part.id)}"><part-name>${name}</part-name><part-abbreviation>${abbreviation}</part-abbreviation>${instruments}</score-part>`;
}

interface ScoreInstrumentDefinition {
  id: string;
  name: string;
  channel: number;
  unpitched?: number;
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

/** Conservatively infers drum/percussion parts from their display name. */
function isPercussionPartName(part: NotatedPart): boolean {
  return /\b(drum|drums|kit|percussion|perc|cajon|conga|bongo)\b/i.test(part.name);
}

/**
 * Uses MIDI channel metadata as the primary percussion signal. Part-name
 * inference remains only as a compatibility fallback for hand-authored scores
 * that do not carry source channel metadata.
 */
function partUsesPercussionMap(part: NotatedPart): boolean {
  let sawChannelMetadata = false;
  for (const measure of part.measures) {
    for (const voice of measure.voices) {
      for (const event of voice.events) {
        if (event.kind !== 'note' || event.midiChannels === undefined) continue;
        if (event.midiChannels.length > 0) sawChannelMetadata = true;
        if (event.midiChannels.includes(GM_PERCUSSION_CHANNEL)) return true;
      }
    }
  }
  return sawChannelMetadata ? false : isPercussionPartName(part);
}

/** Returns true when a note event should be serialized with a drum map. */
function eventUsesPercussionMap(event: NotatedEvent, partPercussionFallback: boolean): boolean {
  if (event.midiChannels !== undefined && event.midiChannels.length > 0) {
    return event.midiChannels.includes(GM_PERCUSSION_CHANNEL);
  }
  return partPercussionFallback;
}

/** Returns percussion pitches used by this part, sorted by GM note number. */
function percussionPitches(part: NotatedPart): number[] {
  const pitches = new Set<number>();
  for (const measure of part.measures) {
    for (const voice of measure.voices) {
      for (const event of voice.events) {
        if (event.kind !== 'note' || !eventUsesPercussionMap(event, true)) continue;
        for (const pitch of event.pitches) pitches.add(pitch);
      }
    }
  }
  return [...pitches].sort((a, b) => a - b);
}

/** Builds part-list instrument metadata for drum maps. */
function percussionInstrumentDefinitions(part: NotatedPart): ScoreInstrumentDefinition[] {
  return percussionPitches(part).map((pitch) => ({
    id: percussionInstrumentId(part.id, pitch),
    name: percussionDisplay(pitch).name,
    channel: GM_PERCUSSION_CHANNEL + 1,
    unpitched: pitch + 1,
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

/** Stable MusicXML score-instrument id for one GM percussion pitch. */
function percussionInstrumentId(partId: string, midi: number): string {
  return `${escapeXml(partId)}-I${midi}`;
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
  let activeKeyFifths = score.keyFifths;
  // Percussion velocity directions are inferred display metadata. Keep the
  // previous value per voice across measure boundaries so a steady groove
  // does not print the same dynamic at the start of every measure.
  const inferredDynamicsByVoice = new Map<NotatedVoiceNumber, NoteDynamics>();
  for (const [measureIndex, measure] of part.measures.entries()) {
    const measureClef = clefForMeasure(part.clef, measure, prevClef);
    const keyFifths = score.measureKeyFifths?.[measure.index];
    if (keyFifths !== undefined) activeKeyFifths = keyFifths;
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
  const accidentals = buildAccidentalIndex(measure, activeKeyFifths, staffMap);
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

/** Builds a compact first-system drum-map legend for printed percussion parts. */
function percussionLegendDirectionXml(part: NotatedPart): string {
  const items = percussionPitches(part)
    .slice(0, 8)
    .map((pitch) => `${percussionDisplay(pitch).name}=${pitch}`)
    .join(', ');
  if (items === '') return '';
  return `<direction placement="above"><direction-type><words default-y="18" font-size="8">${escapeXml(`Drum map: ${items}`)}</words></direction-type></direction>`;
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

function octaveShiftDirection(lineSpan: Exclude<NoteLineSpan, 'pedal' | 'glissando'>): {
  placement: 'above' | 'below';
  shift: 'up' | 'down';
  size: 8 | 15;
} {
  switch (lineSpan) {
    case 'ottava-up':
      return { placement: 'above', shift: 'up', size: 8 };
    case 'ottava-down':
      return { placement: 'below', shift: 'down', size: 8 };
    case 'ottava-15-up':
      return { placement: 'above', shift: 'up', size: 15 };
    case 'ottava-15-down':
      return { placement: 'below', shift: 'down', size: 15 };
  }
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

/** Builds explicit accidentals only when the visible pitch state changes. */
function buildAccidentalIndex(
  measure: NotatedMeasure,
  keyFifths: number,
  staffMap: ReadonlyMap<NotatedEvent, StaffNumber> | undefined,
): AccidentalIndex {
  const accidentals = new Map<NotatedEvent, Map<number, string>>();
  const state = new Map<string, number>();
  const noteEvents = measure.voices
    .flatMap((voice) => voice.events)
    .filter((event) => event.kind === 'note')
    .sort((a, b) => a.startPpq - b.startPpq || a.voice - b.voice);
  for (const event of noteEvents) {
    const suppressDisplay = event.tieStop;
    const staff = staffMap?.get(event) ?? 1;
    event.pitches.forEach((midi, pitchIndex) => {
      const pitch = spellPitch(midi, keyFifths);
      const key = `${staff}:${pitch.step}:${pitch.octave}`;
      const current = state.get(key) ?? keySignatureAlter(pitch.step, keyFifths);
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
 * beammable notes and short rests are grouped within the same staff; unbeammable
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
    if (group.filter((event) => event.kind === 'note').length >= 2) assignBeams(group, beams);
    group = [];
    groupStaff = undefined;
  };
  for (const event of voice.events) {
    const staff = staffMap?.get(event);
    const startsNewBeatGroup =
      group.length > 0 && isBeatGroupBoundary(event.startPpq, measure.startPpq, groupLen);
    if (beamLevel(event) === 0 || staff !== groupStaff || startsNewBeatGroup) {
      flush();
      if (beamLevel(event) > 0) {
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
      : pitchXml(spellPitch(midi, keyFifths));
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

/** Maps common GM drum notes to readable percussion positions and names. */
function percussionDisplay(midi: number): PercussionDisplay {
  switch (midi) {
    case 35:
      return { step: 'F', octave: 4, notehead: 'normal', name: 'Acoustic Bass Drum' };
    case 36:
      return { step: 'F', octave: 4, notehead: 'normal', name: 'Bass Drum 1' };
    case 37:
      return { step: 'B', octave: 4, notehead: 'normal', name: 'Side Stick' };
    case 38:
      return { step: 'C', octave: 5, notehead: 'normal', name: 'Acoustic Snare' };
    case 39:
      return { step: 'C', octave: 5, notehead: 'normal', name: 'Hand Clap' };
    case 40:
      return { step: 'C', octave: 5, notehead: 'normal', name: 'Electric Snare' };
    case 41:
      return { step: 'F', octave: 4, notehead: 'normal', name: 'Low Floor Tom' };
    case 42:
      return { step: 'G', octave: 5, notehead: 'x', name: 'Closed Hi-Hat' };
    case 43:
      return { step: 'G', octave: 4, notehead: 'normal', name: 'High Floor Tom' };
    case 44:
      return { step: 'F', octave: 5, notehead: 'x', name: 'Pedal Hi-Hat' };
    case 45:
      return { step: 'A', octave: 4, notehead: 'normal', name: 'Low Tom' };
    case 46:
      return { step: 'A', octave: 5, notehead: 'x', name: 'Open Hi-Hat' };
    case 47:
      return { step: 'B', octave: 4, notehead: 'normal', name: 'Low-Mid Tom' };
    case 48:
      return { step: 'D', octave: 5, notehead: 'normal', name: 'Hi-Mid Tom' };
    case 49:
      return { step: 'C', octave: 6, notehead: 'x', name: 'Crash Cymbal 1' };
    case 50:
      return { step: 'E', octave: 5, notehead: 'normal', name: 'High Tom' };
    case 51:
      return { step: 'D', octave: 6, notehead: 'x', name: 'Ride Cymbal 1' };
    case 52:
      return { step: 'C', octave: 6, notehead: 'x', name: 'Chinese Cymbal' };
    case 53:
      return { step: 'D', octave: 6, notehead: 'normal', name: 'Ride Bell' };
    case 54:
      return { step: 'B', octave: 5, notehead: 'x', name: 'Tambourine' };
    case 55:
      return { step: 'C', octave: 6, notehead: 'x', name: 'Splash Cymbal' };
    case 56:
      return { step: 'B', octave: 4, notehead: 'x', name: 'Cowbell' };
    case 57:
      return { step: 'C', octave: 6, notehead: 'x', name: 'Crash Cymbal 2' };
    case 58:
      return { step: 'A', octave: 5, notehead: 'x', name: 'Vibraslap' };
    case 59:
      return { step: 'D', octave: 6, notehead: 'x', name: 'Ride Cymbal 2' };
    default:
      return {
        step: 'C',
        octave: 5,
        notehead: midi >= 42 && midi <= 59 ? 'x' : 'normal',
        name: `GM Percussion ${midi}`,
      };
  }
}

/** Builds a MusicXML unpitched notehead location. */
function unpitchedXml(display: PercussionDisplay): string {
  return `<unpitched><display-step>${display.step}</display-step><display-octave>${display.octave}</display-octave></unpitched>`;
}

/** Builds an optional MusicXML notehead. */
function noteheadXml(display: PercussionDisplay, event: NotatedEvent): string {
  if (display.notehead === undefined) return '';
  const parentheses =
    event.velocity !== undefined && event.velocity <= 45 ? ' parentheses="yes"' : '';
  return `<notehead${parentheses}>${display.notehead}</notehead>`;
}

/** Builds an explicit MusicXML accidental element. */
function accidentalXml(accidental: string | undefined): string {
  return accidental === undefined ? '' : `<accidental>${accidental}</accidental>`;
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
    if (measure !== undefined && isPercussionRoll(event, measure, midi)) {
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

/** Builds percussion technique markings for common GM drum articulations. */
function percussionTechnicalXml(midi: number): string {
  switch (midi) {
    case 42:
      return '<technical><stopped/></technical>';
    case 46:
      return '<technical><open-string/></technical>';
    default:
      return '';
  }
}

/** Returns true when repeated short drum notes should carry a roll/tremolo mark. */
function isPercussionRoll(event: NotatedEvent, measure: NotatedMeasure, midi: number): boolean {
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
      if (candidateGroup === groupIndex) count++;
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
  return `<${ARTICULATION_ELEMENT[articulation]} placement="${slurPlacement(event)}"/>`;
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
 * Builds MusicXML `<harmony>` elements for a chord symbol. The primary entry
 * remains a pop/jazz root-based symbol; Roman numeral text is preserved as an
 * alternate functional harmony when present.
 */
function harmonyXml(
  symbol: NotatedChordSymbol,
  measure: NotatedMeasure,
  score: NotatedScore,
  keyFifths: number,
): string[] {
  if (!isPitchClass(symbol.rootPc)) {
    return [];
  }
  const root = spellPitch(GRAND_STAFF_SPLIT_MIDI + symbol.rootPc, keyFifths);
  const rootAlter = root.alter === 0 ? '' : `<root-alter>${root.alter}</root-alter>`;
  const rootXml = `<root><root-step>${root.step}</root-step>${rootAlter}</root>`;
  const kindXml = chordKindXml(symbol);
  const degreeXml = chordDegreeXml(symbol);
  let bassXml = '';
  if (isPitchClass(symbol.bassPc)) {
    const bass = spellPitch(GRAND_STAFF_SPLIT_MIDI + symbol.bassPc, keyFifths);
    const bassAlter = bass.alter === 0 ? '' : `<bass-alter>${bass.alter}</bass-alter>`;
    bassXml = `<bass><bass-step>${bass.step}</bass-step>${bassAlter}</bass>`;
  }
  const offset = ppqToDivisions(symbol.ppq - measure.startPpq, score.divisions);
  const offsetXml = offset === 0 ? '' : `<offset>${offset}</offset>`;
  const harmonies = [`<harmony>${rootXml}${kindXml}${bassXml}${degreeXml}${offsetXml}</harmony>`];
  const romanNumeral = symbol.romanNumeral?.trim();
  if (romanNumeral !== undefined && romanNumeral !== '') {
    harmonies.push(
      `<harmony type="alternate"><function>${escapeXml(romanNumeral)}</function>${kindXml}${degreeXml}${offsetXml}</harmony>`,
    );
  }
  return harmonies;
}

/** Builds a MusicXML chord kind while preserving compact display suffixes. */
function chordKindXml(symbol: NotatedChordSymbol): string {
  const quality = symbol.quality;
  const add9BaseKind = quality === 10 ? 'major' : quality === 11 ? 'minor' : undefined;
  const kindName =
    add9BaseKind ?? (quality === undefined ? undefined : CHORD_QUALITY_KIND.get(quality));
  if (kindName === undefined) {
    return `<kind text="${escapeXml(symbol.text)}">other</kind>`;
  }
  const text = quality === undefined ? undefined : CHORD_QUALITY_TEXT.get(quality);
  const textXml = text === undefined ? '' : ` text="${escapeXml(text)}"`;
  return `<kind${textXml}>${kindName}</kind>`;
}

/** Adds explicit MusicXML degree data for add9 chord qualities. */
function chordDegreeXml(symbol: NotatedChordSymbol): string {
  if (symbol.quality !== 10 && symbol.quality !== 11) return '';
  return '<degree><degree-value>9</degree-value><degree-alter>0</degree-alter><degree-type>add</degree-type></degree>';
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
