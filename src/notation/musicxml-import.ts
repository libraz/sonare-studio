/**
 * Pragmatic MusicXML importer for the browser DAW.
 *
 * Parses a `score-partwise` MusicXML document into a {@link ProjectDocument}
 * with the same shape the Standard MIDI File importer produces (one MIDI track
 * per part, a single clip per track, plus the project tempo / time-signature /
 * key-signature maps). It is a note-level importer aimed at correctness on the
 * common cases rather than full MusicXML coverage: it understands pitches,
 * chords, rests, ties, voices/staves, `<backup>`/`<forward>`, `<divisions>`,
 * key/time attributes, and tempo from `<sound tempo>` or `<metronome>`.
 *
 * Timing is mapped from MusicXML divisions to the app PPQ convention (quarter
 * note = 1.0). The parser is defensive: malformed XML raises
 * {@link MusicXmlImportError}, and a well-formed document with no importable
 * parts yields an empty-but-valid project rather than throwing.
 */

import { SaxesParser } from 'saxes';
import { keyMarkerName } from '@/compose/key-name';
import { GM_PERCUSSION_CHANNEL } from '@/compose/tracks';
import { type LossReport, LossTally } from '@/export/loss-descriptor';
import { clampInt } from '@/lib/math';
import { DEFAULT_NOTE_VELOCITY } from '@/lib/midi';
import { MAX_XML_DOCUMENT_BYTES, preflightXmlBytes, XmlPreflightError } from '@/lib/xml-preflight';
import {
  type DocumentClip,
  type DocumentMarker,
  type DocumentNote,
  type DocumentTempoSegment,
  type DocumentTimeSignature,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from '@/project/serialization';
import { presetForGmProgram } from '@/project/smf';
import { DEFAULT_TEMPO_BPM } from '@/project/tempo-map';
import { TRACK_COLOR_PALETTE } from '@/project/types';
import { NOTE_VALUE_BASE_PPQ } from './model';

/** Sample rate assigned to imported projects (matches the SMF importer). */
const DEFAULT_SAMPLE_RATE = 48000;

/**
 * Divisions per quarter note assumed when a part omits `<divisions>` entirely.
 * MusicXML normally declares it in the first measure's `<attributes>`; the
 * fallback only guards malformed input so durations still map to a sane PPQ.
 */
const FALLBACK_DIVISIONS = 480;

/** Minimum clip length in PPQ. */
const MIN_CLIP_LENGTH_PPQ = 1;

/** Rounding tolerance for treating a PPQ length as integral. */
const PPQ_INTEGER_EPSILON = 1 / 256;

export interface MusicXmlImportLimits {
  maxBytes: number;
  maxElements: number;
  maxDepth: number;
  maxParts: number;
  maxMeasures: number;
  maxNotes: number;
  maxNumericAbs: number;
}

export const DEFAULT_MUSICXML_IMPORT_LIMITS: Readonly<MusicXmlImportLimits> = Object.freeze({
  maxBytes: MAX_XML_DOCUMENT_BYTES,
  // A normal detailed score uses roughly 9--15 XML elements per note. Keep
  // this comfortably above the documented note limit while the byte limit
  // remains the primary protection against hostile input.
  maxElements: 5_000_000,
  maxDepth: 128,
  maxParts: 1_024,
  maxMeasures: 100_000,
  maxNotes: 1_000_000,
  maxNumericAbs: 1_000_000_000,
});

function resolveImportLimits(limits: Partial<MusicXmlImportLimits> = {}): MusicXmlImportLimits {
  return { ...DEFAULT_MUSICXML_IMPORT_LIMITS, ...limits };
}

interface XmlElement {
  tagName: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/** Semitone offset above C for each diatonic step. */
const STEP_SEMITONES: Readonly<Record<string, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Quarter-note length of a metronome beat unit, before augmentation dots. */
const BEAT_UNIT_QUARTERS: Readonly<Record<string, number>> = { ...NOTE_VALUE_BASE_PPQ, breve: 8 };

/** Raised when a MusicXML document cannot be parsed or is not a supported score. */
export class MusicXmlImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MusicXmlImportError';
  }
}

/** Every class the MusicXML import loss dialog can list, in dialog order. */
export const MUSICXML_IMPORT_LOSS_KINDS = [
  'harmony',
  'lyrics',
  'repeats',
  'jumps',
  'dynamics',
  'fingering',
  'fermatas',
  'arpeggios',
  'annotations',
  'grace-notes',
  'figured-bass',
  'extra-instruments',
  'tempo-conflicts',
  'other-notation',
] as const;

export type MusicXmlImportLossKind = (typeof MUSICXML_IMPORT_LOSS_KINDS)[number];

export interface MusicXmlImportResult {
  document: ProjectDocument;
  report: LossReport<MusicXmlImportLossKind>;
}

/** Percussion instrument mapping declared in the `<part-list>`. */
interface InstrumentMapping {
  /** 0-based MIDI channel, when declared. */
  channel?: number;
  /** 0-based MIDI pitch for an unpitched note, when declared. */
  unpitched?: number;
  /** 0-based General MIDI program, when declared. */
  program?: number;
  /** Linear track volume converted from MusicXML's 0--100 range. */
  volume?: number;
  /** Track pan normalized from MusicXML's -90--90 degree range. */
  pan?: number;
}

/** Parsed `<score-part>` metadata used while importing its `<part>`. */
interface PartInfo {
  name: string;
  instruments: Map<string, InstrumentMapping>;
}

/** Returns direct child elements of `parent`, optionally filtered by tag name. */
function childElements(parent: XmlElement, tag?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of parent.children) {
    if (tag === undefined || child.tagName === tag) out.push(child);
  }
  return out;
}

/** Returns the trimmed text of the first `tag` child, or null when absent. */
function elementText(element: XmlElement): string {
  return element.text + element.children.map(elementText).join('');
}

function childText(parent: XmlElement, tag: string): string | null {
  const child = childElements(parent, tag)[0];
  const text = child === undefined ? undefined : elementText(child).trim();
  return text === undefined || text === '' ? null : text;
}

/** Parses the first `tag` child as an integer, or null when absent/invalid. */
function childInt(parent: XmlElement, tag: string, maxNumericAbs: number): number | null {
  const text = childText(parent, tag);
  if (text === null) return null;
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || Math.abs(value) > maxNumericAbs) {
    throw new MusicXmlImportError(`MusicXML numeric value exceeds the safe limit: ${text}`);
  }
  return value;
}

/** Parses the first `tag` child as a bounded finite number. */
function childNumber(parent: XmlElement, tag: string, maxNumericAbs: number): number | null {
  const text = childText(parent, tag);
  if (text === null) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > maxNumericAbs) return null;
  return value;
}

function descendants(parent: XmlElement, tag: string): XmlElement[] {
  const out: XmlElement[] = [];
  const pending = [...parent.children].reverse();
  while (pending.length > 0) {
    const child = pending.pop();
    if (child === undefined) continue;
    if (child.tagName === tag) out.push(child);
    for (let index = child.children.length - 1; index >= 0; index -= 1) {
      pending.push(child.children[index]);
    }
  }
  return out;
}

/**
 * Parses a MusicXML string into a DOM document.
 *
 * @param xml MusicXML source text.
 * @returns The root `score-partwise` element.
 * @throws MusicXmlImportError When the input is not well-formed XML or is not
 *   a `score-partwise` document.
 */
function parseScoreRoot(xml: string, limits: Partial<MusicXmlImportLimits> = {}): XmlElement {
  const resolved = { ...DEFAULT_MUSICXML_IMPORT_LIMITS, ...limits };
  try {
    preflightXmlBytes(new TextEncoder().encode(xml).byteLength, 'MusicXML', {
      maxBytes: resolved.maxBytes,
    });
  } catch (error) {
    if (error instanceof XmlPreflightError) {
      throw new MusicXmlImportError(error.message);
    }
    throw new MusicXmlImportError('MusicXML could not be parsed as XML');
  }
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];
  let elements = 0;
  let parts = 0;
  let measures = 0;
  let notes = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => {
    elements += 1;
    if (tag.name === 'part') parts += 1;
    if (tag.name === 'measure') measures += 1;
    if (tag.name === 'note') notes += 1;
    if (elements > resolved.maxElements) {
      throw new MusicXmlImportError(
        `MusicXML is too complex to import (more than ${resolved.maxElements.toLocaleString()} structural entries)`,
      );
    }
    if (stack.length + 1 > resolved.maxDepth) {
      throw new MusicXmlImportError(`MusicXML exceeds the ${resolved.maxDepth}-level depth limit`);
    }
    if (parts > resolved.maxParts) {
      throw new MusicXmlImportError(`MusicXML exceeds the ${resolved.maxParts}-part limit`);
    }
    if (measures > resolved.maxMeasures) {
      throw new MusicXmlImportError(`MusicXML exceeds the ${resolved.maxMeasures}-measure limit`);
    }
    if (notes > resolved.maxNotes) {
      throw new MusicXmlImportError(`MusicXML exceeds the ${resolved.maxNotes}-note limit`);
    }
    const attributes: Record<string, string> = {};
    for (const [name, raw] of Object.entries(tag.attributes)) {
      attributes[name] = raw;
    }
    const element: XmlElement = { tagName: tag.name, attributes, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root === null) root = element;
    else throw new MusicXmlImportError('MusicXML contains multiple root elements');
    stack.push(element);
  });
  parser.on('text', (text) => {
    const current = stack[stack.length - 1];
    if (current) current.text += text;
  });
  parser.on('cdata', (text) => {
    const current = stack[stack.length - 1];
    if (current) current.text += text;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof MusicXmlImportError) throw error;
    throw new MusicXmlImportError('MusicXML is not well-formed XML');
  }
  const parsedRoot = root as XmlElement | null;
  if (parsedRoot === null) throw new MusicXmlImportError('MusicXML is not well-formed XML');
  if (parsedRoot.tagName === 'score-timewise') {
    throw new MusicXmlImportError('score-timewise MusicXML is not supported; convert to partwise');
  }
  if (parsedRoot.tagName !== 'score-partwise') {
    throw new MusicXmlImportError(`Unexpected MusicXML root element <${parsedRoot.tagName}>`);
  }
  return parsedRoot;
}

/** MIDI note number for a `<pitch>` element, or null when it is incomplete. */
function pitchToMidi(pitch: XmlElement, maxNumericAbs: number): number | null {
  const step = childText(pitch, 'step');
  const octave = childInt(pitch, 'octave', maxNumericAbs);
  if (step === null || octave === null) return null;
  const semitone = STEP_SEMITONES[step.toUpperCase()];
  if (semitone === undefined) return null;
  const alter = childInt(pitch, 'alter', maxNumericAbs) ?? 0;
  return (octave + 1) * 12 + semitone + alter;
}

/** Common Sonare MusicXML drum display positions, reversed to GM note numbers. */
const GM_DRUM_BY_DISPLAY_POSITION: Readonly<Record<string, number>> = {
  F4: 36,
  G4: 43,
  A4: 45,
  B4: 37,
  C5: 38,
  D5: 48,
  E5: 50,
  F5: 44,
  G5: 42,
  A5: 46,
  B5: 54,
  C6: 49,
  D6: 51,
};

/**
 * MIDI note number for an `<unpitched>` display position, or null when the
 * position is malformed. Valid but unmapped positions fall back to snare:
 * staff placement is a notation convention, not a chromatic MIDI pitch.
 */
function unpitchedToMidi(unpitched: XmlElement, maxNumericAbs: number): number | null {
  const step = childText(unpitched, 'display-step');
  const octave = childInt(unpitched, 'display-octave', maxNumericAbs);
  if (step === null || octave === null) return null;
  const normalizedStep = step.toUpperCase();
  if (STEP_SEMITONES[normalizedStep] === undefined) return null;
  return GM_DRUM_BY_DISPLAY_POSITION[`${normalizedStep}${octave}`] ?? 38;
}

/** Reads the `<part-list>` into per-part names and instrument mappings. */
function readPartList(root: XmlElement, maxNumericAbs: number): Map<string, PartInfo> {
  const parts = new Map<string, PartInfo>();
  const partList = childElements(root, 'part-list')[0];
  if (partList === undefined) return parts;
  for (const [index, scorePart] of childElements(partList, 'score-part').entries()) {
    // Some exporters omit the optional score-part id. Match the same ordinal
    // fallback used for a <part> without id so its name/instrument metadata is
    // still applied instead of being stored under an unreachable undefined key.
    const id = scorePart.attributes.id || `P${index + 1}`;
    const instruments = new Map<string, InstrumentMapping>();
    for (const midiInstrument of childElements(scorePart, 'midi-instrument')) {
      const instrumentId = midiInstrument.attributes.id;
      if (instrumentId === undefined || instrumentId === '') continue;
      const midiChannel = childInt(midiInstrument, 'midi-channel', maxNumericAbs);
      const midiUnpitched = childInt(midiInstrument, 'midi-unpitched', maxNumericAbs);
      const midiProgram = childInt(midiInstrument, 'midi-program', maxNumericAbs);
      const volume = childNumber(midiInstrument, 'volume', maxNumericAbs);
      const pan = childNumber(midiInstrument, 'pan', maxNumericAbs);
      instruments.set(instrumentId, {
        ...(midiChannel !== null ? { channel: midiChannel - 1 } : {}),
        ...(midiUnpitched !== null ? { unpitched: midiUnpitched - 1 } : {}),
        ...(midiProgram !== null ? { program: clampInt(midiProgram - 1, 0, 127) } : {}),
        ...(volume !== null ? { volume: Math.min(1, Math.max(0, volume / 100)) } : {}),
        ...(pan !== null ? { pan: Math.min(1, Math.max(-1, pan / 90)) } : {}),
      });
    }
    parts.set(id, {
      name: childText(scorePart, 'part-name') ?? id,
      instruments,
    });
  }
  return parts;
}

/** Quarter-note BPM from a `<metronome>` element, or null when incomputable. */
function tempoFromMetronome(metronome: XmlElement): number | null {
  const perMinute = childText(metronome, 'per-minute');
  const beatUnit = childText(metronome, 'beat-unit');
  if (perMinute === null || beatUnit === null) return null;
  const perMinuteValue = Number.parseFloat(perMinute);
  const unitQuarters = BEAT_UNIT_QUARTERS[beatUnit];
  if (!Number.isFinite(perMinuteValue) || unitQuarters === undefined) return null;
  const dots = childElements(metronome, 'beat-unit-dot').length;
  const dotFactor = 2 - 2 ** -dots;
  return perMinuteValue * unitQuarters * dotFactor;
}

/** Quarter-note BPM from a measure-level `<sound>` or `<direction>`, or null. */
function tempoFromDirection(element: XmlElement): number | null {
  const sound = element.tagName === 'sound' ? element : (descendants(element, 'sound')[0] ?? null);
  const soundTempo = sound?.attributes.tempo;
  if (soundTempo !== null && soundTempo !== undefined) {
    const value = Number.parseFloat(soundTempo);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const metronome = descendants(element, 'metronome')[0];
  if (metronome !== undefined) return tempoFromMetronome(metronome);
  return null;
}

function dynamicsPercentToVelocity(
  value: string | undefined,
  maxNumericAbs: number,
): number | null {
  if (value === undefined || value.trim() === '') return null;
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || Math.abs(percent) > maxNumericAbs) {
    // Dynamics is an optional playback hint. A malformed attribute must not
    // reject an otherwise importable score; retain the current/default velocity.
    return null;
  }
  return clampInt((percent * 90) / 100, 1, 127);
}

function noteVelocity(value: string | undefined, current: number, maxNumericAbs: number): number {
  return dynamicsPercentToVelocity(value, maxNumericAbs) ?? current;
}

function dynamicsFromDirection(element: XmlElement, maxNumericAbs: number): number | null {
  const sound =
    element.tagName === 'sound' ? element : (descendants(element, 'sound')[0] ?? undefined);
  return dynamicsPercentToVelocity(sound?.attributes.dynamics, maxNumericAbs);
}

/**
 * How the importer treats each element it can meet inside a measure:
 * `realized` feeds the document, `presentation` is engraving-only, a loss kind
 * is counted. An element missing from its table is counted as other notation,
 * so the report never omits a class the importer ignores.
 */
type ElementDisposition = 'realized' | 'presentation' | 'walk' | MusicXmlImportLossKind;

const MEASURE_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  attributes: 'realized',
  note: 'walk',
  backup: 'realized',
  forward: 'realized',
  direction: 'walk',
  sound: 'walk',
  harmony: 'harmony',
  'figured-bass': 'figured-bass',
  barline: 'walk',
  print: 'presentation',
  grouping: 'presentation',
  link: 'presentation',
  bookmark: 'presentation',
  listening: 'presentation',
};

const BARLINE_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  'bar-style': 'presentation',
  repeat: 'repeats',
  ending: 'repeats',
  segno: 'jumps',
  coda: 'jumps',
  fermata: 'fermatas',
  'wavy-line': 'annotations',
  footnote: 'presentation',
  level: 'presentation',
};

const DIRECTION_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  'direction-type': 'walk',
  offset: 'realized',
  sound: 'walk',
  staff: 'presentation',
  voice: 'presentation',
  footnote: 'presentation',
  level: 'presentation',
  listening: 'presentation',
};

const DIRECTION_TYPE_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  metronome: 'realized',
  // Realized only through a sound dynamics attribute; checked by the walker.
  dynamics: 'dynamics',
  segno: 'jumps',
  coda: 'jumps',
  words: 'presentation',
  rehearsal: 'presentation',
  symbol: 'presentation',
  dashes: 'presentation',
  bracket: 'presentation',
  image: 'presentation',
  'staff-divide': 'presentation',
  wedge: 'annotations',
  pedal: 'annotations',
  'octave-shift': 'annotations',
  'harp-pedals': 'annotations',
  damp: 'annotations',
  'damp-all': 'annotations',
  eyeglasses: 'annotations',
  'string-mute': 'annotations',
  scordatura: 'annotations',
  'principal-voice': 'annotations',
  percussion: 'annotations',
  'accordion-registration': 'annotations',
  'other-direction': 'annotations',
};

const NOTE_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  grace: 'grace-notes',
  cue: 'realized',
  chord: 'realized',
  pitch: 'realized',
  unpitched: 'realized',
  rest: 'realized',
  duration: 'realized',
  tie: 'realized',
  instrument: 'realized',
  voice: 'realized',
  staff: 'realized',
  type: 'presentation',
  dot: 'presentation',
  accidental: 'presentation',
  'time-modification': 'presentation',
  stem: 'presentation',
  notehead: 'presentation',
  'notehead-text': 'presentation',
  beam: 'presentation',
  footnote: 'presentation',
  level: 'presentation',
  play: 'presentation',
  listen: 'presentation',
  notations: 'walk',
  lyric: 'lyrics',
};

const NOTATIONS_ELEMENTS: Readonly<Record<string, ElementDisposition>> = {
  tied: 'presentation',
  tuplet: 'presentation',
  'accidental-mark': 'presentation',
  footnote: 'presentation',
  level: 'presentation',
  technical: 'walk',
  dynamics: 'dynamics',
  fermata: 'fermatas',
  arpeggiate: 'arpeggios',
  'non-arpeggiate': 'arpeggios',
  slur: 'annotations',
  glissando: 'annotations',
  slide: 'annotations',
  ornaments: 'annotations',
  articulations: 'annotations',
  'other-notation': 'annotations',
};

/** `<sound>` attributes that restructure playback order, which import never applies. */
const SOUND_JUMP_ATTRIBUTES = ['dacapo', 'dalsegno', 'segno', 'coda', 'tocoda', 'fine'] as const;

/** Records what the importer does not realize while it walks a part. */
class ImportLossWalker {
  private readonly otherTags = new Set<string>();

  constructor(readonly loss: LossTally<MusicXmlImportLossKind>) {}

  private count(element: XmlElement, table: Readonly<Record<string, ElementDisposition>>): void {
    const disposition = table[element.tagName];
    if (disposition === 'realized' || disposition === 'presentation' || disposition === 'walk') {
      return;
    }
    if (disposition !== undefined) {
      this.loss.add(disposition);
      return;
    }
    const detail = this.otherTags.has(element.tagName) ? undefined : element.tagName;
    this.otherTags.add(element.tagName);
    this.loss.add('other-notation', 1, detail);
  }

  measureChild(element: XmlElement): void {
    this.count(element, MEASURE_ELEMENTS);
    if (element.tagName === 'barline') {
      for (const child of element.children) this.count(child, BARLINE_ELEMENTS);
    } else if (element.tagName === 'sound') {
      this.sound(element);
    }
  }

  direction(direction: XmlElement, dynamicsRealized: boolean): void {
    for (const child of direction.children) {
      this.count(child, DIRECTION_ELEMENTS);
      if (child.tagName === 'sound') this.sound(child);
      if (child.tagName !== 'direction-type') continue;
      for (const type of child.children) {
        if (type.tagName === 'dynamics' && dynamicsRealized) continue;
        this.count(type, DIRECTION_TYPE_ELEMENTS);
      }
    }
  }

  note(note: XmlElement): void {
    for (const child of note.children) {
      this.count(child, NOTE_ELEMENTS);
      if (child.tagName !== 'notations') continue;
      for (const notation of child.children) {
        this.count(notation, NOTATIONS_ELEMENTS);
        if (notation.tagName !== 'technical') continue;
        for (const technical of notation.children) {
          this.loss.add(technical.tagName === 'fingering' ? 'fingering' : 'annotations');
        }
      }
    }
  }

  private sound(sound: XmlElement): void {
    if (SOUND_JUMP_ATTRIBUTES.some((name) => sound.attributes[name] !== undefined)) {
      this.loss.add('jumps');
    }
  }
}

/** Extra `<midi-instrument>` programs a part declares beyond the one its track plays. */
function extraInstrumentCount(part: PartInfo): number {
  const [primary, ...rest] = [...part.instruments.values()];
  return rest.filter((entry) => entry.program !== undefined && entry.program !== primary?.program)
    .length;
}

/** Global tempo / time-signature / key-signature events shared by all parts. */
interface GlobalMaps {
  tempos: Map<number, number>;
  timeSignatures: Array<{ ppq: number; numerator: number; denominator: number }>;
  keys: DocumentMarker[];
  pickupLengthPpq?: number;
}

/** Mutable per-part cursor state while walking measures. */
interface PartState {
  divisions: number;
  measureStartPpq: number;
  timeSigLengthPpq: number;
  chromaticTranspose: number;
  velocity: number;
}

/**
 * Extends a tied note or records a fresh one, keyed by voice/staff/pitch so
 * a `<tie type="stop">` continuation lengthens its predecessor instead of
 * emitting a second note.
 */
class TieTracker {
  private readonly pending = new Map<string, DocumentNote>();

  static key(voice: number, staff: number, pitch: number): string {
    return `${voice}:${staff}:${pitch}`;
  }

  take(key: string): DocumentNote | undefined {
    const note = this.pending.get(key);
    this.pending.delete(key);
    return note;
  }

  hold(key: string, note: DocumentNote): void {
    this.pending.set(key, note);
  }
}

/** Reads MusicXML additive meter pairs (for example `3+2/8` or `3/8 + 2/8`). */
function additiveTimeSignature(
  time: XmlElement,
  maxNumericAbs: number,
): { numerator: number; denominator: number } | null {
  const beats = childElements(time, 'beats');
  const beatTypes = childElements(time, 'beat-type');
  if (beats.length === 0 || beats.length !== beatTypes.length) return null;
  const denominators = beatTypes.map((element) => {
    const raw = elementText(element).trim();
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value <= maxNumericAbs ? value : null;
  });
  const denominator = denominators[0];
  if (
    denominator === null ||
    denominator <= 0 ||
    denominators.some((value) => value !== denominator)
  )
    return null;
  let numerator = 0;
  for (const element of beats) {
    const raw = elementText(element).trim();
    const terms = raw.split('+');
    if (terms.length === 0) return null;
    for (const term of terms) {
      if (!/^\d+$/.test(term)) return null;
      const value = Number(term);
      if (!Number.isSafeInteger(value) || value <= 0 || value > maxNumericAbs) return null;
      numerator += value;
      if (numerator > maxNumericAbs) return null;
    }
  }
  return { numerator, denominator };
}

/** Reads `<attributes>` into the part cursor and the shared global maps. */
function applyAttributes(
  attributes: XmlElement,
  state: PartState,
  global: GlobalMaps,
  captureGlobal: boolean,
  maxNumericAbs: number,
): void {
  const divisions = childInt(attributes, 'divisions', maxNumericAbs);
  if (divisions !== null && divisions > 0) state.divisions = divisions;
  const time = childElements(attributes, 'time')[0];
  if (time !== undefined) {
    const signature = additiveTimeSignature(time, maxNumericAbs);
    if (signature !== null) {
      state.timeSigLengthPpq = signature.numerator * (4 / signature.denominator);
      if (captureGlobal) {
        global.timeSignatures.push({ ppq: state.measureStartPpq, ...signature });
      }
    }
  }
  if (captureGlobal) {
    const key = childElements(attributes, 'key')[0];
    if (key !== undefined) {
      const fifths = childInt(key, 'fifths', maxNumericAbs);
      if (fifths !== null) {
        const minor = childText(key, 'mode')?.toLowerCase() === 'minor';
        global.keys.push({ ppq: state.measureStartPpq, name: keyMarkerName(fifths, minor) });
      }
    }
  }
  const transpose = childElements(attributes, 'transpose')[0];
  if (transpose !== undefined) {
    const chromatic = childInt(transpose, 'chromatic', maxNumericAbs) ?? 0;
    const octaveChange = childInt(transpose, 'octave-change', maxNumericAbs) ?? 0;
    state.chromaticTranspose = clampInt(chromatic + octaveChange * 12, -127, 127);
  }
}

/**
 * Walks one `<note>`, emitting a {@link DocumentNote} when it sounds and
 * returning the PPQ length by which the voice cursor advances.
 */
function importNote(
  noteEl: XmlElement,
  onsetPpq: number,
  isChord: boolean,
  state: PartState,
  part: PartInfo,
  ties: TieTracker,
  notes: DocumentNote[],
  maxNumericAbs: number,
): number {
  // Grace notes carry no duration and never advance the cursor.
  if (childElements(noteEl, 'grace').length > 0) return 0;
  const durationDivisions = childInt(noteEl, 'duration', maxNumericAbs) ?? 0;
  const durationPpq = durationDivisions / state.divisions;
  const advance = isChord ? 0 : durationPpq;
  // Cue notes are engraved for orientation and advance the voice, but never sound.
  if (childElements(noteEl, 'rest').length > 0 || childElements(noteEl, 'cue').length > 0) {
    return advance;
  }

  const voice = childInt(noteEl, 'voice', maxNumericAbs) ?? 1;
  const staff = childInt(noteEl, 'staff', maxNumericAbs) ?? 1;
  let pitch: number | null = null;
  let channel = 0;
  const pitchEl = childElements(noteEl, 'pitch')[0];
  if (pitchEl !== undefined) {
    pitch = pitchToMidi(pitchEl, maxNumericAbs);
  } else {
    const unpitchedEl = childElements(noteEl, 'unpitched')[0];
    if (unpitchedEl !== undefined) {
      channel = GM_PERCUSSION_CHANNEL;
      const instrumentId = childElements(noteEl, 'instrument')[0]?.attributes.id;
      const mapped = instrumentId !== undefined ? part.instruments.get(instrumentId) : undefined;
      pitch = mapped?.unpitched ?? unpitchedToMidi(unpitchedEl, maxNumericAbs);
      if (mapped?.channel !== undefined) channel = mapped.channel;
    }
  }
  const instrumentId = childElements(noteEl, 'instrument')[0]?.attributes.id;
  const instrument = instrumentId === undefined ? undefined : part.instruments.get(instrumentId);
  if (pitchEl !== undefined && pitch !== null) pitch += state.chromaticTranspose;
  if (instrument?.channel !== undefined) channel = clampInt(instrument.channel, 0, 15);
  if (pitch === null || durationPpq <= 0) return advance;

  const tieTypes = childElements(noteEl, 'tie').map((tie) => tie.attributes.type);
  const tieStop = tieTypes.includes('stop');
  const tieStart = tieTypes.includes('start');
  const key = TieTracker.key(voice, staff, clampInt(pitch, 0, 127));

  if (tieStop) {
    const held = ties.take(key);
    if (held !== undefined) {
      held.durationPpq = onsetPpq + durationPpq - held.startPpq;
      if (tieStart) ties.hold(key, held);
      return advance;
    }
  }
  const note: DocumentNote = {
    pitch: clampInt(pitch, 0, 127),
    velocity: noteVelocity(noteEl.attributes.dynamics, state.velocity, maxNumericAbs),
    startPpq: onsetPpq,
    durationPpq,
    channel,
  };
  notes.push(note);
  if (tieStart) ties.hold(key, note);
  return advance;
}

/** Imports every `<measure>` of one `<part>` into a flat note list. */
function importPartNotes(
  partEl: XmlElement,
  part: PartInfo,
  global: GlobalMaps,
  captureGlobal: boolean,
  canonicalTempos: ReadonlyArray<DocumentTempoSegment> | null,
  tempoConflicts: Set<string>,
  partId: string,
  maxNumericAbs: number,
  lossWalker: ImportLossWalker,
): { notes: DocumentNote[]; endPpq: number } {
  const notes: DocumentNote[] = [];
  const ties = new TieTracker();
  const state: PartState = {
    divisions: FALLBACK_DIVISIONS,
    measureStartPpq: 0,
    timeSigLengthPpq: 4,
    chromaticTranspose: 0,
    velocity: DEFAULT_NOTE_VELOCITY,
  };
  for (const [measureIndex, measure] of childElements(partEl, 'measure').entries()) {
    let cursorPpq = state.measureStartPpq;
    let measureMaxPpq = state.measureStartPpq;
    let chordHeadPpq = state.measureStartPpq;
    for (const element of childElements(measure)) {
      lossWalker.measureChild(element);
      switch (element.tagName) {
        case 'attributes':
          applyAttributes(element, state, global, captureGlobal, maxNumericAbs);
          break;
        case 'note': {
          lossWalker.note(element);
          const isChord = childElements(element, 'chord').length > 0;
          const onset = isChord ? chordHeadPpq : cursorPpq;
          const advance = importNote(
            element,
            onset,
            isChord,
            state,
            part,
            ties,
            notes,
            maxNumericAbs,
          );
          if (!isChord) chordHeadPpq = cursorPpq;
          cursorPpq += advance;
          if (cursorPpq > measureMaxPpq) measureMaxPpq = cursorPpq;
          break;
        }
        case 'backup': {
          const duration = childInt(element, 'duration', maxNumericAbs) ?? 0;
          cursorPpq = Math.max(state.measureStartPpq, cursorPpq - duration / state.divisions);
          break;
        }
        case 'forward': {
          const duration = childInt(element, 'duration', maxNumericAbs) ?? 0;
          cursorPpq += duration / state.divisions;
          if (cursorPpq > measureMaxPpq) measureMaxPpq = cursorPpq;
          break;
        }
        case 'direction':
        case 'sound': {
          const bpm = tempoFromDirection(element);
          if (bpm !== null && bpm > 0) {
            const offset = childInt(element, 'offset', maxNumericAbs) ?? 0;
            const ppq = Math.max(0, cursorPpq + offset / state.divisions);
            if (captureGlobal) {
              global.tempos.set(ppq, bpm);
            } else if (
              canonicalTempos !== null &&
              Math.abs(tempoAtPpq(canonicalTempos, ppq) - bpm) > Number.EPSILON
            ) {
              tempoConflicts.add(`${partId}:${ppq}:${bpm}`);
            }
          }
          const dynamics = dynamicsFromDirection(element, maxNumericAbs);
          if (dynamics !== null) state.velocity = dynamics;
          if (element.tagName === 'direction') lossWalker.direction(element, dynamics !== null);
          break;
        }
      }
    }
    const measureLength = measureMaxPpq - state.measureStartPpq;
    // A pickup/partial measure (implicit, or explicitly numbered 0) genuinely
    // occupies less than a full bar, so it advances by its own content length.
    const isPartialMeasure =
      measure.attributes.implicit === 'yes' || measure.attributes.number === '0';
    if (
      captureGlobal &&
      measureIndex === 0 &&
      measureLength > 0 &&
      measureLength < state.timeSigLengthPpq - PPQ_INTEGER_EPSILON &&
      isPartialMeasure
    ) {
      global.pickupLengthPpq = measureLength;
    }
    // A normal measure always advances one full bar even when it underfills
    // (e.g. trailing rests were omitted), so later barlines and the time-
    // signature / key markers anchored to measure starts stay aligned. Only a
    // genuine partial measure advances by its shorter content; overfilled
    // measures still advance by their content.
    state.measureStartPpq +=
      isPartialMeasure && measureLength > 0
        ? measureLength
        : Math.max(measureLength, state.timeSigLengthPpq);
  }
  return { notes, endPpq: state.measureStartPpq };
}

/** Rounds a raw clip end up to an integral PPQ length, floored at the minimum. */
function clipLengthPpq(maxEndPpq: number): number {
  const rounded = Math.round(maxEndPpq);
  if (Math.abs(maxEndPpq - rounded) < PPQ_INTEGER_EPSILON) {
    return Math.max(MIN_CLIP_LENGTH_PPQ, rounded);
  }
  return Math.max(MIN_CLIP_LENGTH_PPQ, Math.ceil(maxEndPpq));
}

/** Builds a single MIDI clip covering a part's imported notes. */
function clipFromNotes(name: string, notes: DocumentNote[], scoreEndPpq: number): DocumentClip {
  const maxEnd = notes.reduce(
    (end, note) => Math.max(end, note.startPpq + note.durationPpq),
    scoreEndPpq,
  );
  return {
    name,
    startPpq: 0,
    lengthPpq: clipLengthPpq(maxEnd),
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    kind: 'midi',
    notes: notes.slice().sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch),
  };
}

/** Collapses raw global tempo events into an ordered, deduplicated map. */
function tempoSegments(tempos: Map<number, number>): DocumentTempoSegment[] {
  const sorted = [...tempos.entries()]
    .map(([ppq, bpm]) => ({ startPpq: Math.max(0, ppq), bpm }))
    .sort((a, b) => a.startPpq - b.startPpq);
  const segments: DocumentTempoSegment[] = [];
  for (const segment of sorted) {
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.bpm === segment.bpm) continue;
    segments.push(segment);
  }
  if (segments.length === 0 || segments[0].startPpq > 0) {
    segments.unshift({ startPpq: 0, bpm: segments[0]?.bpm ?? DEFAULT_TEMPO_BPM });
  }
  return segments;
}

/** Effective canonical tempo at a PPQ position (segments are ordered). */
function tempoAtPpq(segments: ReadonlyArray<DocumentTempoSegment>, ppq: number): number {
  let low = 0;
  let high = segments.length - 1;
  let match = segments[0]?.bpm ?? DEFAULT_TEMPO_BPM;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const segment = segments[middle];
    if (segment.startPpq <= ppq) {
      match = segment.bpm;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}

/** Collapses raw global time-signature events into an ordered list. */
function timeSignatureSegments(entries: GlobalMaps['timeSignatures']): DocumentTimeSignature[] {
  const sorted = entries
    .map((entry) => ({
      startPpq: Math.max(0, entry.ppq),
      numerator: entry.numerator,
      denominator: entry.denominator,
    }))
    .sort((a, b) => a.startPpq - b.startPpq);
  const segments: DocumentTimeSignature[] = [];
  for (const segment of sorted) {
    const previous = segments[segments.length - 1];
    if (
      previous !== undefined &&
      previous.numerator === segment.numerator &&
      previous.denominator === segment.denominator
    ) {
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/** Derives the project name from the score header or the source file name. */
function projectName(root: XmlElement, fileName?: string): string {
  const work = childElements(root, 'work')[0];
  const title = work !== undefined ? childText(work, 'work-title') : null;
  if (title !== null) return title;
  const movement = childText(root, 'movement-title');
  if (movement !== null) return movement;
  if (fileName !== undefined) {
    const base = fileName.replace(/\.[^./\\]+$/, '');
    const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
    const trimmed = (slash >= 0 ? base.slice(slash + 1) : base).trim();
    if (trimmed !== '') return trimmed;
  }
  return 'Imported MusicXML';
}

/**
 * Imports a MusicXML `score-partwise` document into a {@link ProjectDocument}.
 *
 * @param xml MusicXML source text.
 * @param fileName Optional source file name used for the project title.
 * @returns A project document with one MIDI track per part.
 * @throws MusicXmlImportError When the input is not well-formed or supported.
 */
export function importMusicXmlWithReport(
  xml: string,
  fileName?: string,
  limits: Partial<MusicXmlImportLimits> = {},
): MusicXmlImportResult {
  const resolved = resolveImportLimits(limits);
  const root = parseScoreRoot(xml, resolved);
  const partInfos = readPartList(root, resolved.maxNumericAbs);
  const global: GlobalMaps = { tempos: new Map(), timeSignatures: [], keys: [] };
  const tracks: ProjectDocument['tracks'] = [];
  const partElements = childElements(root, 'part');
  const tempoConflicts = new Set<string>();
  const loss = new LossTally(MUSICXML_IMPORT_LOSS_KINDS);
  const lossWalker = new ImportLossWalker(loss);
  let canonicalTempos: DocumentTempoSegment[] | null = null;
  partElements.forEach((partEl, index) => {
    const id = partEl.attributes.id ?? `P${index + 1}`;
    const info = partInfos.get(id) ?? { name: id, instruments: new Map() };
    const imported = importPartNotes(
      partEl,
      info,
      global,
      index === 0,
      canonicalTempos,
      tempoConflicts,
      id,
      resolved.maxNumericAbs,
      lossWalker,
    );
    if (index === 0) canonicalTempos = tempoSegments(global.tempos);
    const name = info.name || `Part ${index + 1}`;
    loss.add('extra-instruments', extraInstrumentCount(info), name);
    const primaryInstrument = info.instruments.values().next().value as
      | InstrumentMapping
      | undefined;
    const instrument =
      primaryInstrument?.program === undefined
        ? undefined
        : {
            kind: 'synth-preset' as const,
            preset: presetForGmProgram(primaryInstrument.program, primaryInstrument.channel ?? 0),
            useGmPrograms: true as const,
            gmProgram: primaryInstrument.program,
          };
    tracks.push({
      name,
      musicXmlPartId: id,
      color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
      kind: 'midi',
      mute: false,
      solo: false,
      volume: primaryInstrument?.volume ?? 1,
      pan: primaryInstrument?.pan ?? 0,
      ...(instrument !== undefined ? { instrument } : {}),
      clips: [clipFromNotes(name, imported.notes, imported.endPpq)],
    });
  });

  const markers = global.keys.slice().sort((a, b) => a.ppq - b.ppq || a.name.localeCompare(b.name));

  const document: ProjectDocument = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: projectName(root, fileName),
    sampleRate: DEFAULT_SAMPLE_RATE,
    tempoSegments: tempoSegments(global.tempos),
    timeSignatures: timeSignatureSegments(global.timeSignatures),
    tracks,
    markers,
    sections: [],
    ...(global.pickupLengthPpq !== undefined ? { pickupLengthPpq: global.pickupLengthPpq } : {}),
  };
  loss.add('tempo-conflicts', tempoConflicts.size);
  return { document, report: loss.report() };
}

/** Compatibility API for callers that do not need the structured loss report. */
export function importMusicXml(xml: string, fileName?: string): ProjectDocument {
  return importMusicXmlWithReport(xml, fileName).document;
}
