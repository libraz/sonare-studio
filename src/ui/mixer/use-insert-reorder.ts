/**
 * Drag-and-drop reordering of insert slots: the dragged and hovered slot, and
 * the single undoable reorder applied on drop.
 */

import { type ComputedRef, type Ref, ref } from 'vue';
import { describeError } from '@/lib/errors';
import type { MixerStripTarget } from '@/project/commands';
import type { MixerStrip } from '@/project/mixer';
import { useI18n } from '@/ui/i18n';
import { reorderInsertSlots } from '@/ui/mixer/insert-rack';

/** Configuration for {@link useInsertReorder}. */
export interface UseInsertReorderOptions {
  /** Rack props: the strip target being reordered. */
  props: {
    readonly target: MixerStripTarget;
  };
  /** The strip whose inserts the rack shows. */
  strip: ComputedRef<MixerStrip>;
  /** Expanded slot index; a reorder collapses it. */
  expandedIndex: Ref<number | null>;
  /** The rack's error banner, set when a reorder is rejected. */
  error: Ref<string>;
}

/** Drag state and handlers returned by {@link useInsertReorder}. */
export interface InsertReorder {
  /** Slot currently hovered by a reorder drag, or null. */
  dragOverIndex: Ref<number | null>;
  /** Starts dragging a slot. */
  onDragStart(index: number, event: DragEvent): void;
  /** Marks a slot as the drop target. */
  onDragOver(index: number, event: DragEvent): void;
  /** Moves the dragged slot to the drop position. */
  onDrop(index: number): void;
  /** Clears the drag state. */
  onDragEnd(): void;
}

/**
 * Creates the drag-reorder state of one insert rack.
 *
 * @param options - The rack props, the strip, the expanded slot and the error banner.
 * @returns The hovered slot and the drag handlers.
 */
export function useInsertReorder(options: UseInsertReorderOptions): InsertReorder {
  const { props, strip, expandedIndex, error } = options;
  const { t } = useI18n();

  // --- Drag reorder ------------------------------------------------------------

  const dragIndex = ref<number | null>(null);
  const dragOverIndex = ref<number | null>(null);

  function onDragStart(index: number, event: DragEvent): void {
    dragIndex.value = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  }

  function onDragOver(index: number, event: DragEvent): void {
    if (dragIndex.value === null) return;
    event.preventDefault();
    dragOverIndex.value = index;
  }

  function onDrop(index: number): void {
    const from = dragIndex.value;
    dragIndex.value = null;
    dragOverIndex.value = null;
    if (from === null || from === index) return;
    try {
      reorderInsertSlots(props.target, strip.value.inserts, from, index);
      expandedIndex.value = null;
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    }
  }

  function onDragEnd(): void {
    dragIndex.value = null;
    dragOverIndex.value = null;
  }

  return { dragOverIndex, onDragStart, onDragOver, onDrop, onDragEnd };
}
