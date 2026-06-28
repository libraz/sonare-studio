/**
 * Shared viewport plumbing for the piano roll: the non-reactive TimelineRange
 * and painter, the redraw `revision` counter, the grid step derived from the
 * snap division, the layout element refs, first-layout centering and
 * active-clip re-centering, the horizontal content extent and the store
 * lifecycle.
 *
 * The TimelineRange and painter are markRaw plain objects shared by reference
 * with the canvas children; every range mutation routes through {@link bump} so
 * the canvases redraw. Watch and lifecycle timing match the original editor.
 */

import { computed, markRaw, onBeforeUnmount, onMounted, type Ref, ref, watch } from 'vue';
import { useProjectStore } from '@/project/store';
import { createPainter, type Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { createNoteExtentCache } from './content-extent';
import { contentCenterPitch } from './overlay';

/** Default horizontal zoom in px per quarter note (zoomed out for an overview). */
const DEFAULT_PX_PER_PPQ = 38;
/** Default pitch row height in px (compact so more of the range is visible). */
const DEFAULT_ROW_HEIGHT = 10;
/** Pitch placed near the vertical center on first layout (C5). */
const INITIAL_CENTER_PITCH = 72;

/** Reactive viewport state and helpers returned by {@link usePianoRollViewport}. */
export interface PianoRollViewport {
  /** Shared timeline viewport (non-reactive; the note grid owns resizing). */
  range: TimelineRange;
  /** Shared frame batcher for canvas redraws. */
  painter: Painter;
  /** Monotonic counter bumped after every range mutation to trigger redraws. */
  revision: Ref<number>;
  /** Initialization/runtime error surfaced above the editor. */
  error: Ref<string>;
  /** Snap grid step in PPQ derived from the store's divisions-per-whole-note. */
  gridPpq: Ref<number>;
  /** Root editor element (focus target for keyboard shortcuts). */
  root: Ref<HTMLDivElement | null>;
  /** Note-grid cell element (wheel-zoom anchor and size source). */
  gridCell: Ref<HTMLDivElement | null>;
  /** Horizontal scrollbar track element. */
  hTrack: Ref<HTMLDivElement | null>;
  /** Vertical scrollbar track element. */
  vTrack: Ref<HTMLDivElement | null>;
  /** Bumps the redraw revision after a range mutation. */
  bump(): void;
  /** Centers the view on middle-register pitches after the first layout pass. */
  onGridResize(): void;
  /** Re-centers the view vertically on the active clip's note content. */
  centerOnActiveClip(): void;
  /** Total horizontal content extent in PPQ (clip length, notes and view). */
  contentPpq(): number;
}

/** Configuration for {@link usePianoRollViewport}. */
export interface UsePianoRollViewportOptions {
  /**
   * Called after the view re-centers on an active-clip change, so the host can
   * react to clip switches (e.g. close the transform popover).
   */
  onClipChange?(): void;
}

/**
 * Creates the shared viewport for one piano-roll editor.
 *
 * @param options - Optional active-clip-change hook.
 * @returns The shared range/painter, redraw counter, layout refs and helpers.
 */
export function usePianoRollViewport(options: UsePianoRollViewportOptions = {}): PianoRollViewport {
  const store = useProjectStore();

  const error = ref('');

  // The TimelineRange and painter are plain (non-reactive) objects; views are
  // invalidated through the `revision` counter after every range mutation.
  const range = markRaw(
    new TimelineRange({
      widthPx: 1,
      heightPx: 1,
      pxPerPpq: DEFAULT_PX_PER_PPQ,
      rowHeight: DEFAULT_ROW_HEIGHT,
    }),
  );
  const painter = markRaw(createPainter());

  const revision = ref(0);

  function bump(): void {
    revision.value++;
  }

  const gridPpq = computed(() => 4 / store.snapDivision);

  const root = ref<HTMLDivElement | null>(null);
  const gridCell = ref<HTMLDivElement | null>(null);
  const hTrack = ref<HTMLDivElement | null>(null);
  const vTrack = ref<HTMLDivElement | null>(null);

  let initialScrollDone = false;

  function onGridResize(): void {
    if (!initialScrollDone && range.heightPx > 1) {
      initialScrollDone = true;
      const rowTop = (127 - INITIAL_CENTER_PITCH) * range.rowHeight;
      range.setScrollY(rowTop - range.heightPx / 2);
    }
    bump();
  }

  function centerOnActiveClip(): void {
    if (range.heightPx <= 1) return;
    const center = contentCenterPitch(store.notes);
    if (center === null) return;
    const rowTop = (127 - center) * range.rowHeight;
    range.setScrollY(rowTop + range.rowHeight / 2 - range.heightPx / 2);
    bump();
  }

  // Follow active-clip switches: re-center vertically on the new content while
  // preserving the horizontal scroll position.
  watch(
    () => store.clipId,
    () => {
      centerOnActiveClip();
      options.onClipChange?.();
    },
  );

  /** Extent of the note content, cached per note-mirror identity. */
  const noteExtentPpq = createNoteExtentCache();

  function contentPpq(): number {
    return Math.max(store.clipLengthPpq, noteExtentPpq(store.notes), range.endPpq);
  }

  onMounted(async () => {
    try {
      await store.init();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  });

  onBeforeUnmount(() => {
    painter.dispose();
  });

  return {
    range,
    painter,
    revision,
    error,
    gridPpq,
    root,
    gridCell,
    hTrack,
    vTrack,
    bump,
    onGridResize,
    centerOnActiveClip,
    contentPpq,
  };
}
