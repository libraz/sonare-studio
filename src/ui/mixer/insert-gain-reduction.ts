import { engineBusInsertAutomationIndex } from '@/engine/engine-declaration';
import type { InsertSlot, MixerStrip } from '@/project/mixer';
import { gainReductionAmountDb } from './master-meter';

/** How a strip's store inserts are declared to the engine. */
export type InsertChainKind = 'lane' | 'bus' | 'master';

/**
 * Maps a store insert slot to its index in the engine's per-insert
 * gain-reduction array, mirroring strip-sync's declaration of that strip.
 * Track and master scenes declare every store insert in order (the master's
 * realtime mastering-chain slots follow them). Bus scenes use the bus
 * automation index; per-insert readings only come from engines that have the
 * bus bypass setter, so every bus slot stays declared.
 *
 * @param kind Chain kind of the strip owning the slot.
 * @param strip The store strip.
 * @param storeIndex Slot index in `strip.inserts`.
 * @returns The engine insert index, or undefined when the slot is not declared.
 */
export function insertGainReductionEngineIndex(
  kind: InsertChainKind,
  strip: MixerStrip,
  storeIndex: number,
): number | undefined {
  if (kind === 'bus') return engineBusInsertAutomationIndex(strip, storeIndex, true);
  return storeIndex < strip.inserts.length ? storeIndex : undefined;
}

/**
 * Per-slot gain-reduction magnitudes (dB, positive) for a strip's inserts.
 * A bypassed slot, a slot past the engine reading, or one reducing less than
 * the display epsilon yields undefined.
 *
 * @param kind Chain kind of the strip owning the inserts.
 * @param strip The store strip.
 * @param valuesDb Engine per-insert gain reduction (each <= 0).
 * @returns One entry per store insert slot.
 */
export function insertGainReductionBySlot(
  kind: InsertChainKind,
  strip: MixerStrip,
  valuesDb: readonly number[],
): Array<number | undefined> {
  return strip.inserts.map((slot: InsertSlot, storeIndex) => {
    if (!slot.enabled) return undefined;
    const engineIndex = insertGainReductionEngineIndex(kind, strip, storeIndex);
    return engineIndex === undefined ? undefined : gainReductionAmountDb(valuesDb[engineIndex]);
  });
}
