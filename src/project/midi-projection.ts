import type { EditorClip, EditorNote } from './types';

/** Minimum note shape accepted by the shared audible MIDI projector. */
export interface MidiProjectionNote {
  id?: number;
  pitch: number;
  velocity: number;
  offVelocity?: number;
  startPpq: number;
  durationPpq: number;
  channel: number;
}

/** Clip fields needed to project a source-note window onto the timeline. */
export interface MidiProjectionClip<T extends MidiProjectionNote = MidiProjectionNote> {
  id?: number;
  notes: ReadonlyArray<T>;
  startPpq: number;
  lengthPpq: number;
  sourceOffsetPpq: number;
  loopEnabled?: boolean;
  loopLengthPpq?: number;
}

/** Stable source identity of one audible MIDI note occurrence. */
export interface MidiSourceIdentity {
  clipId: number;
  noteId: number;
  /** Zero-based loop occurrence; non-looping notes use 0. */
  occurrence: number;
}

/** All coordinate frames of one audible source-note occurrence. */
export interface AudibleMidiOccurrence<T extends MidiProjectionNote = MidiProjectionNote> {
  /** Original source note object (never mutated). */
  note: T;
  sourceIdentity: MidiSourceIdentity;
  /** Original onset in the clip source (`note.startPpq`). */
  sourceStartPpq: number;
  /** Audible onset relative to the clip window (left-trimmed sustains start at 0). */
  clipStartPpq: number;
  /** Absolute onset on the project timeline. */
  timelineStartPpq: number;
  /** Audible duration, clamped at the clip's left and right edges. */
  durationPpq: number;
}

/** Source-coordinate bounds of the audible first clip window. */
export interface AudibleMidiSourceWindow {
  startPpq: number;
  endPpq: number;
  lengthPpq: number;
}

/** Minimum breakpoint shape accepted by the expression-window adapters. */
export interface MidiProjectionPoint {
  ppq: number;
}

/** One source note projected onto the project timeline. */
export interface ProjectedMidiNote extends EditorNote {
  sourceIdentity: MidiSourceIdentity;
}

/** Stable record key for maps that carry a composite MIDI source identity. */
export function midiSourceIdentityKey(identity: MidiSourceIdentity): string {
  return `${identity.clipId}:${identity.noteId}:${identity.occurrence}`;
}

/** Maps one source-coordinate PPQ position into the clip's first timeline window. */
export function midiSourcePpqToTimeline(
  clip: Pick<MidiProjectionClip, 'startPpq' | 'sourceOffsetPpq'>,
  sourcePpq: number,
): number {
  return clip.startPpq + sourcePpq - clip.sourceOffsetPpq;
}

/** Resolves the source window shared by playback, editors, and projection. */
export function audibleMidiSourceWindow(
  clip: Pick<MidiProjectionClip, 'lengthPpq' | 'sourceOffsetPpq' | 'loopEnabled' | 'loopLengthPpq'>,
): AudibleMidiSourceWindow {
  const loopLength = clip.loopLengthPpq ?? 0;
  const lengthPpq =
    clip.loopEnabled === true && loopLength > 0
      ? Math.min(loopLength, Math.max(0, clip.lengthPpq))
      : Math.max(0, clip.lengthPpq);
  return {
    startPpq: clip.sourceOffsetPpq,
    endPpq: clip.sourceOffsetPpq + lengthPpq,
    lengthPpq,
  };
}

/**
 * Single source of truth for MIDI source-window filtering and coordinate
 * projection. It returns source, clip-local, and absolute timeline positions
 * together, plus stable clip/note/loop-occurrence identity.
 *
 * `expandLoops: false` projects only the first source window. This is used by
 * source editors and by the engine, which repeats that window itself. Analysis,
 * score, and cross-track consumers use the default expanded occurrences.
 */
export function audibleMidiProjector<T extends MidiProjectionNote>(
  clip: MidiProjectionClip<T>,
  options: { expandLoops?: boolean } = {},
): AudibleMidiOccurrence<T>[] {
  if (!(clip.lengthPpq > 0)) return [];
  const loopLength = clip.loopLengthPpq ?? 0;
  const looping = clip.loopEnabled === true && loopLength > 0;
  const sourceWindow = audibleMidiSourceWindow(clip);
  const sourceWindowLength = sourceWindow.lengthPpq;
  if (!(sourceWindowLength > 0)) return [];
  const sourceNotes = clip.notes
    .map((note, sourceIndex) => ({ note, sourceIndex }))
    .filter(
      ({ note }) =>
        note.startPpq < sourceWindow.endPpq &&
        note.startPpq + note.durationPpq > sourceWindow.startPpq,
    );
  const repeatCount =
    looping && options.expandLoops !== false ? Math.ceil(clip.lengthPpq / sourceWindowLength) : 1;
  const clipId = clip.id ?? 0;
  const projected: AudibleMidiOccurrence<T>[] = [];
  for (let occurrence = 0; occurrence < repeatCount; occurrence += 1) {
    const repeatOffset = occurrence * sourceWindowLength;
    for (const { note, sourceIndex } of sourceNotes) {
      const audibleSourceStartPpq = Math.max(note.startPpq, sourceWindow.startPpq);
      const leftTrimPpq = audibleSourceStartPpq - note.startPpq;
      const clipStartPpq = repeatOffset + audibleSourceStartPpq - clip.sourceOffsetPpq;
      if (clipStartPpq < 0 || clipStartPpq >= clip.lengthPpq) continue;
      const durationPpq = Math.min(
        note.durationPpq - leftTrimPpq,
        sourceWindow.endPpq - audibleSourceStartPpq,
        clip.lengthPpq - clipStartPpq,
      );
      if (!(durationPpq > 0)) continue;
      projected.push({
        note,
        sourceIdentity: {
          clipId,
          noteId: note.id ?? sourceIndex,
          occurrence,
        },
        sourceStartPpq: note.startPpq,
        clipStartPpq,
        timelineStartPpq: midiSourcePpqToTimeline(clip, audibleSourceStartPpq) + repeatOffset,
        durationPpq,
      });
    }
  }
  projected.sort(
    (a, b) =>
      a.timelineStartPpq - b.timelineStartPpq ||
      b.note.pitch - a.note.pitch ||
      a.sourceIdentity.clipId - b.sourceIdentity.clipId ||
      a.sourceIdentity.noteId - b.sourceIdentity.noteId ||
      a.sourceIdentity.occurrence - b.sourceIdentity.occurrence,
  );
  return projected;
}

/** Returns each audible source note once for source-coordinate editors. */
export function audibleMidiSourceNotes<T extends MidiProjectionNote>(
  clip: MidiProjectionClip<T>,
): T[] {
  return audibleMidiProjector(clip, { expandLoops: false }).map((entry) => entry.note);
}

/**
 * Maps clip-local expression breakpoints into the source-coordinate window
 * used by the piano roll. Points outside the first audible loop/window remain
 * stored on the clip but are intentionally hidden from that editor view.
 */
export function audibleMidiSourcePoints<T extends MidiProjectionPoint>(
  clip: Pick<MidiProjectionClip, 'lengthPpq' | 'sourceOffsetPpq' | 'loopEnabled' | 'loopLengthPpq'>,
  points: ReadonlyArray<T>,
): T[] {
  const window = audibleMidiSourceWindow(clip);
  return points
    .filter((point) => point.ppq >= 0 && point.ppq <= window.lengthPpq)
    .map((point) => ({ ...point, ppq: point.ppq + window.startPpq }))
    .sort((a, b) => a.ppq - b.ppq);
}

/**
 * Inverse of {@link audibleMidiSourcePoints} for an editor commit. Hidden
 * clip-local points are preserved while the visible source window is replaced.
 */
export function mergeAudibleMidiSourcePoints<T extends MidiProjectionPoint>(
  clip: Pick<MidiProjectionClip, 'lengthPpq' | 'sourceOffsetPpq' | 'loopEnabled' | 'loopLengthPpq'>,
  currentPoints: ReadonlyArray<T>,
  editedSourcePoints: ReadonlyArray<T>,
): T[] {
  const window = audibleMidiSourceWindow(clip);
  const hidden = currentPoints.filter((point) => point.ppq < 0 || point.ppq > window.lengthPpq);
  const edited = editedSourcePoints
    .filter((point) => point.ppq >= window.startPpq && point.ppq <= window.endPpq)
    .map((point) => ({ ...point, ppq: point.ppq - window.startPpq }));
  return [...hidden.map((point) => ({ ...point })), ...edited].sort((a, b) => a.ppq - b.ppq);
}

/** Projects audible notes and loop occurrences into clip-local coordinates. */
export function projectMidiClipNoteOccurrences(
  clip: Pick<
    EditorClip,
    'id' | 'notes' | 'startPpq' | 'lengthPpq' | 'sourceOffsetPpq' | 'loopEnabled' | 'loopLengthPpq'
  >,
  options: { expandLoops?: boolean } = {},
): ProjectedMidiNote[] {
  return audibleMidiProjector(clip, options).map((entry) => ({
    ...entry.note,
    startPpq: entry.clipStartPpq,
    durationPpq: entry.durationPpq,
    sourceIdentity: entry.sourceIdentity,
  }));
}

/**
 * Projects a MIDI clip's audible source window and loop occurrences onto the
 * absolute project timeline while retaining clip/note/occurrence identity.
 */
export function projectMidiNoteOccurrences(
  clip: Pick<
    EditorClip,
    'id' | 'notes' | 'startPpq' | 'lengthPpq' | 'sourceOffsetPpq' | 'loopEnabled' | 'loopLengthPpq'
  >,
): ProjectedMidiNote[] {
  return audibleMidiProjector(clip).map((entry) => ({
    ...entry.note,
    startPpq: entry.timelineStartPpq,
    durationPpq: entry.durationPpq,
    sourceIdentity: entry.sourceIdentity,
  }));
}
