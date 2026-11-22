/**
 * Processor rack of the mastering panel: slot expansion, enable/remove,
 * parameter knob gestures, drag reordering and the add-processor popover.
 */

import { type ComputedRef, computed, onBeforeUnmount, type Ref, ref } from 'vue';
import {
  addMasteringProcessor,
  type CommandGestureOptions,
  removeMasteringProcessor,
  reorderMasteringProcessor,
  setMasteringEnabled,
  setMasteringParam,
} from '@/project/commands';
import { isSoloProcessor, type MasteringChainState } from '@/project/mixer';
import { useI18n } from '@/ui/i18n';
import {
  clampControlValue,
  type MasteringControl,
  masteringProcessorControls,
} from '@/ui/mastering/chain-controls';
import {
  groupInsertCatalogEntries,
  type InsertCatalogGroup,
  loadInsertCatalogEntries,
} from '@/ui/mixer/insert-catalog';
import { insertEditErrorMessage } from '@/ui/mixer/insert-edit-error';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';

/** Configuration for {@link useMasteringProcessorRack}. */
export interface UseMasteringProcessorRackOptions {
  /** The project mastering chain, or the default chain when none is stored. */
  chain: ComputedRef<MasteringChainState>;
  /** The panel's error banner. */
  error: Ref<string>;
  /** Runs an undoable edit, clearing the banner or setting it on a throw. */
  runCommand(action: () => void): void;
}

/** Rack state and actions returned by {@link useMasteringProcessorRack}. */
export interface MasteringProcessorRack {
  /** Index of the slot showing its parameter knobs, or null. */
  expandedIndex: Ref<number | null>;
  /** Parameter controls of the expanded slot. */
  expandedControls: ComputedRef<MasteringControl[]>;
  /** Expands a slot, or collapses it when already expanded. */
  toggleExpanded(index: number): void;
  /** Flips a slot's enabled state. */
  onToggleEnabled(index: number): void;
  /** Removes a slot, keeping the expanded slot in place. */
  onRemove(index: number): void;
  /** Applies a knob change; continuous drags coalesce into one undo entry. */
  onParamChange(index: number, control: MasteringControl, value: number, commit: boolean): void;
  /** Index of the slot being dragged, or null. */
  dragIndex: Ref<number | null>;
  /** Index of the slot under the drag, or null. */
  dragOverIndex: Ref<number | null>;
  /** Starts dragging a slot. */
  onDragStart(index: number, event: DragEvent): void;
  /** Tracks the drop target while a slot is dragged. */
  onDragOver(index: number, event: DragEvent): void;
  /** Moves the dragged slot to the drop target. */
  onDrop(index: number): void;
  /** Clears the drag state. */
  onDragEnd(): void;
  /** Moves a slot without dragging it. */
  onMoveProcessor(from: number, to: number): void;
  /** True while the add-processor popover is open. */
  addMenuOpen: Ref<boolean>;
  /** Processor catalog shown in the add-processor popover. */
  catalog: Ref<InsertCatalogGroup[]>;
  /** Opens the add-processor popover (reloading the catalog) or closes it. */
  toggleAddMenu(): void;
  /** Appends a processor and expands its slot. */
  onAddProcessor(processorId: string): void;
}

/**
 * Creates the processor rack editing state of the mastering panel.
 *
 * @param options - The mastering chain, error banner and command runner.
 * @returns Slot state, drag state, the add popover and their actions.
 */
export function useMasteringProcessorRack(
  options: UseMasteringProcessorRackOptions,
): MasteringProcessorRack {
  const { chain, error, runCommand } = options;
  const { t } = useI18n();

  // --- Processor rack ------------------------------------------------------------

  const expandedIndex = ref<number | null>(null);

  const expandedControls = computed<MasteringControl[]>(() => {
    const index = expandedIndex.value;
    if (index === null) return [];
    const slot = chain.value.processors[index];
    if (!slot) return [];
    return masteringProcessorControls(slot);
  });

  function toggleExpanded(index: number): void {
    expandedIndex.value = expandedIndex.value === index ? null : index;
  }

  function onToggleEnabled(index: number): void {
    const slot = chain.value.processors[index];
    if (!slot) return;
    runCommand(() => setMasteringEnabled(index, !slot.enabled));
  }

  function onRemove(index: number): void {
    runCommand(() => removeMasteringProcessor(index));
    if (expandedIndex.value !== null) {
      if (expandedIndex.value === index) expandedIndex.value = null;
      else if (expandedIndex.value > index) expandedIndex.value -= 1;
    }
  }

  /** In-flight knob gestures keyed by `${slot index}:${param}`. */
  const gestures = new Map<string, ValueGesture>();

  function onParamChange(
    index: number,
    control: MasteringControl,
    value: number,
    commit: boolean,
  ): void {
    if (control.kind === 'boolean' || control.kind === 'enum') {
      try {
        const next =
          control.kind === 'boolean'
            ? value >= 0.5
            : control.options.find((option) => option.value === value)?.value;
        if (next === undefined || typeof next === 'string') {
          throw new RangeError(`Invalid value for ${control.kind} control "${control.id}"`);
        }
        setMasteringParam(index, control.id, next, { commit: true });
        error.value = '';
      } catch (err) {
        error.value = insertEditErrorMessage(err, t.value);
      }
      return;
    }
    const gestureKey = `${index}:${control.id}`;
    const apply = (v: number, options: CommandGestureOptions): void => {
      setMasteringParam(index, control.id, clampControlValue(control, v), options);
    };
    try {
      if (!commit) {
        let gesture = gestures.get(gestureKey);
        if (!gesture) {
          gesture = createValueGesture(apply, control.value);
          gestures.set(gestureKey, gesture);
        }
        gesture.update(value);
      } else {
        const gesture = gestures.get(gestureKey);
        if (gesture) gesture.end(value);
        else apply(value, { commit: true });
        gestures.delete(gestureKey);
      }
      error.value = '';
    } catch (err) {
      error.value = insertEditErrorMessage(err, t.value);
    }
  }

  // --- Drag reorder ----------------------------------------------------------------

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
    runCommand(() => {
      reorderMasteringProcessor(from, index);
    });
    expandedIndex.value = null;
  }

  function onDragEnd(): void {
    dragIndex.value = null;
    dragOverIndex.value = null;
  }

  function onMoveProcessor(from: number, to: number): void {
    runCommand(() => reorderMasteringProcessor(from, to));
    expandedIndex.value = null;
  }

  // --- Add processor popover -------------------------------------------------------

  const addMenuOpen = ref(false);
  const catalog = ref<InsertCatalogGroup[]>([]);

  function toggleAddMenu(): void {
    if (!addMenuOpen.value) {
      // The mastering chain runs offline, so it may use the full processor set.
      catalog.value = groupInsertCatalogEntries(loadInsertCatalogEntries('offline'));
    }
    addMenuOpen.value = !addMenuOpen.value;
  }

  function onAddProcessor(processorId: string): void {
    addMenuOpen.value = false;
    runCommand(() => {
      if (!isSoloProcessor(processorId)) {
        throw new RangeError(`Unknown mastering processor: ${processorId}`);
      }
      expandedIndex.value = addMasteringProcessor(processorId);
    });
  }
  onBeforeUnmount(() => {
    for (const gesture of gestures.values()) gesture.end();
    gestures.clear();
  });

  return {
    expandedIndex,
    expandedControls,
    toggleExpanded,
    onToggleEnabled,
    onRemove,
    onParamChange,
    dragIndex,
    dragOverIndex,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    onMoveProcessor,
    addMenuOpen,
    catalog,
    toggleAddMenu,
    onAddProcessor,
  };
}
