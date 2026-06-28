import {
  isMidiFxNoop,
  type MidiFxConfig,
  midiFxConfigJson,
  sanitizeMidiFxConfig,
} from '../midi-fx';
import { getProject, useProjectStore } from '../store';
import type { EditorTrack } from '../types';
import { execute } from './history';
import { requireClip, requireTrack } from './utils';

/**
 * Bakes a MIDI-FX transform into a clip's stored notes as one undoable edit.
 * The engine applies transpose, grid quantize, velocity scale/offset/curve,
 * timing/velocity humanize and chord harmonize destructively; the result is
 * read back into the mirror so it plays back (and bounces) like any edit. A
 * no-op transform (every field at its identity value) is skipped silently.
 *
 * @param clipId Target MIDI clip id.
 * @param config The transform to apply (sanitized internally).
 * @returns True when the clip was changed, false when the transform was a no-op.
 * @throws RangeError when the clip is unknown or not a MIDI clip.
 */
export function bakeClipMidiFx(clipId: number, config: MidiFxConfig): boolean {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if ((clip.kind ?? 'midi') !== 'midi') {
    throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  }
  const json = midiFxConfigJson(sanitizeMidiFxConfig(config));
  if (json === null) return false;
  const project = getProject();
  execute(1, () => {
    project.bakeMidiFx(clipId, json);
    store.refresh();
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
 * render) without rewriting any stored notes, so it can be re-edited or cleared
 * freely. A sanitized no-op transform clears any existing transform instead of
 * storing an identity entry.
 *
 * @param trackId Target track id.
 * @param config The transform to apply (sanitized internally).
 * @returns True when the track's transform changed, false when it was a no-op.
 * @throws RangeError when the track is unknown.
 */
export function setTrackMidiFx(trackId: number, config: MidiFxConfig): boolean {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  const sanitized = sanitizeMidiFxConfig(config);
  // A no-op transform is equivalent to having none: clear instead of storing it.
  if (isMidiFxNoop(sanitized)) return clearTrackMidiFx(trackId);
  if (
    track.midiFx !== undefined &&
    midiFxConfigJson(track.midiFx) === midiFxConfigJson(sanitized)
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
  const track = requireTrack(store, trackId);
  if (track.midiFx === undefined) return false;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => (t.id === trackId ? withoutMidiFx(t) : t));
    store.refresh();
  });
  return true;
}
