/**
 * Shared processor-control descriptors and catalog helpers.
 *
 * The project mirror stores processor parameters as ABI values, but the UI
 * needs to know how each value is edited.  In particular, an omitted boolean
 * must not be mistaken for a numeric amount with a zero default.  The small
 * explicit catalog below is therefore authoritative for the non-numeric
 * processor keys; names alone remain numeric only for the legacy/custom
 * processor fallback.
 */

import { formatControlValue } from '@/ui/devices/knob-math';
import type { MasteringInsertParamInfo } from '@/wasm/index.js';
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
>;

interface NumberControlSpec {
  kind: 'number';
  name?: string;
  min: number;
  max: number;
  scale?: 'linear' | 'log';
  unit?: string;
  defaultValue: number;
}

interface BooleanControlSpec {
  kind: 'boolean';
  name?: string;
  defaultValue: boolean;
}

interface EnumControlSpec {
  kind: 'enum';
  name?: string;
  options: ReadonlyArray<ProcessorEnumOption>;
  defaultValue: string | number;
}

type ProcessorControlSpec = NumberControlSpec | BooleanControlSpec | EnumControlSpec;

const EQ_BAND_TYPE_OPTIONS: ReadonlyArray<ProcessorEnumOption> = [
  { value: 0, label: 'Peak' },
  { value: 1, label: 'Low Shelf' },
  { value: 2, label: 'High Shelf' },
  { value: 3, label: 'Low Pass' },
  { value: 4, label: 'High Pass' },
  { value: 5, label: 'Band Pass' },
  { value: 6, label: 'Notch' },
  { value: 7, label: 'Tilt Shelf' },
  { value: 8, label: 'Flat Tilt' },
];
const EQ_COEFF_MODE_OPTIONS: ReadonlyArray<ProcessorEnumOption> = [
  { value: 0, label: 'RBJ' },
  { value: 1, label: 'Vicanek' },
];
const EQ_PLACEMENT_OPTIONS: ReadonlyArray<ProcessorEnumOption> = [
  { value: 0, label: 'Stereo' },
  { value: 1, label: 'Left' },
  { value: 2, label: 'Right' },
  { value: 3, label: 'Mid' },
  { value: 4, label: 'Side' },
];
const EQ_PHASE_OPTIONS: ReadonlyArray<ProcessorEnumOption> = [
  { value: 0, label: 'Inherit' },
  { value: 1, label: 'Zero Latency' },
  { value: 2, label: 'Natural Phase' },
  { value: 3, label: 'Linear Phase' },
];
const EQ_GLOBAL_PHASE_OPTIONS: ReadonlyArray<ProcessorEnumOption> = EQ_PHASE_OPTIONS.filter(
  (option) => option.value !== 0,
);
const EQ_CUT_SLOPE_OPTIONS: ReadonlyArray<ProcessorEnumOption> = [
  { value: 0, label: '12 dB/oct' },
  { value: 1, label: '24 dB/oct' },
  { value: 2, label: '6 dB/oct' },
  { value: 3, label: '18 dB/oct' },
  { value: 4, label: '30 dB/oct' },
  { value: 5, label: '36 dB/oct' },
  { value: 6, label: '42 dB/oct' },
  { value: 7, label: '48 dB/oct' },
  { value: 8, label: '54 dB/oct' },
  { value: 9, label: '60 dB/oct' },
  { value: 10, label: '66 dB/oct' },
  { value: 11, label: '72 dB/oct' },
  { value: 12, label: '78 dB/oct' },
  { value: 13, label: '84 dB/oct' },
  { value: 14, label: '90 dB/oct' },
  { value: 15, label: '96 dB/oct' },
  { value: 16, label: 'Brickwall' },
];
const MULTIBAND_SLOPE_OPTIONS: ReadonlyArray<ProcessorEnumOption> = [
  { value: 0, label: 'LR2' },
  { value: 1, label: 'LR4' },
  { value: 2, label: 'LR8' },
];
const MULTIBAND_MODE_OPTIONS: ReadonlyArray<ProcessorEnumOption> = [
  { value: 0, label: 'Linkwitz-Riley' },
  { value: 1, label: 'Butterworth' },
  { value: 2, label: 'Bessel' },
  { value: 3, label: 'FIR Linear Phase' },
];

const EQ_BAND_TYPE_SPEC: EnumControlSpec = {
  kind: 'enum',
  options: EQ_BAND_TYPE_OPTIONS,
  defaultValue: 0,
};
const EQ_COEFF_MODE_SPEC: EnumControlSpec = {
  kind: 'enum',
  options: EQ_COEFF_MODE_OPTIONS,
  defaultValue: 0,
};
const EQ_PLACEMENT_SPEC: EnumControlSpec = {
  kind: 'enum',
  options: EQ_PLACEMENT_OPTIONS,
  defaultValue: 0,
};
const EQ_PHASE_SPEC: EnumControlSpec = {
  kind: 'enum',
  options: EQ_PHASE_OPTIONS,
  defaultValue: 0,
};
const EQ_GLOBAL_PHASE_SPEC: EnumControlSpec = {
  kind: 'enum',
  options: EQ_GLOBAL_PHASE_OPTIONS,
  defaultValue: 1,
};
const EQ_CUT_SLOPE_SPEC: EnumControlSpec = {
  kind: 'enum',
  options: EQ_CUT_SLOPE_OPTIONS,
  defaultValue: 0,
};
const MULTIBAND_SLOPE_SPEC: EnumControlSpec = {
  kind: 'enum',
  options: MULTIBAND_SLOPE_OPTIONS,
  defaultValue: 1,
};
const MULTIBAND_MODE_SPEC: EnumControlSpec = {
  kind: 'enum',
  options: MULTIBAND_MODE_OPTIONS,
  defaultValue: 0,
};

/** One explicit non-numeric ABI entry. */
export interface ProcessorCatalogEntry {
  processor: string;
  param: string;
  kind: 'boolean' | 'enum';
}

/** A processor-specific catalog of exposed non-numeric ABI parameters. */
const EXPLICIT_PROCESSOR_CONTROLS: Readonly<
  Record<string, Readonly<Record<string, ProcessorControlSpec>>>
> = {
  'dynamics.compressor': {
    autoMakeup: {
      kind: 'boolean',
      name: 'Auto Makeup',
      defaultValue: false,
    },
    detector: {
      kind: 'enum',
      name: 'Detector',
      options: [
        { value: 0, label: 'Peak' },
        { value: 1, label: 'RMS' },
        { value: 2, label: 'Log RMS' },
      ],
      defaultValue: 1,
    },
    sidechainHpfEnabled: {
      kind: 'boolean',
      name: 'Sidechain HPF',
      defaultValue: false,
    },
  },
  'dynamics.parallelComp': {
    linkedDetection: {
      kind: 'boolean',
      name: 'Linked Detection',
      defaultValue: true,
    },
    outputLimiter: {
      kind: 'boolean',
      name: 'Output Limiter',
      defaultValue: true,
    },
  },
  'dynamics.sidechainRouter': {
    sidechainHpfEnabled: {
      kind: 'boolean',
      name: 'Sidechain HPF',
      defaultValue: false,
    },
    monoSumming: {
      kind: 'boolean',
      name: 'Mono Summing',
      defaultValue: false,
    },
    keyListen: {
      kind: 'boolean',
      name: 'Key Listen',
      defaultValue: false,
    },
  },
  'dynamics.vocalRider': {
    linkedDetection: {
      kind: 'boolean',
      name: 'Linked Detection',
      defaultValue: true,
    },
  },
  'eq.equalizer': {
    autoGain: {
      kind: 'boolean',
      name: 'Auto Gain',
      defaultValue: false,
    },
    phaseMode: { ...EQ_GLOBAL_PHASE_SPEC, name: 'Phase Mode' },
  },
  'eq.linearPhase': {
    resolution: {
      kind: 'enum',
      name: 'Resolution',
      options: [
        { value: 0, label: 'Custom' },
        { value: 1, label: 'Low' },
        { value: 2, label: 'Medium' },
        { value: 3, label: 'High' },
        { value: 4, label: 'Very High' },
        { value: 5, label: 'Maximum' },
      ],
      defaultValue: 0,
    },
    usePartitionedConvolution: {
      kind: 'boolean',
      name: 'Partitioned Convolution',
      defaultValue: true,
    },
  },
  'eq.pultec': {
    componentModel: {
      kind: 'enum',
      name: 'Component Model',
      options: [
        { value: 0, label: 'Curve Only' },
        { value: 1, label: 'EQP1A WDF' },
      ],
      defaultValue: 0,
    },
  },
  'eq.cutFilter': {
    highPassSlope: { ...EQ_CUT_SLOPE_SPEC, name: 'High-Pass Slope' },
    highPassEnabled: { kind: 'boolean', name: 'High-Pass Enabled', defaultValue: false },
    lowPassSlope: { ...EQ_CUT_SLOPE_SPEC, name: 'Low-Pass Slope' },
    lowPassEnabled: { kind: 'boolean', name: 'Low-Pass Enabled', defaultValue: false },
  },
  'eq.bandPass': {
    bandPassEnabled: { kind: 'boolean', name: 'Band-Pass Enabled', defaultValue: true },
    notchEnabled: { kind: 'boolean', name: 'Notch Enabled', defaultValue: false },
  },
  'eq.shelving': {
    lowEnabled: { kind: 'boolean', name: 'Low Shelf Enabled', defaultValue: true },
    highEnabled: { kind: 'boolean', name: 'High Shelf Enabled', defaultValue: true },
  },
  'multiband.compressor': {
    slope: { ...MULTIBAND_SLOPE_SPEC, name: 'Crossover Slope' },
    mode: { ...MULTIBAND_MODE_SPEC, name: 'Crossover Mode' },
  },
  'multiband.expander': {
    slope: { ...MULTIBAND_SLOPE_SPEC, name: 'Crossover Slope' },
    mode: { ...MULTIBAND_MODE_SPEC, name: 'Crossover Mode' },
  },
  'multiband.limiter': {
    slope: { ...MULTIBAND_SLOPE_SPEC, name: 'Crossover Slope' },
    mode: { ...MULTIBAND_MODE_SPEC, name: 'Crossover Mode' },
  },
  'multiband.imager': {
    slope: { ...MULTIBAND_SLOPE_SPEC, name: 'Crossover Slope' },
    mode: { ...MULTIBAND_MODE_SPEC, name: 'Crossover Mode' },
  },
  'multiband.saturation': {
    slope: { ...MULTIBAND_SLOPE_SPEC, name: 'Crossover Slope' },
    mode: { ...MULTIBAND_MODE_SPEC, name: 'Crossover Mode' },
  },
  'multiband.dynamicEq': {
    slope: { ...MULTIBAND_SLOPE_SPEC, name: 'Crossover Slope' },
    mode: { ...MULTIBAND_MODE_SPEC, name: 'Crossover Mode' },
  },
  'saturation.ampSim': {
    cab: {
      kind: 'boolean',
      name: 'Cabinet',
      defaultValue: true,
    },
    cabModel: {
      kind: 'enum',
      name: 'Cabinet Model',
      options: [
        { value: 0, label: 'Guitar 4x12' },
        { value: 1, label: 'Bass 8x10' },
      ],
      defaultValue: 0,
    },
    ampModel: {
      kind: 'enum',
      name: 'Amp Model',
      options: [
        { value: 0, label: 'Classic Crunch' },
        { value: 1, label: 'Fender Clean' },
        { value: 2, label: 'Modern Hi-Gain' },
        { value: 3, label: 'Vintage Tweed' },
        { value: 4, label: 'Vox Chime' },
        { value: 5, label: 'Modern Rectifier' },
      ],
      defaultValue: 0,
    },
  },
  'saturation.bitcrusher': {
    ditherType: {
      kind: 'enum',
      name: 'Dither Type',
      options: [
        { value: 0, label: 'None' },
        { value: 1, label: 'RPDF' },
        { value: 2, label: 'TPDF' },
        { value: 3, label: 'Noise Shaped' },
      ],
      defaultValue: 0,
    },
  },
  'saturation.waveshaper': {
    curve: {
      kind: 'enum',
      name: 'Curve',
      options: [
        { value: 0, label: 'Tanh' },
        { value: 1, label: 'Arctan' },
        { value: 2, label: 'Asymmetric' },
      ],
      defaultValue: 0,
    },
  },
  'stereo.haasEnhancer': {
    delayRight: {
      kind: 'boolean',
      name: 'Delay Right',
      defaultValue: true,
    },
  },
  'stereo.imager': {
    preserveEnergy: {
      kind: 'boolean',
      name: 'Preserve Energy',
      defaultValue: true,
    },
  },
  'stereo.phaseAlign': {
    delayRight: {
      kind: 'boolean',
      name: 'Delay Right',
      defaultValue: true,
    },
  },
  'stereo.stereoBalance': {
    constantPower: {
      kind: 'boolean',
      name: 'Constant Power',
      defaultValue: true,
    },
  },
  'maximizer.truePeakLimiter': {
    applyGainAtInputRate: {
      kind: 'boolean',
      name: 'Apply Gain at Input Rate',
      defaultValue: false,
    },
  },
  'effects.reverb.velvet': {
    enableShelf: {
      kind: 'boolean',
      name: 'Enable Shelf',
      defaultValue: true,
    },
  },
};

const EQ_BAND_PROCESSORS = new Set([
  'eq.parametric',
  'eq.minimumPhase',
  'eq.linearPhase',
  'eq.dynamic',
  'eq.equalizer',
  'eq.midSide',
]);

/** Returns explicit nonnumeric catalog entries for inspection and tests. */
export function processorCatalogEntries(): ProcessorCatalogEntry[] {
  return Object.entries(EXPLICIT_PROCESSOR_CONTROLS).flatMap(([processor, params]) =>
    Object.entries(params).map(([param, spec]) => ({
      processor,
      param,
      kind: spec.kind as 'boolean' | 'enum',
    })),
  );
}

/** Returns the explicit spec for a known processor parameter, when present. */
export function explicitProcessorControlSpec(
  processor: string,
  param: string,
): ProcessorControlSpec | undefined {
  const direct = EXPLICIT_PROCESSOR_CONTROLS[processor]?.[param];
  if (direct) return direct;

  // EQ processors share the same construction-time band schema. The engine
  // expands it into band0..band23 (and mid/side variants), so resolve those
  // indexed keys from this explicit schema instead of treating an unset bool or
  // enum as the generic [0, 1] numeric fallback.
  if (
    EQ_BAND_PROCESSORS.has(processor) &&
    /^(?:band|midBand|sideBand)\d+\.(?:type|coeffMode|placement|phase|enabled|soloed|bypassed|proportionalQ|dynamic|autoThreshold)$/u.test(
      param,
    )
  ) {
    const field = param.slice(param.indexOf('.') + 1);
    if (field === 'type') return EQ_BAND_TYPE_SPEC;
    if (field === 'coeffMode') return EQ_COEFF_MODE_SPEC;
    if (field === 'placement') return EQ_PLACEMENT_SPEC;
    if (field === 'phase') return EQ_PHASE_SPEC;
    if (field === 'enabled') return { kind: 'boolean', defaultValue: true };
    return { kind: 'boolean', defaultValue: false };
  }

  // Multiband processors use indexed crossover-band keys. Their nonnumeric
  // per-band fields are the same enum/toggle shapes as their scalar siblings.
  if (processor === 'multiband.imager' && /^band\d+\.(?:enabled|preserveEnergy)$/u.test(param)) {
    return { kind: 'boolean', defaultValue: true };
  }
  if (processor === 'multiband.dynamicEq' && /^band\d+\.dyn\d+\.(?:type|enabled)$/u.test(param)) {
    return param.endsWith('.type') ? EQ_BAND_TYPE_SPEC : { kind: 'boolean', defaultValue: true };
  }
  return undefined;
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
 * then parameter-info-only names, then explicit app-catalog names, then saved
 * extras. Duplicate names retain their first occurrence.
 */
export function processorControlNames(
  processor: string,
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
  // The explicit app catalog is authoritative for nonnumeric ABI keys. Append
  // those entries even when an older/injected name-only resolver omits them so
  // an unset boolean is never silently downgraded to a numeric control.
  for (const name of Object.keys(EXPLICIT_PROCESSOR_CONTROLS[processor] ?? {})) append(name);
  for (const name of Object.keys(params)) append(name);
  return names;
}

/** Resolves one processor parameter's editing spec. */
export function processorControlSpec(
  processor: string,
  param: string,
  info?: ProcessorParamInfo,
): ProcessorControlSpec {
  const explicit = explicitProcessorControlSpec(processor, param);
  if (explicit) return explicit;
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
  const name = spec.name ?? humanizeProcessorControlName(param);
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

/** Builds all descriptors for one processor in the shared order. */
export function processorControls(
  processor: string,
  catalogNames: ReadonlyArray<string>,
  params: Readonly<Record<string, unknown>>,
  paramInfo: ReadonlyArray<ProcessorParamInfo> = [],
): ProcessorControl[] {
  const infoByName = new Map(paramInfo.map((info) => [info.name, info]));
  return processorControlNames(processor, catalogNames, paramInfo, params)
    .map((name) => processorControl(processor, name, params[name], infoByName.get(name)))
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
