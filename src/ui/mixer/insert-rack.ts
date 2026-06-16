/**
 * Insert-rack actions: thin, injectable bindings from the rack UI to the
 * undoable command layer, plus the pure bookkeeping for which slot stays
 * expanded across removals.
 */

import type { MixerStripTarget } from '@/project/commands';
import { addInsert, removeInsert, setInsertEnabled, setInsertSidechain } from '@/project/commands';
import type { InsertSlot } from '@/project/mixer';
import { applyChainReorder, moveIndex, planChainReorder } from '@/ui/mastering/chain-reorder';

/** Insert processors whose sidechain can be keyed from another track. */
export const SIDECHAIN_KEYED_PROCESSORS: readonly string[] = [
  'dynamics.duckingProcessor',
  'dynamics.sidechainRouter',
];

/**
 * True when a processor accepts an external sidechain key source (see
 * InsertSlot.sidechainSourceTrackId).
 *
 * @param processor Processor catalog name (e.g. 'dynamics.duckingProcessor').
 */
export function isSidechainKeyedProcessor(processor: string): boolean {
  return SIDECHAIN_KEYED_PROCESSORS.includes(processor);
}

/** Injectable command surface (defaults to the real command layer). */
export interface InsertRackCommands {
  addInsert: typeof addInsert;
  removeInsert: typeof removeInsert;
  setInsertEnabled: typeof setInsertEnabled;
  setInsertSidechain: typeof setInsertSidechain;
}

/** The real command layer (default dependency). */
const defaultCommands: InsertRackCommands = {
  addInsert,
  removeInsert,
  setInsertEnabled,
  setInsertSidechain,
};

/**
 * Appends a processor to a strip's insert chain (one undo entry).
 *
 * @param target Track id or 'master'.
 * @param processor Catalog id (e.g. 'dynamics.compressor').
 * @param commands Injectable command layer (tests).
 * @returns The new slot index.
 */
export function addInsertSlot(
  target: MixerStripTarget,
  processor: string,
  commands: InsertRackCommands = defaultCommands,
): number {
  return commands.addInsert(target, processor);
}

/**
 * Removes an insert slot (one undo entry).
 *
 * @param target Track id or 'master'.
 * @param index Slot index.
 * @param commands Injectable command layer (tests).
 */
export function removeInsertSlot(
  target: MixerStripTarget,
  index: number,
  commands: InsertRackCommands = defaultCommands,
): void {
  commands.removeInsert(target, index);
}

/**
 * Toggles a slot between enabled and bypassed (one undo entry).
 *
 * @param target Track id or 'master'.
 * @param index Slot index.
 * @param slot Current slot state (its enabled flag is inverted).
 * @param commands Injectable command layer (tests).
 */
export function toggleInsertEnabled(
  target: MixerStripTarget,
  index: number,
  slot: InsertSlot,
  commands: InsertRackCommands = defaultCommands,
): void {
  commands.setInsertEnabled(target, index, !slot.enabled);
}

/**
 * Recomputes the expanded slot index after a removal: removing the expanded
 * slot collapses the rack, removing an earlier slot shifts the index down.
 *
 * @param expanded Currently expanded index, or null.
 * @param removed Index that was removed.
 * @returns The new expanded index, or null.
 */
export function adjustExpandedAfterRemove(expanded: number | null, removed: number): number | null {
  if (expanded === null) return null;
  if (expanded === removed) return null;
  return expanded > removed ? expanded - 1 : expanded;
}

/**
 * Drag-reorders a strip's insert chain, moving the slot at `from` to `to`. The
 * move is planned over the append/remove/set-enabled primitives (shared with
 * the mastering rack) and then sidechain key sources — which the append
 * primitive does not carry — are restored on the moved slots.
 *
 * @param target Track id or 'master'.
 * @param slots Current insert chain, in order.
 * @param from Index of the dragged slot.
 * @param to Destination index after the move.
 * @param commands Injectable command layer (tests).
 */
export function reorderInsertSlots(
  target: MixerStripTarget,
  slots: ReadonlyArray<InsertSlot>,
  from: number,
  to: number,
  commands: InsertRackCommands = defaultCommands,
): void {
  const steps = planChainReorder(slots, from, to);
  if (steps.length === 0) return;
  applyChainReorder(steps, {
    remove: (index) => commands.removeInsert(target, index),
    append: (processor, params) => {
      commands.addInsert(target, processor, params);
    },
    setEnabled: (index, enabled) => commands.setInsertEnabled(target, index, enabled),
  });
  // Sidechain sources only exist on track strips and are dropped by append.
  if (typeof target === 'number') {
    const start = Math.min(from, to);
    moveIndex(slots, from, to)
      .slice(start)
      .forEach((slot, offset) => {
        const source = slot.sidechainSourceTrackId;
        if (source !== undefined && source !== null) {
          commands.setInsertSidechain(target, start + offset, source);
        }
      });
  }
}
