import type { ProjectMidiEvent } from '@/wasm/index.js';
import type { EditorNote } from './types';

/** UMP message-type nibble for MIDI 1.0 channel-voice words. */
const UMP_MIDI1_CHANNEL_VOICE = 0x2;
/** MIDI 1.0 note-off status nibble. */
const STATUS_NOTE_OFF = 0x8;
/** MIDI 1.0 note-on status nibble. */
const STATUS_NOTE_ON = 0x9;

/** Shape of one serialized MIDI event inside the Project JSON document. */
export interface SerializedMidiEvent {
  ppq: number;
  data0: number;
  data1: number;
}

/**
 * A note-on or note-off boundary at a timeline position. Used both when
 * decoding serialized events and when capturing live MIDI input for recording.
 */
export interface NoteBoundaryEvent {
  /** Boundary position in PPQ. */
  ppq: number;
  /** Whether this boundary opens ('on') or closes ('off') a note. */
  kind: 'on' | 'off';
  /** MIDI channel (0-15). */
  channel: number;
  /** MIDI note number (0-127). */
  pitch: number;
  /** Velocity (note-on velocity, or release velocity for note-offs). */
  velocity: number;
}

/** An editor note without its id, as recovered from the Project. */
export type RawNote = Omit<EditorNote, 'id'>;

/**
 * A recovered note tagged with the position of the event that opened it in the
 * source event array. The engine's MIDI-FX provenance is expressed in that
 * index space, so carrying it is what lets a note keep its editor id across a
 * destructive bake.
 */
export interface IndexedRawNote {
  note: RawNote;
  /** Index of the note-on event within the array the note was recovered from. */
  onEventIndex: number;
}

/**
 * Decodes a packed UMP MIDI 1.0 channel-voice word into a note boundary.
 *
 * @param ppq Event position in PPQ.
 * @param data0 Packed 32-bit UMP word.
 * @returns The decoded boundary, or null for non-note events.
 */
function decodeNoteEvent(ppq: number, data0: number): NoteBoundaryEvent | null {
  if (((data0 >>> 28) & 0xf) !== UMP_MIDI1_CHANNEL_VOICE) return null;
  const status = (data0 >>> 20) & 0xf;
  const channel = (data0 >>> 16) & 0xf;
  const pitch = (data0 >>> 8) & 0x7f;
  const velocity = data0 & 0x7f;
  if (status === STATUS_NOTE_ON && velocity > 0) {
    return { ppq, kind: 'on', channel, pitch, velocity };
  }
  if (status === STATUS_NOTE_OFF || status === STATUS_NOTE_ON) {
    // A note-on with velocity 0 is a note-off per MIDI 1.0 semantics.
    return {
      ppq,
      kind: 'off',
      channel,
      pitch,
      velocity: status === STATUS_NOTE_OFF ? velocity : 0,
    };
  }
  return null;
}

/**
 * Pairs serialized note-on/note-off events back into notes.
 *
 * Events are matched FIFO per (channel, pitch); note-offs sort before
 * note-ons at the same PPQ so back-to-back repeats pair correctly.
 * Unmatched boundaries and non-note events (CC, pitch bend, ...) are dropped;
 * the editor only manages note content in its clips.
 *
 * @param events Serialized events from the Project JSON document.
 * @returns Recovered notes sorted by start position.
 */
export function pairEventsIntoNotes(events: ReadonlyArray<SerializedMidiEvent>): RawNote[] {
  return pairEventsIntoNotesIndexed(events).map((entry) => entry.note);
}

/**
 * {@link pairEventsIntoNotes} keeping each note's note-on event index.
 *
 * Non-note events (program change, CC, ...) occupy positions in the event
 * array too, and the array is in the Project's own storage order rather than a
 * sorted one, so the index must come from the array itself — it cannot be
 * reconstructed from the recovered notes.
 *
 * @param events Serialized events from the Project JSON document.
 * @returns Recovered notes with their opening event index, sorted by start.
 */
export function pairEventsIntoNotesIndexed(
  events: ReadonlyArray<SerializedMidiEvent>,
): IndexedRawNote[] {
  const decoded: IndexedBoundary[] = [];
  events.forEach((event, index) => {
    const note = decodeNoteEvent(event.ppq, event.data0);
    if (note) decoded.push({ ...note, index });
  });
  return pairIndexedBoundaries(decoded);
}

/**
 * Pairs note-on/note-off boundaries back into notes, FIFO per (channel, pitch).
 *
 * The input may be unsorted (live capture arrives in wall-clock order, which
 * is not necessarily PPQ order under a tempo ramp): boundaries are sorted with
 * note-offs before note-ons at the same PPQ so back-to-back repeats pair
 * correctly. Unmatched boundaries and zero/negative-length pairs are dropped.
 *
 * @param boundaries Note-on/note-off boundaries (decoded or captured).
 * @returns Recovered notes sorted by start position.
 */
export function pairNoteBoundariesIntoNotes(
  boundaries: ReadonlyArray<NoteBoundaryEvent>,
): RawNote[] {
  return pairIndexedBoundaries(boundaries.map((boundary, index) => ({ ...boundary, index }))).map(
    (entry) => entry.note,
  );
}

/** A note boundary tagged with its position in the array it came from. */
interface IndexedBoundary extends NoteBoundaryEvent {
  index: number;
}

/**
 * Pairing core shared by the serialized-event and live-capture entry points.
 * Each recovered note carries the index of the boundary that opened it.
 */
function pairIndexedBoundaries(boundaries: ReadonlyArray<IndexedBoundary>): IndexedRawNote[] {
  const decoded = boundaries.slice();
  decoded.sort(
    (a, b) =>
      a.ppq - b.ppq ||
      (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1) ||
      a.pitch - b.pitch ||
      a.channel - b.channel,
  );
  const pending = new Map<string, Array<{ startPpq: number; velocity: number; index: number }>>();
  const out: IndexedRawNote[] = [];
  for (const event of decoded) {
    const key = `${event.channel}:${event.pitch}`;
    if (event.kind === 'on') {
      const queue = pending.get(key) ?? [];
      queue.push({ startPpq: event.ppq, velocity: event.velocity, index: event.index });
      pending.set(key, queue);
      continue;
    }
    const on = pending.get(key)?.shift();
    if (!on || event.ppq <= on.startPpq) continue;
    const note: RawNote = {
      pitch: event.pitch,
      velocity: on.velocity,
      startPpq: on.startPpq,
      durationPpq: event.ppq - on.startPpq,
      channel: event.channel,
    };
    if (event.velocity > 0) note.offVelocity = event.velocity;
    out.push({ note, onEventIndex: on.index });
  }
  out.sort(
    (a, b) =>
      a.note.startPpq - b.note.startPpq ||
      a.note.pitch - b.note.pitch ||
      a.note.channel - b.note.channel,
  );
  return out;
}

/** A note-on or note-off boundary used to build a flat event list. */
interface NoteBoundary {
  ppq: number;
  kind: 'on' | 'off';
  pitch: number;
  channel: number;
  velocity: number;
}

interface MidiEventFactory {
  Project: {
    midiNoteOn(
      ppq: number,
      group: number,
      channel: number,
      note: number,
      velocity: number,
    ): ProjectMidiEvent;
    midiNoteOff(
      ppq: number,
      group: number,
      channel: number,
      note: number,
      velocity?: number,
    ): ProjectMidiEvent;
  };
}

/**
 * Expands editor notes into a sorted flat event list for Project.setMidiEvents.
 * Note-offs sort before note-ons at the same PPQ so a repeated pitch releases
 * before it retriggers.
 */
export function notesToProjectMidiEvents(
  notes: ReadonlyArray<RawNote>,
  wasm: MidiEventFactory,
): ProjectMidiEvent[] {
  const boundaries: NoteBoundary[] = [];
  for (const note of notes) {
    boundaries.push({
      ppq: note.startPpq,
      kind: 'on',
      pitch: note.pitch,
      channel: note.channel,
      velocity: note.velocity,
    });
    boundaries.push({
      ppq: note.startPpq + note.durationPpq,
      kind: 'off',
      pitch: note.pitch,
      channel: note.channel,
      velocity: note.offVelocity ?? 0,
    });
  }
  boundaries.sort(
    (a, b) =>
      a.ppq - b.ppq ||
      (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1) ||
      a.pitch - b.pitch ||
      a.channel - b.channel,
  );
  return boundaries.map((b) =>
    b.kind === 'on'
      ? wasm.Project.midiNoteOn(b.ppq, 0, b.channel, b.pitch, b.velocity)
      : wasm.Project.midiNoteOff(b.ppq, 0, b.channel, b.pitch, b.velocity),
  );
}

/** PPQ values are keyed at micro-PPQ resolution to absorb float round-trip noise. */
const KEY_PPQ_SCALE = 1e6;

/** Builds the content key used to re-associate editor ids after a refresh. */
export function noteKey(note: RawNote): string {
  return [
    note.pitch,
    note.velocity,
    Math.round(note.startPpq * KEY_PPQ_SCALE),
    Math.round(note.durationPpq * KEY_PPQ_SCALE),
    note.channel,
    note.offVelocity ?? 0,
  ].join('|');
}
