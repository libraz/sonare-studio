/**
 * Upgrade of schema-4 project documents and version-1 track presets to the
 * libsonare 2.0 vocabulary. Every table is a frozen fact about what an older
 * build wrote and how 2.0 spells it, so none of them may follow later core
 * changes; the right-hand sides are typed against the core so a core rename
 * that invalidates one fails to compile.
 *
 * The walk runs on plain JSON before the typed loaders see it and never
 * mutates its input. Insert-parameter renames are keyed by processor; the
 * parameter segment of automation and MIDI-learn tokens is rewritten through
 * the processor its id or slot index names, so strips are upgraded first.
 */

import type {
  AutomationCurve,
  EqBandPhase,
  EqBandType,
  EqCoeffMode,
  EqStereoPlacement,
  MasteringChainConfig,
  MasteringInsertName,
  PanLaw,
  SampleLoopMode,
  SoloProcessor,
  SynthBodyType,
  SynthEngineMode,
  SynthFilterModel,
  SynthFilterOutput,
  SynthModDestination,
  SynthModSource,
} from '@libraz/libsonare';
import type { ChainPath, ChainPathValue } from '@/ui/mastering/chain-config-path';

type Json = Record<string, unknown>;
type Table<T extends string = string> = Readonly<Record<string, T>>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function eachObject(value: unknown, visit: (item: Json) => void): void {
  if (!Array.isArray(value)) return;
  for (const item of value) if (isObject(item)) visit(item);
}

function mapValue(obj: Json, key: string, table: Table): void {
  const value = obj[key];
  if (typeof value === 'string' && Object.hasOwn(table, value)) obj[key] = table[value];
}

/** Moves `from` to `to`; a value already stored under `to` wins. */
function renameKey(obj: Json, from: string, to: string): void {
  if (!Object.hasOwn(obj, from)) return;
  if (!Object.hasOwn(obj, to)) obj[to] = obj[from];
  delete obj[from];
}

/** Floor of the 2.0 dBFS threshold parameter domain. */
const MIN_THRESHOLD_DB = -890;

/**
 * Converts a 1.x linear amplitude threshold to the 2.0 dBFS parameter,
 * clamped to that parameter's domain (silence maps to its floor).
 */
export function linearToThresholdDb(linear: number): number {
  if (!(linear > 0)) return MIN_THRESHOLD_DB;
  return Math.min(0, Math.max(MIN_THRESHOLD_DB, 20 * Math.log10(linear)));
}

/**
 * Converts a 1.x denoiser gain floor (linear, 0..1) to the 2.0 positive
 * reduction depth in dB.
 */
export function gainFloorToReductionDb(gainFloor: number): number {
  return Math.abs(linearToThresholdDb(gainFloor));
}

const PAN_LAWS: Table<PanLaw> = {
  const3dB: 'const3Db',
  'const4.5dB': 'const4.5Db',
  const6dB: 'const6Db',
  linear0dB: 'linear0Db',
};

const CURVES: Table<AutomationCurve> = { 's-curve': 'sCurve' };

const EQ_TYPES: Table<EqBandType> = {
  Peak: 'peak',
  LowShelf: 'lowShelf',
  HighShelf: 'highShelf',
  LowPass: 'lowPass',
  HighPass: 'highPass',
  BandPass: 'bandPass',
  Notch: 'notch',
  AllPass: 'allPass',
  TiltShelf: 'tiltShelf',
  FlatTilt: 'flatTilt',
};
const EQ_COEFF_MODES: Table<EqCoeffMode> = { Rbj: 'rbj', Vicanek: 'vicanek' };
const EQ_PLACEMENTS: Table<EqStereoPlacement> = {
  Stereo: 'stereo',
  Left: 'left',
  Right: 'right',
  Mid: 'mid',
  Side: 'side',
};
const EQ_PHASES: Table<EqBandPhase> = {
  Inherit: 'inherit',
  ZeroLatency: 'zeroLatency',
  NaturalPhase: 'naturalPhase',
  LinearPhase: 'linearPhase',
};

const SYNTH_ENGINE_MODES: Table<SynthEngineMode> = {
  'karplus-strong': 'karplusStrong',
  'pipe-organ': 'pipeOrgan',
  'bowed-string': 'bowedString',
  'plucked-string': 'pluckedString',
  'free-reed': 'freeReed',
};
const SYNTH_FILTER_MODELS: Table<SynthFilterModel> = {
  'transistor-ladder': 'transistorLadder',
  'moog-ladder': 'transistorLadder',
  'diode-ladder': 'diodeLadder',
  'sallen-key': 'sallenKey',
  'svf-4-pole': 'svf4Pole',
};
const SYNTH_FILTER_OUTPUTS: Table<SynthFilterOutput> = {
  lowpass: 'lowPass',
  bandpass: 'bandPass',
  highpass: 'highPass',
};
const SYNTH_BODIES: Table<SynthBodyType> = { 'wood-tube': 'woodTube', 'brass-bell': 'brassBell' };
const SYNTH_MOD_SOURCES: Table<SynthModSource> = {
  'amp-env': 'ampEnv',
  'filter-env': 'filterEnv',
  'key-track': 'keyTrack',
  'mod-wheel': 'modWheel',
  'expression-cc': 'expressionCc',
  'pitch-bend': 'pitchBend',
};
const SYNTH_MOD_DESTINATIONS: Table<SynthModDestination> = {
  'pitch-cents': 'pitchCents',
  'cutoff-cents': 'cutoffCents',
  'amp-gain': 'ampGain',
  'pan-units': 'panUnits',
  'resonance-q': 'resonanceQ',
  'vibrato-depth-cents': 'vibratoDepthCents',
  'filter-env-depth': 'filterEnvDepth',
  'lfo1-rate-scale': 'lfo1RateScale',
  'excitation-force': 'excitationForce',
  'excitation-position': 'excitationPosition',
  'excitation-brightness': 'excitationBrightness',
  'spectrum-morph': 'spectrumMorph',
};
const SAMPLE_LOOP_MODES: Table<SampleLoopMode> = { 'key-down': 'keyDown' };

/** Retired processor ids, mapped to the catalog id that replaced each. */
const RENAMED_PROCESSORS: Table<SoloProcessor> = {
  'eq.pultec': 'eq.passiveTube',
  'eq.apiStyle': 'eq.steppedProportionalQ',
  'effects.reverb.dattorro': 'effects.reverb.plate',
};

/** One-to-one parameter renames per processor (1.x name -> 2.0 name). */
const PARAM_RENAMES: Readonly<Record<string, Table>> = {
  'dynamics.deesser': { bandpassQ: 'bandPassQ' },
  'dynamics.gate': { keyHpfHz: 'keyHighPassHz' },
  'effects.acoustic.roomMorph': { maxSeconds: 'maxSec' },
  'effects.reverb.room': { maxSeconds: 'maxSec' },
  'effects.reverb.velvet': { reverbTimeS: 'reverbTimeSec' },
  'effects.modulation.rotary': { accelTauS: 'accelTauSec', decelTauS: 'decelTauSec' },
  'effects.modulation.pitchShifter': {
    semitones: 'pitchSemitones',
    cents: 'pitchCents',
    semitones2: 'pitchSemitones2',
    cents2: 'pitchCents2',
  },
  'maximizer.adaptiveRelease': { ceilingDb: 'ceilingDbtp' },
  'maximizer.truePeakLimiter': { ceilingDb: 'ceilingDbtp' },
  'repair.declip': { clipThreshold: 'clipThresholdDb' },
  'repair.trimSilence': { threshold: 'thresholdDb' },
  'voice.changer': {
    retuneSemitones: 'retunePitchSemitones',
    eqHighpassHz: 'eqHighPassHz',
    retuneGrainSize: 'retuneGrainSizeSamples',
  },
};

/** 1.x parameters converted from a linear amplitude to dBFS. */
const LINEAR_TO_DB_PARAMS: Readonly<Record<string, string>> = {
  'repair.declip': 'clipThreshold',
  'repair.trimSilence': 'threshold',
};

/** 1.x `sidechainHpfHz` default, used when the filter was on with no frequency stored. */
const SIDECHAIN_HPF_DEFAULT_HZ: Readonly<Record<string, number>> = {
  'dynamics.compressor': 100,
  'dynamics.sidechainRouter': 90,
};

/** Per-band detector delay processors that renamed `lookaheadMs` in 2.0. */
const BAND_LOOKAHEAD = /^(band|midBand|sideBand)\d+\.(dyn\d+\.)?lookaheadMs$/;
const DETECTOR_DELAY_PROCESSORS = new Set([
  'eq.dynamic',
  'eq.equalizer',
  'eq.linearPhase',
  'eq.midSide',
  'eq.minimumPhase',
  'eq.parametric',
  'multiband.dynamicEq',
]);

/** Canonical per-band detector key, leaving other lookahead parameters intact. */
export function upgradeDetectorDelayParamName(processor: string, param: string): string {
  if (DETECTOR_DELAY_PROCESSORS.has(processor) && BAND_LOOKAHEAD.test(param)) {
    return param.replace(/lookaheadMs$/, 'detectorDelayMs');
  }
  return param;
}

/** 2.0 name of a 1.x parameter of `processor`, or the name unchanged. */
export function upgradeParamName(processor: string, param: string): string {
  const table = PARAM_RENAMES[processor];
  if (table !== undefined && Object.hasOwn(table, param)) return table[param];
  return upgradeDetectorDelayParamName(processor, param);
}

/** Catalog name of a closed-set insert parameter's stored ordinal, or undefined when it has none. */
type ChoiceNamer = (processor: string, param: string, ordinal: number) => string | undefined;

/**
 * Names stored ordinals through the 2.0 catalog: 1.x wrote the engine value
 * itself, and the catalog pairs each value with the name 2.0 stores.
 */
function catalogChoiceNamer(
  core: Pick<UpgradeCore, 'masteringInsertNames' | 'masteringInsertParamInfo'>,
): ChoiceNamer {
  const supported = new Set<string>(core.masteringInsertNames());
  const byProcessor = new Map<string, ReadonlyMap<string, ReadonlyMap<number, string>>>();
  const choicesOf = (processor: string): ReadonlyMap<string, ReadonlyMap<number, string>> => {
    let params = byProcessor.get(processor);
    if (params === undefined) {
      const entries = supported.has(processor)
        ? core.masteringInsertParamInfo({ insert: processor as MasteringInsertName })
        : [];
      params = new Map(
        entries
          .filter((info) => info.type === 'enum' && info.choices !== undefined)
          .map((info) => [
            info.name,
            new Map((info.choices ?? []).map((choice) => [choice.value, choice.name])),
          ]),
      );
      byProcessor.set(processor, params);
    }
    return params;
  };
  return (processor, param, ordinal) => choicesOf(processor).get(param)?.get(ordinal);
}

function upgradeInsertParams(processor: string, params: Json, names: ChoiceNamer): void {
  const linear = LINEAR_TO_DB_PARAMS[processor];
  if (linear !== undefined && typeof params[linear] === 'number') {
    params[linear] = linearToThresholdDb(params[linear]);
  }
  if (Object.hasOwn(SIDECHAIN_HPF_DEFAULT_HZ, processor)) {
    const hz = typeof params.sidechainHpfHz === 'number' ? params.sidechainHpfHz : undefined;
    // 2.0 spells "filter off" as absence of the corner frequency.
    if (params.sidechainHpfEnabled === true && !Object.hasOwn(params, 'sidechainHighPassHz')) {
      params.sidechainHighPassHz = hz ?? SIDECHAIN_HPF_DEFAULT_HZ[processor];
    }
    delete params.sidechainHpfEnabled;
    delete params.sidechainHpfHz;
  }
  // A zero grain size meant "automatic", which 2.0 spells as absence.
  if (processor === 'voice.changer' && params.retuneGrainSize === 0) delete params.retuneGrainSize;
  for (const key of Object.keys(params)) {
    const next = upgradeParamName(processor, key);
    if (next !== key) renameKey(params, key, next);
  }
  for (const [key, value] of Object.entries(params)) {
    const name = typeof value === 'number' ? names(processor, key, value) : undefined;
    if (name !== undefined) params[key] = name;
  }
}

/** Upgrades one insert list; returns each slot's (upgraded) processor id. */
function upgradeInsertSlots(
  slots: unknown,
  processorsById: Map<string, string>,
  names: ChoiceNamer,
): void {
  eachObject(slots, (slot) => {
    mapValue(slot, 'processor', RENAMED_PROCESSORS);
    const processor = typeof slot.processor === 'string' ? slot.processor : '';
    if (isObject(slot.params)) upgradeInsertParams(processor, slot.params, names);
    if (typeof slot.id === 'string' && !processorsById.has(slot.id)) {
      processorsById.set(slot.id, processor);
    }
  });
}

function upgradeEqBand(band: Json): void {
  mapValue(band, 'type', EQ_TYPES);
  mapValue(band, 'coeffMode', EQ_COEFF_MODES);
  mapValue(band, 'placement', EQ_PLACEMENTS);
  mapValue(band, 'phase', EQ_PHASES);
  renameKey(band, 'lookaheadMs', 'detectorDelayMs');
}

function upgradeStrip(
  strip: unknown,
  processorsById: Map<string, string>,
  names: ChoiceNamer,
): void {
  if (!isObject(strip)) return;
  mapValue(strip, 'panLaw', PAN_LAWS);
  if (isObject(strip.eq)) eachObject(strip.eq.bands, upgradeEqBand);
  if (isObject(strip.surroundPan)) {
    // Neither ever reached the panner, and 2.0 refuses both.
    delete strip.surroundPan.elevation;
    delete strip.surroundPan.distance;
  }
  upgradeInsertSlots(strip.inserts, processorsById, names);
}

/** 1.x dotted mastering override keys whose 2.0 path is not the key itself. */
const OVERRIDE_PATHS: Readonly<Record<string, ChainPath>> = {
  'loudness.ceilingDb': 'loudness.ceilingDbtp',
  'maximizer.truePeakLimiter.ceilingDb': 'maximizer.truePeakLimiter.ceilingDbtp',
  'dynamics.deesser.bandpassQ': 'dynamics.deesser.bandPassQ',
  'repair.reductionDb': 'repair.denoise.reductionDb',
  'repair.nFft': 'repair.denoise.nFft',
  'repair.hopLength': 'repair.denoise.hopLength',
  'repair.ddAlpha': 'repair.denoise.ddAlpha',
  'eq.tiltDb': 'eq.tilt.tiltDb',
  'eq.pivotHz': 'eq.tilt.pivotHz',
};

/** Closed-set override values 1.x stored as ordinals, in ordinal order; a hole had no 2.0 token. */
const OVERRIDE_ORDINALS: {
  readonly [P in ChainPath]?: ReadonlyArray<ChainPathValue<MasteringChainConfig, P> | undefined>;
} = {
  'repair.denoise.mode': ['logMmse', 'mmseStsa', 'spectralSubtraction'],
  'repair.denoise.noiseEstimator': ['quantile', 'mcra', 'imcra', 'spp'],
  'repair.decrackle.mode': ['median', 'waveletShrinkage'],
  'repair.dehum.mode': ['subtract', 'notch'],
  // 1.x already refused the two ADAA ordinals.
  'saturation.exciter.aliasing': ['none', undefined, undefined, 'oversample4x'],
  'dynamics.compressor.detector': ['peak', 'rms', 'logRms'],
};

function overrideValue(path: string, value: number | boolean): unknown {
  const tokens = (OVERRIDE_ORDINALS as Readonly<Record<string, ReadonlyArray<string | undefined>>>)[
    path
  ];
  return tokens !== undefined && typeof value === 'number' ? tokens[value] : value;
}

const MULTIBAND_KEY =
  /^dynamics\.multibandComp\.(low|mid|high)(AttackMs|ReleaseMs|Ratio|ThresholdDb)$/;
const MULTIBAND_BANDS = ['low', 'mid', 'high'];
const MULTIBAND_CUTOFFS: Readonly<Record<string, number>> = {
  'dynamics.multibandComp.lowCutoffHz': 0,
  'dynamics.multibandComp.highCutoffHz': 1,
};
const COMPRESSOR_HPF_ENABLED = 'dynamics.compressor.sidechainHpfEnabled';
const COMPRESSOR_HPF_HZ = 'dynamics.compressor.sidechainHpfHz';
const EMPTY_CHAIN_CONFIG = JSON.stringify({ version: 2, params: {} });
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

function nest(path: string, value: unknown): Json {
  return path
    .split('.')
    .reduceRight<unknown>((inner, segment) => ({ [segment]: inner }), value) as Json;
}

function mergeInto(target: Json, source: Json): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isObject(existing) && isObject(value)) mergeInto(existing, value);
    else target[key] = value;
  }
}

/** The core calls the upgrade reads mastering presets and chain configurations through. */
export type UpgradeCore = Pick<
  typeof import('@libraz/libsonare'),
  | 'masteringChainConfigFromJson'
  | 'masteringInsertNames'
  | 'masteringInsertParamInfo'
  | 'masteringPresetNames'
  | 'masteringPresetParams'
>;

/** A stored 1.x setting the upgrade could not carry into 2.0. */
export interface UpgradeDrop {
  /** Document path of the object the setting was stored in. */
  readonly location: string;
  /** The setting's 1.x key. */
  readonly key: string;
  readonly value: unknown;
  /** Why it was dropped; for a core refusal, the core's message. */
  readonly reason: string;
}

type OverrideDrop = Omit<UpgradeDrop, 'location'>;

/** The chain a 1.x override was applied over: the preset's, or the core defaults. */
function baseChain(preset: unknown, core: UpgradeCore): MasteringChainConfig {
  const known = core.masteringPresetNames().find((name) => name === preset);
  return known !== undefined
    ? core.masteringPresetParams(known)
    : core.masteringChainConfigFromJson(EMPTY_CHAIN_CONFIG);
}

/**
 * Converts a 1.x flat dotted-key mastering override map to the nested 2.0
 * `MasteringChainConfig`. 2.0 replaces the multiband band and cutoff lists
 * whole, so the entries 1.x left to the preset are filled from `preset`'s
 * chain. Each converted entry goes through the core's chain-config reader;
 * an entry it refuses is dropped and returned with the refusal.
 */
export function upgradeMasteringOverrides(
  flat: Json,
  preset: unknown,
  core: UpgradeCore,
): { overrides: Json; dropped: OverrideDrop[] } {
  const fragments: Array<{ keys: string[]; fragment: Json }> = [];
  const dropped: OverrideDrop[] = [];
  const bands: Json[] = [];
  const bandKeys: string[] = [];
  const cutoffs: number[] = [];
  const cutoffKeys: string[] = [];
  for (const [key, value] of Object.entries(flat)) {
    if (typeof value !== 'number' && typeof value !== 'boolean') {
      dropped.push({ key, value, reason: 'not a number or boolean' });
      continue;
    }
    const band = key.match(MULTIBAND_KEY);
    if (band) {
      const index = MULTIBAND_BANDS.indexOf(band[1]);
      bands[index] ??= {};
      bands[index][lowerFirst(band[2])] = value;
      bandKeys.push(key);
    } else if (Object.hasOwn(MULTIBAND_CUTOFFS, key) && typeof value === 'number') {
      cutoffs[MULTIBAND_CUTOFFS[key]] = value;
      cutoffKeys.push(key);
    } else if (key === 'repair.declip.lpcBlend') {
      dropped.push({ key, value, reason: 'The declipper no longer blends interpolation into LPC' });
    } else if (key === 'repair.declip.clipThreshold' && typeof value === 'number') {
      fragments.push({
        keys: [key],
        fragment: nest('repair.declip.clipThresholdDb', linearToThresholdDb(value)),
      });
    } else if (
      (key === 'repair.gainFloor' || key === 'repair.denoise.gainFloor') &&
      typeof value === 'number'
    ) {
      fragments.push({
        keys: [key],
        fragment: nest('repair.denoise.reductionDb', gainFloorToReductionDb(value)),
      });
    } else if (key === COMPRESSOR_HPF_ENABLED || key === COMPRESSOR_HPF_HZ) {
      // Folded below: 2.0 keeps only the corner frequency, absent = off.
    } else {
      const path = Object.hasOwn(OVERRIDE_PATHS, key) ? OVERRIDE_PATHS[key] : key;
      // An ordinal with no token stays numeric, and the reader refuses it.
      fragments.push({ keys: [key], fragment: nest(path, overrideValue(path, value) ?? value) });
    }
  }
  const hpfKeys = [COMPRESSOR_HPF_ENABLED, COMPRESSOR_HPF_HZ].filter((k) => Object.hasOwn(flat, k));
  if (flat[COMPRESSOR_HPF_ENABLED] === true) {
    const hz = flat[COMPRESSOR_HPF_HZ];
    const cornerHz = typeof hz === 'number' ? hz : SIDECHAIN_HPF_DEFAULT_HZ['dynamics.compressor'];
    fragments.push({
      keys: hpfKeys,
      fragment: nest('dynamics.compressor.sidechainHighPassHz', cornerHz),
    });
  }
  if (bandKeys.length > 0 || cutoffKeys.length > 0) {
    const multiband = baseChain(preset, core).dynamics?.multibandComp;
    if (bandKeys.length > 0) {
      const baseBands = multiband?.bands ?? [];
      const merged = MULTIBAND_BANDS.map((_, i) => ({ ...baseBands[i], ...bands[i] }));
      fragments.push({ keys: bandKeys, fragment: nest('dynamics.multibandComp.bands', merged) });
    }
    if (cutoffKeys.length > 0) {
      const baseCutoffs = multiband?.crossover?.cutoffsHz ?? [];
      const merged = [cutoffs[0] ?? baseCutoffs[0], cutoffs[1] ?? baseCutoffs[1]];
      fragments.push({
        keys: cutoffKeys,
        fragment: nest('dynamics.multibandComp.crossover.cutoffsHz', merged),
      });
    }
  }
  // The reader answers with the whole canonical chain, defaults included, so
  // it only decides acceptance; the stored override stays the fragment itself.
  const overrides: Json = {};
  for (const { keys, fragment } of fragments) {
    try {
      core.masteringChainConfigFromJson(JSON.stringify({ version: 2, params: fragment }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const key of keys) dropped.push({ key, value: flat[key], reason });
      continue;
    }
    mergeInto(overrides, fragment);
  }
  return { overrides, dropped };
}

function upgradeMixerState(
  mixer: unknown,
  location: string,
  processorsById: Map<string, string>,
  names: ChoiceNamer,
  core: UpgradeCore,
  dropped: UpgradeDrop[],
): void {
  if (!isObject(mixer)) return;
  upgradeStrip(mixer.master, processorsById, names);
  eachObject(mixer.buses, (bus) => upgradeStrip(bus.strip, processorsById, names));
  const chain = mixer.masteringChain;
  if (!isObject(chain)) return;
  upgradeInsertSlots(chain.processors, processorsById, names);
  if (isObject(chain.presetOverrides)) {
    const result = upgradeMasteringOverrides(chain.presetOverrides, chain.preset, core);
    chain.presetOverrides = result.overrides;
    const at = `${location}.masteringChain.presetOverrides`;
    for (const drop of result.dropped) dropped.push({ location: at, ...drop });
  }
}

/** 1.x kebab-case synth preset name -> 2.0 lowerCamel; a `va:` prefix is kept. */
export function upgradePresetName(name: string): string {
  const prefix = name.startsWith('va:') ? 'va:' : '';
  return (
    prefix + name.slice(prefix.length).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  );
}

function upgradeInstrument(instrument: unknown): void {
  if (!isObject(instrument)) return;
  if (instrument.kind === 'synth-preset' && typeof instrument.preset === 'string') {
    instrument.preset = upgradePresetName(instrument.preset);
  }
  if (instrument.kind !== 'synth-patch' || !isObject(instrument.patch)) return;
  const patch = instrument.patch;
  if (typeof patch.preset === 'string') patch.preset = upgradePresetName(patch.preset);
  mapValue(patch, 'engineMode', SYNTH_ENGINE_MODES);
  mapValue(patch, 'filterModel', SYNTH_FILTER_MODELS);
  mapValue(patch, 'filterOutput', SYNTH_FILTER_OUTPUTS);
  mapValue(patch, 'body', SYNTH_BODIES);
  mapValue(patch, 'sampleLoop', SAMPLE_LOOP_MODES);
  eachObject(patch.modRoutings, (routing) => {
    mapValue(routing, 'source', SYNTH_MOD_SOURCES);
    mapValue(routing, 'destination', SYNTH_MOD_DESTINATIONS);
  });
}

function upgradeCurves(points: unknown): void {
  eachObject(points, (point) => mapValue(point, 'curve', CURVES));
}

const CLIP_CURVE_LANES = ['ccLanes', 'pitchBendLanes', 'channelPressureLanes', 'polyPressureLanes'];

function upgradeClipCurves(clip: Json): void {
  for (const key of CLIP_CURVE_LANES) eachObject(clip[key], (lane) => upgradeCurves(lane.points));
}

/** Resolves the identity segment of a token to the processor it names. */
type ProcessorResolver = (identity: string) => string | undefined;

function decode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function byId(processorsById: ReadonlyMap<string, string>): ProcessorResolver {
  return (identity) => {
    const id = decode(identity);
    return id === undefined ? undefined : processorsById.get(id);
  };
}

function bySlot(slots: unknown): ProcessorResolver {
  return (identity) => {
    const slot = Array.isArray(slots) ? slots[Number(identity)] : undefined;
    return isObject(slot) && typeof slot.processor === 'string' ? slot.processor : undefined;
  };
}

/** Rewrites the parameter of an `<identity>:<param>` token tail. */
function upgradeTokenTail(tail: string, resolve: ProcessorResolver, encoded: boolean): string {
  const sep = tail.indexOf(':');
  if (sep <= 0) return tail;
  const processor = resolve(tail.slice(0, sep));
  const raw = tail.slice(sep + 1);
  const param = encoded ? decode(raw) : raw;
  if (processor === undefined || param === undefined) return tail;
  const next = upgradeParamName(processor, param);
  if (next === param) return tail;
  return `${tail.slice(0, sep + 1)}${encoded ? encodeURIComponent(next) : next}`;
}

/** Rewrites `token` when it starts with one of `rules`' prefixes. */
function upgradeToken(
  token: string,
  rules: ReadonlyArray<[prefix: string, resolve: ProcessorResolver, encoded: boolean]>,
): string {
  for (const [prefix, resolve, encoded] of rules) {
    if (token.startsWith(prefix)) {
      return prefix + upgradeTokenTail(token.slice(prefix.length), resolve, encoded);
    }
  }
  return token;
}

/** Automation tokens: `insert[-id]:` on the owning strip, `mastering[-id]:` on the chain. */
function upgradeAutomationLanes(
  lanes: unknown,
  stripInserts: unknown,
  chainProcessors: unknown,
  processorsById: ReadonlyMap<string, string>,
): void {
  const rules: Array<[string, ProcessorResolver, boolean]> = [
    ['insert-id:', byId(processorsById), false],
    ['insert:', bySlot(stripInserts), false],
    ['mastering-id:', byId(processorsById), false],
    ['mastering:', bySlot(chainProcessors), false],
  ];
  eachObject(lanes, (lane) => {
    upgradeCurves(lane.points);
    if (typeof lane.param === 'string') lane.param = upgradeToken(lane.param, rules);
  });
}

/** Strip a lane or learn target addresses inside one mixer context. */
interface MixerContext {
  mixer: Json;
  trackStrip(index: number): unknown;
}

function stripInserts(strip: unknown): unknown {
  return isObject(strip) ? strip.inserts : undefined;
}

function chainOf(mixer: Json): unknown {
  return isObject(mixer.masteringChain) ? mixer.masteringChain.processors : undefined;
}

function laneTargetInserts(target: unknown, ctx: MixerContext): unknown {
  if (typeof target === 'number') return stripInserts(ctx.trackStrip(target));
  if (target === 'master') return stripInserts(ctx.mixer.master);
  if (typeof target === 'string' && target.startsWith('bus:') && Array.isArray(ctx.mixer.buses)) {
    const id = target.slice('bus:'.length);
    const bus = ctx.mixer.buses.find((b) => isObject(b) && b.id === id);
    return isObject(bus) ? stripInserts(bus.strip) : undefined;
  }
  return undefined;
}

/** Learn targets carry a scope segment (`master` or a track index) after `insert[-id]:`. */
function upgradeLearnTarget(
  binding: Json,
  ctx: MixerContext,
  processorsById: ReadonlyMap<string, string>,
): void {
  const target = binding.target;
  if (typeof target !== 'string') return;
  const chain = chainOf(ctx.mixer);
  for (const [prefix, stable] of [
    ['insert-id:', true],
    ['insert:', false],
  ] as const) {
    if (!target.startsWith(prefix)) continue;
    const rest = target.slice(prefix.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return;
    const scope = rest.slice(0, sep);
    let inserts: unknown;
    if (scope === 'master') inserts = stripInserts(ctx.mixer.master);
    else if (binding.trackScoped === true) inserts = stripInserts(ctx.trackStrip(Number(scope)));
    const resolve = stable ? byId(processorsById) : bySlot(inserts);
    binding.target = `${prefix}${scope}:${upgradeTokenTail(rest.slice(sep + 1), resolve, stable)}`;
    return;
  }
  binding.target = upgradeToken(target, [
    ['mastering-id:', byId(processorsById), true],
    ['mastering:', bySlot(chain), true],
  ]);
}

/**
 * Upgrades a schema-4 project document to schema 5, the libsonare 2.0
 * vocabulary.
 *
 * @param doc Parsed schema-4 document.
 * @param core The core calls used for mastering overrides.
 * @returns A deep copy with every 1.x token rewritten and `schemaVersion` 5,
 *   and every stored setting the upgrade had to drop.
 */
export function upgradeDocumentToV5(
  doc: Json,
  core: UpgradeCore,
): { document: Json; dropped: UpgradeDrop[] } {
  const out = structuredClone(doc);
  const dropped: UpgradeDrop[] = [];
  const processorsById = new Map<string, string>();
  const names = catalogChoiceNamer(core);
  const tracks = Array.isArray(out.tracks) ? out.tracks : [];
  const mixer = isObject(out.mixer) ? out.mixer : {};
  const slotEntries =
    isObject(out.mixerSnapshots) && isObject(out.mixerSnapshots.slots)
      ? Object.entries(out.mixerSnapshots.slots).filter((entry): entry is [string, Json] =>
          isObject(entry[1]),
        )
      : [];
  const slots = slotEntries.map(([, slot]) => slot);

  // Live strips first, so live processor ids win over snapshot copies.
  eachObject(tracks, (track) => {
    upgradeStrip(track.mixer, processorsById, names);
    upgradeInstrument(track.instrument);
    eachObject(track.clips, (clip) => {
      upgradeClipCurves(clip);
      eachObject(clip.midiTakes, upgradeClipCurves);
    });
  });
  upgradeMixerState(mixer, 'mixer', processorsById, names, core, dropped);
  for (const [slotKey, snapshot] of slotEntries) {
    const location = `mixerSnapshots.slots.${slotKey}.mixer`;
    upgradeMixerState(snapshot.mixer, location, processorsById, names, core, dropped);
    eachObject(snapshot.tracks, (entry) => upgradeStrip(entry.mixer, processorsById, names));
  }

  const live: MixerContext = {
    mixer,
    trackStrip: (index) => (isObject(tracks[index]) ? tracks[index].mixer : undefined),
  };
  const chain = chainOf(mixer);
  tracks.forEach((track, index) => {
    if (!isObject(track)) return;
    upgradeAutomationLanes(
      track.automation,
      stripInserts(live.trackStrip(index)),
      chain,
      processorsById,
    );
  });
  upgradeAutomationLanes(out.masterAutomation, stripInserts(mixer.master), chain, processorsById);
  eachObject(mixer.buses, (bus) =>
    upgradeAutomationLanes(bus.automation, stripInserts(bus.strip), chain, processorsById),
  );
  for (const snapshot of slots) {
    const snapshotMixer = isObject(snapshot.mixer) ? snapshot.mixer : {};
    const entries = Array.isArray(snapshot.tracks) ? snapshot.tracks.filter(isObject) : [];
    const ctx: MixerContext = {
      mixer: snapshotMixer,
      trackStrip: (index) => entries.find((entry) => entry.trackIndex === index)?.mixer,
    };
    eachObject(snapshot.automationLanes, (lane) =>
      upgradeAutomationLanes(
        [lane],
        laneTargetInserts(lane.target, ctx),
        chainOf(snapshotMixer),
        processorsById,
      ),
    );
  }
  eachObject(out.midiCcBindings, (binding) => upgradeLearnTarget(binding, live, processorsById));

  out.schemaVersion = 5;
  return { document: out, dropped };
}

/**
 * Upgrades a version-1 stored track preset to the 2.0 vocabulary. Presets
 * carry no automation or learn targets, so only stored values change.
 *
 * @param preset Parsed version-1 preset.
 * @param core The catalog that names closed-set insert parameters.
 * @returns A deep copy with its strip and instrument upgraded.
 */
export function upgradeTrackPresetToV2(
  preset: Json,
  core: Pick<UpgradeCore, 'masteringInsertNames' | 'masteringInsertParamInfo'>,
): Json {
  const out = structuredClone(preset);
  upgradeStrip(out.strip, new Map(), catalogChoiceNamer(core));
  upgradeInstrument(out.instrument);
  out.schemaVersion = 2;
  return out;
}
