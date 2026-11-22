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

import type { ChainPath, ChainPathValue } from '@/ui/mastering/chain-config-path';
import type {
  AutomationCurve,
  EqBandPhase,
  EqBandType,
  EqCoeffMode,
  EqStereoPlacement,
  MasteringChainConfig,
  PanLaw,
  SampleLoopMode,
  SoloProcessor,
  SynthBodyType,
  SynthEngineMode,
  SynthFilterModel,
  SynthFilterOutput,
  SynthModDestination,
  SynthModSource,
} from '@/wasm/index.js';

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

/** Per-band look-ahead of the EQ family; 2.0 keeps only `detectorDelayMs`. */
const BAND_LOOKAHEAD = /^(band|midBand|sideBand)\d+\.(dyn\d+\.)?lookaheadMs$/;

/** 2.0 name of a 1.x parameter of `processor`, or the name unchanged. */
export function upgradeParamName(processor: string, param: string): string {
  const table = PARAM_RENAMES[processor];
  if (table !== undefined && Object.hasOwn(table, param)) return table[param];
  if (BAND_LOOKAHEAD.test(param)) return param.replace(/lookaheadMs$/, 'detectorDelayMs');
  return param;
}

function upgradeInsertParams(processor: string, params: Json): void {
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
}

/** Upgrades one insert list; returns each slot's (upgraded) processor id. */
function upgradeInsertSlots(slots: unknown, processorsById: Map<string, string>): void {
  eachObject(slots, (slot) => {
    mapValue(slot, 'processor', RENAMED_PROCESSORS);
    const processor = typeof slot.processor === 'string' ? slot.processor : '';
    if (isObject(slot.params)) upgradeInsertParams(processor, slot.params);
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

function upgradeStrip(strip: unknown, processorsById: Map<string, string>): void {
  if (!isObject(strip)) return;
  mapValue(strip, 'panLaw', PAN_LAWS);
  if (isObject(strip.eq)) eachObject(strip.eq.bands, upgradeEqBand);
  if (isObject(strip.surroundPan)) {
    // Neither ever reached the panner, and 2.0 refuses both.
    delete strip.surroundPan.elevation;
    delete strip.surroundPan.distance;
  }
  upgradeInsertSlots(strip.inserts, processorsById);
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

/** The core's reader of a serialized chain configuration (`masteringChainConfigFromJson`). */
export type ChainConfigReader = (document: string) => MasteringChainConfig;

/**
 * Converts a 1.x flat dotted-key mastering override map to the nested 2.0
 * `MasteringChainConfig`. Each converted entry goes through the core's own
 * chain-config reader; an entry 2.0 refuses (a key with no 2.0 home, or a
 * value outside its domain) is dropped rather than left to fail the render.
 */
export function upgradeMasteringOverrides(flat: Json, read: ChainConfigReader): Json {
  const fragments: Json[] = [];
  const bands: Json[] = [];
  const cutoffs: number[] = [];
  for (const [key, value] of Object.entries(flat)) {
    if (typeof value !== 'number' && typeof value !== 'boolean') continue;
    const band = key.match(MULTIBAND_KEY);
    if (band) {
      const index = MULTIBAND_BANDS.indexOf(band[1]);
      bands[index] ??= {};
      bands[index][lowerFirst(band[2])] = value;
    } else if (Object.hasOwn(MULTIBAND_CUTOFFS, key) && typeof value === 'number') {
      cutoffs[MULTIBAND_CUTOFFS[key]] = value;
    } else if (key === 'repair.declip.clipThreshold' && typeof value === 'number') {
      fragments.push(nest('repair.declip.clipThresholdDb', linearToThresholdDb(value)));
    } else if (
      (key === 'repair.gainFloor' || key === 'repair.denoise.gainFloor') &&
      typeof value === 'number'
    ) {
      fragments.push(nest('repair.denoise.reductionDb', gainFloorToReductionDb(value)));
    } else if (key === COMPRESSOR_HPF_ENABLED || key === COMPRESSOR_HPF_HZ) {
      // Folded below: 2.0 keeps only the corner frequency, absent = off.
    } else {
      const path = Object.hasOwn(OVERRIDE_PATHS, key) ? OVERRIDE_PATHS[key] : key;
      // An ordinal with no token stays numeric, and the reader refuses it.
      fragments.push(nest(path, overrideValue(path, value) ?? value));
    }
  }
  if (flat[COMPRESSOR_HPF_ENABLED] === true) {
    const hz = flat[COMPRESSOR_HPF_HZ];
    const cornerHz = typeof hz === 'number' ? hz : SIDECHAIN_HPF_DEFAULT_HZ['dynamics.compressor'];
    fragments.push(nest('dynamics.compressor.sidechainHighPassHz', cornerHz));
  }
  // 2.0 replaces the whole band list, so the 1.x three-band layout is kept whole.
  if (bands.length > 0) {
    fragments.push(
      nest(
        'dynamics.multibandComp.bands',
        MULTIBAND_BANDS.map((_, i) => bands[i] ?? {}),
      ),
    );
  }
  if (cutoffs[0] !== undefined && cutoffs[1] !== undefined) {
    fragments.push(nest('dynamics.multibandComp.crossover.cutoffsHz', cutoffs));
  }
  // The reader answers with the whole canonical chain, defaults included, so
  // it only decides acceptance; the stored override stays the fragment itself.
  const nested: Json = {};
  for (const fragment of fragments) {
    try {
      read(JSON.stringify({ version: 2, params: fragment }));
    } catch {
      continue;
    }
    mergeInto(nested, fragment);
  }
  return nested;
}

function upgradeMixerState(
  mixer: unknown,
  processorsById: Map<string, string>,
  read: ChainConfigReader,
): void {
  if (!isObject(mixer)) return;
  upgradeStrip(mixer.master, processorsById);
  eachObject(mixer.buses, (bus) => upgradeStrip(bus.strip, processorsById));
  const chain = mixer.masteringChain;
  if (!isObject(chain)) return;
  upgradeInsertSlots(chain.processors, processorsById);
  if (isObject(chain.presetOverrides)) {
    chain.presetOverrides = upgradeMasteringOverrides(chain.presetOverrides, read);
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
 * @param read The core's chain-config reader, used for mastering overrides.
 * @returns A deep copy with every 1.x token rewritten and `schemaVersion` 5.
 */
export function upgradeDocumentToV5(doc: Json, read: ChainConfigReader): Json {
  const out = structuredClone(doc);
  const processorsById = new Map<string, string>();
  const tracks = Array.isArray(out.tracks) ? out.tracks : [];
  const mixer = isObject(out.mixer) ? out.mixer : {};
  const slots =
    isObject(out.mixerSnapshots) && isObject(out.mixerSnapshots.slots)
      ? Object.values(out.mixerSnapshots.slots).filter(isObject)
      : [];

  // Live strips first, so live processor ids win over snapshot copies.
  eachObject(tracks, (track) => {
    upgradeStrip(track.mixer, processorsById);
    upgradeInstrument(track.instrument);
    eachObject(track.clips, (clip) => {
      upgradeClipCurves(clip);
      eachObject(clip.midiTakes, upgradeClipCurves);
    });
  });
  upgradeMixerState(mixer, processorsById, read);
  for (const snapshot of slots) {
    upgradeMixerState(snapshot.mixer, processorsById, read);
    eachObject(snapshot.tracks, (entry) => upgradeStrip(entry.mixer, processorsById));
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
  return out;
}

/**
 * Upgrades a version-1 stored track preset to the 2.0 vocabulary. Presets
 * carry no automation or learn targets, so only stored values change.
 *
 * @param preset Parsed version-1 preset.
 * @returns A deep copy with its strip and instrument upgraded.
 */
export function upgradeTrackPresetToV2(preset: Json): Json {
  const out = structuredClone(preset);
  upgradeStrip(out.strip, new Map());
  upgradeInstrument(out.instrument);
  out.schemaVersion = 2;
  return out;
}
