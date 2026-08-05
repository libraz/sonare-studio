/**
 * Parameter-control descriptors for mastering chain processors.
 *
 * Mirrors the insert quick-control conventions: processor-specific domains
 * are resolved from the shared insert-param catalog first, with camelCase
 * name heuristics reserved for unknown custom processors.
 * Mastering chain slots are not strip inserts, so they cannot reuse the
 * strip-addressed quick-control targets directly.
 */

import { INSERT_PARAM_DOMAIN_FALLBACK, insertParamDomain } from '@/project/insert-param-domains';
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
  /** Value mapping across the knob travel (logarithmic when min > 0). */
  scale?: 'linear' | 'log';
  /** Value restored by the knob's double-click and Reset menu action. */
  defaultValue: number;
  /** Display unit (e.g. 'Hz', 'ms', 'dB'); omitted for unitless values. */
  unit?: string;
}

/** Resolves a processor name to its parameter names (injectable for tests). */
export type MasteringParamResolver = (processor: string) => string[];

/** One parameter range heuristic, matched by name pattern. */
interface ParamRangeRule {
  test: RegExp;
  min: number;
  max: number;
  scale?: 'linear' | 'log';
  unit?: string;
  fallback: number;
}

/** Fallback range heuristics keyed by camelCase parameter naming conventions. */
const PARAM_RANGE_RULES: ReadonlyArray<ParamRangeRule> = [
  { test: /thresholdDb$/i, min: -60, max: 0, unit: 'dB', fallback: -24 },
  { test: /Db$/, min: -24, max: 24, unit: 'dB', fallback: 0 },
  { test: /ratio$/i, min: 1, max: 20, fallback: 4 },
  { test: /Ms$/, min: 0, max: 5000, unit: 'ms', fallback: 10 },
  { test: /Hz$/, min: 20, max: 20000, scale: 'log', unit: 'Hz', fallback: 1000 },
  { test: /^q$|Q$/, min: 0.1, max: 18, scale: 'log', fallback: Math.SQRT1_2 },
];

/** Fallback range for parameters no rule matches (normalized amounts). */
const DEFAULT_PARAM_RULE: Omit<ParamRangeRule, 'test'> = { min: 0, max: 1, fallback: 0 };

/** Returns the range rule for a processor parameter. */
function paramRule(processor: string, name: string): Omit<ParamRangeRule, 'test'> {
  const heuristic = PARAM_RANGE_RULES.find((rule) => rule.test.test(name)) ?? DEFAULT_PARAM_RULE;
  const domain = insertParamDomain(processor, name);
  if (domain === INSERT_PARAM_DOMAIN_FALLBACK) return heuristic;
  return {
    min: domain.min,
    max: domain.max,
    ...(heuristic.scale !== undefined && domain.min > 0 ? { scale: heuristic.scale } : {}),
    ...(domain.unit ? { unit: domain.unit } : {}),
    fallback: Math.min(domain.max, Math.max(domain.min, heuristic.fallback)),
  };
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
 * merged with any explicitly set numeric params. Explicit values come first
 * so a saved parameter is never hidden by a long processor catalog.
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
  const names = [...new Set([...setNames, ...catalogNames])];
  return names.map((name) => {
    const rule = paramRule(slot.processor, name);
    const raw = slot.params[name];
    const control: MasteringControl = {
      id: name,
      name: humanizeParamName(name),
      value: typeof raw === 'number' ? raw : rule.fallback,
      min: rule.min,
      max: rule.max,
      defaultValue: rule.fallback,
    };
    if (rule.scale !== undefined && rule.min > 0) control.scale = rule.scale;
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
