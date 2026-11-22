/**
 * Per-insert gain reduction for the insert rack: the engine subscription
 * gated on dock visibility, and the readout state of the slots that reduce.
 */

import { type ComputedRef, computed, onBeforeUnmount, type Ref, ref, watch } from 'vue';
import type { MeterSource } from '@/engine/meters';
import type { MixerStripTarget } from '@/project/commands';
import { isMixerBusStripTarget } from '@/project/commands';
import type { InsertSlot, MixerStrip } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatLevel } from '@/ui/mastering/loudness';
import { type InsertChainKind, insertGainReductionBySlot } from '@/ui/mixer/insert-gain-reduction';
import { gainReductionFraction } from '@/ui/mixer/master-meter';

/** Configuration for {@link useInsertGainReduction}. */
export interface UseInsertGainReductionOptions {
  /** Rack props: the strip target, its meter source and the dock visibility. */
  props: {
    readonly target: MixerStripTarget;
    readonly meter: MeterSource | null;
    readonly visible: boolean;
  };
  /** The strip whose inserts the rack shows. */
  strip: ComputedRef<MixerStrip>;
}

/** Gain-reduction readout state returned by {@link useInsertGainReduction}. */
export interface InsertGainReduction {
  /** Reduction magnitude (dB, 0.1 dB steps) per store slot; undefined when idle. */
  slotGrDb: Ref<Array<number | undefined>>;
  /** True once the slot has reduced, so it keeps a readout. */
  hasGrReadout(slot: InsertSlot, index: number): boolean;
  /** Readout text for the slot's current reduction. */
  grLabel(index: number): string;
  /** Bar fill fraction for the slot's current reduction. */
  grFraction(index: number): number;
}

/**
 * Subscribes the rack to its strip's per-insert gain reduction while visible.
 *
 * @param options - The rack props and the strip being shown.
 * @returns Per-slot reduction values and their readout formatting.
 */
export function useInsertGainReduction(
  options: UseInsertGainReductionOptions,
): InsertGainReduction {
  const { props, strip } = options;
  const store = useProjectStore();

  /** Chain kind deciding how store slots map to engine inserts. */
  const chainKind = computed<InsertChainKind>(() => {
    if (props.target === 'master') return 'master';
    if (isMixerBusStripTarget(props.target)) return 'bus';
    const target = props.target;
    return store.tracks.find((track) => track.id === target)?.kind === 'group' ? 'bus' : 'lane';
  });

  // --- Per-insert gain reduction -----------------------------------------------

  /** Reduction magnitude (dB, 0.1 dB steps) per store slot; undefined when idle. */
  const slotGrDb = ref<Array<number | undefined>>([]);
  /** Slots that have reduced at least once; only they keep a readout. */
  const grSlotKeys = ref(new Set<string>());

  function slotKey(slot: InsertSlot, index: number): string {
    return slot.id ?? `${index}:${slot.processor}`;
  }

  function onInsertGr(valuesDb: readonly number[]): void {
    const inserts = strip.value.inserts;
    const next = insertGainReductionBySlot(chainKind.value, strip.value, valuesDb).map((db) =>
      db === undefined ? undefined : Math.round(db * 10) / 10,
    );
    const current = slotGrDb.value;
    if (next.length === current.length && next.every((db, i) => db === current[i])) return;
    slotGrDb.value = next;
    next.forEach((db, i) => {
      const slot = inserts[i];
      if (db === undefined || !slot) return;
      const key = slotKey(slot, i);
      if (!grSlotKeys.value.has(key)) grSlotKeys.value = new Set(grSlotKeys.value).add(key);
    });
  }

  function hasGrReadout(slot: InsertSlot, index: number): boolean {
    return grSlotKeys.value.has(slotKey(slot, index));
  }

  function grLabel(index: number): string {
    const db = slotGrDb.value[index];
    return db === undefined ? '0.0' : `-${formatLevel(db)}`;
  }

  function grFraction(index: number): number {
    const db = slotGrDb.value[index];
    return db === undefined ? 0 : gainReductionFraction(db);
  }

  let unsubscribeGr: (() => void) | null = null;

  watch(
    () => [props.meter, props.visible] as const,
    ([meter, visible]) => {
      unsubscribeGr?.();
      unsubscribeGr = null;
      slotGrDb.value = [];
      if (meter && visible) unsubscribeGr = meter.subscribeInsertGainReduction(onInsertGr);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    unsubscribeGr?.();
    unsubscribeGr = null;
  });

  return { slotGrDb, hasGrReadout, grLabel, grFraction };
}
