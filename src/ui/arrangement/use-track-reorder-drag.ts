/**
 * Grip drag reordering of the arrangement track headers: the in-flight drag
 * state behind the row feedback classes and the pointer handlers that commit
 * the new order.
 */

import { type Ref, ref } from 'vue';
import { reorderTracks } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import {
  type ArrangementRowLayout,
  reorderRowIndexForDelta,
} from '@/ui/arrangement/automation-rows';

/** One reorder drag in flight. */
interface ReorderDrag {
  trackId: number;
  fromIndex: number;
  toIndex: number;
  startClientY: number;
}

/** Configuration for {@link useTrackReorderDrag}. */
export interface UseTrackReorderDragOptions {
  /** Header list props supplying the row geometry the drag maps pointer deltas onto. */
  props: { readonly rowLayout: ArrangementRowLayout };
  /** Tracks the headers currently show, indexed like the rows. */
  displayTracks: Readonly<Ref<readonly EditorTrack[]>>;
}

/** Drag state and pointer handlers returned by {@link useTrackReorderDrag}. */
export interface TrackReorderDrag {
  /** The drag in flight, or null. */
  reorderDrag: Ref<ReorderDrag | null>;
  onGripPointerDown(track: EditorTrack, index: number, event: PointerEvent): void;
  onGripPointerMove(event: PointerEvent): void;
  /** Commits the new order when the pointer was released over another row. */
  onGripPointerUp(): void;
  onGripPointerCancel(): void;
}

/**
 * Creates the grip drag reordering for one track header list.
 *
 * @param options - Row geometry props and the displayed tracks.
 * @returns The drag state and pointer handlers.
 */
export function useTrackReorderDrag(options: UseTrackReorderDragOptions): TrackReorderDrag {
  const { props, displayTracks } = options;
  const store = useProjectStore();

  const reorderDrag = ref<ReorderDrag | null>(null);

  function onGripPointerDown(track: EditorTrack, index: number, event: PointerEvent): void {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    reorderDrag.value = {
      trackId: track.id,
      fromIndex: index,
      toIndex: index,
      startClientY: event.clientY,
    };
  }

  function onGripPointerMove(event: PointerEvent): void {
    const drag = reorderDrag.value;
    if (!drag) return;
    const toIndex = reorderRowIndexForDelta(
      props.rowLayout,
      drag.fromIndex,
      event.clientY - drag.startClientY,
    );
    if (toIndex !== drag.toIndex) reorderDrag.value = { ...drag, toIndex };
  }

  function onGripPointerUp(): void {
    const drag = reorderDrag.value;
    reorderDrag.value = null;
    if (!drag || drag.toIndex === drag.fromIndex) return;
    const ids = store.tracks.map((track) => track.id);
    const fromIndex = ids.indexOf(drag.trackId);
    const destinationId = displayTracks.value[drag.toIndex]?.id;
    if (fromIndex < 0 || destinationId === undefined) return;
    ids.splice(fromIndex, 1);
    const destinationIndex = ids.indexOf(destinationId);
    if (destinationIndex < 0) return;
    ids.splice(destinationIndex + (drag.fromIndex < drag.toIndex ? 1 : 0), 0, drag.trackId);
    reorderTracks(ids);
  }

  function onGripPointerCancel(): void {
    reorderDrag.value = null;
  }

  return {
    reorderDrag,
    onGripPointerDown,
    onGripPointerMove,
    onGripPointerUp,
    onGripPointerCancel,
  };
}
