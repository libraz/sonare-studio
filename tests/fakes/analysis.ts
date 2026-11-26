/**
 * Typed stand-ins for libsonare results and functions.
 *
 * Every result factory is built from the core type, so a field the core adds,
 * renames or drops breaks the type-check here instead of silently feeding the
 * code under test a stale shape. Every function fake has the core function's
 * own call signature (request form and positional form) and routes both to one
 * request-form implementation, so a spy on that implementation sees what the
 * core would see.
 */

import type {
  AcousticResult,
  AnalyzeImpulseResponseRequest,
  AutoTuneOptions,
  AutoTuneRequest,
  AutoTuneResult,
  ClickDetection,
  ClipDetection,
  CrackleDetection,
  DeclickOptions,
  DeclickReport,
  DeclickResult,
  DeclipOptions,
  DeclipReport,
  DeclipResult,
  DecrackleOptions,
  DecrackleReport,
  DecrackleResult,
  DehumOptions,
  DehumReport,
  DehumResult,
  DenoiseClassicalOptions,
  DenoiseReport,
  DenoiseResult,
  DereverbClassicalOptions,
  DereverbReport,
  DereverbResult,
  DetectAcousticRequest,
  DetectOnsetsRequest,
  EstimateRoomRequest,
  EstimateTuningRequest,
  HarmonicRequest,
  HumDetection,
  MasterAudioRequest,
  MasteringAnalyzePairRequest,
  MasteringApplyPairProcessorRequest,
  MasteringChainResult,
  MasteringChainStereoResult,
  MasteringLoudnessSummary,
  MasteringRepairAnalysis,
  MasteringRepairApplyResult,
  MasteringRepairDeclickRequest,
  MasteringRepairDeclickResult,
  MasteringRepairDeclipRequest,
  MasteringRepairDecrackleRequest,
  MasteringRepairDehumRequest,
  MasteringRepairDenoiseClassicalRequest,
  MasteringRepairDenoiseClassicalResult,
  MasteringRepairDereverbClassicalRequest,
  MasteringRepairTrimSilenceRequest,
  MasteringReport,
  MasteringResult,
  MeterEstimate,
  NoiseDetection,
  NoteMoveOptions,
  NoteMoveRequest,
  NoteSegment,
  NoteStretchOptions,
  NoteStretchRequest,
  OptionsOf,
  PairAnalysis,
  PairAnalysisResultMap,
  PairProcessor,
  PercussiveRequest,
  PitchCorrectOptions,
  PitchCorrectTimevaryingRequest,
  PitchCorrectToMidiRequest,
  PitchPyinRequest,
  PitchResult,
  PitchShiftRequest,
  PitchYinRequest,
  ReverbDetection,
  RhythmResult,
  RirDiagnostic,
  RirResult,
  RoomEstimateOptions,
  RoomEstimateResult,
  RoomMorphOptions,
  RoomMorphRequest,
  RoomMorphResult,
  RoomMorphStereoResult,
  SpectralEditOptions,
  SpectralEditRequest,
  SplitSilenceRequest,
  TimeSignature,
  TimeStretchRequest,
  TrimReport,
  TrimSilenceOptions,
  TrimSilenceResult,
  VoiceChangeOptions,
  VoiceChangeRequest,
  WaveformPeaksReport,
  WebMidiInputInfo,
} from '@libraz/libsonare';

// ---------------------------------------------------------------------------
// Function fakes
// ---------------------------------------------------------------------------

/** A core call that carries its audio and rate in the request. */
interface SamplesRequest {
  samples: Float32Array;
  sampleRate: number;
}

/** The two call forms the core gives a one-buffer function. */
export interface TwoForms<Q, O, R> {
  (request: Q): R;
  (samples: Float32Array, sampleRate: number, options?: O): R;
}

/**
 * Builds a function with the core's request form and positional form from one
 * request-form implementation. The positional form is folded into the request
 * the core would build from it.
 */
export function twoForms<Q extends SamplesRequest, O extends object, R>(
  impl: (request: Q) => R,
): TwoForms<Q, O, R> {
  function call(request: Q): R;
  function call(samples: Float32Array, sampleRate: number, options?: O): R;
  function call(first: Q | Float32Array, sampleRate?: number, options?: O): R {
    if (first instanceof Float32Array) {
      // The positional form is, by the core's contract, this request with the options spread in.
      return impl({ ...options, samples: first, sampleRate } as Q);
    }
    return impl(first);
  }
  return call;
}

type Impl<Q, R> = (request: Q) => R;

export const pitchShiftFn = (impl: Impl<PitchShiftRequest, Float32Array>) =>
  twoForms<PitchShiftRequest, OptionsOf<PitchShiftRequest>, Float32Array>(impl);
export const pitchCorrectToMidiFn = (impl: Impl<PitchCorrectToMidiRequest, Float32Array>) =>
  twoForms<PitchCorrectToMidiRequest, OptionsOf<PitchCorrectToMidiRequest>, Float32Array>(impl);
export const pitchYinFn = (impl: Impl<PitchYinRequest, PitchResult>) =>
  twoForms<PitchYinRequest, OptionsOf<PitchYinRequest>, PitchResult>(impl);
export const pitchPyinFn = (impl: Impl<PitchPyinRequest, PitchResult>) =>
  twoForms<PitchPyinRequest, OptionsOf<PitchPyinRequest>, PitchResult>(impl);
export const pitchCorrectTimevaryingFn = (
  impl: Impl<PitchCorrectTimevaryingRequest, Float32Array>,
) => twoForms<PitchCorrectTimevaryingRequest, PitchCorrectOptions, Float32Array>(impl);
export const estimateTuningFn = (impl: Impl<EstimateTuningRequest, number>) =>
  twoForms<EstimateTuningRequest, OptionsOf<EstimateTuningRequest>, number>(impl);
export const autoTuneFn = (impl: Impl<AutoTuneRequest, AutoTuneResult>) =>
  twoForms<AutoTuneRequest, AutoTuneOptions, AutoTuneResult>(impl);
export const voiceChangeFn = (impl: Impl<VoiceChangeRequest, Float32Array>) =>
  twoForms<VoiceChangeRequest, VoiceChangeOptions, Float32Array>(impl);
export const timeStretchFn = (impl: Impl<TimeStretchRequest, Float32Array>) =>
  twoForms<TimeStretchRequest, OptionsOf<TimeStretchRequest>, Float32Array>(impl);
export const noteStretchFn = (impl: Impl<NoteStretchRequest, Float32Array>) =>
  twoForms<NoteStretchRequest, NoteStretchOptions, Float32Array>(impl);
export const noteMoveFn = (impl: Impl<NoteMoveRequest, Float32Array>) =>
  twoForms<NoteMoveRequest, NoteMoveOptions, Float32Array>(impl);
export const harmonicFn = (impl: Impl<HarmonicRequest, Float32Array>) =>
  twoForms<HarmonicRequest, OptionsOf<HarmonicRequest>, Float32Array>(impl);
export const percussiveFn = (impl: Impl<PercussiveRequest, Float32Array>) =>
  twoForms<PercussiveRequest, OptionsOf<PercussiveRequest>, Float32Array>(impl);
export const spectralEditFn = (impl: Impl<SpectralEditRequest, Float32Array>) =>
  twoForms<SpectralEditRequest, SpectralEditOptions, Float32Array>(impl);
export const detectOnsetsFn = (impl: Impl<DetectOnsetsRequest, Float32Array>) =>
  twoForms<DetectOnsetsRequest, OptionsOf<DetectOnsetsRequest>, Float32Array>(impl);
export const splitSilenceFn = (impl: Impl<SplitSilenceRequest, Int32Array>) =>
  twoForms<SplitSilenceRequest, OptionsOf<SplitSilenceRequest>, Int32Array>(impl);
export const declickFn = (impl: Impl<MasteringRepairDeclickRequest, DeclickResult>) =>
  twoForms<MasteringRepairDeclickRequest, DeclickOptions, DeclickResult>(impl);
export const denoiseClassicalFn = (
  impl: Impl<MasteringRepairDenoiseClassicalRequest, DenoiseResult>,
) => twoForms<MasteringRepairDenoiseClassicalRequest, DenoiseClassicalOptions, DenoiseResult>(impl);
export const declipFn = (impl: Impl<MasteringRepairDeclipRequest, DeclipResult>) =>
  twoForms<MasteringRepairDeclipRequest, DeclipOptions, DeclipResult>(impl);
export const decrackleFn = (impl: Impl<MasteringRepairDecrackleRequest, DecrackleResult>) =>
  twoForms<MasteringRepairDecrackleRequest, DecrackleOptions, DecrackleResult>(impl);
export const dehumFn = (impl: Impl<MasteringRepairDehumRequest, DehumResult>) =>
  twoForms<MasteringRepairDehumRequest, DehumOptions, DehumResult>(impl);
export const dereverbClassicalFn = (
  impl: Impl<MasteringRepairDereverbClassicalRequest, DereverbResult>,
) =>
  twoForms<MasteringRepairDereverbClassicalRequest, DereverbClassicalOptions, DereverbResult>(impl);
export const trimSilenceFn = (impl: Impl<MasteringRepairTrimSilenceRequest, TrimSilenceResult>) =>
  twoForms<MasteringRepairTrimSilenceRequest, TrimSilenceOptions, TrimSilenceResult>(impl);
export const roomMorphFn = (impl: Impl<RoomMorphRequest, RoomMorphResult>) =>
  twoForms<RoomMorphRequest, RoomMorphOptions, RoomMorphResult>(impl);
export const estimateRoomFn = (impl: Impl<EstimateRoomRequest, RoomEstimateResult>) =>
  twoForms<EstimateRoomRequest, RoomEstimateOptions, RoomEstimateResult>(impl);
export const analyzeImpulseResponseFn = (
  impl: Impl<AnalyzeImpulseResponseRequest, AcousticResult>,
) =>
  twoForms<AnalyzeImpulseResponseRequest, OptionsOf<AnalyzeImpulseResponseRequest>, AcousticResult>(
    impl,
  );
export const detectAcousticFn = (impl: Impl<DetectAcousticRequest, AcousticResult>) =>
  twoForms<DetectAcousticRequest, OptionsOf<DetectAcousticRequest>, AcousticResult>(impl);
export const masterAudioFn = (impl: Impl<MasterAudioRequest, MasteringChainResult>) =>
  twoForms<MasterAudioRequest, OptionsOf<MasterAudioRequest>, MasteringChainResult>(impl);

/**
 * `masteringApplyPairProcessor` with the processor type left open: the fake
 * answers every processor the same way, whatever `P` the caller names.
 */
export const applyPairProcessorFn =
  (impl: Impl<MasteringApplyPairProcessorRequest, MasteringResult>) =>
  <P extends PairProcessor>(request: MasteringApplyPairProcessorRequest<P>): MasteringResult =>
    impl(request);

/**
 * `masteringAnalyzePair`, whose result type depends on the analysis asked for.
 * `results` carries one result per analysis, so the lookup is typed by `A`.
 */
export const analyzePairFn =
  (
    results: PairAnalysisResultMap,
    onCall?: (request: MasteringAnalyzePairRequest) => void,
  ): (<A extends PairAnalysis>(
    request: MasteringAnalyzePairRequest<A>,
  ) => PairAnalysisResultMap[A]) =>
  <A extends PairAnalysis>(request: MasteringAnalyzePairRequest<A>) => {
    onCall?.(request);
    return results[request.analysis];
  };

// ---------------------------------------------------------------------------
// Result factories
// ---------------------------------------------------------------------------

/** A pitch-tracker result; the contour is empty unless overridden. */
export function pitchResult(overrides: Partial<PitchResult> = {}): PitchResult {
  return {
    f0: new Float32Array(),
    voicedProb: new Float32Array(),
    voicedFlag: [],
    ...(overrides.medianF0 === undefined ? {} : { meanF0: overrides.medianF0 }),
    ...overrides,
  };
}

/** A note segment spanning `[frameStart, frameEnd)` frames at `medianCents` from A440. */
export function noteSegment(overrides: Partial<NoteSegment> = {}): NoteSegment {
  return { frameStart: 0, frameEnd: 1, startSec: 0, endSec: 1, medianCents: 0, ...overrides };
}

const clickDetection = (): ClickDetection => ({
  count: 0,
  rejected: 0,
  longestRunSamples: 0,
  perSecond: 0,
});
const clipDetection = (): ClipDetection => ({
  clippedSamples: 0,
  clippedRatio: 0,
  runCount: 0,
  longestRunSamples: 0,
  flatRunCount: 0,
  longestFlatRunSamples: 0,
  flatSampleCount: 0,
  flatLevel: 0,
});
const crackleDetection = (): CrackleDetection => ({
  sampleCount: 0,
  sampleFraction: 0,
  perSecond: 0,
});
const noiseDetection = (): NoiseDetection => ({
  bandFloorDbfs: new Float32Array(),
  bandFloorBand: new Int32Array(),
});
const humDetection = (): HumDetection => ({
  fundamentalHz: 0,
  fundamentalProminence: 0,
  harmonics: 0,
  harmonicDbfs: new Float32Array(),
});
const reverbDetection = (): ReverbDetection => ({ lateDecayRatioDb: 0 });

/** The no-op report of a repair pass; each pass's report shape is the core's. */
export const declickReport = (): DeclickReport => ({
  detected: clickDetection(),
  repairedRuns: 0,
  repairedSamples: 0,
  linkedRuns: 0,
  lpcModelUsed: false,
});
export const denoiseReport = (): DenoiseReport => ({
  detected: noiseDetection(),
  meanReductionDb: 0,
  maxReductionDb: 0,
  floorLimitedFraction: 0,
});
const declipReport = (): DeclipReport => ({
  detected: clipDetection(),
  lpcReconstructedRuns: 0,
  unreconstructedRuns: 0,
  repairedSamples: 0,
  linkedRuns: 0,
});
const decrackleReport = (): DecrackleReport => ({
  detected: crackleDetection(),
  replacedSamples: 0,
  detailCoefficients: 0,
  shrunkCoefficients: 0,
  noiseSigma: 0,
});
const dehumReport = (): DehumReport => ({
  detected: humDetection(),
  notchedHarmonics: 0,
  appliedFundamentalHz: 0,
  fundamentalDriftHz: 0,
});
const dereverbReport = (): DereverbReport => ({
  detected: reverbDetection(),
  meanReductionDb: 0,
  suppressedFraction: 0,
  wpePredictorNorm: 0,
});
const trimReport = (): TrimReport => ({
  range: { first: 0, lastExclusive: 0 },
  removedHeadSamples: 0,
  removedTailSamples: 0,
});

export const declickResult = (samples: Float32Array): DeclickResult => ({
  samples,
  report: declickReport(),
});
export const denoiseResult = (samples: Float32Array): DenoiseResult => ({
  samples,
  report: denoiseReport(),
});
export const declipResult = (samples: Float32Array): DeclipResult => ({
  samples,
  report: declipReport(),
});
export const decrackleResult = (samples: Float32Array): DecrackleResult => ({
  samples,
  report: decrackleReport(),
});
export const dehumResult = (samples: Float32Array): DehumResult => ({
  samples,
  report: dehumReport(),
});
export const dereverbResult = (samples: Float32Array): DereverbResult => ({
  samples,
  report: dereverbReport(),
});
export const trimSilenceResult = (samples: Float32Array): TrimSilenceResult => ({
  samples,
  report: trimReport(),
});

/** A linked stereo declick result: one report per channel. */
export const declickStereoResult = (channels: Float32Array[]): MasteringRepairDeclickResult => ({
  channels,
  reports: channels.map(declickReport),
});
export const denoiseStereoResult = (
  channels: Float32Array[],
): MasteringRepairDenoiseClassicalResult => ({ channels, reports: channels.map(denoiseReport) });

/** A staged repair result with no per-stage reports. */
export const repairApplyResult = (channels: Float32Array[]): MasteringRepairApplyResult => ({
  channels,
  reports: [],
});

/** A repair analysis recommending the given stages. */
export function repairAnalysis(
  overrides: Partial<MasteringRepairAnalysis> = {},
): MasteringRepairAnalysis {
  return {
    declipThresholdSafe: true,
    integratedLufs: -23,
    recommended: [],
    explanation: [],
    ...overrides,
  };
}

/** The result of an auto-tune pass with a detected A minor key. */
export function autoTuneResult(
  samples: Float32Array,
  key: Partial<AutoTuneResult['key']> = {},
): AutoTuneResult {
  return {
    samples,
    key: { root: 9, mode: 'minor', confidence: 0.6, name: 'A minor', shortName: 'Am', ...key },
  };
}

/** A morphed take. */
export function roomMorphResult(
  audio: Float32Array,
  diagnostics: RirDiagnostic[] = [],
  sampleRate = 48000,
): RoomMorphResult {
  return { audio, sampleRate, diagnostics };
}

/** A morphed stereo take. */
export function roomMorphStereoResult(
  left: Float32Array,
  right: Float32Array,
  diagnostics: RirDiagnostic[] = [],
  sampleRate = 48000,
): RoomMorphStereoResult {
  return { left, right, sampleRate, diagnostics };
}

/** A synthesized room impulse response. */
export function rirResult(
  rir: Float32Array,
  diagnostics: RirDiagnostic[] = [],
  sampleRate = 48000,
): RirResult {
  return { rir, sampleRate, diagnostics };
}

/** A blind room estimate; every figure is zero unless overridden. */
export function roomEstimateResult(
  overrides: Partial<RoomEstimateResult> = {},
): RoomEstimateResult {
  return {
    volume: 0,
    lengthM: 0,
    widthM: 0,
    heightM: 0,
    drrDb: 0,
    confidence: 0,
    bandAbsorption: new Float32Array(),
    rt60Bands: new Float32Array(),
    ...overrides,
  };
}

/** An acoustic measurement; every figure is zero unless overridden. */
export function acousticResult(overrides: Partial<AcousticResult> = {}): AcousticResult {
  return {
    rt60: 0,
    edt: 0,
    c50: 0,
    c80: 0,
    d50: 0,
    rt60Bands: new Float32Array(),
    edtBands: new Float32Array(),
    c50Bands: new Float32Array(),
    c80Bands: new Float32Array(),
    confidence: 0,
    isBlind: false,
    ...overrides,
  };
}

/** The result of a single mastering processor. */
export function masteringResult(
  samples: Float32Array,
  overrides: Partial<MasteringResult> = {},
): MasteringResult {
  return {
    samples,
    sampleRate: 48000,
    inputLufs: 0,
    outputLufs: 0,
    appliedGainDb: 0,
    latencySamples: 0,
    nonFiniteSubstitutionCount: 0,
    ...overrides,
  };
}

const loudnessSummary = (): MasteringLoudnessSummary => ({
  integratedLufs: -23,
  maxMomentaryLufs: -23,
  maxShortTermLufs: -23,
  truePeakDbtp: -3,
  loudnessRangeLu: 0,
});

const masteringReport = (): MasteringReport => ({
  before: loudnessSummary(),
  after: loudnessSummary(),
  appliedGainDb: 0,
  maxGainReductionDb: 0,
  loudnessTargetLimited: false,
  bandEnergyDeltaDb: new Float32Array(),
});

/** The result of a full mastering chain pass over one channel. */
export function masteringChainResult(samples: Float32Array): MasteringChainResult {
  return {
    samples,
    sampleRate: 48000,
    inputLufs: -23,
    outputLufs: -23,
    appliedGainDb: 0,
    stages: [],
    outputTruePeakDbtp: -3,
    outputLoudnessRangeLu: 0,
    loudnessTargetLimited: false,
    nonFiniteSubstitutionCount: 0,
    stageGainReductions: [],
    report: masteringReport(),
  };
}

/** The result of a full mastering chain pass over a stereo pair. */
export function masteringChainStereoResult(
  left: Float32Array,
  right: Float32Array,
): MasteringChainStereoResult {
  return {
    left,
    right,
    sampleRate: 48000,
    inputLufs: -23,
    outputLufs: -23,
    appliedGainDb: 0,
    stages: [],
    outputTruePeakDbtp: -3,
    outputLoudnessRangeLu: 0,
    loudnessTargetLimited: false,
    nonFiniteSubstitutionCount: 0,
    stageGainReductions: [],
    report: masteringReport(),
  };
}

/** One result per pair analysis, each empty unless overridden. */
export function pairAnalysisResults(
  overrides: Partial<PairAnalysisResultMap> = {},
): PairAnalysisResultMap {
  return {
    'match.referenceLoudness': {
      sourceLufs: Number.NEGATIVE_INFINITY,
      referenceLufs: Number.NEGATIVE_INFINITY,
    },
    'match.tonalBalance': { bands: [] },
    'match.tonalBalanceLogBands': { bands: [] },
    'match.matchEqCurve': { frequencies: [], gainDb: [] },
    'match.estimateReferenceDelaySamples': { delaySamples: 0 },
    ...overrides,
  };
}

/** A waveform-peaks report of `channels` equal channels, `bucketCount` buckets each. */
export function waveformPeaksReport(
  overrides: Partial<WaveformPeaksReport> = {},
): WaveformPeaksReport {
  return {
    min: [new Float32Array()],
    max: [new Float32Array()],
    bucketCount: 0,
    samplesPerBucket: 1,
    ...overrides,
  };
}

/** A meter estimate; 4/4 with full confidence unless overridden. */
export function timeSignature(overrides: Partial<TimeSignature> = {}): TimeSignature {
  return { numerator: 4, denominator: 4, confidence: 1, ...overrides };
}

export function meterEstimate(overrides: Partial<MeterEstimate> = {}): MeterEstimate {
  return {
    timeSignature: timeSignature(),
    downbeatPhase: 0,
    grouping: [2, 2],
    candidateScores: [],
    candidates: [],
    searched: true,
    unobservedBeats: [],
    ...overrides,
  };
}

/** A rhythm analysis of steady 120 BPM 4/4; override the fields a test reads. */
export function rhythmResult(overrides: Partial<RhythmResult> = {}): RhythmResult {
  return {
    timeSignature: { numerator: 4, denominator: 4, confidence: 1 },
    syncopation: 0,
    grooveType: 'straight',
    patternRegularity: 1,
    tempoStability: 1,
    bpm: 120,
    beatIntervals: new Float32Array(),
    ...overrides,
  };
}

/** A connected Web MIDI input port. */
export function webMidiInputInfo(overrides: Partial<WebMidiInputInfo> = {}): WebMidiInputInfo {
  return { id: 'input-1', name: 'Controller', manufacturer: '', state: 'connected', ...overrides };
}
