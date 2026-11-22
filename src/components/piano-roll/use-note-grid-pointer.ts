/**
 * Pointer input of the note grid: hover tracking for the HUD, theory card and
 * status readout, ghost-note activation, and forwarding of edit gestures to
 * the shared note interactions.
 */

import type { Ref } from 'vue';
import type { TheoryCardHold } from '@/components/compose/use-theory-card-hold';
import type { EditorNote } from '@/project/types';
import type { TimelineRange } from '@/ui/canvas/timeline-range';
import type { EditorToolId } from '@/ui/editor/tools';
import { type GhostNote, hitTestGhost } from './overlay';
import type {
  InteractionModifiers,
  InteractionPoint,
  NoteInteractions,
} from './use-note-interactions';

/** Configuration for {@link useNoteGridPointer}. */
export interface UseNoteGridPointerOptions {
  /** Grid props: viewport, notes, ghosts, the active tool and the gesture state. */
  props: {
    readonly range: TimelineRange;
    readonly notes: EditorNote[];
    readonly ghostNotes?: GhostNote[];
    readonly activeTool?: EditorToolId;
    readonly interactions: NoteInteractions;
  };
  /** Grid emit for ghost activation, the context menu and the hover readout. */
  emit: {
    (event: 'ghost-activate', ghost: GhostNote): void;
    (
      event: 'note-context',
      payload: { x: number; y: number; noteId: number | null; ppq: number },
    ): void;
    (event: 'hover-status', payload: { ppq: number; pitch: number } | null): void;
  };
  /** Grid root element pointer positions are relative to. */
  wrapper: Ref<HTMLDivElement | null>;
  /** Ghost note under the pointer. */
  hoveredGhost: Ref<GhostNote | null>;
  /** Editable note under the pointer during a passive hover. */
  hoveredNote: Ref<EditorNote | null>;
  /** Local pointer position over the grid, or null off it. */
  hoverPoint: Ref<InteractionPoint | null>;
  /** Theory-card hold released or dismissed as the pointer leaves. */
  cardHold: TheoryCardHold;
  /** Resolves the theory card for the hovered note. */
  updateTheoryCard(point: InteractionPoint): void;
  /** Schedules an overlay-layer repaint. */
  scheduleOverlay(): void;
}

/** Grid pointer handlers returned by {@link useNoteGridPointer}. */
export interface NoteGridPointer {
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  onPointerCancel(): void;
  onPointerLeave(): void;
  onDoubleClick(event: MouseEvent): void;
  onContextMenu(event: MouseEvent): void;
}

/**
 * Creates the pointer handlers of one note grid.
 *
 * @param options - The grid props, emit, root element, hover state and repaint hooks.
 * @returns The handlers bound on the grid root.
 */
export function useNoteGridPointer(options: UseNoteGridPointerOptions): NoteGridPointer {
  const {
    props,
    emit,
    wrapper,
    hoveredGhost,
    hoveredNote,
    hoverPoint,
    cardHold,
    updateTheoryCard,
    scheduleOverlay,
  } = options;

  function localPoint(event: MouseEvent): InteractionPoint {
    const rect = wrapper.value?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }

  function modifiers(event: MouseEvent): InteractionModifiers {
    return { shift: event.shiftKey, alt: event.altKey, meta: event.metaKey || event.ctrlKey };
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const point = localPoint(event);
    const mods = modifiers(event);
    // A press on a ghost note requests track/clip activation instead of an
    // editing gesture; alt keeps the current track and edits normally.
    if (!mods.alt && (props.activeTool === undefined || props.activeTool === 'select')) {
      const ghost = hitTestGhost(props.notes, props.ghostNotes ?? [], point, props.range);
      if (ghost) {
        emit('ghost-activate', ghost);
        return;
      }
    }
    props.interactions.onPointerDown(point, mods);
  }

  function onPointerMove(event: PointerEvent): void {
    const point = localPoint(event);
    const mods = modifiers(event);
    hoveredGhost.value =
      mods.alt || (props.activeTool !== undefined && props.activeTool !== 'select')
        ? null
        : hitTestGhost(props.notes, props.ghostNotes ?? [], point, props.range);
    // Mirror the ghost-note hover HUD for the active layer: surface the editable
    // note under the pointer so hovering an active note reads it out too. The
    // overlay suppresses it while a ghost is hovered or a gesture is in flight.
    if (hoveredGhost.value) {
      hoveredNote.value = null;
    } else {
      const hitId = props.interactions.hitNoteAt(point);
      hoveredNote.value =
        hitId === null ? null : (props.notes.find((note) => note.id === hitId) ?? null);
    }
    hoverPoint.value = point;
    updateTheoryCard(point);
    emit('hover-status', {
      ppq: Math.max(0, props.range.xToPpq(point.x)),
      pitch: props.range.yToPitch(point.y),
    });
    props.interactions.onPointerMove(point, mods);
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.button !== 0) return;
    props.interactions.onPointerUp(localPoint(event), modifiers(event));
  }

  function onPointerCancel(): void {
    hoveredGhost.value = null;
    hoveredNote.value = null;
    hoverPoint.value = null;
    cardHold.dismiss();
    emit('hover-status', null);
    props.interactions.cancel();
  }

  function onPointerLeave(): void {
    hoveredGhost.value = null;
    hoveredNote.value = null;
    hoverPoint.value = null;
    // The card is teleported outside the grid, so reaching its ⓘ leaves the grid
    // too; the grace period is what lets the pointer get there.
    cardHold.release();
    emit('hover-status', null);
    scheduleOverlay();
  }

  function onDoubleClick(event: MouseEvent): void {
    props.interactions.onDoubleClick(localPoint(event), modifiers(event));
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const point = localPoint(event);
    emit('note-context', {
      x: event.clientX,
      y: event.clientY,
      noteId: props.interactions.hitNoteAt(point),
      ppq: Math.max(0, props.range.xToPpq(point.x)),
    });
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    onDoubleClick,
    onContextMenu,
  };
}
