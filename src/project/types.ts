import type { MidiNote } from '@/engine/instruments';

/**
 * One note in the piano-roll editor mirror.
 *
 * The underlying libsonare Project stores anonymous note-on/note-off event
 * pairs only; `id` is an editor-side identity assigned by the project store
 * so the UI can track notes across edits (selection, drag handles, undo).
 */
export interface EditorNote {
  /** Stable editor-assigned identity (monotonic, never reused in a session). */
  id: number;
  /** MIDI note number (integer, 0-127). */
  pitch: number;
  /** Note-on velocity (integer, 1-127). */
  velocity: number;
  /** Note start within the clip, in quarter-note PPQ (fractional allowed, >= 0). */
  startPpq: number;
  /** Note length in PPQ (> 0). */
  durationPpq: number;
  /** MIDI channel (integer, 0-15). */
  channel: number;
  /** Optional note-off (release) velocity (integer, 1-127); omitted = default release. */
  offVelocity?: number;
}

/** Payload for creating a note; velocity and channel fall back to defaults. */
export interface NewEditorNote {
  /** MIDI note number (integer, 0-127). */
  pitch: number;
  /** Note start within the clip, in PPQ (>= 0). */
  startPpq: number;
  /** Note length in PPQ (> 0). */
  durationPpq: number;
  /** Note-on velocity (integer, 1-127). Defaults to 96. */
  velocity?: number;
  /** MIDI channel (integer, 0-15). Defaults to 0. */
  channel?: number;
  /** Optional note-off velocity (integer, 1-127). */
  offVelocity?: number;
}

/** Partial note edit addressed by editor note id (move / resize / velocity). */
export interface EditorNoteUpdate {
  /** Id of the note to edit. */
  id: number;
  /** New MIDI note number (integer, 0-127). */
  pitch?: number;
  /** New note-on velocity (integer, 1-127). */
  velocity?: number;
  /** New start position in PPQ (>= 0). */
  startPpq?: number;
  /** New length in PPQ (> 0). */
  durationPpq?: number;
  /** New MIDI channel (integer, 0-15). */
  channel?: number;
  /** New note-off velocity (integer, 1-127). */
  offVelocity?: number;
}

/** Scale highlight configuration for the piano roll key lane. */
export interface ScaleHighlightConfig {
  /** Whether scale highlighting is active; when false no pitch class is highlighted. */
  enabled: boolean;
  /** Root pitch class (0-11, C = 0). */
  rootPc: number;
  /** 12-bit interval mask relative to the root (bit n = interval n enabled). */
  modeMask: number;
}

/** 12-bit interval mask of the natural major scale (C major when rootPc = 0). */
export const MAJOR_MODE_MASK = 0b101010110101;

/**
 * Converts an editor note to the engine {@link MidiNote} shape
 * (e.g., for prerenderMidiClip / scheduleMidiClip).
 *
 * @param note Editor note to convert.
 * @returns Engine-facing note (drops the editor id and off velocity).
 */
export function editorNoteToMidiNote(note: EditorNote): MidiNote {
  return {
    note: note.pitch,
    velocity: note.velocity,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel,
  };
}

/**
 * Converts a list of editor notes to engine {@link MidiNote}s.
 *
 * @param notes Editor notes to convert.
 * @returns Engine-facing notes in the same order.
 */
export function editorNotesToMidiNotes(notes: ReadonlyArray<EditorNote>): MidiNote[] {
  return notes.map(editorNoteToMidiNote);
}

/**
 * Converts an engine {@link MidiNote} to a {@link NewEditorNote} payload
 * (e.g., to import a generated phrase into the editor).
 *
 * @param note Engine note to convert.
 * @returns Creation payload accepted by the addNote command.
 */
export function midiNoteToNewEditorNote(note: MidiNote): NewEditorNote {
  return {
    pitch: note.note,
    velocity: note.velocity,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel ?? 0,
  };
}
