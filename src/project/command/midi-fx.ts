import type { Project } from '@libraz/libsonare';
import { pairEventsIntoNotesIndexed, projectMidiContent } from '../midi-events';
import { isMidiFxNoop, type MidiFxConfig, midiFxConfig, sanitizeMidiFxConfig } from '../midi-fx';
import { getProject, useProjectStore } from '../store';
import type { NoteProvenanceHints } from '../store-refresh';
import type { EditorNote, EditorTrack } from '../types';
import { execute } from './history';
import { requireEditableClip, requireEditableTrack } from './utils';

/**
 * Maps each of a clip's stored note-on events to the editor id the mirror
 * currently gives that note, so the ids can be carried across a bake.
 *
 * The index space is the Project's own event array: it holds non-note events
 * too and is in storage rather than sorted order, so it has to be read back
 * from the document rather than rebuilt from the mirror. Returns null when the
 * clip's events and its mirror notes disagree, which leaves the caller on the
 * content-key path instead of guessing a correspondence.
 */
function captureNoteProvenance(
  project: Project,
  clipId: number,
  notes: ReadonlyArray<EditorNote>,
): Map<number, number> | null {
  const recovered = pairEventsIntoNotesIndexed(projectMidiContent(project)[String(clipId)] ?? []);
  if (recovered.length !== notes.length) return null;
  const byOnEventIndex = new Map<number, number>();
  recovered.forEach((entry, index) => {
    byOnEventIndex.set(entry.onEventIndex, notes[index].id);
  });
  return byOnEventIndex;
}

/**
 * Bakes a MIDI-FX transform into a clip's stored notes as one undoable edit.
 * The engine applies transpose, grid quantize, velocity scale/offset/curve,
 * timing/velocity humanize and chord harmonize destructively; the result is
 * read back into the mirror so it plays back (and bounces) like any edit. A
 * no-op transform (every field at its identity value) is skipped silently.
 *
 * The bake is asked for per-event provenance so a note keeps its editor id —
 * and with it the piano-roll selection — across the rewrite. Harmonize and
 * arpeggiator fan-out give every generated voice the same origin, so only the
 * first output of each input stays the original note; the rest are new.
 *
 * @param clipId Target MIDI clip id.
 * @param config The transform to apply (sanitized internally).
 * @returns True when the clip was changed, false when the transform was a no-op.
 * @throws RangeError when the clip is unknown or not a MIDI clip.
 */
export function bakeClipMidiFx(clipId: number, config: MidiFxConfig): boolean {
  const store = useProjectStore();
  const clip = requireEditableClip(store, clipId);
  if ((clip.kind ?? 'midi') !== 'midi') {
    throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  }
  const engineConfig = midiFxConfig(sanitizeMidiFxConfig(config));
  if (engineConfig === null) return false;
  const project = getProject();
  const idByOnEventIndex = captureNoteProvenance(project, clipId, clip.notes);
  execute(1, () => {
    const result = project.bakeMidiFx({
      clipId,
      config: engineConfig,
      withSourceIndex: idByOnEventIndex !== null,
    });
    const sourceIndex = result?.sourceIndex;
    const hints: NoteProvenanceHints | undefined =
      idByOnEventIndex && sourceIndex ? { clipId, sourceIndex, idByOnEventIndex } : undefined;
    store.refresh(hints);
  });
  return true;
}

/** Drops the `midiFx` key from a track mirror entry (returns a fresh object). */
function withoutMidiFx(track: EditorTrack): EditorTrack {
  const { midiFx: _omit, ...rest } = track;
  return rest;
}

/**
 * Sets a track's live, non-destructive MIDI-FX transform as one undoable edit.
 * The transform is mirrored to the engine in realtime (and applied at offline
 * render) without rewriting any stored notes, so it can be replaced or cleared
 * without touching them. A sanitized no-op transform clears any existing transform instead of
 * storing an identity entry.
 *
 * @param trackId Target track id.
 * @param config The transform to apply (sanitized internally).
 * @returns True when the track's transform changed, false when it was a no-op.
 * @throws RangeError when the track is unknown.
 */
export function setTrackMidiFx(trackId: number, config: MidiFxConfig): boolean {
  const store = useProjectStore();
  const track = requireEditableTrack(store, trackId);
  const sanitized = sanitizeMidiFxConfig(config);
  // A no-op transform is equivalent to having none: clear instead of storing it.
  if (isMidiFxNoop(sanitized)) return clearTrackMidiFx(trackId);
  if (
    track.midiFx !== undefined &&
    JSON.stringify(midiFxConfig(track.midiFx)) === JSON.stringify(midiFxConfig(sanitized))
  ) {
    return false;
  }
  execute(0, () => {
    store.tracks = store.tracks.map((t) => (t.id === trackId ? { ...t, midiFx: sanitized } : t));
    store.refresh();
  });
  return true;
}

/**
 * Removes a track's live MIDI-FX transform as one undoable edit, bypassing it
 * in realtime and at offline render. A no-op when the track carries none.
 *
 * @param trackId Target track id.
 * @returns True when a transform was removed, false when there was none.
 * @throws RangeError when the track is unknown.
 */
export function clearTrackMidiFx(trackId: number): boolean {
  const store = useProjectStore();
  const track = requireEditableTrack(store, trackId);
  if (track.midiFx === undefined) return false;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => (t.id === trackId ? withoutMidiFx(t) : t));
    store.refresh();
  });
  return true;
}
