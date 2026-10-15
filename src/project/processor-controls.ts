/**
 * Shared processor-control descriptors and catalog helpers.
 *
 * The project mirror stores processor parameters as ABI values, but the UI
 * needs to know how each value is edited. The engine's insert catalog
 * (masteringInsertParamInfo) is authoritative for that: its type, choices and
 * default decide whether a key is a toggle, a menu or a knob, and a key with no
 * automation id is read only when the insert is built. The descriptor also
 * supplies the display range (uiMin/uiMax), axis, unit, exclusive bounds, the
 * Nyquist ceiling and sibling dependencies. Names decide only for what the
 * descriptor leaves open.
 */

import { errorMessage } from '@/lib/errors';
import { isSwitchOn } from '@/lib/midi';
import { formatControlValue } from '@/ui/devices/knob-math';
import type {
  MasteringInsertParamDependency,
  MasteringInsertParamInfo,
  MasteringInsertParamUnit,
  MasteringInsertSlot,
} from '@/wasm/index.js';
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
  /** Display range; the accepted range in {@link accepts} may be wider. */
  min: number;
  max: number;
  scale?: 'linear' | 'log';
  defaultValue: number;
  unit?: string;
  /** What the engine accepts, when the catalog states it. */
  accepts?: NumberAcceptance;
  /** Siblings whose live value bounds this one, read as `this <relation> sibling`. */
  dependsOn?: ReadonlyArray<MasteringInsertParamDependency>;
  /** Siblings whose value moves this one's accepted range; the engine judges the combination. */
  coupledWith?: ReadonlyArray<string>;
}

/** Accepted range of a numeric parameter; null ends are unbounded. */
export interface NumberAcceptance {
  min: number | null;
  max: number | null;
  minExclusive: boolean;
  maxExclusive: boolean;
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
  Partial<
    Pick<
      MasteringInsertParamInfo,
      | 'id'
      | 'choices'
      | 'slot'
      | 'uiMin'
      | 'uiMax'
      | 'scale'
      | 'minExclusive'
      | 'maxExclusive'
      | 'dependsOn'
      | 'coupledWith'
    >
  >;

interface NumberControlSpec {
  kind: 'number';
  min: number;
  max: number;
  scale?: 'linear' | 'log';
  unit?: string;
  defaultValue: number;
  accepts?: NumberAcceptance;
  dependsOn?: ReadonlyArray<MasteringInsertParamDependency>;
  coupledWith?: ReadonlyArray<string>;
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
  wdfCircuit: 'WDF Circuit',
  guitar4x12: 'Guitar 4x12',
  bass8x10: 'Bass 8x10',
  guitar1x12Combo: 'Guitar 1x12 Combo',
  guitar2x12Open: 'Guitar 2x12 Open-Back',
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

/**
 * Hand windows for parameters whose descriptor states no display range or
 * bounds (open-ended gains, thresholds, times and frequencies). A descriptor
 * uiMin/uiMax or finite bound always replaces the matching end.
 */
const PARAM_RANGE_RULES: ReadonlyArray<ParamRangeRule> = [
  { test: /thresholdDb$/i, min: -60, max: 0, unit: 'dB', defaultValue: -24 },
  { test: /Db$/i, min: -24, max: 24, unit: 'dB', defaultValue: 0 },
  { test: /ratio$/i, min: 1, max: 20, defaultValue: 4 },
  { test: /Ms$/i, min: 0, max: 5000, unit: 'ms', defaultValue: 10 },
  { test: /Hz$/i, min: 20, max: 20000, scale: 'log', unit: 'Hz', defaultValue: 1000 },
  { test: /^q$|Q$/u, min: 0.1, max: 18, scale: 'log', defaultValue: Math.SQRT1_2 },
];

/** Readout suffix of each descriptor unit; '' shows a bare number. */
const UNIT_LABELS: Readonly<Record<MasteringInsertParamUnit, string>> = {
  dB: 'dB',
  dBFS: 'dBFS',
  LUFS: 'LUFS',
  Hz: 'Hz',
  ms: 'ms',
  s: 's',
  samples: 'smp',
  m: 'm',
  cm: 'cm',
  mm: 'mm',
  deg: '°',
  percent: '%',
  degC: '°C',
  V: 'V',
  inPerSec: 'in/s',
  dBPerOct: 'dB/oct',
  semitones: 'st',
  cents: 'ct',
  ratio: '',
  bits: 'bit',
  count: '',
  none: '',
};

/** Readout suffix for a descriptor unit; an unlisted unit shows as written. */
export function unitLabel(unit: string): string {
  return (UNIT_LABELS as Readonly<Record<string, string>>)[unit] ?? unit;
}

const DEFAULT_PARAM_RANGE: NumberControlSpec = {
  kind: 'number',
  min: 0,
  max: 1,
  defaultValue: 0,
};

/** Parameter catalogs per loaded module, keyed by processor and rate. */
const catalogCache = new WeakMap<object, Map<string, MasteringInsertParamInfo[]>>();

/** Construction-only key names per cached catalog entry list. */
const constructionOnlyCache = new WeakMap<object, ReadonlySet<string>>();

/** Rate the Nyquist-bounded ceilings are resolved at; undefined until the engine runs. */
let processingSampleRate: number | undefined;

/**
 * Sets the project/engine rate that Nyquist-bounded insert ceilings resolve
 * at. Controls built afterwards use the matching ceiling.
 */
export function setProcessingSampleRate(rate: number | undefined): void {
  processingSampleRate = rate !== undefined && rate > 0 ? rate : undefined;
}

/**
 * The loaded module's catalog metadata for one processor at the processing
 * rate, or [] before the module is initialized.
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
  const key = `${processor}@${processingSampleRate ?? ''}`;
  let entries = byProcessor.get(key);
  if (!entries) {
    try {
      entries = wasm.masteringInsertParamInfo(processor, processingSampleRate);
    } catch {
      // A rate outside the supported range still has a rate-less answer.
      try {
        entries = wasm.masteringInsertParamInfo(processor);
      } catch {
        entries = [];
      }
    }
    byProcessor.set(key, entries);
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

/** Share of the display span a control stays clear of an exclusive bound by. */
const EXCLUSIVE_INSET = 1e-3;

/**
 * Resolves a numeric range. The window starts from the hand rules (a name
 * heuristic, else the catalog bounds when both are finite), the descriptor's
 * uiMin/uiMax replace its ends, and the result is narrowed to the accepted
 * bounds. An end sitting on an exclusive bound is moved just inside it, and a
 * range reaching zero is drawn linear. The default
 * is the catalog's when it publishes one.
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
  min = info?.uiMin ?? min;
  max = info?.uiMax ?? max;
  const narrowedMin = clampToBounds(min, hardMin, hardMax);
  const narrowedMax = clampToBounds(max, hardMin, hardMax);
  if (narrowedMax > narrowedMin) {
    min = narrowedMin;
    max = narrowedMax;
  } else if (!(max > min)) {
    max = min + 1;
  }
  const declaredUnit = info?.unit ? unitLabel(info.unit) : undefined;
  const unit = declaredUnit ?? ((hasDomain ? domain.unit : '') || rule?.unit);
  let scale = info?.scale === 'log' || (info?.scale === undefined && rule?.scale === 'log');
  if (scale && min <= 0) {
    scale = false;
  } else if (info?.minExclusive && hardMin !== null && min === hardMin) {
    min += (max - min) * EXCLUSIVE_INSET;
  }
  if (info?.maxExclusive && hardMax !== null && max === hardMax) {
    max -= (max - min) * EXCLUSIVE_INSET;
  }
  const fallbackDefault = rule?.defaultValue ?? DEFAULT_PARAM_RANGE.defaultValue;
  const catalogDefault =
    typeof info?.default === 'number' && Number.isFinite(info.default) ? info.default : undefined;
  const coupledWith =
    info?.coupledWith && info.coupledWith.length > 0 ? info.coupledWith : undefined;
  // A coupled key's bounds hold only at its siblings' defaults, so they draw the knob but do not clamp.
  const accepts: NumberAcceptance | undefined =
    info && !coupledWith && (hardMin !== null || hardMax !== null)
      ? {
          min: hardMin,
          max: hardMax,
          minExclusive: info.minExclusive === true,
          maxExclusive: info.maxExclusive === true,
        }
      : undefined;
  const dependsOn = info?.dependsOn && info.dependsOn.length > 0 ? info.dependsOn : undefined;
  return {
    kind: 'number',
    min,
    max,
    ...(scale ? { scale: 'log' as const } : {}),
    ...(unit ? { unit } : {}),
    defaultValue: Math.min(max, Math.max(min, catalogDefault ?? fallbackDefault)),
    ...(accepts ? { accepts } : {}),
    ...(dependsOn ? { dependsOn } : {}),
    ...(coupledWith ? { coupledWith } : {}),
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
    ...(spec.accepts ? { accepts: spec.accepts } : {}),
    ...(spec.dependsOn ? { dependsOn: spec.dependsOn } : {}),
    ...(spec.coupledWith ? { coupledWith: spec.coupledWith } : {}),
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
  const bounded =
    typeof value === 'number' ? withinSiblings(processor, params, param, value) : value;
  assertCoupledKeysAccepted(processor, { ...params, [param]: bounded }, param);
  if (!CROSSOVER_CUTOFF.test(param)) return { ...params, [param]: bounded };
  const kept = Object.fromEntries(
    cutoffsInEffect(catalogParamInfo(processor), params).map((cutoff) => [
      cutoff.name,
      cutoff.value,
    ]),
  );
  return { ...kept, ...params, [param]: bounded };
}

/** An insert edit the engine refuses in combination with the coupled keys' current values. */
export class InsertConfigurationRefusedError extends Error {
  constructor(
    readonly processor: string,
    readonly param: string,
    /** The keys coupled to the edited one. */
    readonly related: ReadonlyArray<string>,
    detail: string,
  ) {
    super(`${processor} refuses ${param} with ${related.join(', ')}: ${detail}`);
    this.name = 'InsertConfigurationRefusedError';
  }
}

/** Rate an insert is built at to judge a configuration; a refused combination does not depend on it. */
const CONFIGURATION_CHECK_SAMPLE_RATE = 48000;

/** The always-read keys bounding one another with `param` through coupledWith/dependsOn, `param` first. */
function coupledGroup(info: ReadonlyArray<MasteringInsertParamInfo>, param: string): string[] {
  const touches = (entry: MasteringInsertParamInfo, key: string): boolean =>
    entry.coupledWith?.includes(key) === true ||
    entry.dependsOn?.some((dependency) => dependency.key === key) === true;
  const coupled = info.some(
    (entry) =>
      (entry.name === param && (entry.coupledWith?.length ?? 0) > 0) ||
      entry.coupledWith?.includes(param) === true,
  );
  if (!coupled) return [];
  const group = [param];
  for (let index = 0; index < group.length; index += 1) {
    const key = group[index];
    const own = info.find((entry) => entry.name === key);
    const neighbours = [
      ...(own?.coupledWith ?? []),
      ...(own?.dependsOn ?? []).map((dependency) => dependency.key),
      ...info.filter((entry) => touches(entry, key)).map((entry) => entry.name),
    ];
    for (const next of neighbours) if (!group.includes(next)) group.push(next);
  }
  return group.filter((key) => info.find((entry) => entry.name === key)?.slot === null);
}

/**
 * Asks the engine whether the coupled keys of an edited insert build. Only
 * those keys are sent: the engine refuses a key it would not read, such as a
 * band slot the configuration leaves out.
 *
 * @throws InsertConfigurationRefusedError when the engine refuses them.
 */
function assertCoupledKeysAccepted(
  processor: string,
  params: Readonly<Record<string, unknown>>,
  param: string,
): void {
  const info = catalogParamInfo(processor);
  const group = coupledGroup(info, param);
  if (group.length < 2) return;
  const wasm = getWasmModule();
  const subset: Record<string, number | boolean> = {};
  for (const key of group) {
    const value = params[key];
    if (typeof value === 'number' || typeof value === 'boolean') subset[key] = value;
  }
  try {
    wasm.masteringInsertTiming(
      processor,
      subset,
      processingSampleRate ?? CONFIGURATION_CHECK_SAMPLE_RATE,
    );
  } catch (error) {
    const detail = errorMessage(error);
    const own = info.find((entry) => entry.name === param)?.coupledWith ?? [];
    const related = [
      ...own,
      ...info
        .filter((entry) => entry.coupledWith?.includes(param) && !own.includes(entry.name))
        .map((entry) => entry.name),
    ];
    throw new InsertConfigurationRefusedError(processor, param, related, detail);
  }
}

/** A value held to the live value of each sibling its key depends on. */
function withinSiblings(
  processor: string,
  params: Readonly<Record<string, unknown>>,
  param: string,
  value: number,
): number {
  const dependsOn = catalogParamInfo(processor).find((entry) => entry.name === param)?.dependsOn;
  if (!dependsOn || dependsOn.length === 0) return value;
  return clampToAccepted({ min: 0, max: 1, dependsOn }, value, liveSiblingValue(processor, params));
}

/** Reads a sibling key's live value: the stored one, else the catalog default. */
export function liveSiblingValue(
  processor: string,
  params: Readonly<Record<string, unknown>>,
): (key: string) => number | undefined {
  return (key) => {
    const set = params[key];
    if (typeof set === 'number') return set;
    const fallback = catalogParamInfo(processor).find((entry) => entry.name === key)?.default;
    return typeof fallback === 'number' ? fallback : undefined;
  };
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
    const { accepts } = control;
    if (accepts?.minExclusive && accepts.min !== null && value <= accepts.min) {
      throw new RangeError(`Control "${control.id}" must be greater than ${accepts.min}`);
    }
    if (accepts?.maxExclusive && accepts.max !== null && value >= accepts.max) {
      throw new RangeError(`Control "${control.id}" must be less than ${accepts.max}`);
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

/**
 * Clamps an edited number to what the engine accepts: the accepted bounds
 * (an exclusive end is approached to just inside it) and each sibling the
 * control depends on. The display range does not bound it.
 *
 * @param control The numeric control being edited.
 * @param value Proposed value.
 * @param sibling Live value of a sibling key, or undefined when it has none.
 */
export function clampToAccepted(
  control: Pick<NumberProcessorControl, 'min' | 'max' | 'accepts' | 'dependsOn'>,
  value: number,
  sibling: (key: string) => number | undefined = () => undefined,
): number {
  const inset = (control.max - control.min) * EXCLUSIVE_INSET;
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  const { accepts } = control;
  if (accepts?.min != null) lo = accepts.min + (accepts.minExclusive ? inset : 0);
  if (accepts?.max != null) hi = accepts.max - (accepts.maxExclusive ? inset : 0);
  for (const dependency of control.dependsOn ?? []) {
    const live = sibling(dependency.key);
    if (live === undefined) continue;
    const other = live * (dependency.factor ?? 1);
    const strict = dependency.relation === 'lt' || dependency.relation === 'gt';
    const margin = strict ? (Number.isInteger(other) ? 1 : inset) : 0;
    if (dependency.relation === 'le' || dependency.relation === 'lt')
      hi = Math.min(hi, other - margin);
    else lo = Math.max(lo, other + margin);
  }
  return lo > hi ? value : Math.min(hi, Math.max(lo, value));
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
  if (control.kind === 'boolean') return isSwitchOn(cc);
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
