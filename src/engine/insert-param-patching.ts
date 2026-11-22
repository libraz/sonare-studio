import type { InsertParamValue, InsertSlot, MixerChannelLayout, MixerStrip } from '@/project/mixer';
import {
  catalogParamInfo,
  choiceValue,
  isConstructionOnlyParam,
} from '@/project/processor-controls';
import { currentWasmModule } from '@/project/runtime';
import { engineBusPanState } from './engine-declaration';

type InsertParamKind = 'structural' | 'patchableRoot' | 'patchableConditional';

/**
 * Classifies one insert parameter for strip structure and realtime updates.
 *
 * The catalog is the authority for whether a key has a realtime target and
 * whether its value belongs to a conditional insert slot. A missing catalog
 * is possible during engine startup, so retain the historical construction
 * check as a compatibility fallback. Once a processor has catalog metadata,
 * an unlisted saved key is structural: sending it through the realtime setter
 * would otherwise leave the engine and the persisted strip out of sync.
 */
function insertParamKind(slot: InsertSlot, key: string, value: unknown): InsertParamKind {
  if (typeof value !== 'number' && typeof value !== 'string') return 'structural';
  // A preset changes the entire amplifier configuration. Even on older WASM
  // catalogs that do not describe presetIndex, patching one numeric parameter
  // cannot replace the active rig: the insert must be constructed again.
  if (slot.processor === 'saturation.ampSim' && key === 'presetIndex') return 'structural';

  const entries = catalogParamInfo(slot.processor);
  const info = entries.find((entry) => entry.name === key);
  if (info !== undefined) {
    if (info.id === undefined || info.rtSafe === false) return 'structural';
    if (typeof value === 'string' && choiceValue(info, value) === undefined) return 'structural';
    return info.slot === undefined ? 'patchableRoot' : 'patchableConditional';
  }

  if (typeof value === 'string') return 'structural';
  // Before the catalog is initialized, preserve the previous behaviour for
  // known construction-only checks. An initialized catalog makes unknown
  // keys structural so a saved extra cannot be mistaken for a live target.
  if (
    currentWasmModule() === null &&
    entries.length === 0 &&
    !isConstructionOnlyParam(slot.processor, key)
  ) {
    return 'patchableRoot';
  }
  return 'structural';
}

/** The value the realtime setter takes for a param the engine can patch without rebuilding. */
function patchableValue(slot: InsertSlot, key: string, value: unknown): number | undefined {
  const kind = insertParamKind(slot, key, value);
  if (kind !== 'patchableRoot' && kind !== 'patchableConditional') return undefined;
  if (typeof value === 'number') return value;
  const info = catalogParamInfo(slot.processor).find((entry) => entry.name === key);
  return typeof value === 'string' ? choiceValue(info, value) : undefined;
}

/**
 * Insert params that affect scene structure: every value the engine reads only
 * while building the insert. Patchable numeric values are masked out.
 */
export function insertParamStructure(slot: InsertSlot): Record<string, InsertParamValue | null> {
  const entries: Array<[string, InsertParamValue | null]> = [];
  for (const [key, value] of Object.entries(slot.params).sort(([a], [b]) => a.localeCompare(b))) {
    const kind = insertParamKind(slot, key, value);
    // A top-level realtime value does not affect construction, so its
    // presence must not turn a knob drag into a full strip replacement.
    if (kind === 'patchableRoot') continue;
    // Conditional values need a stable presence marker. Adding/removing the
    // first key creates/destroys the nested processor state and must rebuild.
    entries.push([key, kind === 'patchableConditional' ? null : value]);
  }
  return Object.fromEntries(entries);
}

/** Patchable numeric insert params last seen by the engine, keyed by insert index. */
export function insertNumericParams(
  inserts: ReadonlyArray<InsertSlot>,
): Array<Record<string, number>> {
  return inserts.map((slot) =>
    Object.fromEntries(
      Object.entries(slot.params)
        .flatMap(([key, value]): Array<[string, number]> => {
          const patchable = patchableValue(slot, key, value);
          return patchable === undefined ? [] : [[key, patchable]];
        })
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

/** Replays changed numeric insert params without replacing the whole strip scene. */
export function syncInsertNumericParams(
  previous: ReadonlyArray<Record<string, number>>,
  next: ReadonlyArray<Record<string, number>>,
  sendInsertParam: (insertIndex: number, paramName: string, value: number) => void,
): void {
  for (let insertIndex = 0; insertIndex < next.length; insertIndex += 1) {
    const previousParams = previous[insertIndex] ?? {};
    for (const [paramName, value] of Object.entries(next[insertIndex])) {
      if (previousParams[paramName] !== value) sendInsertParam(insertIndex, paramName, value);
    }
  }
}

/** True when a previously applied root realtime key was removed from a slot. */
export function hasRemovedPatchableRootParam(
  previous: ReadonlyArray<Record<string, number>>,
  next: ReadonlyArray<Record<string, number>>,
  inserts: ReadonlyArray<InsertSlot>,
): boolean {
  for (let insertIndex = 0; insertIndex < previous.length; insertIndex += 1) {
    const slot = inserts[insertIndex];
    if (!slot) continue;
    const nextParams = next[insertIndex] ?? {};
    for (const [paramName, value] of Object.entries(previous[insertIndex] ?? {})) {
      if (paramName in nextParams) continue;
      if (insertParamKind(slot, paramName, value) === 'patchableRoot') return true;
    }
  }
  return false;
}

/**
 * Change-detection key for a bus strip's audible DSP. Folds the insert structure
 * together with the output trim/width/polarity stages so a change in any of them
 * re-sends the bus scene (the insert structure alone would miss a trim/width/
 * polarity edit that touched no insert). Numeric insert values are excluded so
 * knob drags can use the realtime param setter instead of replacing the scene.
 */
export function busStripDspKey(
  strip: MixerStrip | undefined,
  includeEnabled: boolean,
  includePan: boolean,
  channelLayout?: MixerChannelLayout,
): string {
  return JSON.stringify({
    ...(channelLayout !== undefined && channelLayout !== 'stereo' ? { channelLayout } : {}),
    inserts: (strip?.inserts ?? []).map((slot) => ({
      processor: slot.processor,
      params: insertParamStructure(slot),
      ...(includeEnabled ? { enabled: slot.enabled } : {}),
    })),
    inputTrimDb: strip?.inputTrimDb ?? 0,
    width: strip?.width ?? 1,
    polarityInvertLeft: strip?.polarityInvertLeft === true,
    polarityInvertRight: strip?.polarityInvertRight === true,
    ...(includePan ? { pan: engineBusPanState(strip) } : {}),
  });
}
