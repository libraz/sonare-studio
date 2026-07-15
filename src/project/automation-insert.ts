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
  masteringAutomationParam,
  parseInsertAutomationParam,
  parseMasteringAutomationParam,
} from './automation';
import type { InsertSlot, MasteringChainState, MixerStrip } from './mixer';

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

/** Resolves a stable/current or legacy positional insert reference. */
export function insertIndexForAutomationRef(
  slots: ReadonlyArray<Pick<InsertSlot, 'id'>>,
  ref: { insertIndex?: number; processorId?: string },
): number | undefined {
  if (ref.processorId !== undefined) {
    const index = slots.findIndex((slot) => slot.id === ref.processorId);
    return index >= 0 ? index : undefined;
  }
  return ref.insertIndex;
}

/** Resolves a stable/current or legacy positional mastering reference. */
export function masteringIndexForAutomationRef(
  chain: MasteringChainState | undefined,
  ref: { processorIndex?: number; processorId?: string },
): number | undefined {
  if (!chain) return undefined;
  if (ref.processorId !== undefined) {
    const index = chain.processors.findIndex((slot) => slot.id === ref.processorId);
    return index >= 0 ? index : undefined;
  }
  return ref.processorIndex !== undefined && chain.processors[ref.processorIndex]
    ? ref.processorIndex
    : undefined;
}

/** Migrates legacy positional lane tokens to stable processor identities. */
export function migrateAutomationLanesToProcessorIds(
  lanes: ReadonlyArray<AutomationLaneState>,
  ctx: InsertLaneStripContext,
  masteringChain?: MasteringChainState,
): AutomationLaneState[] {
  return lanes.flatMap((lane): AutomationLaneState[] => {
    const masteringRef = parseMasteringAutomationParam(lane.param);
    if (masteringRef) {
      if (lane.target !== 'master') return [];
      const index = masteringIndexForAutomationRef(masteringChain, masteringRef);
      if (index === undefined) return [];
      const slot = masteringChain?.processors[index];
      if (!slot?.id) return [];
      const param = masteringAutomationParam(slot.id, masteringRef.paramName);
      return [param === lane.param ? lane : { ...lane, param }];
    }
    const insertRef = parseInsertAutomationParam(lane.param);
    if (!insertRef) return [lane];
    const strip = stripForAutomationTarget(lane.target, ctx);
    if (!strip) return [];
    const index = insertIndexForAutomationRef(strip.inserts, insertRef);
    if (index === undefined) return [];
    const slot = strip.inserts[index];
    if (!slot?.id) return [];
    const param = insertAutomationParam(slot.id, insertRef.paramName);
    return [param === lane.param ? lane : { ...lane, param }];
  });
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
  removedProcessorId?: string,
): AutomationLaneState[] {
  const out: AutomationLaneState[] = [];
  for (const lane of lanes) {
    const ref = lane.target === target ? parseInsertAutomationParam(lane.param) : undefined;
    if (ref === undefined) {
      out.push(lane);
      continue;
    }
    if (ref.processorId !== undefined) {
      if (ref.processorId !== removedProcessorId) out.push(lane);
      continue;
    }
    const insertIndex = ref.insertIndex as number;
    if (insertIndex === removedIndex) continue;
    if (insertIndex < removedIndex) {
      out.push(lane);
      continue;
    }
    out.push({ ...lane, param: insertAutomationParam(insertIndex - 1, ref.paramName) });
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
    if (ref.processorId !== undefined) {
      out.push(lane);
      continue;
    }
    const i = ref.insertIndex as number;
    let next = i;
    if (i === fromIndex) next = toIndex;
    else if (fromIndex < toIndex && i > fromIndex && i <= toIndex) next = i - 1;
    else if (fromIndex > toIndex && i >= toIndex && i < fromIndex) next = i + 1;
    out.push(next === i ? lane : { ...lane, param: insertAutomationParam(next, ref.paramName) });
  }
  return out;
}

/** Drops a removed mastering processor's lanes and shifts later slots down. */
export function remapMasteringLanesAfterRemoval(
  lanes: ReadonlyArray<AutomationLaneState>,
  removedIndex: number,
  removedProcessorId?: string,
): AutomationLaneState[] {
  const out: AutomationLaneState[] = [];
  for (const lane of lanes) {
    const ref = lane.target === 'master' ? parseMasteringAutomationParam(lane.param) : undefined;
    if (ref === undefined) {
      out.push(lane);
      continue;
    }
    if (ref.processorId !== undefined) {
      if (ref.processorId !== removedProcessorId) out.push(lane);
      continue;
    }
    const processorIndex = ref.processorIndex as number;
    if (processorIndex === removedIndex) continue;
    if (processorIndex < removedIndex) {
      out.push(lane);
      continue;
    }
    out.push({
      ...lane,
      param: masteringAutomationParam(processorIndex - 1, ref.paramName),
    });
  }
  return out;
}

/** Remaps mastering lanes so they follow a processor moved within the chain. */
export function remapMasteringLanesAfterReorder(
  lanes: ReadonlyArray<AutomationLaneState>,
  fromIndex: number,
  toIndex: number,
): AutomationLaneState[] {
  const out: AutomationLaneState[] = [];
  for (const lane of lanes) {
    const ref = lane.target === 'master' ? parseMasteringAutomationParam(lane.param) : undefined;
    if (ref === undefined) {
      out.push(lane);
      continue;
    }
    if (ref.processorId !== undefined) {
      out.push(lane);
      continue;
    }
    const index = ref.processorIndex as number;
    let next = index;
    if (index === fromIndex) next = toIndex;
    else if (fromIndex < toIndex && index > fromIndex && index <= toIndex) next = index - 1;
    else if (fromIndex > toIndex && index >= toIndex && index < fromIndex) next = index + 1;
    out.push(
      next === index ? lane : { ...lane, param: masteringAutomationParam(next, ref.paramName) },
    );
  }
  return out;
}

/**
 * Drops insert lanes whose stable processor id or legacy slot index no longer
 * exists on the target strip. Parameter compatibility is enforced
 * defensively by the sync/export layers.
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
    if (!strip) return false;
    if (ref.processorId !== undefined) {
      return insertIndexForAutomationRef(strip.inserts, ref) !== undefined;
    }
    return ref.insertIndex !== undefined && ref.insertIndex < strip.inserts.length;
  });
}
