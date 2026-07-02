/**
 * Insert-parameter automation lane maintenance: helpers that keep insert lanes
 * consistent with the strips they target as inserts are added, removed or the
 * project is loaded. Insert lanes are encoded as structured automation params
 * (see {@link insertAutomationParam}); these helpers operate on the param token
 * so the rest of the automation pipeline stays index-agnostic.
 *
 * Pure data transforms: no store access, no reactivity.
 */

import {
  type AutomationLaneState,
  type AutomationTarget,
  busIdFromAutomationTarget,
  insertAutomationParam,
  isBusAutomationTarget,
  parseInsertAutomationParam,
} from './automation';
import type { MixerStrip } from './mixer';

/** Context for resolving an automation target to its mixer strip. */
export interface InsertLaneStripContext {
  /** Strip per track id (a track's `mixer`), used for numeric lane targets. */
  trackStrips: ReadonlyMap<number, MixerStrip | undefined>;
  /** The master strip. */
  master: MixerStrip;
  /** Return-bus strip per bus id, used for `bus:<id>` lane targets. */
  busStrips: ReadonlyMap<string, MixerStrip | undefined>;
}

/**
 * Resolves the strip an automation target addresses, or undefined when the
 * target names no live strip (an unknown track id or bus).
 *
 * @param target Lane target (track id / 'master' / `bus:<id>`).
 * @param ctx Strip lookup context.
 * @returns The matching strip, or undefined.
 */
export function stripForAutomationTarget(
  target: AutomationTarget,
  ctx: InsertLaneStripContext,
): MixerStrip | undefined {
  if (target === 'master') return ctx.master;
  if (isBusAutomationTarget(target)) return ctx.busStrips.get(busIdFromAutomationTarget(target));
  return ctx.trackStrips.get(target);
}

/**
 * Converts a store insert slot index to the engine insert index used by bus
 * strips, where disabled slots are omitted from the sent scene. Returns
 * undefined when the target slot is missing or disabled.
 */
export function enabledInsertAutomationIndex(
  strip: MixerStrip | undefined,
  storeInsertIndex: number,
): number | undefined {
  const slot = strip?.inserts[storeInsertIndex];
  if (!slot?.enabled) return undefined;
  let engineIndex = 0;
  for (let i = 0; i < storeInsertIndex; i += 1) {
    if (strip?.inserts[i]?.enabled) engineIndex += 1;
  }
  return engineIndex;
}

/**
 * Rebuilds the lane list after an insert slot was removed from a strip,
 * remapping or dropping the insert lanes that target that strip:
 *
 * - a lane on the removed slot is dropped,
 * - a lane on a later slot is shifted down by one (its index decrements),
 * - lanes on earlier slots, on other strips, or non-insert lanes are kept.
 *
 * Lanes that survive with a changed index get a freshly encoded param token.
 *
 * @param lanes Current automation lanes (not mutated).
 * @param target The strip whose insert was removed.
 * @param removedIndex Index of the removed slot.
 * @returns A new lane list with insert lanes remapped against the removal.
 */
export function remapInsertLanesAfterRemoval(
  lanes: ReadonlyArray<AutomationLaneState>,
  target: AutomationTarget,
  removedIndex: number,
): AutomationLaneState[] {
  const out: AutomationLaneState[] = [];
  for (const lane of lanes) {
    const ref = lane.target === target ? parseInsertAutomationParam(lane.param) : undefined;
    if (ref === undefined) {
      out.push(lane);
      continue;
    }
    if (ref.insertIndex === removedIndex) continue;
    if (ref.insertIndex < removedIndex) {
      out.push(lane);
      continue;
    }
    out.push({ ...lane, param: insertAutomationParam(ref.insertIndex - 1, ref.paramName) });
  }
  return out;
}

/**
 * Rebuilds the lane list after an insert slot moved within a strip, remapping
 * the insert lanes that target that strip to follow their slot's new index:
 *
 * - the moved slot's lane takes the destination index,
 * - a lane between the source and destination shifts one step toward the
 *   source (down by one when moving later, up by one when moving earlier),
 * - lanes outside that span, on other strips, or non-insert lanes are kept.
 *
 * Lanes whose index changes get a freshly encoded param token. A no-op move
 * (equal indices) returns the lanes unchanged.
 *
 * @param lanes Current automation lanes (not mutated).
 * @param target The strip whose insert moved.
 * @param fromIndex Source slot index.
 * @param toIndex Destination slot index.
 * @returns A new lane list with insert lanes remapped against the move.
 */
export function remapInsertLanesAfterReorder(
  lanes: ReadonlyArray<AutomationLaneState>,
  target: AutomationTarget,
  fromIndex: number,
  toIndex: number,
): AutomationLaneState[] {
  const out: AutomationLaneState[] = [];
  for (const lane of lanes) {
    const ref = lane.target === target ? parseInsertAutomationParam(lane.param) : undefined;
    if (ref === undefined) {
      out.push(lane);
      continue;
    }
    const i = ref.insertIndex;
    let next = i;
    if (i === fromIndex) next = toIndex;
    else if (fromIndex < toIndex && i > fromIndex && i <= toIndex) next = i - 1;
    else if (fromIndex > toIndex && i >= toIndex && i < fromIndex) next = i + 1;
    out.push(next === i ? lane : { ...lane, param: insertAutomationParam(next, ref.paramName) });
  }
  return out;
}

/**
 * Drops insert lanes whose slot index no longer exists on the target strip
 * (e.g. a loaded document referencing more inserts than the strip carries).
 * Only the slot index is validated here; processor/parameter compatibility is
 * enforced defensively by the sync/export layers.
 *
 * @param lanes Current automation lanes (not mutated).
 * @param ctx Strip lookup context.
 * @returns A new lane list with out-of-range insert lanes removed.
 */
export function pruneInsertLanesAgainstStrips(
  lanes: ReadonlyArray<AutomationLaneState>,
  ctx: InsertLaneStripContext,
): AutomationLaneState[] {
  return lanes.filter((lane) => {
    const ref = parseInsertAutomationParam(lane.param);
    if (ref === undefined) return true;
    const strip = stripForAutomationTarget(lane.target, ctx);
    return strip !== undefined && ref.insertIndex < strip.inserts.length;
  });
}
