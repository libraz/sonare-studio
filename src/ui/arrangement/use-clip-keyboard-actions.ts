/**
 * Keyboard and virtual-list clip actions of the arrangement view: select,
 * nudge/resize on the grid and move across track lanes, all through the same
 * undoable project commands as pointer edits.
 */

import type { ComputedRef, Ref } from 'vue';
import { describeError } from '@/lib/errors';
import { moveClip, setActiveClip, trimClip } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { adjacentBarDelta } from '@/project/time-signature';
import { canTrackContainClip, clipKind, type EditorTrack } from '@/project/types';
import type { AccessibleObjectAdjustment } from '@/ui/accessibility/object-navigation';
import { barRangeAt } from '@/ui/arrangement/ruler';
import { useI18n } from '@/ui/i18n';

/** One clip action requested from the accessible object list. */
export type ClipKeyboardAction =
  | { clipId: number; kind: 'select' }
  | { clipId: number; kind: 'adjust'; adjustment: AccessibleObjectAdjustment }
  | { clipId: number; kind: 'set'; controlId: string; value: number };

/** Configuration for {@link useClipKeyboardActions}. */
export interface UseClipKeyboardActionsOptions {
  /** Error line shown above the view; failed commands set it. */
  error: Ref<string>;
  /** Snap grid step in PPQ (0 when snapping is off). */
  gridPpq: ComputedRef<number>;
  /** Tracks in the visible row order; vertical moves stay within them. */
  visibleTracks: Readonly<Ref<readonly EditorTrack[]>>;
  /** Trim bounds of a clip against its backing asset; null when unbounded. */
  sourceBoundsFor: (clipId: number) => { maxEndPpq: number } | null;
}

/** Keyboard clip handler returned by {@link useClipKeyboardActions}. */
export interface ClipKeyboardActions {
  /** Applies one clip action through the undoable project commands. */
  onClipKeyboardAction(payload: ClipKeyboardAction): void;
}

/**
 * Creates the keyboard clip action handler for one arrangement view.
 *
 * @param options - The shared error line, grid, visible rows and source bounds.
 * @returns The action handler.
 */
export function useClipKeyboardActions({
  error,
  gridPpq,
  visibleTracks,
  sourceBoundsFor,
}: UseClipKeyboardActionsOptions): ClipKeyboardActions {
  const store = useProjectStore();
  const { t } = useI18n();

  /** Applies virtual-list clip actions through the same undoable project commands as pointer edits. */
  function onClipKeyboardAction(payload: ClipKeyboardAction): void {
    const clip = store.clips.find((item) => item.id === payload.clipId);
    if (!clip) return;
    setActiveClip(clip.id);
    if (payload.kind === 'select') return;
    const track = store.tracks.find((item) => item.id === clip.trackId);
    if (track?.frozen !== undefined) return;
    // A key press that lands on the current value records no undo step.
    const moveClipTo = (startPpq: number): void => {
      if (startPpq !== clip.startPpq) moveClip(clip.id, startPpq);
    };
    const trimClipTo = (lengthPpq: number): void => {
      if (lengthPpq !== clip.lengthPpq) trimClip(clip.id, clip.startPpq, lengthPpq);
    };
    try {
      if (payload.kind === 'set') {
        if (payload.controlId === 'start') {
          moveClipTo(Math.max(0, payload.value));
        } else if (payload.controlId === 'length') {
          const bounds = sourceBoundsFor(clip.id);
          const maximum = bounds ? bounds.maxEndPpq - clip.startPpq : Number.POSITIVE_INFINITY;
          trimClipTo(Math.max(0.25, Math.min(maximum, payload.value)));
        }
        return;
      }
      const { direction, resize, coarse } = payload.adjustment;
      const step = Math.max(0.0625, gridPpq.value) * (coarse ? 4 : 1);
      if (direction === 'left' || direction === 'right') {
        const delta =
          store.snapEnabled && store.snapBar
            ? adjacentBarDelta(
                (ppq) => barRangeAt(store.timeSignatures, ppq),
                clip.startPpq,
                direction,
                coarse,
              )
            : direction === 'left'
              ? -step
              : step;
        if (resize) {
          const bounds = sourceBoundsFor(clip.id);
          const maximum = bounds ? bounds.maxEndPpq - clip.startPpq : Number.POSITIVE_INFINITY;
          trimClipTo(Math.max(0.25, Math.min(maximum, clip.lengthPpq + delta)));
        } else {
          moveClipTo(Math.max(0, clip.startPpq + delta));
        }
        return;
      }
      const lanes = visibleTracks.value;
      const currentTrackIndex = lanes.findIndex((item) => item.id === clip.trackId);
      const trackDelta = direction === 'up' ? -1 : 1;
      for (
        let index = currentTrackIndex + trackDelta;
        index >= 0 && index < lanes.length;
        index += trackDelta
      ) {
        const destination = lanes[index];
        if (
          destination.frozen === undefined &&
          canTrackContainClip(destination.kind, clipKind(clip))
        ) {
          moveClip(clip.id, clip.startPpq, destination.id);
          break;
        }
      }
    } catch (cause) {
      error.value = describeError(cause, t.value.notices.errors);
    }
  }

  return { onClipKeyboardAction };
}
