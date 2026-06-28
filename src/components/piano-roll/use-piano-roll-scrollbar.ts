/**
 * Custom scrollbars for the piano-roll viewport: the vertical and horizontal
 * thumb geometry (size and position as percentages of the content) and the
 * pointer-drag handlers that pan the shared TimelineRange.
 *
 * The thumb styles read the redraw `revision` (and the store notes for the
 * horizontal thumb) so they recompute as the view pans/zooms or content grows;
 * every drag mutation routes through the injected {@link bump} to redraw.
 */

import { type ComputedRef, computed, type Ref } from 'vue';
import { useProjectStore } from '@/project/store';
import type { TimelineRange } from '@/ui/canvas/timeline-range';

/** In-flight scrollbar drag captured on pointerdown. */
interface ScrollDrag {
  axis: 'h' | 'v';
  startClient: number;
  startValue: number;
  contentSize: number;
  trackPx: number;
  spanPpq: number;
}

/** Inline style for one scrollbar thumb. */
interface ThumbStyle {
  [property: string]: string;
}

/** Thumb styles and drag handlers returned by {@link usePianoRollScrollbar}. */
export interface PianoRollScrollbar {
  /** Inline style (top/height %) for the vertical scrollbar thumb. */
  vThumbStyle: ComputedRef<ThumbStyle>;
  /** Inline style (left/width %) for the horizontal scrollbar thumb. */
  hThumbStyle: ComputedRef<ThumbStyle>;
  /** Starts a vertical scrollbar drag. */
  onVScrollDown(event: PointerEvent): void;
  /** Starts a horizontal scrollbar drag. */
  onHScrollDown(event: PointerEvent): void;
  /** Updates the scroll position while a thumb drag runs. */
  onScrollMove(event: PointerEvent): void;
  /** Ends the active scrollbar drag. */
  onScrollUp(): void;
}

/** Configuration for {@link usePianoRollScrollbar}. */
export interface UsePianoRollScrollbarOptions {
  /** Shared timeline viewport panned by the drags. */
  range: TimelineRange;
  /** Redraw counter read by the thumb styles so they follow the view. */
  revision: Ref<number>;
  /** Horizontal scrollbar track element. */
  hTrack: Ref<HTMLElement | null>;
  /** Vertical scrollbar track element. */
  vTrack: Ref<HTMLElement | null>;
  /** Total horizontal content extent in PPQ (clip length, notes and view). */
  contentPpq(): number;
  /** Bumps the redraw revision after a range mutation. */
  bump(): void;
}

/**
 * Creates the custom scrollbar thumbs and drag handlers for one piano-roll
 * editor.
 *
 * @param options - Shared range, redraw counter, track refs, content extent
 *   and the redraw bump.
 * @returns The thumb styles plus the pointer-drag handlers.
 */
export function usePianoRollScrollbar(options: UsePianoRollScrollbarOptions): PianoRollScrollbar {
  const { range, revision, hTrack, vTrack, contentPpq, bump } = options;
  const store = useProjectStore();

  let scrollDrag: ScrollDrag | null = null;

  const vThumbStyle = computed<ThumbStyle>(() => {
    void revision.value;
    const content = Math.max(1, range.contentHeightPx);
    const sizePct = Math.max(4, Math.min(100, (range.heightPx / content) * 100));
    const topPct = Math.min(100 - sizePct, (range.scrollY / content) * 100);
    return { top: `${topPct}%`, height: `${sizePct}%` };
  });

  const hThumbStyle = computed<ThumbStyle>(() => {
    void revision.value;
    // Track the store notes so the thumb resizes when content grows.
    void store.notes;
    const content = Math.max(1e-6, contentPpq());
    const span = range.endPpq - range.startPpq;
    const sizePct = Math.max(4, Math.min(100, (span / content) * 100));
    const leftPct = Math.min(100 - sizePct, (range.startPpq / content) * 100);
    return { left: `${leftPct}%`, width: `${sizePct}%` };
  });

  function onVScrollDown(event: PointerEvent): void {
    const track = vTrack.value;
    if (!track || event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    scrollDrag = {
      axis: 'v',
      startClient: event.clientY,
      startValue: range.scrollY,
      contentSize: range.contentHeightPx,
      trackPx: Math.max(1, track.clientHeight),
      spanPpq: 0,
    };
  }

  function onHScrollDown(event: PointerEvent): void {
    const track = hTrack.value;
    if (!track || event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    scrollDrag = {
      axis: 'h',
      startClient: event.clientX,
      startValue: range.startPpq,
      contentSize: contentPpq(),
      trackPx: Math.max(1, track.clientWidth),
      spanPpq: range.endPpq - range.startPpq,
    };
  }

  function onScrollMove(event: PointerEvent): void {
    const drag = scrollDrag;
    if (!drag) return;
    if (drag.axis === 'v') {
      const dy = event.clientY - drag.startClient;
      range.setScrollY(drag.startValue + (dy * drag.contentSize) / drag.trackPx);
    } else {
      const dx = event.clientX - drag.startClient;
      const target = drag.startValue + (dx * drag.contentSize) / drag.trackPx;
      range.setStartPpq(Math.min(target, drag.contentSize - drag.spanPpq));
    }
    bump();
  }

  function onScrollUp(): void {
    scrollDrag = null;
  }

  return {
    vThumbStyle,
    hThumbStyle,
    onVScrollDown,
    onHScrollDown,
    onScrollMove,
    onScrollUp,
  };
}
