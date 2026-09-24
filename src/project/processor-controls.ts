/**
 * Shared processor-control descriptors and catalog helpers.
 *
 * The project mirror stores processor parameters as ABI values, but the UI
 * needs to know how each value is edited. The engine's insert catalog
 * (masteringInsertParamInfo) is authoritative for that: its type, choices and
 * default decide whether a key is a toggle, a menu or a knob, and a key with no
 * automation id is read only when the insert is built. Names alone decide only
 * for a key the catalog does not describe.
 */

import { formatControlValue } from '@/ui/devices/knob-math';
import type { MasteringInsertParamInfo, MasteringInsertSlot } from '@/wasm/index.js';
import { type AutomationParam, parseInsertAutomationParam } from './automation';
import { insertIndexForAutomationRef } from './automation-insert';
import {
  INSERT_PARAM_DOMAIN_FALLBACK,
  type InsertParamDomain,
  insertParamDomain,
} from './insert-param-domains';
import type { MixerStrip } from './mixer';
import { getWasmModule } from './runtime';

/** Values accepted by a processor parameter command. */
export type ProcessorControlValue = number | boolean | string;

/** A SelectMenu option for an enum-valued processor parameter. */
export interface ProcessorEnumOption {
  value: string | number;
  label: string;
}

/** Common fields shared by every processor-control descriptor. */
interface ProcessorControlBase {
  /** ABI parameter key. */
  id: string;
  /** Human-readable label. */
  name: string;
}

/** A numeric parameter rendered as a knob. */
export interface NumberProcessorControl extends ProcessorControlBase {
  kind: 'number';
  value: number;
  min: number;
  max: number;
  scale?: 'linear' | 'log';
  defaultValue: number;
  unit?: string;
}

/** A boolean parameter rendered as a toggle button. */
export interface BooleanProcessorControl extends ProcessorControlBase {
  kind: 'boolean';
  value: boolean;
  defaultValue: boolean;
}

/** An enum parameter rendered as a SelectMenu. */
export interface EnumProcessorControl extends ProcessorControlBase {
  kind: 'enum';
  value: string | number;
  options: ReadonlyArray<ProcessorEnumOption>;
  defaultValue: string | number;
}

/** Discriminated descriptor shared by device, insert, and mastering racks. */
export type ProcessorControl =
  | NumberProcessorControl
  | BooleanProcessorControl
  | EnumProcessorControl;

/**
 * Catalog metadata for one insert parameter (masteringInsertParamInfo). The
 * bounds are hard limits construction accepts, not a display range; null
 * means the catalog knows of no limit.
 */
export type ProcessorParamInfo = Pick<
  MasteringInsertParamInfo,
  'name' | 'type' | 'unit' | 'min' | 'max' | 'default'
> &
  Partial<Pick<MasteringInsertParamInfo, 'id' | 'choices' | 'slot'>>;

interface NumberControlSpec {
  kind: 'number';
  min: number;
  max: number;
  scale?: 'linear' | 'log';
  unit?: string;
  defaultValue: number;
}

interface BooleanControlSpec {
  kind: 'boolean';
  defaultValue: boolean;
}

interface EnumControlSpec {
  kind: 'enum';
  options: ReadonlyArray<ProcessorEnumOption>;
  defaultValue: string | number;
}

type ProcessorControlSpec = NumberControlSpec | BooleanControlSpec | EnumControlSpec;

/** Menu labels for catalog choice names whose camelCase split reads poorly. */
const CHOICE_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  rbj: 'RBJ',
  lr2: 'LR2',
  lr4: 'LR4',
  lr8: 'LR8',
  rms: 'RMS',
  logRms: 'Log RMS',
  rpdf: 'RPDF',
  tpdf: 'TPDF',
  adaa1: 'ADAA 1',
  adaa2: 'ADAA 2',
  oversample4x: '4x Oversampling',
  firLinearPhase: 'FIR Linear Phase',
  eqp1aWdf: 'EQP-1A (WDF)',
  guitar4x12: 'Guitar 4x12',
  bass8x10: 'Bass 8x10',
};

/** Display label of a catalog choice name ('db24PerOct' -> '24 dB/oct'). */
export function choiceLabel(name: string): string {
  const override = CHOICE_LABEL_OVERRIDES[name];
  if (override !== undefined) return override;
  const slope = /^db(\d+)PerOct$/u.exec(name);
  if (slope) return `${slope[1]} dB/oct`;
  const spaced = name.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Camel-case to compact title-case control label. */
export function humanizeProcessorControlName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^(band|midBand|sideBand)(\d+)/i, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface ParamRangeRule {
  test: RegExp;
  min: number;
  max: number;
  scale?: 'linear' | 'log';
  unit?: string;
  defaultValue: number;
}

/** Shared fallback domains for unknown/custom insert parameters. */
const PARAM_RANGE_RULES: ReadonlyArray<ParamRangeRule> = [
  { test: /thresholdDb$/i, min: -60, max: 0, unit: 'dB', defaultValue: -24 },
  { test: /Db$/i, min: -24, max: 24, unit: 'dB', defaultValue: 0 },
  { test: /ratio$/i, min: 1, max: 20, defaultValue: 4 },
  { test: /Ms$/i, min: 0, max: 5000, unit: 'ms', defaultValue: 10 },
  { test: /Hz$/i, min: 20, max: 20000, scale: 'log', unit: 'Hz', defaultValue: 1000 },
  { test: /^q$|Q$/u, min: 0.1, max: 18, scale: 'log', defaultValue: Math.SQRT1_2 },
];

const DEFAULT_PARAM_RANGE: NumberControlSpec = {
  kind: 'number',
  min: 0,
  max: 1,
  defaultValue: 0,
};

/** Parameter catalogs per loaded module; a build's catalog never changes. */
const catalogCache = new WeakMap<object, Map<string, MasteringInsertParamInfo[]>>();

/** Construction-only key names per cached catalog entry list. */
const constructionOnlyCache = new WeakMap<object, ReadonlySet<string>>();

/**
 * The loaded module's catalog metadata for one processor, or [] before the
 * module is initialized.
 */
export function catalogParamInfo(processor: string): MasteringInsertParamInfo[] {
  let wasm: ReturnType<typeof getWasmModule>;
  try {
    wasm = getWasmModule();
  } catch {
    return [];
  }
  if (typeof wasm.masteringInsertParamInfo !== 'function') return [];
  let byProcessor = catalogCache.get(wasm);
  if (!byProcessor) {
    byProcessor = new Map();
    catalogCache.set(wasm, byProcessor);
  }
  let entries = byProcessor.get(processor);
  if (!entries) {
    try {
      entries = wasm.masteringInsertParamInfo(processor);
    } catch {
      entries = [];
    }
    byProcessor.set(processor, entries);
  }
  return entries;
}

/**
 * True when the engine reads a key only while it builds the insert: the
 * catalog gives it no automation id, so a change has to rebuild the insert.
 */
export function isConstructionOnlyParam(processor: string, param: string): boolean {
  const entries = catalogParamInfo(processor);
  let names = constructionOnlyCache.get(entries);
  if (!names) {
    names = new Set(entries.filter((entry) => entry.id === null).map((entry) => entry.name));
    constructionOnlyCache.set(entries, names);
  }
  return names.has(param);
}

/**
 * Value domain an insert-parameter automation lane is drawn in: the same
 * range the parameter's rack control uses. Undefined for a fader/pan lane or
 * a lane whose slot no longer exists.
 */
export function insertAutomationDomain(
  strip: Pick<MixerStrip, 'inserts'> | undefined,
  param: AutomationParam,
): InsertParamDomain | undefined {
  const ref = parseInsertAutomationParam(param);
  if (!ref || !strip) return undefined;
  const index = insertIndexForAutomationRef(strip.inserts, ref);
  const slot = index === undefined ? undefined : strip.inserts[index];
  if (!slot) return undefined;
  const info = catalogParamInfo(slot.processor).find((entry) => entry.name === ref.paramName);
  const spec = processorNumberSpec(slot.processor, ref.paramName, info);
  return { min: spec.min, max: spec.max, unit: spec.unit ?? '' };
}

/** Clamps a value into a range whose ends may be absent. */
function clampToBounds(value: number, min: number | null, max: number | null): number {
  const floored = min === null ? value : Math.max(min, value);
  return max === null ? floored : Math.min(max, floored);
}

/**
 * Resolves a numeric range: the app's display window (explicit domain, else a
 * name heuristic) narrowed to the catalog's hard bounds, with the catalog's
 * default when it publishes one. A parameter nothing in the app describes
 * takes the catalog bounds whole when both are finite.
 */
export function processorNumberSpec(
  processor: string,
  param: string,
  info?: ProcessorParamInfo,
): NumberControlSpec {
  const rule = PARAM_RANGE_RULES.find((candidate) => candidate.test.test(param));
  const domain = insertParamDomain(processor, param);
  const hasDomain = domain !== INSERT_PARAM_DOMAIN_FALLBACK;
  const hardMin = info?.min ?? null;
  const hardMax = info?.max ?? null;
  let min: number;
  let max: number;
  if (hasDomain) {
    ({ min, max } = domain);
  } else if (rule) {
    ({ min, max } = rule);
  } else if (hardMin !== null && hardMax !== null) {
    min = hardMin;
    max = hardMax;
  } else {
    ({ min, max } = DEFAULT_PARAM_RANGE);
  }
  const narrowedMin = clampToBounds(min, hardMin, hardMax);
  const narrowedMax = clampToBounds(max, hardMin, hardMax);
  if (narrowedMax > narrowedMin) {
    min = narrowedMin;
    max = narrowedMax;
  }
  const scale = rule?.scale;
  const unit = info?.unit || (hasDomain ? domain.unit : undefined) || rule?.unit;
  const fallbackDefault = rule?.defaultValue ?? DEFAULT_PARAM_RANGE.defaultValue;
  const catalogDefault =
    typeof info?.default === 'number' && Number.isFinite(info.default) ? info.default : undefined;
  return {
    kind: 'number',
    min,
    max,
    ...(scale !== undefined && min > 0 ? { scale } : {}),
    ...(unit ? { unit } : {}),
    defaultValue: Math.min(max, Math.max(min, catalogDefault ?? fallbackDefault)),
  };
}

/**
 * Returns the names in one stable order for every rack: engine/catalog order,
 * then parameter-info-only names, then saved extras. Duplicate names retain
 * their first occurrence.
 */
export function processorControlNames(
  catalogNames: ReadonlyArray<string>,
  paramInfo: ReadonlyArray<ProcessorParamInfo>,
  params: Readonly<Record<string, unknown>>,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const append = (name: string): void => {
    if (name.length === 0 || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const name of catalogNames) append(name);
  for (const info of paramInfo) append(info.name);
  for (const name of Object.keys(params)) append(name);
  return names;
}

/**
 * Resolves one processor parameter's editing spec, or null for a key no rack
 * control can edit (an embedded string or array).
 */
export function processorControlSpec(
  processor: string,
  param: string,
  info?: ProcessorParamInfo,
): ProcessorControlSpec | null {
  if (info?.type === 'string' || info?.type === 'array') return null;
  if (info?.choices && info.choices.length > 0) {
    const options = info.choices.map((choice) => ({
      value: choice.value,
      label: choiceLabel(choice.name),
    }));
    const declared = options.find((option) => option.value === info.default);
    return { kind: 'enum', options, defaultValue: (declared ?? options[0]).value };
  }
  if (info?.type === 'boolean') {
    return { kind: 'boolean', defaultValue: info.default === true };
  }
  return processorNumberSpec(processor, param, info);
}

/** Builds a descriptor for one parameter using its saved ABI value. */
export function processorControl(
  processor: string,
  param: string,
  rawValue: unknown,
  info?: ProcessorParamInfo,
): ProcessorControl | null {
  const spec = processorControlSpec(processor, param, info);
  if (!spec) return null;
  const name = humanizeProcessorControlName(param);
  if (spec.kind === 'boolean') {
    const value =
      typeof rawValue === 'boolean'
        ? rawValue
        : typeof rawValue === 'number' && Number.isFinite(rawValue)
          ? rawValue !== 0
          : spec.defaultValue;
    return { kind: 'boolean', id: param, name, value, defaultValue: spec.defaultValue };
  }
  if (spec.kind === 'enum') {
    if (spec.options.length === 0) return null;
    const valid = spec.options.some((option) => option.value === rawValue);
    const value = valid ? (rawValue as string | number) : spec.defaultValue;
    return {
      kind: 'enum',
      id: param,
      name,
      value,
      options: spec.options,
      defaultValue: spec.defaultValue,
    };
  }
  const raw = typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : undefined;
  return {
    kind: 'number',
    id: param,
    name,
    value: raw ?? spec.defaultValue,
    min: spec.min,
    max: spec.max,
    ...(spec.scale !== undefined && spec.min > 0 ? { scale: spec.scale } : {}),
    defaultValue: spec.defaultValue,
    ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
  };
}

/** A multiband crossover's cutoff key, `cutoff<i>Hz`. */
const CROSSOVER_CUTOFF = /^cutoff\d+Hz$/u;

/** Highest crossover cutoff a rack offers, the top of the Hz knob range. */
const CROSSOVER_CUTOFF_CEILING_HZ = 20000;

/** A crossover cutoff the insert reads, with the value it reads. */
interface CutoffInEffect {
  name: string;
  value: number;
}

/**
 * The crossover cutoffs an insert reads: the supplied cutoff keys when there
 * are any (they replace the default split whole), else the catalog defaults.
 */
function cutoffsInEffect(
  paramInfo: ReadonlyArray<ProcessorParamInfo>,
  params: Readonly<Record<string, unknown>>,
): CutoffInEffect[] {
  const cutoffs = paramInfo.filter((info) => CROSSOVER_CUTOFF.test(info.name));
  const supplied = cutoffs.flatMap((info) => {
    const value = params[info.name];
    return typeof value === 'number' ? [{ name: info.name, value }] : [];
  });
  if (supplied.length > 0) return supplied;
  return cutoffs.flatMap((info) =>
    typeof info.default === 'number' ? [{ name: info.name, value: info.default }] : [],
  );
}

/**
 * The params after one edit. A crossover cutoff edit also writes the other
 * cutoffs in effect: a partial cutoff set replaces the default split, so the
 * edit would otherwise drop the default cutoffs and their bands.
 */
export function editedProcessorParams<T extends Readonly<Record<string, unknown>>>(
  processor: string,
  params: T,
  param: string,
  value: number | boolean,
): T {
  if (!CROSSOVER_CUTOFF.test(param)) return { ...params, [param]: value };
  const kept = Object.fromEntries(
    cutoffsInEffect(catalogParamInfo(processor), params).map((cutoff) => [
      cutoff.name,
      cutoff.value,
    ]),
  );
  return { ...kept, ...params, [param]: value };
}

/** Conditional key groups per loaded module, by processor. */
const slotCache = new WeakMap<object, Map<string, MasteringInsertSlot[]>>();

/** The loaded module's conditional key groups of one processor, or [] before init. */
export function catalogSlots(processor: string): MasteringInsertSlot[] {
  let wasm: ReturnType<typeof getWasmModule>;
  try {
    wasm = getWasmModule();
  } catch {
    return [];
  }
  if (typeof wasm.masteringProcessorCatalog !== 'function') return [];
  let byProcessor = slotCache.get(wasm);
  if (!byProcessor) {
    byProcessor = new Map(wasm.masteringProcessorCatalog().map((entry) => [entry.id, entry.slots]));
    slotCache.set(wasm, byProcessor);
  }
  return byProcessor.get(processor) ?? [];
}

/** The names a rack shows, and a default for the cutoff that adds a band. */
interface VisibleSlotNames {
  names: string[];
  addCutoff?: CutoffInEffect;
}

/**
 * Keeps the conditional keys a rack should show: every key of a slot that
 * exists, plus one key (its frequency when it has one) of the first missing
 * `anyKey` slot of each family so another band can be added. Crossover
 * cutoffs show the ones in effect and the next one, which adds a band.
 */
function visibleSlotNames(
  names: ReadonlyArray<string>,
  params: Readonly<Record<string, unknown>>,
  paramInfo: ReadonlyArray<ProcessorParamInfo>,
  slots: ReadonlyArray<MasteringInsertSlot>,
): VisibleSlotNames {
  if (slots.length === 0) return { names: [...names] };
  const slotOf = new Map(paramInfo.map((info) => [info.name, info.slot ?? null]));
  const keysBySlot = new Map<string, string[]>();
  for (const name of names) {
    const slot = slotOf.get(name);
    if (slot) keysBySlot.set(slot, [...(keysBySlot.get(slot) ?? []), name]);
  }
  const cutoffs = cutoffsInEffect(paramInfo, params);
  const existing = new Set<string>();
  const offered = new Set<string>();
  const offeredFamilies = new Set<string>();
  // A parent slot is always listed before the slots naming it.
  for (const slot of slots) {
    if (slot.parent !== null && !existing.has(slot.parent)) continue;
    const keys = keysBySlot.get(slot.name) ?? [];
    const exists =
      slot.activation === 'always'
        ? cutoffs.length >= slot.minCrossoverCutoffs
        : keys.some((key) => params[key] !== undefined);
    if (exists) {
      existing.add(slot.name);
      continue;
    }
    const family = `${slot.parent ?? ''}|${slot.name.replace(/\d+$/u, '')}`;
    if (slot.activation !== 'anyKey' || offeredFamilies.has(family)) continue;
    offeredFamilies.add(family);
    const key = keys.find((name) => name.endsWith('.frequencyHz')) ?? keys[0];
    if (key !== undefined) offered.add(key);
  }
  const inEffect = new Set(cutoffs.map((cutoff) => cutoff.name));
  const nextCutoff = names.find((name) => CROSSOVER_CUTOFF.test(name) && !inEffect.has(name));
  const last = cutoffs.at(-1)?.value;
  return {
    names: names.filter((name) => {
      if (CROSSOVER_CUTOFF.test(name)) return inEffect.has(name) || name === nextCutoff;
      const slot = slotOf.get(name) ?? null;
      return slot === null || existing.has(slot) || offered.has(name);
    }),
    // Cutoffs must ascend, so the added one starts above the last in effect.
    ...(nextCutoff !== undefined && last !== undefined
      ? {
          addCutoff: {
            name: nextCutoff,
            value: Math.sqrt(last * CROSSOVER_CUTOFF_CEILING_HZ),
          },
        }
      : {}),
  };
}

/** Builds all descriptors for one processor in the shared order. */
export function processorControls(
  processor: string,
  catalogNames: ReadonlyArray<string>,
  params: Readonly<Record<string, unknown>>,
  paramInfo: ReadonlyArray<ProcessorParamInfo> = [],
  slots: ReadonlyArray<MasteringInsertSlot> = [],
): ProcessorControl[] {
  const infoByName = new Map(paramInfo.map((info) => [info.name, info]));
  const visible = visibleSlotNames(
    processorControlNames(catalogNames, paramInfo, params),
    params,
    paramInfo,
    slots,
  );
  const { addCutoff } = visible;
  return visible.names
    .map((name) => {
      const info = infoByName.get(name);
      const withDefault =
        addCutoff?.name === name && info ? { ...info, default: addCutoff.value } : info;
      return processorControl(processor, name, params[name], withDefault);
    })
    .filter((control): control is ProcessorControl => control !== null);
}

/** Ensures a value is valid for the descriptor before it reaches a command. */
export function validateProcessorControlValue(
  control: ProcessorControl,
  value: ProcessorControlValue,
): void {
  if (control.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`Control "${control.id}" requires a finite number`);
    }
    return;
  }
  if (control.kind === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new RangeError(`Control "${control.id}" requires a boolean`);
    }
    return;
  }
  if (!control.options.some((option) => option.value === value)) {
    throw new RangeError(`Invalid value for enum control "${control.id}": ${String(value)}`);
  }
}

/** Maps a MIDI CC sweep to the descriptor's native value type. */
export function processorControlValueFromMidi(
  control: ProcessorControl,
  midiValue: number,
): ProcessorControlValue {
  const cc = Math.min(127, Math.max(0, Number.isFinite(midiValue) ? midiValue : 0));
  if (control.kind === 'number') {
    if (control.scale === 'log' && control.min > 0 && control.max > control.min) {
      const t = cc / 127;
      return control.min * (control.max / control.min) ** t;
    }
    return control.min + (cc / 127) * (control.max - control.min);
  }
  if (control.kind === 'boolean') return cc >= 64;
  const index = Math.min(
    control.options.length - 1,
    Math.floor((cc / 128) * control.options.length),
  );
  return control.options[Math.max(0, index)]?.value ?? control.defaultValue;
}

/** Shared display resolver used by all three racks. */
export function formatProcessorControlValue(control: ProcessorControl): string {
  const legacy = control as unknown as {
    kind?: ProcessorControl['kind'];
    value: number | boolean | string;
    unit?: string;
    options?: ReadonlyArray<ProcessorEnumOption>;
  };
  if (legacy.kind === 'number' || legacy.kind === undefined) {
    return formatControlValue(
      typeof legacy.value === 'number' ? legacy.value : Number(legacy.value),
      legacy.unit,
    );
  }
  if (legacy.kind === 'boolean') return legacy.value ? 'On' : 'Off';
  const options = legacy.options ?? [];
  return options.find((option) => option.value === legacy.value)?.label ?? String(legacy.value);
}
