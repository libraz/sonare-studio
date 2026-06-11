/**
 * Parameter-control descriptors for mastering chain processors.
 *
 * Mirrors the insert quick-control conventions: the wasm catalog exposes
 * parameter names only (masteringInsertParamNames), so display ranges are
 * inferred from the camelCase naming conventions of the processor params.
 * Mastering chain slots are not strip inserts, so they cannot reuse the
 * strip-addressed quick-control targets directly.
 */

import type { InsertSlot } from '@/project/mixer';
import { getWasmModule } from '@/project/store';

/** One mastering parameter control (a knob in the rack row). */
export interface MasteringControl {
  /** Parameter name (camelCase, see masteringInsertParamNames). */
  id: string;
  /** Display name. */
  name: string;
  /** Current value. */
  value: number;
  /** Lower bound of the control range. */
  min: number;
  /** Upper bound of the control range. */
  max: number;
  /** Display unit (e.g. 'Hz', 'ms', 'dB'); omitted for unitless values. */
  unit?: string;
}

/** Resolves a processor name to its parameter names (injectable for tests). */
export type MasteringParamResolver = (processor: string) => string[];

/** Maximum number of controls a processor row exposes. */
const MAX_CHAIN_CONTROLS = 8;

/** One parameter range heuristic, matched by name pattern. */
interface ParamRangeRule {
  test: RegExp;
  min: number;
  max: number;
  unit?: string;
  fallback: number;
}

/** Range heuristics keyed by camelCase parameter naming conventions. */
const PARAM_RANGE_RULES: ReadonlyArray<ParamRangeRule> = [
  { test: /thresholdDb$/i, min: -60, max: 0, unit: 'dB', fallback: -24 },
  { test: /Db$/, min: -24, max: 24, unit: 'dB', fallback: 0 },
  { test: /ratio$/i, min: 1, max: 20, fallback: 4 },
  { test: /Ms$/, min: 0, max: 5000, unit: 'ms', fallback: 10 },
  { test: /Hz$/, min: 20, max: 20000, unit: 'Hz', fallback: 1000 },
  { test: /(^q|Q)$/, min: 0.1, max: 18, fallback: Math.SQRT1_2 },
];

/** Fallback range for parameters no rule matches (normalized amounts). */
const DEFAULT_PARAM_RULE: Omit<ParamRangeRule, 'test'> = { min: 0, max: 1, fallback: 0 };

/** Returns the range rule for a parameter name. */
function paramRule(name: string): Omit<ParamRangeRule, 'test'> {
  return PARAM_RANGE_RULES.find((rule) => rule.test.test(name)) ?? DEFAULT_PARAM_RULE;
}

/** Splits a camelCase parameter name into a capitalized display name. */
function humanizeParamName(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

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

/**
 * Lists the parameter controls of a mastering chain slot: the catalog names
 * merged with any explicitly set numeric params, capped at eight controls.
 *
 * @param slot The chain processor slot.
 * @param resolveParams Optional catalog resolver (tests, custom catalogs).
 * @returns Control descriptors (possibly empty).
 */
export function masteringProcessorControls(
  slot: InsertSlot,
  resolveParams: MasteringParamResolver = defaultResolveParams,
): MasteringControl[] {
  const catalogNames = resolveParams(slot.processor);
  const setNames = Object.keys(slot.params).filter((name) => typeof slot.params[name] === 'number');
  const names = [...new Set([...catalogNames, ...setNames])].slice(0, MAX_CHAIN_CONTROLS);
  return names.map((name) => {
    const rule = paramRule(name);
    const raw = slot.params[name];
    const control: MasteringControl = {
      id: name,
      name: humanizeParamName(name),
      value: typeof raw === 'number' ? raw : rule.fallback,
      min: rule.min,
      max: rule.max,
    };
    if (rule.unit !== undefined) control.unit = rule.unit;
    return control;
  });
}

/**
 * Clamps a value to a control's range.
 *
 * @param control The control descriptor.
 * @param value Proposed value.
 * @returns The value clamped to [min, max].
 */
export function clampControlValue(control: MasteringControl, value: number): number {
  return Math.min(control.max, Math.max(control.min, value));
}
