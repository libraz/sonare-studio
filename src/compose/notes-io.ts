/**
 * Note interchange between the editor's {@link EditorNote} and libcantus's
 * {@link NoteEvent}.
 *
 * Both measure time in quarter-note beats: the app's PPQ counts quarter notes
 * (1 PPQ = one quarter note, see bar-beat.ts) and libcantus's `startBeat`/
 * `durationBeat` are quarter-note beats too, so the time conversion is the
 * identity (coefficient 1). Dividing by a tick resolution such as
 * `TICKS_PER_QUARTER` here would collapse every note to beat ~0 and silently
 * destroy all rhythmic position — the transport tick resolution is a display
 * concern only.
 *
 * `EditorNote.startPpq` is measured from the clip's own origin; pass a
 * `beatOffset` (typically the clip's timeline `startPpq`) to place notes on the
 * shared timeline that cross-track analysis needs. Pure module.
 */

import type { NoteEvent } from '@libraz/libcantus';
import type { EditorNote, NewEditorNote } from '@/project/types';

/** Default note-on velocity for generated notes without an explicit velocity. */
const DEFAULT_VELOCITY = 96;

function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, Math.round(pitch)));
}

function clampVelocity(velocity: number): number {
  return Math.max(1, Math.min(127, Math.round(velocity)));
}

/**
 * Converts one editor note to a libcantus note event.
 *
 * @param note Editor note (clip-relative timing).
 * @param beatOffset Beats added to the onset to reach the shared timeline
 *   (pass the clip's `startPpq` for absolute positioning; default 0 keeps
 *   clip-relative timing).
 */
export function editorNoteToNoteEvent(note: EditorNote, beatOffset = 0): NoteEvent {
  return {
    pitch: note.pitch,
    startBeat: note.startPpq + beatOffset,
    durationBeat: note.durationPpq,
    velocity: note.velocity,
  };
}

/**
 * Converts editor notes to libcantus note events, sorted by onset.
 *
 * @param notes Editor notes (not mutated).
 * @param beatOffset Beats added to every onset (see {@link editorNoteToNoteEvent}).
 */
export function editorNotesToNoteEvents(
  notes: ReadonlyArray<EditorNote>,
  beatOffset = 0,
): NoteEvent[] {
  return notes
    .map((note) => editorNoteToNoteEvent(note, beatOffset))
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

/**
 * Converts a libcantus note event to an editor note-creation payload. Pitch is
 * clamped to the MIDI range, velocity defaults to {@link DEFAULT_VELOCITY} when
 * absent, and non-positive durations are dropped by returning null.
 *
 * @param event Note event (timeline beats).
 * @param options Target `channel` (default 0) and `beatOffset` to subtract when
 *   writing back into a clip whose notes are clip-relative.
 */
export function noteEventToNewEditorNote(
  event: NoteEvent,
  options: { channel?: number; beatOffset?: number } = {},
): NewEditorNote | null {
  const beatOffset = options.beatOffset ?? 0;
  const startPpq = event.startBeat - beatOffset;
  if (!Number.isFinite(startPpq) || startPpq < 0) return null;
  if (!Number.isFinite(event.durationBeat) || event.durationBeat <= 0) return null;
  const payload: NewEditorNote = {
    pitch: clampPitch(event.pitch),
    startPpq,
    durationPpq: event.durationBeat,
    velocity: clampVelocity(event.velocity ?? DEFAULT_VELOCITY),
  };
  if (options.channel !== undefined) payload.channel = options.channel;
  return payload;
}

/**
 * Maps libcantus note events to editor note-creation payloads, dropping events
 * with a non-positive duration or negative onset (see
 * {@link noteEventToNewEditorNote}).
 */
export function noteEventsToNewEditorNotes(
  events: ReadonlyArray<NoteEvent>,
  options: { channel?: number; beatOffset?: number } = {},
): NewEditorNote[] {
  const out: NewEditorNote[] = [];
  for (const event of events) {
    const note = noteEventToNewEditorNote(event, options);
    if (note !== null) out.push(note);
  }
  return out;
}
