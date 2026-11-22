/**
 * Reads the `<part-list>` and walks each `<part>` measure by measure into
 * notes, a clip, and the tempo, meter and key maps shared across parts.
 */

import { keyMarkerName } from '@/compose/key-name';
import { GM_PERCUSSION_CHANNEL } from '@/compose/tracks';
import { clamp01, clampInt } from '@/lib/math';
import { DEFAULT_NOTE_VELOCITY } from '@/lib/midi';
import type {
  DocumentClip,
  DocumentMarker,
  DocumentNote,
  DocumentTempoSegment,
} from '@/project/serialization';
import { DEFAULT_TEMPO_BPM } from '@/project/tempo-map';
import { NOTE_VALUE_BASE_PPQ } from './model';
import type { ImportLossWalker } from './musicxml-import-loss';
import {
  childElements,
  childInt,
  childNumber,
  childText,
  descendants,
  elementText,
  type XmlElement,
} from './musicxml-import-xml';

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

/** Percussion instrument mapping declared in the `<part-list>`. */
export interface InstrumentMapping {
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
export interface PartInfo {
  name: string;
  instruments: Map<string, InstrumentMapping>;
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
export function readPartList(root: XmlElement, maxNumericAbs: number): Map<string, PartInfo> {
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
        ...(volume !== null ? { volume: clamp01(volume / 100) } : {}),
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

/** Global tempo / time-signature / key-signature events shared by all parts. */
export interface GlobalMaps {
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
export function importPartNotes(
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
export function clipFromNotes(
  name: string,
  notes: DocumentNote[],
  scoreEndPpq: number,
): DocumentClip {
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
