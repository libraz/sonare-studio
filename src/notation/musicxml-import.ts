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

import {
  type DocumentClip,
  type DocumentMarker,
  type DocumentNote,
  type DocumentTempoSegment,
  type DocumentTimeSignature,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from '@/project/serialization';
import { TRACK_COLOR_PALETTE } from '@/project/types';

/** Sample rate assigned to imported projects (matches the SMF importer). */
const DEFAULT_SAMPLE_RATE = 48000;

/** Fallback tempo in BPM when the document carries no tempo direction. */
const DEFAULT_BPM = 120;

/** Default note-on velocity when a note carries no dynamics hint. */
const DEFAULT_VELOCITY = 96;

/**
 * Divisions per quarter note assumed when a part omits `<divisions>` entirely.
 * MusicXML normally declares it in the first measure's `<attributes>`; the
 * fallback only guards malformed input so durations still map to a sane PPQ.
 */
const FALLBACK_DIVISIONS = 480;

/** General MIDI percussion channel (0-based; MIDI channel 10). */
const GM_PERCUSSION_CHANNEL = 9;

/** Minimum clip length in PPQ. */
const MIN_CLIP_LENGTH_PPQ = 1;

/** Rounding tolerance for treating a PPQ length as integral. */
const PPQ_INTEGER_EPSILON = 1 / 256;

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
const BEAT_UNIT_QUARTERS: Readonly<Record<string, number>> = {
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
};

/** Major-key tonic per `<fifths>` value, index `fifths + 7`. */
const MAJOR_TONICS: readonly string[] = [
  'Cb',
  'Gb',
  'Db',
  'Ab',
  'Eb',
  'Bb',
  'F',
  'C',
  'G',
  'D',
  'A',
  'E',
  'B',
  'F#',
  'C#',
];

/** Minor-key tonic per `<fifths>` value, index `fifths + 7`. */
const MINOR_TONICS: readonly string[] = [
  'Ab',
  'Eb',
  'Bb',
  'F',
  'C',
  'G',
  'D',
  'A',
  'E',
  'B',
  'F#',
  'C#',
  'G#',
  'D#',
  'A#',
];

/** Raised when a MusicXML document cannot be parsed or is not a supported score. */
export class MusicXmlImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MusicXmlImportError';
  }
}

/** Percussion instrument mapping declared in the `<part-list>`. */
interface InstrumentMapping {
  /** 0-based MIDI channel, when declared. */
  channel?: number;
  /** 0-based MIDI pitch for an unpitched note, when declared. */
  unpitched?: number;
}

/** Parsed `<score-part>` metadata used while importing its `<part>`. */
interface PartInfo {
  name: string;
  instruments: Map<string, InstrumentMapping>;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Returns direct child elements of `parent`, optionally filtered by tag name. */
function childElements(parent: Element, tag?: string): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (tag === undefined || child.tagName === tag) out.push(child);
  }
  return out;
}

/** Returns the trimmed text of the first `tag` child, or null when absent. */
function childText(parent: Element, tag: string): string | null {
  const child = childElements(parent, tag)[0];
  const text = child?.textContent?.trim();
  return text === undefined || text === '' ? null : text;
}

/** Parses the first `tag` child as an integer, or null when absent/invalid. */
function childInt(parent: Element, tag: string): number | null {
  const text = childText(parent, tag);
  if (text === null) return null;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses a MusicXML string into a DOM document.
 *
 * @param xml MusicXML source text.
 * @returns The root `score-partwise` element.
 * @throws MusicXmlImportError When the input is not well-formed XML or is not
 *   a `score-partwise` document.
 */
function parseScoreRoot(xml: string): Element {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    throw new MusicXmlImportError('MusicXML could not be parsed as XML');
  }
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new MusicXmlImportError('MusicXML is not well-formed XML');
  }
  const root = doc.documentElement;
  if (root === null || root.tagName === 'parsererror') {
    throw new MusicXmlImportError('MusicXML is not well-formed XML');
  }
  if (root.tagName === 'score-timewise') {
    throw new MusicXmlImportError('score-timewise MusicXML is not supported; convert to partwise');
  }
  if (root.tagName !== 'score-partwise') {
    throw new MusicXmlImportError(`Unexpected MusicXML root element <${root.tagName}>`);
  }
  return root;
}

/** MIDI note number for a `<pitch>` element, or null when it is incomplete. */
function pitchToMidi(pitch: Element): number | null {
  const step = childText(pitch, 'step');
  const octave = childInt(pitch, 'octave');
  if (step === null || octave === null) return null;
  const semitone = STEP_SEMITONES[step.toUpperCase()];
  if (semitone === undefined) return null;
  const alter = childInt(pitch, 'alter') ?? 0;
  return (octave + 1) * 12 + semitone + alter;
}

/** MIDI note number for an `<unpitched>` display position, or null. */
function unpitchedToMidi(unpitched: Element): number | null {
  const step = childText(unpitched, 'display-step');
  const octave = childInt(unpitched, 'display-octave');
  if (step === null || octave === null) return null;
  const semitone = STEP_SEMITONES[step.toUpperCase()];
  if (semitone === undefined) return null;
  return (octave + 1) * 12 + semitone;
}

/** Reads the `<part-list>` into per-part names and instrument mappings. */
function readPartList(root: Element): Map<string, PartInfo> {
  const parts = new Map<string, PartInfo>();
  const partList = childElements(root, 'part-list')[0];
  if (partList === undefined) return parts;
  for (const scorePart of childElements(partList, 'score-part')) {
    const id = scorePart.getAttribute('id');
    if (id === null) continue;
    const instruments = new Map<string, InstrumentMapping>();
    for (const midiInstrument of childElements(scorePart, 'midi-instrument')) {
      const instrumentId = midiInstrument.getAttribute('id');
      if (instrumentId === null) continue;
      const midiChannel = childInt(midiInstrument, 'midi-channel');
      const midiUnpitched = childInt(midiInstrument, 'midi-unpitched');
      instruments.set(instrumentId, {
        ...(midiChannel !== null ? { channel: midiChannel - 1 } : {}),
        ...(midiUnpitched !== null ? { unpitched: midiUnpitched - 1 } : {}),
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
function tempoFromMetronome(metronome: Element): number | null {
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
function tempoFromDirection(element: Element): number | null {
  const sound =
    element.tagName === 'sound' ? element : (element.getElementsByTagName('sound')[0] ?? null);
  const soundTempo = sound?.getAttribute('tempo');
  if (soundTempo !== null && soundTempo !== undefined) {
    const value = Number.parseFloat(soundTempo);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const metronome = element.getElementsByTagName('metronome')[0];
  if (metronome !== undefined) return tempoFromMetronome(metronome);
  return null;
}

/** Key-signature marker name (e.g. "Key: C major") for the SMF marker model. */
function keyMarkerName(fifths: number, minor: boolean): string {
  const table = minor ? MINOR_TONICS : MAJOR_TONICS;
  const tonic = table[fifths + 7] ?? 'C';
  return `Key: ${tonic} ${minor ? 'minor' : 'major'}`;
}

/** Global tempo / time-signature / key-signature events shared by all parts. */
interface GlobalMaps {
  tempos: Map<number, number>;
  timeSignatures: Array<{ ppq: number; numerator: number; denominator: number }>;
  keys: DocumentMarker[];
}

/** Mutable per-part cursor state while walking measures. */
interface PartState {
  divisions: number;
  measureStartPpq: number;
  timeSigLengthPpq: number;
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

/** Reads `<attributes>` into the part cursor and the shared global maps. */
function applyAttributes(
  attributes: Element,
  state: PartState,
  global: GlobalMaps,
  captureGlobal: boolean,
): void {
  const divisions = childInt(attributes, 'divisions');
  if (divisions !== null && divisions > 0) state.divisions = divisions;
  const time = childElements(attributes, 'time')[0];
  if (time !== undefined) {
    const numerator = childInt(time, 'beats');
    const denominator = childInt(time, 'beat-type');
    if (numerator !== null && denominator !== null && numerator > 0 && denominator > 0) {
      state.timeSigLengthPpq = numerator * (4 / denominator);
      if (captureGlobal) {
        global.timeSignatures.push({ ppq: state.measureStartPpq, numerator, denominator });
      }
    }
  }
  if (captureGlobal) {
    const key = childElements(attributes, 'key')[0];
    if (key !== undefined) {
      const fifths = childInt(key, 'fifths');
      if (fifths !== null) {
        const minor = childText(key, 'mode')?.toLowerCase() === 'minor';
        global.keys.push({ ppq: state.measureStartPpq, name: keyMarkerName(fifths, minor) });
      }
    }
  }
}

/**
 * Walks one `<note>`, emitting a {@link DocumentNote} when it sounds and
 * returning the PPQ length by which the voice cursor advances.
 */
function importNote(
  noteEl: Element,
  onsetPpq: number,
  isChord: boolean,
  state: PartState,
  part: PartInfo,
  ties: TieTracker,
  notes: DocumentNote[],
): number {
  // Grace notes carry no duration and never advance the cursor.
  if (childElements(noteEl, 'grace').length > 0) return 0;
  const durationDivisions = childInt(noteEl, 'duration') ?? 0;
  const durationPpq = durationDivisions / state.divisions;
  const advance = isChord ? 0 : durationPpq;
  if (childElements(noteEl, 'rest').length > 0) return advance;

  const voice = childInt(noteEl, 'voice') ?? 1;
  const staff = childInt(noteEl, 'staff') ?? 1;
  let pitch: number | null = null;
  let channel = 0;
  const pitchEl = childElements(noteEl, 'pitch')[0];
  if (pitchEl !== undefined) {
    pitch = pitchToMidi(pitchEl);
  } else {
    const unpitchedEl = childElements(noteEl, 'unpitched')[0];
    if (unpitchedEl !== undefined) {
      channel = GM_PERCUSSION_CHANNEL;
      const instrumentId = childElements(noteEl, 'instrument')[0]?.getAttribute('id') ?? undefined;
      const mapped = instrumentId !== undefined ? part.instruments.get(instrumentId) : undefined;
      pitch = mapped?.unpitched ?? unpitchedToMidi(unpitchedEl);
      if (mapped?.channel !== undefined) channel = mapped.channel;
    }
  }
  if (pitch === null || durationPpq <= 0) return advance;

  const tieTypes = childElements(noteEl, 'tie').map((tie) => tie.getAttribute('type'));
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
    velocity: DEFAULT_VELOCITY,
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
  partEl: Element,
  part: PartInfo,
  global: GlobalMaps,
  captureGlobal: boolean,
): DocumentNote[] {
  const notes: DocumentNote[] = [];
  const ties = new TieTracker();
  const state: PartState = {
    divisions: FALLBACK_DIVISIONS,
    measureStartPpq: 0,
    timeSigLengthPpq: 4,
  };
  for (const measure of childElements(partEl, 'measure')) {
    let cursorPpq = state.measureStartPpq;
    let measureMaxPpq = state.measureStartPpq;
    let chordHeadPpq = state.measureStartPpq;
    for (const element of childElements(measure)) {
      switch (element.tagName) {
        case 'attributes':
          applyAttributes(element, state, global, captureGlobal);
          break;
        case 'note': {
          const isChord = childElements(element, 'chord').length > 0;
          const onset = isChord ? chordHeadPpq : cursorPpq;
          const advance = importNote(element, onset, isChord, state, part, ties, notes);
          if (!isChord) chordHeadPpq = cursorPpq;
          cursorPpq += advance;
          if (cursorPpq > measureMaxPpq) measureMaxPpq = cursorPpq;
          break;
        }
        case 'backup': {
          const duration = childInt(element, 'duration') ?? 0;
          cursorPpq = Math.max(state.measureStartPpq, cursorPpq - duration / state.divisions);
          break;
        }
        case 'forward': {
          const duration = childInt(element, 'duration') ?? 0;
          cursorPpq += duration / state.divisions;
          if (cursorPpq > measureMaxPpq) measureMaxPpq = cursorPpq;
          break;
        }
        case 'direction':
        case 'sound': {
          const bpm = tempoFromDirection(element);
          if (bpm !== null && bpm > 0) {
            const offset = childInt(element, 'offset') ?? 0;
            global.tempos.set(cursorPpq + offset / state.divisions, bpm);
          }
          break;
        }
      }
    }
    const measureLength = measureMaxPpq - state.measureStartPpq;
    state.measureStartPpq += measureLength > 0 ? measureLength : state.timeSigLengthPpq;
  }
  return notes;
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
function clipFromNotes(name: string, notes: DocumentNote[]): DocumentClip {
  const maxEnd = notes.reduce((end, note) => Math.max(end, note.startPpq + note.durationPpq), 0);
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
    segments.unshift({ startPpq: 0, bpm: segments[0]?.bpm ?? DEFAULT_BPM });
  }
  return segments;
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
function projectName(root: Element, fileName?: string): string {
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
export function importMusicXml(xml: string, fileName?: string): ProjectDocument {
  const root = parseScoreRoot(xml);
  const partInfos = readPartList(root);
  const global: GlobalMaps = { tempos: new Map(), timeSignatures: [], keys: [] };
  const tracks: ProjectDocument['tracks'] = [];
  const partElements = childElements(root, 'part');
  partElements.forEach((partEl, index) => {
    const id = partEl.getAttribute('id') ?? `P${index + 1}`;
    const info = partInfos.get(id) ?? { name: id, instruments: new Map() };
    const notes = importPartNotes(partEl, info, global, index === 0);
    const name = info.name || `Part ${index + 1}`;
    tracks.push({
      name,
      color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      clips: [clipFromNotes(name, notes)],
    });
  });

  const markers = global.keys.slice().sort((a, b) => a.ppq - b.ppq || a.name.localeCompare(b.name));

  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: projectName(root, fileName),
    sampleRate: DEFAULT_SAMPLE_RATE,
    tempoSegments: tempoSegments(global.tempos),
    timeSignatures: timeSignatureSegments(global.timeSignatures),
    tracks,
    markers,
    sections: [],
  };
}
