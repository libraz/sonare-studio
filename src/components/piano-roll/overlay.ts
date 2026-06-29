/**
 * Multi-track overlay logic for the piano roll: projecting other clips' notes
 * ("ghost notes") into the active clip's coordinate frame, deriving their
 * desaturated colors, view culling and pointer routing between editable notes
 * and read-only ghosts.
 *
 * Pure geometry/color math with no canvas, DOM or store access, so every rule
 * is unit-testable in isolation.
 */

import type { EditorClip, EditorNote, EditorTrack } from '@/project/types';
import {
  type HitTestOptions,
  hitTestNote,
  type NoteRect,
  type NoteView,
  type Point,
} from '@/ui/canvas/hit-test';
import { DEFAULT_NOTE_COLOR } from './theme';

/** Clip fields needed to convert between source-relative and timeline PPQ. */
export type ClipFrame = Pick<EditorClip, 'startPpq' | 'sourceOffsetPpq'>;

/** One read-only note from a non-active clip, projected for overlay drawing. */
export interface GhostNote {
  /** Editor id of the underlying note (valid after its clip is activated). */
  noteId: number;
  /** Id of the clip the note belongs to. */
  clipId: number;
  /** Id of the track owning that clip. */
  trackId: number;
  /** MIDI pitch (0..127). */
  pitch: number;
  /** Note start in the active clip's source-relative frame (may be negative). */
  startPpq: number;
  /** Note duration in PPQ. */
  durationPpq: number;
  /** Fill color (desaturated, translucent track color). */
  color: string;
  /** Display name of the source track. */
  trackName: string;
}

/**
 * Returns the PPQ offset that maps a source clip's note positions into a
 * target clip's source-relative frame.
 *
 * A clip places its source PPQ `p` on the timeline at
 * `startPpq + (p - sourceOffsetPpq)`; the offset below composes that mapping
 * with the inverse mapping of the target clip. A null target means the
 * timeline itself (offset relative to PPQ 0).
 *
 * @param source - Clip the notes belong to.
 * @param target - Clip whose frame the notes are projected into, or null.
 * @returns Value to add to a source-relative note PPQ.
 */
export function clipFrameOffsetPpq(source: ClipFrame, target: ClipFrame | null): number {
  const sourceOrigin = source.startPpq - source.sourceOffsetPpq;
  const targetOrigin = target ? target.startPpq - target.sourceOffsetPpq : 0;
  return sourceOrigin - targetOrigin;
}

/** An RGB triple with 0..255 channels. */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses a #rgb or #rrggbb CSS hex color; returns null for anything else. */
function parseHexColor(color: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const s = match[1];
  const hex = s.length === 3 ? `${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}` : s;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

/** How far ghost colors are mixed toward their luma gray (0 = none, 1 = full). */
const GHOST_DESATURATION = 0.65;

/** Default ghost-note fill opacity. */
export const GHOST_NOTE_ALPHA = 0.32;

/** Fallback RGB used when a track color cannot be parsed. */
const DEFAULT_RGB: Rgb = parseHexColor(DEFAULT_NOTE_COLOR) ?? { r: 128, g: 128, b: 128 };

/**
 * Derives the ghost (read-only overlay) fill color for a track color:
 * desaturated by mixing toward its luma gray, then made translucent.
 *
 * @param trackColor - Track color as a #rgb/#rrggbb hex string.
 * @param alpha - Fill opacity. Default {@link GHOST_NOTE_ALPHA}.
 * @returns An rgba() CSS color string.
 */
export function ghostNoteColor(trackColor: string, alpha: number = GHOST_NOTE_ALPHA): string {
  const { r, g, b } = parseHexColor(trackColor) ?? DEFAULT_RGB;
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  const mix = (channel: number): number =>
    Math.round(channel + (gray - channel) * GHOST_DESATURATION);
  return `rgba(${mix(r)}, ${mix(g)}, ${mix(b)}, ${alpha})`;
}

/** Inputs for {@link buildGhostNotes}. */
export interface BuildGhostNotesOptions {
  /** All clips in the mirror (the active one is skipped). */
  clips: ReadonlyArray<EditorClip>;
  /** All tracks in the mirror (color lookup). */
  tracks: ReadonlyArray<EditorTrack>;
  /** Id of the active clip (-1 projects ghosts into the timeline frame). */
  activeClipId: number;
}

/**
 * Builds the read-only ghost-note list for the overlay: every note of every
 * non-active clip whose extent intersects its clip's audible window
 * [sourceOffsetPpq, sourceOffsetPpq + lengthPpq), projected into the active
 * clip's source-relative frame and colored by its track.
 *
 * @param options - Clip/track mirrors and the active clip id.
 * @returns Ghost notes in (clip, note) order; later entries draw on top.
 */
export function buildGhostNotes(options: BuildGhostNotesOptions): GhostNote[] {
  const { clips, tracks, activeClipId } = options;
  const colorByTrack = new Map(tracks.map((track) => [track.id, ghostNoteColor(track.color)]));
  const nameByTrack = new Map(tracks.map((track) => [track.id, track.name]));
  const fallbackColor = ghostNoteColor(DEFAULT_NOTE_COLOR);
  const active = clips.find((clip) => clip.id === activeClipId) ?? null;
  const out: GhostNote[] = [];
  for (const clip of clips) {
    if (clip.id === activeClipId) continue;
    const color = colorByTrack.get(clip.trackId) ?? fallbackColor;
    const trackName = nameByTrack.get(clip.trackId) ?? 'Track';
    const offset = clipFrameOffsetPpq(clip, active);
    const windowStart = clip.sourceOffsetPpq;
    const windowEnd = clip.sourceOffsetPpq + clip.lengthPpq;
    for (const note of clip.notes) {
      if (note.startPpq + note.durationPpq <= windowStart || note.startPpq >= windowEnd) continue;
      out.push({
        noteId: note.id,
        clipId: clip.id,
        trackId: clip.trackId,
        pitch: note.pitch,
        startPpq: note.startPpq + offset,
        durationPpq: note.durationPpq,
        color,
        trackName,
      });
    }
  }
  return out;
}

/** Visible musical window of a note grid viewport, for culling. */
export interface NoteViewWindow {
  /** Left edge of the viewport in PPQ. */
  startPpq: number;
  /** Exclusive right edge of the viewport in PPQ. */
  endPpq: number;
  /** Lowest (at least partially) visible pitch row. */
  minPitch: number;
  /** Highest (at least partially) visible pitch row. */
  maxPitch: number;
}

/**
 * Returns true when a note's rectangle intersects the visible window.
 * Notes merely touching the horizontal edges are culled (zero visible width);
 * the pitch bounds are inclusive.
 *
 * @param note - Note extent in musical coordinates.
 * @param view - Visible window of the viewport.
 */
export function isNoteInView(
  note: { startPpq: number; durationPpq: number; pitch: number },
  view: NoteViewWindow,
): boolean {
  if (note.startPpq + note.durationPpq <= view.startPpq || note.startPpq >= view.endPpq) {
    return false;
  }
  return note.pitch >= view.minPitch && note.pitch <= view.maxPitch;
}

/** Projects editor notes into the string-id rectangles the hit-test consumes. */
function toRects(
  notes: ReadonlyArray<Pick<EditorNote, 'id' | 'startPpq' | 'durationPpq' | 'pitch'>>,
): NoteRect[] {
  return notes.map((note) => ({
    id: String(note.id),
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    pitch: note.pitch,
  }));
}

/**
 * Routes a pointer press between editable notes and overlay ghosts: editable
 * notes draw on top and keep priority, so a press only resolves to a ghost
 * when no editable note is under the point. Ghosts are read-only, so the
 * whole rectangle counts as body (no resize zones); the topmost (last) ghost
 * wins.
 *
 * @param editableNotes - The active clip's notes in draw order.
 * @param ghosts - Ghost notes in draw order.
 * @param point - Pointer position in viewport px.
 * @param view - Projection from musical coordinates to px.
 * @param options - Resize tolerance applied to the editable-note test only.
 * @returns The hit ghost, or null when the press belongs to normal editing.
 */
export function hitTestGhost(
  editableNotes: ReadonlyArray<Pick<EditorNote, 'id' | 'startPpq' | 'durationPpq' | 'pitch'>>,
  ghosts: ReadonlyArray<GhostNote>,
  point: Point,
  view: NoteView,
  options: HitTestOptions = {},
): GhostNote | null {
  if (ghosts.length === 0) return null;
  if (hitTestNote(toRects(editableNotes), point, view, options)) return null;
  const rects: NoteRect[] = ghosts.map((ghost, index) => ({
    id: String(index),
    startPpq: ghost.startPpq,
    durationPpq: ghost.durationPpq,
    pitch: ghost.pitch,
  }));
  const hit = hitTestNote(rects, point, view, { resizeTolerancePx: 0 });
  return hit ? ghosts[Number(hit.id)] : null;
}

/**
 * Returns the pitch midway between the lowest and highest note, for vertical
 * re-centering when the active clip changes, or null for an empty list.
 *
 * @param notes - Notes to inspect.
 */
export function contentCenterPitch(notes: ReadonlyArray<{ pitch: number }>): number | null {
  if (notes.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    min = Math.min(min, note.pitch);
    max = Math.max(max, note.pitch);
  }
  return Math.round((min + max) / 2);
}
