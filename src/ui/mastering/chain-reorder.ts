/**
 * Reorder math for the mastering processor rack.
 *
 * The mastering command layer exposes only append / remove-at-index /
 * set-enabled mutations, so a drag-reorder is planned as a step sequence
 * over those primitives: the suffix of the chain starting at the lower of
 * the two indices is removed (from the end) and re-appended in the new
 * order, then bypassed slots get their enabled state restored (append
 * always creates enabled slots). Planning is pure; {@link applyChainReorder}
 * executes a plan against an injectable command surface.
 */

import type { InsertSlot } from '@/project/mixer';

/** One primitive mutation of a reorder plan, in execution order. */
export type ChainReorderStep =
  | { type: 'remove'; index: number }
  | { type: 'append'; processor: string; params: Record<string, number | boolean> }
  | { type: 'enable'; index: number; enabled: boolean };

/** Command surface a reorder plan executes against. */
export interface ChainReorderOps {
  /** Removes the processor slot at an index. */
  remove(index: number): void;
  /** Appends a processor slot (created enabled). */
  append(processor: string, params: Record<string, number | boolean>): void;
  /** Sets the enabled state of the slot at an index. */
  setEnabled(index: number, enabled: boolean): void;
}

/**
 * Returns a copy of the list with the item at `from` moved to `to` (the
 * index it occupies after the move). Out-of-range or equal indices return
 * an unchanged copy.
 *
 * @param list Source list (not mutated).
 * @param from Index of the moved item.
 * @param to Destination index after the move.
 * @returns The reordered copy.
 */
export function moveIndex<T>(list: ReadonlyArray<T>, from: number, to: number): T[] {
  const result = [...list];
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length ||
    from === to
  ) {
    return result;
  }
  const [moved] = result.splice(from, 1);
  result.splice(to, 0, moved);
  return result;
}

/**
 * Plans the step sequence that moves a mastering processor from one index to
 * another using only append / remove / set-enabled primitives.
 *
 * Only the chain suffix from `min(from, to)` is rebuilt; slots before it are
 * untouched. Parameter records are copied into the plan so executing it is
 * independent of later chain mutations.
 *
 * @param slots Current chain processors, in order.
 * @param from Index of the dragged slot.
 * @param to Destination index after the move.
 * @returns Steps in execution order; empty when the move is a no-op or the
 *   indices are out of range.
 */
export function planChainReorder(
  slots: ReadonlyArray<InsertSlot>,
  from: number,
  to: number,
): ChainReorderStep[] {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= slots.length ||
    to >= slots.length ||
    from === to
  ) {
    return [];
  }
  const start = Math.min(from, to);
  const desired = moveIndex(slots, from, to).slice(start);
  const steps: ChainReorderStep[] = [];
  for (let index = slots.length - 1; index >= start; index--) {
    steps.push({ type: 'remove', index });
  }
  for (const slot of desired) {
    steps.push({ type: 'append', processor: slot.processor, params: { ...slot.params } });
  }
  desired.forEach((slot, offset) => {
    if (!slot.enabled) {
      steps.push({ type: 'enable', index: start + offset, enabled: false });
    }
  });
  return steps;
}

/**
 * Executes a reorder plan against a command surface, in order.
 *
 * @param steps Plan from {@link planChainReorder}.
 * @param ops Command surface (the real mastering commands in the app).
 */
export function applyChainReorder(
  steps: ReadonlyArray<ChainReorderStep>,
  ops: ChainReorderOps,
): void {
  for (const step of steps) {
    if (step.type === 'remove') ops.remove(step.index);
    else if (step.type === 'append') ops.append(step.processor, step.params);
    else ops.setEnabled(step.index, step.enabled);
  }
}
