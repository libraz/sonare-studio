/**
 * Parameter-control descriptors for mastering chain processors.
 *
 * Mirrors the insert quick-control conventions: processor-specific domains
 * are resolved from the shared insert-param catalog first, with camelCase
 * name heuristics reserved for unknown custom processors.
 * Mastering chain slots are not strip inserts, so they cannot reuse the
 * strip-addressed quick-control targets directly.
 */

import { clamp } from '@/lib/math';
import type { InsertSlot } from '@/project/mixer';
import {
  catalogParamInfo,
  catalogSlots,
  type ProcessorControl,
  type ProcessorParamInfo,
  processorControls,
  processorControlValueFromMidi,
} from '@/project/processor-controls';
import { getWasmModule } from '@/project/store';
import type { MasteringInsertName, MasteringInsertSlot } from '@/wasm/index.js';

/** One mastering parameter control (knob, toggle, or enum menu). */
export type MasteringControl = ProcessorControl;

/** Resolves a processor name to its parameter names (injectable for tests). */
export type MasteringParamResolver = (processor: string) => string[];
/** Resolves typed runtime parameter metadata (injectable for tests). */
export type MasteringParamInfoResolver = (processor: string) => ProcessorParamInfo[];
/** Resolves a processor's conditional key groups (injectable for tests). */
export type MasteringSlotResolver = (processor: string) => MasteringInsertSlot[];

/** Default param resolver: the wasm catalog, when the module is loaded. */
function defaultResolveParams(processor: string): string[] {
  try {
    const wasm = getWasmModule();
    if (typeof wasm.masteringInsertParamNames !== 'function') return [];
    return wasm.masteringInsertParamNames(processor as MasteringInsertName);
  } catch {
    return [];
  }
}

/**
 * Lists the parameter controls of a mastering chain slot: the catalog names
 * merged with any explicitly set params. Catalog order is shared with the
 * device and mixer racks, while saved extras are appended so a long catalog
 * remains stable across all three surfaces.
 *
 * @param slot The chain processor slot.
 * @param resolveParams Optional catalog resolver (tests, custom catalogs).
 * @returns Control descriptors (possibly empty).
 */
export function masteringProcessorControls(
  slot: InsertSlot,
  resolveParams: MasteringParamResolver = defaultResolveParams,
  resolveParamInfo: MasteringParamInfoResolver = catalogParamInfo,
  resolveSlots: MasteringSlotResolver = catalogSlots,
): MasteringControl[] {
  const catalogNames = resolveParams(slot.processor);
  return processorControls(
    slot.processor,
    catalogNames,
    slot.params,
    resolveParamInfo(slot.processor),
    resolveSlots(slot.processor),
  );
}

/**
 * Clamps a value to a control's range.
 *
 * @param control The control descriptor.
 * @param value Proposed value.
 * @returns The value clamped to [min, max].
 */
export function clampControlValue(control: MasteringControl, value: number): number {
  if (control.kind !== 'number') {
    throw new RangeError(`Control "${control.id}" is not numeric`);
  }
  return clamp(value, control.min, control.max);
}

/** Maps a mastering control's MIDI sweep into its native descriptor value. */
export function masteringControlValueFromMidi(
  control: MasteringControl,
  midiValue: number,
): number | boolean | string {
  return processorControlValueFromMidi(control, midiValue);
}
