/**
 * Parameter-control descriptors for mastering chain processors.
 *
 * Mirrors the insert quick-control conventions: processor-specific domains
 * are resolved from the shared insert-param catalog first, with camelCase
 * name heuristics reserved for unknown custom processors.
 * Mastering chain slots are not strip inserts, so they cannot reuse the
 * strip-addressed quick-control targets directly.
 */

import type { InsertSlot } from '@/project/mixer';
import {
  type ProcessorControl,
  type ProcessorParamInfo,
  processorControls,
  processorControlValueFromMidi,
} from '@/project/processor-controls';
import { getWasmModule } from '@/project/store';

/** One mastering parameter control (knob, toggle, or enum menu). */
export type MasteringControl = ProcessorControl;

/** Resolves a processor name to its parameter names (injectable for tests). */
export type MasteringParamResolver = (processor: string) => string[];
/** Resolves typed runtime parameter metadata (injectable for tests). */
export type MasteringParamInfoResolver = (processor: string) => ProcessorParamInfo[];

/** Default param resolver: the wasm catalog, when the module is loaded. */
function defaultResolveParams(processor: string): string[] {
  try {
    const wasm = getWasmModule() as unknown as {
      masteringInsertParamNames?: (name: string) => string[];
    };
    if (typeof wasm.masteringInsertParamNames !== 'function') return [];
    return wasm.masteringInsertParamNames(processor);
  } catch {
    return [];
  }
}

function defaultResolveParamInfo(processor: string): ProcessorParamInfo[] {
  try {
    const wasm = getWasmModule() as unknown as {
      masteringInsertParamInfo?: (name: string) => ProcessorParamInfo[];
    };
    if (typeof wasm.masteringInsertParamInfo !== 'function') return [];
    return wasm.masteringInsertParamInfo(processor);
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
  resolveParamInfo: MasteringParamInfoResolver = defaultResolveParamInfo,
): MasteringControl[] {
  const catalogNames = resolveParams(slot.processor);
  return processorControls(
    slot.processor,
    catalogNames,
    slot.params,
    resolveParamInfo(slot.processor),
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
  return Math.min(control.max, Math.max(control.min, value));
}

/** Maps a mastering control's MIDI sweep into its native descriptor value. */
export function masteringControlValueFromMidi(
  control: MasteringControl,
  midiValue: number,
): number | boolean | string {
  return processorControlValueFromMidi(control, midiValue);
}
