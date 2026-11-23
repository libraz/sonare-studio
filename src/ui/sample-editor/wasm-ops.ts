/**
 * Wasm-delegated offline operations for the sample editor: pitch shift,
 * time stretch and the repair processors. The libsonare
 * functions are one-shot mono Float32Array transforms, so each operation maps
 * them per channel over the selected range and splices the result back.
 *
 * The module surface is injected (and the loader kept separate) so unit
 * tests can run against plain mock functions.
 */

import { stepOf } from '@libraz/libcantus';
import type {
  AutoTuneKey,
  FormantMode,
  Key,
  MasteringPreset,
  MasteringRepairAnalysis,
  MasteringRepairStage,
  PitchResult,
} from '@libraz/libsonare';
import { downmixToMono } from '@/lib/audio-channels';
import { clamp, minOf } from '@/lib/math';
import { ensureWasm } from '@/lib/wasm';
import type { MatchEqAnalysis } from './match-eq-analysis';
import { type DetectedNote, onsetSecondsToFrames, silenceSplitMarkers } from './onsets';
import { cutCrossfadeFrames, resolveRange, type SampleRange, spliceRange } from './ops';

/** F0 hop for note detection, matching the pitch-correction contour. */
export const NOTE_DETECT_HOP = 512;
/** F0 analysis window, matching the pitch-correction contour. */
export const NOTE_DETECT_FRAME = 2048;
/** STFT size of the spectral-edit processor. */
const SPECTRAL_EDIT_FFT_SIZE = 2048;

/** The subset of the libsonare module consumed by the sample editor. */
export type SampleEditorWasmOps = Partial<
  Pick<
    typeof import('@libraz/libsonare'),
    | 'pitchShift'
    | 'pitchCorrectToMidi'
    | 'pitchYin'
    | 'pitchPyin'
    | 'pitchCorrectTimevarying'
    | 'estimateTuning'
    | 'scaleQuantizeMidi'
    | 'autoTune'
    | 'voiceChange'
    | 'timeStretch'
    | 'noteStretch'
    | 'harmonic'
    | 'percussive'
    | 'masteringRepairDeclick'
    | 'masteringRepairDenoiseClassical'
    | 'masteringRepairDeclip'
    | 'masteringRepairDecrackle'
    | 'masteringRepairDehum'
    | 'masteringRepairDereverbClassical'
    | 'masteringRepairTrimSilence'
    | 'masteringRepairAnalyze'
    | 'masteringRepairApply'
    | 'detectOnsets'
    | 'splitSilence'
    | 'noteSegments'
    | 'noteMove'
    | 'roomMorph'
    | 'roomMorphStereo'
    | 'synthesizeRir'
    | 'estimateRoom'
    | 'analyzeImpulseResponse'
    | 'detectAcoustic'
    | 'spectralEdit'
    | 'masteringApplyPairProcessor'
    | 'masteringAnalyzePair'
    | 'masterAudio'
    | 'masterAudioStereo'
    | 'masteringRepairDeclickStereo'
    | 'masteringRepairDenoiseClassicalStereo'
    | 'masteringRepairDeclipStereo'
    | 'masteringRepairDecrackleStereo'
    | 'masteringRepairDehumStereo'
    | 'masteringRepairDereverbClassicalStereo'
  >
>;

/** Which wasm-delegated operations the given module actually provides. */
export interface WasmOpAvailability {
  pitchShift: boolean;
  pitchCorrect: boolean;
  pitchCorrectTimevarying: boolean;
  tuneReference: boolean;
  scaleCorrect: boolean;
  autoTune: boolean;
  voiceChange: boolean;
  harmonic: boolean;
  percussive: boolean;
  timeStretch: boolean;
  noteStretch: boolean;
  noteMove: boolean;
  detectNotes: boolean;
  declick: boolean;
  denoise: boolean;
  restore: boolean;
  declip: boolean;
  decrackle: boolean;
  dehum: boolean;
  dereverb: boolean;
  trimSilence: boolean;
  repairSession: boolean;
  detectOnsets: boolean;
  splitSilence: boolean;
  matchEq: boolean;
  matchEqAnalyze: boolean;
  roomMorph: boolean;
  roomMorphStereo: boolean;
  synthesizeRir: boolean;
  estimateRoom: boolean;
  analyzeImpulseResponse: boolean;
  detectAcoustic: boolean;
  spectralEdit: boolean;
}

export type SpectralEditMode = 'gain' | 'attenuate' | 'mute' | 'heal';

export interface SpectralEditRangeOptions {
  lowHz: number;
  highHz: number;
  gainDb: number;
  mode: SpectralEditMode;
}

/** Reports availability of the wasm-delegated operations (all false on null). */
export function wasmOpAvailability(
  ops: SampleEditorWasmOps | null | undefined,
): WasmOpAvailability {
  return {
    pitchShift: typeof ops?.pitchShift === 'function',
    pitchCorrect:
      typeof ops?.pitchCorrectToMidi === 'function' && typeof ops?.pitchYin === 'function',
    pitchCorrectTimevarying:
      typeof ops?.pitchCorrectTimevarying === 'function' &&
      (typeof ops?.pitchPyin === 'function' || typeof ops?.pitchYin === 'function'),
    tuneReference:
      typeof ops?.estimateTuning === 'function' && typeof ops?.pitchShift === 'function',
    scaleCorrect:
      typeof ops?.pitchYin === 'function' &&
      typeof ops?.scaleQuantizeMidi === 'function' &&
      typeof ops?.pitchCorrectToMidi === 'function',
    autoTune: typeof ops?.autoTune === 'function',
    voiceChange: typeof ops?.voiceChange === 'function',
    harmonic: typeof ops?.harmonic === 'function',
    percussive: typeof ops?.percussive === 'function',
    timeStretch: typeof ops?.timeStretch === 'function',
    noteStretch: typeof ops?.noteStretch === 'function',
    noteMove: typeof ops?.noteMove === 'function',
    detectNotes:
      typeof ops?.noteSegments === 'function' &&
      (typeof ops?.pitchPyin === 'function' || typeof ops?.pitchYin === 'function'),
    declick: typeof ops?.masteringRepairDeclick === 'function',
    denoise: typeof ops?.masteringRepairDenoiseClassical === 'function',
    restore: typeof ops?.masterAudio === 'function' && typeof ops?.masterAudioStereo === 'function',
    declip: typeof ops?.masteringRepairDeclip === 'function',
    decrackle: typeof ops?.masteringRepairDecrackle === 'function',
    dehum: typeof ops?.masteringRepairDehum === 'function',
    dereverb: typeof ops?.masteringRepairDereverbClassical === 'function',
    trimSilence: typeof ops?.masteringRepairTrimSilence === 'function',
    repairSession:
      typeof ops?.masteringRepairAnalyze === 'function' &&
      typeof ops?.masteringRepairApply === 'function',
    detectOnsets: typeof ops?.detectOnsets === 'function',
    splitSilence: typeof ops?.splitSilence === 'function',
    matchEq: typeof ops?.masteringApplyPairProcessor === 'function',
    matchEqAnalyze: typeof ops?.masteringAnalyzePair === 'function',
    roomMorph: typeof ops?.roomMorph === 'function',
    roomMorphStereo: typeof ops?.roomMorphStereo === 'function',
    synthesizeRir: typeof ops?.synthesizeRir === 'function',
    estimateRoom: typeof ops?.estimateRoom === 'function',
    analyzeImpulseResponse: typeof ops?.analyzeImpulseResponse === 'function',
    detectAcoustic: typeof ops?.detectAcoustic === 'function',
    spectralEdit: typeof ops?.spectralEdit === 'function',
  };
}

/**
 * Loads the libsonare module for the wasm-delegated operations. Returns null
 * when the module cannot be initialized (the editor then disables those
 * operations instead of failing).
 */
export async function loadSampleEditorWasm(): Promise<SampleEditorWasmOps | null> {
  try {
    return await ensureWasm();
  } catch {
    return null;
  }
}

/** Resolves the effective range and rejects an empty one. */
function resolveNonEmptyRange(
  channels: ReadonlyArray<Float32Array>,
  range: SampleRange | null | undefined,
): SampleRange {
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
  return resolved;
}

/**
 * Downmixes the range (whole file when omitted) to one mono segment for an
 * analysis call.
 *
 * @throws RangeError on an empty range.
 */
export function analysisMono(
  channels: ReadonlyArray<Float32Array>,
  range?: SampleRange | null,
): Float32Array {
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot analyze an empty range');
  }
  return downmixToMono(
    channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame)),
  );
}

/** Trims per-channel results to the shortest so the set stays planar. */
function toPlanar(segments: ReadonlyArray<Float32Array>): Float32Array[] {
  const minFrames = minOf(segments.map((segment) => segment.length));
  return segments.map((segment) =>
    segment.length === minFrames ? segment : segment.slice(0, minFrames),
  );
}

/** F0 contour of a mono signal: pYIN when the module has it, YIN otherwise. */
function f0Contour(ops: SampleEditorWasmOps, mono: Float32Array, sampleRate: number): PitchResult {
  const options = { frameLength: NOTE_DETECT_FRAME, hopLength: NOTE_DETECT_HOP };
  if (typeof ops.pitchPyin === 'function') {
    return ops.pitchPyin(mono, sampleRate, { ...options, fillNa: true });
  }
  if (typeof ops.pitchYin !== 'function') throw new Error('Pitch tracking is unavailable');
  return ops.pitchYin(mono, sampleRate, options);
}

/**
 * Runs a mono segment transform per channel over the range (whole file when
 * omitted) and splices the results back. Output segments of unequal lengths
 * (some processors are off by a frame between channels) are trimmed to the
 * shortest so the result stays planar.
 */
function applyToRange(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range: SampleRange | null | undefined,
  transform: (segment: Float32Array) => Float32Array,
): Float32Array[] {
  const resolved = resolveNonEmptyRange(channels, range);
  const segments = channels.map((channel) =>
    transform(channel.slice(resolved.startFrame, resolved.endFrame)),
  );
  const planar = toPlanar(segments);
  return spliceRange(channels, resolved, planar, cutCrossfadeFrames(sampleRate));
}

/**
 * Runs a repair over the range. A stereo pair goes through the linked stereo
 * form when the module has one, so both channels take the same repair
 * decisions; otherwise each channel is repaired on its own.
 */
function applyRepairToRange(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range: SampleRange | null | undefined,
  mono: (segment: Float32Array) => Float32Array,
  stereo?: (left: Float32Array, right: Float32Array) => ReadonlyArray<Float32Array>,
): Float32Array[] {
  if (channels.length !== 2 || stereo === undefined)
    return applyToRange(channels, sampleRate, range, mono);
  const resolved = resolveNonEmptyRange(channels, range);
  const out = stereo(
    channels[0].slice(resolved.startFrame, resolved.endFrame),
    channels[1].slice(resolved.startFrame, resolved.endFrame),
  );
  const frames = Math.min(out[0].length, out[1].length);
  return spliceRange(
    channels,
    resolved,
    [out[0].slice(0, frames), out[1].slice(0, frames)],
    cutCrossfadeFrames(sampleRate),
  );
}

/**
 * Pitch shifts the range by semitones (duration preserved).
 *
 * @throws Error when the module does not provide pitchShift.
 */
export function pitchShiftRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  semitones: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.pitchShift;
  if (typeof fn !== 'function') {
    throw new Error('Pitch shift is unavailable in this libsonare build');
  }
  if (!Number.isFinite(semitones)) {
    throw new RangeError(`semitones must be finite, got ${semitones}`);
  }
  return applyToRange(channels, sampleRate, range, (segment) =>
    fn(segment, sampleRate, { pitchSemitones: semitones }),
  );
}

/**
 * Estimates the pitch a mono segment sits on, as the MIDI number the engine's
 * pitch-correction ops take as `currentMidi`, from the core's YIN analysis.
 *
 * @throws Error when the module does not provide pitchYin or no pitch is found.
 */
export function estimateSourceMidi(
  ops: SampleEditorWasmOps,
  mono: Float32Array,
  sampleRate: number,
): number {
  const detect = ops.pitchYin;
  if (typeof detect !== 'function') {
    throw new Error('Pitch correction is unavailable in this libsonare build');
  }
  const medianF0 = detect(mono, sampleRate).medianF0;
  if (!(medianF0 > 0)) {
    throw new Error('Could not detect a pitch to correct in the selection');
  }
  // 12-TET step index is the MIDI number the engine's pitch ops expect.
  return stepOf(medianF0);
}

/**
 * Retunes the range to a target MIDI note (monophonic pitch correction).
 * The source pitch is estimated once on the mono downmix of the range, so every
 * channel moves by the same interval and the segment keeps its duration.
 *
 * @param targetMidi - Target note as a MIDI number in [0, 127].
 * @throws Error when the module does not provide pitchCorrectToMidi or pitchYin,
 *   or no pitch is found.
 * @throws RangeError when targetMidi is not an integer in [0, 127].
 */
export function pitchCorrectRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  targetMidi: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.pitchCorrectToMidi;
  if (typeof fn !== 'function' || typeof ops.pitchYin !== 'function') {
    throw new Error('Pitch correction is unavailable in this libsonare build');
  }
  if (!Number.isInteger(targetMidi) || targetMidi < 0 || targetMidi > 127) {
    throw new RangeError(`targetMidi must be an integer in [0, 127], got ${targetMidi}`);
  }
  const resolved = resolveNonEmptyRange(channels, range);
  const segments = channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame));
  const currentMidi = estimateSourceMidi(ops, downmixToMono(segments), sampleRate);
  const planar = toPlanar(
    segments.map((segment) => fn(segment, sampleRate, { currentMidi, targetMidi })),
  );
  return spliceRange(channels, resolved, planar, cutCrossfadeFrames(sampleRate));
}

/**
 * Contour-following pitch correction to a target MIDI note. The F0 contour is
 * measured once on the mono downmix (pYIN when present, YIN fallback), then the
 * same contour drives every channel so stereo phase relationships remain
 * coherent.
 *
 * Only the voiced flags are forwarded: the tracker's own voiced decision is
 * what marks a frame for correction, and `voicedProb` is a relative confidence
 * that falls with the fundamental rather than a voicing probability.
 *
 * @throws Error when the required contour or correction functions are missing.
 * @throws RangeError when targetMidi/range are invalid.
 */
export function pitchCorrectTimevaryingRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  targetMidi: number,
  range?: SampleRange | null,
): Float32Array[] {
  const correct = ops.pitchCorrectTimevarying;
  const detect = ops.pitchPyin ?? ops.pitchYin;
  if (typeof correct !== 'function' || typeof detect !== 'function') {
    throw new Error('Time-varying pitch correction is unavailable in this libsonare build');
  }
  if (!Number.isInteger(targetMidi) || targetMidi < 0 || targetMidi > 127) {
    throw new RangeError(`targetMidi must be an integer in [0, 127], got ${targetMidi}`);
  }
  const resolved = resolveNonEmptyRange(channels, range);
  const segments = channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame));
  const contour = f0Contour(ops, downmixToMono(segments), sampleRate);
  const f0 = contour.f0;
  if (!f0 || f0.length === 0 || !Array.from(f0).some((hz) => hz > 0 && Number.isFinite(hz))) {
    throw new Error('Could not detect a pitch contour in the selection');
  }
  const voiced =
    contour.voicedFlag && contour.voicedFlag.length === f0.length
      ? Int32Array.from(contour.voicedFlag, (flag) => (flag ? 1 : 0))
      : undefined;
  const corrected = segments.map((segment) =>
    correct({
      samples: segment,
      sampleRate,
      f0Hz: f0,
      hopLength: NOTE_DETECT_HOP,
      targetMode: 'midi',
      targetMidi,
      voiced,
    }),
  );
  const planar = toPlanar(corrected);
  return spliceRange(channels, resolved, planar, cutCrossfadeFrames(sampleRate));
}

/**
 * Corrects the range to A440 concert pitch. The selection's global tuning
 * deviation (a fraction of a semitone) is estimated once on its
 * mono downmix and every channel is pitch-shifted by the opposite amount, so a
 * recording cut a few cents sharp or flat lands on standard tuning with its
 * duration preserved and a stereo pair kept phase-coherent.
 *
 * @throws Error when the required functions are missing or no tuning is found.
 * @throws RangeError on an empty range.
 */
export function tuneToReferenceRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const detect = ops.estimateTuning;
  const shift = ops.pitchShift;
  if (typeof detect !== 'function' || typeof shift !== 'function') {
    throw new Error('Tune to A440 is unavailable in this libsonare build');
  }
  const resolved = resolveNonEmptyRange(channels, range);
  const segments = channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame));
  const tuning = detect(downmixToMono(segments), sampleRate);
  if (!Number.isFinite(tuning)) {
    throw new Error('Could not detect a tuning offset in the selection');
  }
  const semitones = -tuning;
  const corrected = segments.map((segment) =>
    shift(segment, sampleRate, { pitchSemitones: semitones }),
  );
  const planar = toPlanar(corrected);
  return spliceRange(channels, resolved, planar, cutCrossfadeFrames(sampleRate));
}

/**
 * Pitch-corrects the range to the nearest in-scale note. The selection's pitch
 * is detected once on its mono downmix, snapped to the scale (`root` +
 * `modeMask`, a mask of intervals relative to the root), and every channel is
 * retuned by that same correction so a stereo pair stays phase-coherent.
 *
 * Intended for a selection holding a single note (e.g. a slice between
 * transients); duration is preserved.
 *
 * @param root - Scale root as a pitch class (0 = C … 11 = B).
 * @param modeMask - 12-bit mask of scale degrees relative to the root.
 * @throws Error when the required functions are missing or no pitch is found.
 * @throws RangeError on an empty range.
 */
export function scaleCorrectRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  root: number,
  modeMask: number,
  range?: SampleRange | null,
): Float32Array[] {
  const quantize = ops.scaleQuantizeMidi;
  const correct = ops.pitchCorrectToMidi;
  if (
    typeof ops.pitchYin !== 'function' ||
    typeof quantize !== 'function' ||
    typeof correct !== 'function'
  ) {
    throw new Error('Scale correction is unavailable in this libsonare build');
  }
  const resolved = resolveNonEmptyRange(channels, range);
  const segments = channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame));
  const currentMidi = estimateSourceMidi(ops, downmixToMono(segments), sampleRate);
  const targetMidi = quantize(root, modeMask, currentMidi);
  const corrected = segments.map((segment) =>
    correct(segment, sampleRate, { currentMidi, targetMidi }),
  );
  const planar = toPlanar(corrected);
  return spliceRange(channels, resolved, planar, cutCrossfadeFrames(sampleRate));
}

/**
 * Snaps the range's voiced pitch to a key with libsonare's auto-tune, for
 * monophonic material. Each channel is tuned on its own; the key is resolved on
 * the first channel (detected or as named) and shared with the rest, so every
 * channel lands on the same scale.
 *
 * @param key - `'detect'` or a named `{ root, mode }`.
 * @param strength - Correction strength in [0, 1].
 * @returns The spliced channels and the key the audio was tuned to.
 * @throws Error when the module does not provide autoTune.
 * @throws RangeError on an empty range.
 */
export function autoTuneRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  key: 'detect' | AutoTuneKey,
  strength: number,
  range?: SampleRange | null,
): { channels: Float32Array[]; key: Key } {
  const fn = ops.autoTune;
  if (typeof fn !== 'function') {
    throw new Error('Auto-tune is unavailable in this libsonare build');
  }
  const resolved = resolveNonEmptyRange(channels, range);
  const segments = channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame));
  const first = fn({ samples: segments[0], sampleRate, key, retuneAmount: strength });
  const shared: AutoTuneKey = { root: first.key.root, mode: first.key.mode };
  const tuned = [
    first.samples,
    ...segments
      .slice(1)
      .map((samples) => fn({ samples, sampleRate, key: shared, retuneAmount: strength }).samples),
  ];
  return {
    channels: spliceRange(channels, resolved, tuned, cutCrossfadeFrames(sampleRate)),
    key: first.key,
  };
}

/**
 * Voice-changes the range, shifting pitch and formants independently in one
 * pass (duration preserved). Each channel is processed separately. In
 * `'absolute'` mode the formant factor is relative to the input whatever the
 * pitch shift; libsonare refuses an unreachable request with the reachable range.
 *
 * @param pitchSemitones - Pitch transpose in semitones (0 = unchanged).
 * @param formantFactor - Formant scale (> 1 brighter, < 1 darker, 1 = neutral).
 * @param formantMode - How the formant factor relates to the pitch shift.
 * @throws Error when the module does not provide voiceChange.
 * @throws RangeError when pitchSemitones is not finite or formantFactor <= 0.
 */
export function voiceChangeRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  pitchSemitones: number,
  formantFactor: number,
  formantMode: FormantMode,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.voiceChange;
  if (typeof fn !== 'function') {
    throw new Error('Voice change is unavailable in this libsonare build');
  }
  if (!Number.isFinite(pitchSemitones)) {
    throw new RangeError(`pitchSemitones must be finite, got ${pitchSemitones}`);
  }
  if (!Number.isFinite(formantFactor) || formantFactor <= 0) {
    throw new RangeError(`formantFactor must be > 0, got ${formantFactor}`);
  }
  return applyToRange(channels, sampleRate, range, (segment) =>
    fn(segment, sampleRate, { pitchSemitones, formantFactor, formantMode }),
  );
}

/**
 * Isolates the harmonic (sustained/tonal) component of the range via HPSS,
 * a classical median-filter source separation. Each channel is processed
 * separately; duration is preserved.
 *
 * @throws Error when the module does not provide harmonic.
 */
export function harmonicRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.harmonic;
  if (typeof fn !== 'function') {
    throw new Error('Harmonic separation is unavailable in this libsonare build');
  }
  return applyToRange(channels, sampleRate, range, (segment) => fn(segment, sampleRate));
}

/**
 * Isolates the percussive (transient/noisy) component of the range via HPSS,
 * a classical median-filter source separation. Each channel is processed
 * separately; duration is preserved.
 *
 * @throws Error when the module does not provide percussive.
 */
export function percussiveRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.percussive;
  if (typeof fn !== 'function') {
    throw new Error('Percussive separation is unavailable in this libsonare build');
  }
  return applyToRange(channels, sampleRate, range, (segment) => fn(segment, sampleRate));
}

/**
 * Applies a practical spectral cleanup preset to the range: attenuate high
 * frequencies above `lowHz` in the selected time window. The operation uses
 * libsonare's rectangular spectralEdit op over the whole channel so the STFT
 * context can span the edit boundaries while the edit rectangle stays
 * selection-scoped.
 *
 * @throws Error when the module does not provide spectralEdit.
 * @throws RangeError when the range or frequency/gain parameters are invalid.
 */
export function spectralDenoiseRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
  lowHz = 4000,
  gainDb = -18,
): Float32Array[] {
  return spectralEditRange(ops, channels, sampleRate, range, {
    lowHz,
    highHz: 0,
    gainDb,
    mode: 'attenuate',
  });
}

/**
 * Applies one rectangular spectral edit over the selected time range and
 * frequency band. `highHz` may be 0 to mean "up to Nyquist", matching the
 * libsonare spectralEdit convention used by the preset cleanup operation.
 *
 * @throws Error when the module does not provide spectralEdit.
 * @throws RangeError when the range or frequency/gain parameters are invalid.
 */
export function spectralEditRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range: SampleRange | null | undefined,
  options: SpectralEditRangeOptions,
): Float32Array[] {
  const fn = ops.spectralEdit;
  if (typeof fn !== 'function') {
    throw new Error('Spectral edit is unavailable in this libsonare build');
  }
  assertSampleRate(sampleRate);
  if (!Number.isFinite(options.lowHz) || options.lowHz < 0) {
    throw new RangeError(`lowHz must be finite and >= 0, got ${options.lowHz}`);
  }
  if (!Number.isFinite(options.highHz) || options.highHz < 0) {
    throw new RangeError(`highHz must be finite and >= 0, got ${options.highHz}`);
  }
  if (options.highHz > 0 && options.highHz <= options.lowHz) {
    throw new RangeError(`highHz must be greater than lowHz or 0, got ${options.highHz}`);
  }
  if (!Number.isFinite(options.gainDb)) {
    throw new RangeError(`gainDb must be finite, got ${options.gainDb}`);
  }
  if (!['gain', 'attenuate', 'mute', 'heal'].includes(options.mode)) {
    throw new RangeError(`Unsupported spectral edit mode: ${options.mode}`);
  }
  const resolved = resolveNonEmptyRange(channels, range);
  const edit = {
    startSample: resolved.startFrame,
    endSample: resolved.endFrame,
    lowHz: options.lowHz,
    ...(options.highHz > 0 ? { highHz: options.highHz } : {}),
    gainDb: options.gainDb,
    mode: options.mode,
  };
  const processed = channels.map((channel) =>
    fn(channel, sampleRate, {
      ops: [edit],
      nFft: SPECTRAL_EDIT_FFT_SIZE,
      hopLength: NOTE_DETECT_HOP,
      window: 'hann',
    }),
  );
  return toPlanar(processed);
}

/**
 * Time stretches the range by a rate (0.5 = double duration, 2.0 = half),
 * changing the total length accordingly.
 *
 * @throws Error when the module does not provide timeStretch.
 */
export function timeStretchRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  rate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.timeStretch;
  if (typeof fn !== 'function') {
    throw new Error('Time stretch is unavailable in this libsonare build');
  }
  if (!finitePositive(rate)) {
    throw new RangeError(`rate must be > 0, got ${rate}`);
  }
  return applyToRange(channels, sampleRate, range, (segment) =>
    fn(segment, sampleRate, { speedRatio: rate }),
  );
}

/**
 * Note-stretches the range by a rate (0.5 = double duration, 2.0 = half),
 * preserving the note's attack transient. The rate reads the same way as
 * {@link timeStretchRange}'s; noteStretch itself takes the inverse, a duration
 * factor. Unlike timeStretchRange the whole buffer is passed with the range as
 * the region bounds, so the stretched note blends into the surrounding audio at
 * its edges; the total length changes with the rate. Intended for a selection
 * holding a single note. Each channel is processed with the same region and
 * rate (kept planar by trimming to the shortest result).
 *
 * @param rate Playback rate (> 0; 0.5 doubles, 2.0 halves duration).
 * @throws Error when the module does not provide noteStretch.
 * @throws RangeError when rate is not > 0 or the range is empty.
 */
export function noteStretchRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  rate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.noteStretch;
  if (typeof fn !== 'function') {
    throw new Error('Note stretch is unavailable in this libsonare build');
  }
  if (!finitePositive(rate)) {
    throw new RangeError(`rate must be > 0, got ${rate}`);
  }
  const resolved = resolveNonEmptyRange(channels, range);
  const stretched = channels.map((channel) =>
    fn(channel, sampleRate, {
      onsetSample: resolved.startFrame,
      offsetSample: resolved.endFrame,
      stretchRatio: 1 / rate,
    }),
  );
  return toPlanar(stretched);
}

/**
 * Moves the note in the range earlier or later by `shiftFrames`, keeping its
 * duration. As with {@link noteStretchRange} the whole buffer is passed with the
 * range as the region bounds, so the moved note blends into the surrounding
 * audio. Intended for a selection holding a single note: nudging one note off
 * the grid, or onto it.
 *
 * The buffer keeps its length: the note's original position is silenced and the
 * note is added at its target, so a move onto neighbouring audio sums with it
 * rather than replacing it. The shift is clamped to keep the note inside the
 * buffer, since a target past the end would silence the note instead of moving
 * it.
 *
 * @param shiftFrames Frames to move by (negative = earlier).
 * @throws Error when the module does not provide noteMove.
 * @throws RangeError when shiftFrames is not finite or the range is empty.
 */
export function noteMoveRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  shiftFrames: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.noteMove;
  if (typeof fn !== 'function') {
    throw new Error('Note move is unavailable in this libsonare build');
  }
  if (!Number.isFinite(shiftFrames)) {
    throw new RangeError(`shiftFrames must be finite, got ${shiftFrames}`);
  }
  const resolved = resolveNonEmptyRange(channels, range);
  const totalFrames = channels[0]?.length ?? 0;
  const noteFrames = resolved.endFrame - resolved.startFrame;
  const targetOnsetSample = Math.min(
    Math.max(0, resolved.startFrame + Math.round(shiftFrames)),
    Math.max(0, totalFrames - noteFrames),
  );
  const moved = channels.map((channel) =>
    fn(channel, sampleRate, {
      onsetSample: resolved.startFrame,
      offsetSample: resolved.endFrame,
      targetOnsetSample,
    }),
  );
  return toPlanar(moved);
}

/**
 * Repairs clicks/pops inside the range.
 *
 * @throws Error when the module does not provide masteringRepairDeclick.
 */
export function declickRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.masteringRepairDeclick;
  if (typeof fn !== 'function') {
    throw new Error('Declick is unavailable in this libsonare build');
  }
  const stereo = ops.masteringRepairDeclickStereo;
  return applyRepairToRange(
    channels,
    sampleRate,
    range,
    (segment) => fn(segment, sampleRate).samples,
    stereo && ((left, right) => stereo({ left, right, sampleRate }).channels),
  );
}

/**
 * Runs a restoration preset over the range. A stereo pair is repaired as one
 * linked pair so both channels take the same decisions; other layouts are
 * repaired channel by channel. The presets repair only and leave level alone.
 *
 * @throws Error when the module does not provide masterAudio/masterAudioStereo.
 */
export function restoreRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  preset: MasteringPreset,
  range?: SampleRange | null,
): Float32Array[] {
  const mono = ops.masterAudio;
  const stereo = ops.masterAudioStereo;
  if (typeof mono !== 'function' || typeof stereo !== 'function') {
    throw new Error('Restoration is unavailable in this libsonare build');
  }
  return applyRepairToRange(
    channels,
    sampleRate,
    range,
    (segment) => mono(segment, sampleRate, { preset }).samples,
    (left, right) => {
      const out = stereo({ left, right, sampleRate, preset });
      return [out.left, out.right];
    },
  );
}

/**
 * Denoises the range (classical spectral denoiser). `reductionDb` is the
 * deepest attenuation the mask may apply; omitted keeps the library default.
 *
 * @throws Error when the module does not provide
 *   masteringRepairDenoiseClassical.
 */
export function denoiseRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
  reductionDb?: number,
): Float32Array[] {
  const fn = ops.masteringRepairDenoiseClassical;
  if (typeof fn !== 'function') {
    throw new Error('Denoise is unavailable in this libsonare build');
  }
  const stereo = ops.masteringRepairDenoiseClassicalStereo;
  const options = reductionDb === undefined ? undefined : { reductionDb };
  return applyRepairToRange(
    channels,
    sampleRate,
    range,
    (segment) => fn(segment, sampleRate, options).samples,
    stereo && ((left, right) => stereo({ left, right, sampleRate, ...options }).channels),
  );
}

export function declipRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.masteringRepairDeclip;
  if (typeof fn !== 'function') {
    throw new Error('Declip is unavailable in this libsonare build');
  }
  const stereo = ops.masteringRepairDeclipStereo;
  return applyRepairToRange(
    channels,
    sampleRate,
    range,
    (segment) => fn(segment, sampleRate).samples,
    stereo && ((left, right) => stereo({ left, right, sampleRate }).channels),
  );
}

export function decrackleRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.masteringRepairDecrackle;
  if (typeof fn !== 'function') {
    throw new Error('Decrackle is unavailable in this libsonare build');
  }
  const stereo = ops.masteringRepairDecrackleStereo;
  return applyRepairToRange(
    channels,
    sampleRate,
    range,
    (segment) => fn(segment, sampleRate).samples,
    stereo && ((left, right) => stereo({ left, right, sampleRate }).channels),
  );
}

export function dehumRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.masteringRepairDehum;
  if (typeof fn !== 'function') {
    throw new Error('Dehum is unavailable in this libsonare build');
  }
  const stereo = ops.masteringRepairDehumStereo;
  return applyRepairToRange(
    channels,
    sampleRate,
    range,
    (segment) => fn(segment, sampleRate).samples,
    stereo && ((left, right) => stereo({ left, right, sampleRate }).channels),
  );
}

export function dereverbRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.masteringRepairDereverbClassical;
  if (typeof fn !== 'function') {
    throw new Error('Dereverb is unavailable in this libsonare build');
  }
  const stereo = ops.masteringRepairDereverbClassicalStereo;
  return applyRepairToRange(
    channels,
    sampleRate,
    range,
    (segment) => fn(segment, sampleRate).samples,
    stereo && ((left, right) => stereo({ left, right, sampleRate }).channels),
  );
}

export function trimSilenceRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.masteringRepairTrimSilence;
  if (typeof fn !== 'function') {
    throw new Error('Trim silence is unavailable in this libsonare build');
  }
  return applyToRange(channels, sampleRate, range, (segment) => fn(segment, sampleRate).samples);
}

/**
 * Measures the range's repair defects on every channel and returns libsonare's
 * recommended stages with their settings.
 *
 * @throws Error when the module does not provide masteringRepairAnalyze.
 * @throws RangeError on an empty range.
 */
export function analyzeRepairRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): MasteringRepairAnalysis {
  const fn = ops.masteringRepairAnalyze;
  if (typeof fn !== 'function') {
    throw new Error('Repair analysis is unavailable in this libsonare build');
  }
  const resolved = resolveNonEmptyRange(channels, range);
  return fn({
    channels: channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame)),
    sampleRate,
  });
}

/**
 * Applies repair stages to every channel of the range in one libsonare call,
 * so the linked stages take one decision across the channel set.
 *
 * @param stages - Stages with their settings, as the analysis recommends them.
 * @throws Error when the module does not provide masteringRepairApply.
 * @throws RangeError on an empty range or an empty stage list.
 */
export function repairStagesRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  stages: ReadonlyArray<MasteringRepairStage>,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.masteringRepairApply;
  if (typeof fn !== 'function') {
    throw new Error('Repair is unavailable in this libsonare build');
  }
  if (stages.length === 0) throw new RangeError('Choose at least one repair stage');
  const resolved = resolveNonEmptyRange(channels, range);
  const out = fn({
    channels: channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame)),
    sampleRate,
    stages: [...stages],
  });
  return spliceRange(channels, resolved, out.channels, cutCrossfadeFrames(sampleRate));
}

/**
 * Detects transient onsets across the whole file and returns their frame
 * positions (sorted, deduplicated, inside [0, totalFrames)). The channels are
 * downmixed to mono first, since the detector takes a single channel.
 *
 * @throws Error when the module does not provide detectOnsets.
 * @throws RangeError when the sample rate is not positive.
 */
export function detectOnsetFrames(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
): number[] {
  const fn = ops.detectOnsets;
  if (typeof fn !== 'function') {
    throw new Error('Onset detection is unavailable in this libsonare build');
  }
  assertSampleRate(sampleRate);
  const mono = downmixToMono(channels);
  return onsetSecondsToFrames(fn(mono, sampleRate), sampleRate, mono.length);
}

/**
 * Splits the whole file on silence and returns the interior cut frames (the
 * boundaries between silent and non-silent regions). The channels are downmixed
 * to mono first, since the detector takes a single channel; the markers feed the
 * same overlay as the transient onsets, so a click selects the slice between
 * two cuts. The audio is not modified.
 *
 * @param topDb Silence threshold in dB below the peak (lower = more aggressive).
 * @throws Error when the module does not provide splitSilence.
 * @throws RangeError when topDb is given but not finite and positive.
 */
export function splitSilenceFrames(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  topDb?: number,
): number[] {
  const fn = ops.splitSilence;
  if (typeof fn !== 'function') {
    throw new Error('Silence split is unavailable in this libsonare build');
  }
  if (topDb !== undefined && (!Number.isFinite(topDb) || topDb <= 0)) {
    throw new RangeError(`topDb must be > 0, got ${topDb}`);
  }
  const mono = downmixToMono(channels);
  return silenceSplitMarkers(
    fn(mono, sampleRate, topDb === undefined ? {} : { topDb }),
    mono.length,
  );
}

/**
 * Pitch step that starts a new note, in cents. A semitone is 100, so the
 * threshold has to sit below that to separate adjacent semitones — and above
 * the depth of a vibrato, or every cycle of one becomes its own note. Measured
 * on held tones, 70-90 holds a +/-60 cent vibrato as one note while still
 * splitting a semitone step; 100 merges the semitones, 50 (the library default)
 * breaks a +/-50 cent vibrato into a note per cycle. A vibrato wider than a
 * semitone cannot be held together at any threshold.
 */
export const NOTE_DETECT_THRESHOLD_CENTS = 80;

/**
 * Detects the note regions of a monophonic recording: their bounds and pitch.
 *
 * The channels are downmixed to mono for the pitch tracker, which measures an
 * F0 contour that the segmenter then cuts into stable regions. Unlike the
 * transient detector this follows pitch, so it finds the boundary of a legato
 * note that arrives without an attack, and it reports where each note *ends* —
 * which the transient detector cannot, since a note followed by a rest has no
 * transient at its release. The two are complementary: pitch segmentation
 * cannot split a note repeated at the same pitch, which is exactly what a
 * transient marks. The audio is not modified.
 *
 * The tracker's per-frame confidence is not the segmenter's voicing
 * probability: it peaks around 0.44 on a clean tone, well under the 0.5 the
 * segmenter treats as voiced, so every frame would be discarded. The tracker's
 * own voiced decision carries voicing instead.
 *
 * @throws Error when the module provides no pitch tracker or segmenter.
 * @throws RangeError when sampleRate is not > 0.
 */
export function detectNoteRegions(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
): DetectedNote[] {
  const segment = ops.noteSegments;
  if (
    typeof segment !== 'function' ||
    (typeof ops.pitchPyin !== 'function' && typeof ops.pitchYin !== 'function')
  ) {
    throw new Error('Note detection is unavailable in this libsonare build');
  }
  assertSampleRate(sampleRate);
  const mono = downmixToMono(channels);
  const contour = f0Contour(ops, mono, sampleRate);
  const f0 = contour.f0;
  const flags = contour.voicedFlag;
  if (!f0 || f0.length === 0 || !flags || flags.length !== f0.length) return [];
  const regions = segment({
    f0Hz: f0,
    voicedProb: Float32Array.from(flags, (flag) => (flag ? 1 : 0)),
    frameRate: sampleRate / NOTE_DETECT_HOP,
    segmentationThresholdCents: NOTE_DETECT_THRESHOLD_CENTS,
  });
  const notes: DetectedNote[] = [];
  for (const region of regions) {
    const startFrame = Math.max(0, Math.round(region.startSec * sampleRate));
    const endFrame = Math.min(mono.length, Math.round(region.endSec * sampleRate));
    if (endFrame <= startFrame) continue;
    // The segmenter reports pitch in cents from its A440 reference.
    notes.push({ startFrame, endFrame, midi: 69 + region.medianCents / 100 });
  }
  return notes;
}

/** Pair processor id that EQ-matches a source to a reference's tonal balance. */
const MATCH_EQ_PROCESSOR = 'match.applyMatchEq';
/** Pair processor id that linearly crossfades two equal-length signals. */
const MATCH_EQ_CROSSFADE_PROCESSOR = 'match.abCrossfade';

/**
 * EQ-matches the range to a reference signal's tonal balance: each source
 * channel is matched against the same (mono) reference and spliced back. The
 * reference is supplied already downmixed so the caller controls how a stereo
 * reference collapses to mono.
 *
 * `amount` controls a parallel (partial) match: at 1 the matched signal is
 * used as-is, below 1 each channel is linearly crossfaded back toward its dry
 * input (0 leaves the channel untouched). The matched signal is latency-
 * compensated and equal-length to the dry segment, so the blend is sample-
 * aligned.
 *
 * @param ops Wasm op surface (must provide masteringApplyPairProcessor).
 * @param channels Source channels (planar).
 * @param sampleRate Source sample rate in Hz (> 0).
 * @param reference Mono reference samples (non-empty).
 * @param range Range to match (whole file when omitted).
 * @param amount Match strength in [0, 1] (defaults to 1 = fully matched);
 *   non-finite values are treated as 1.
 * @param referenceSampleRate Reference rate; the library resamples it to `sampleRate`.
 * @throws Error when the module does not provide masteringApplyPairProcessor.
 * @throws RangeError on a non-positive sample rate or an empty reference.
 */
export function matchEqToReference(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  reference: Float32Array,
  range?: SampleRange | null,
  amount = 1,
  referenceSampleRate = sampleRate,
): Float32Array[] {
  const fn = ops.masteringApplyPairProcessor;
  if (typeof fn !== 'function') {
    throw new Error('Match EQ is unavailable in this libsonare build');
  }
  assertSampleRate(sampleRate);
  if (reference.length === 0) {
    throw new RangeError('Reference audio is empty');
  }
  if (!Number.isFinite(referenceSampleRate) || referenceSampleRate <= 0) {
    throw new RangeError(`referenceSampleRate must be > 0, got ${referenceSampleRate}`);
  }
  const mix = Number.isFinite(amount) ? clamp(amount, 0, 1) : 1;
  return applyToRange(channels, sampleRate, range, (segment) => {
    if (mix <= 0) return segment;
    const matched = fn({
      processor: MATCH_EQ_PROCESSOR,
      source: segment,
      reference,
      sampleRate,
      referenceSampleRate,
    }).samples;
    if (mix >= 1) return matched;
    // Parallel match: blend the dry segment (mix=0) with the matched version
    // (mix=1). abCrossfade requires equal-length operands, which holds because
    // apply_match_eq preserves the input length.
    return fn({
      processor: MATCH_EQ_CROSSFADE_PROCESSOR,
      source: segment,
      reference: matched,
      sampleRate,
      params: { mix },
    }).samples;
  });
}

/** Pair-analysis names consumed by {@link analyzeMatchEqToReference}. */
const MATCH_EQ_CURVE = 'match.matchEqCurve';
const MATCH_TONAL_BALANCE = 'match.tonalBalance';
const MATCH_REFERENCE_LOUDNESS = 'match.referenceLoudness';

/**
 * Analyzes the range (whole file when omitted) against a reference: the source
 * channels are downmixed to one mono segment and compared with the (mono)
 * reference, returning the match EQ curve, tonal-balance bands and loudness
 * comparison. Unlike {@link matchEqToReference} this produces no audio — it is a
 * read-only inspection of what a match would correct.
 *
 * @param ops Wasm op surface (must provide masteringAnalyzePair).
 * @param channels Source channels (planar).
 * @param sampleRate Source sample rate in Hz (> 0).
 * @param reference Mono reference samples (non-empty).
 * @param range Range to analyze (whole file when omitted).
 * @param referenceSampleRate Reference rate; the library resamples it to `sampleRate`.
 * @throws Error when the module does not provide masteringAnalyzePair.
 * @throws RangeError on a non-positive sample rate, an empty reference or an
 *   empty range.
 */
export function analyzeMatchEqToReference(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  reference: Float32Array,
  range?: SampleRange | null,
  referenceSampleRate = sampleRate,
): MatchEqAnalysis {
  const fn = ops.masteringAnalyzePair;
  if (typeof fn !== 'function') {
    throw new Error('Match EQ analysis is unavailable in this libsonare build');
  }
  assertSampleRate(sampleRate);
  if (reference.length === 0) {
    throw new RangeError('Reference audio is empty');
  }
  if (!Number.isFinite(referenceSampleRate) || referenceSampleRate <= 0) {
    throw new RangeError(`referenceSampleRate must be > 0, got ${referenceSampleRate}`);
  }
  const source = analysisMono(channels, range);
  const pair = { source, reference, sampleRate, referenceSampleRate };
  const { sourceLufs, referenceLufs, gainToMatchDb } = fn({
    analysis: MATCH_REFERENCE_LOUDNESS,
    ...pair,
  });
  return {
    curve: fn({ analysis: MATCH_EQ_CURVE, ...pair }),
    tonalBalance: fn({ analysis: MATCH_TONAL_BALANCE, ...pair }).bands,
    loudness:
      sourceLufs === undefined || referenceLufs === undefined || gainToMatchDb === undefined
        ? null
        : { sourceLufs, referenceLufs, gainToMatchDb },
  };
}

export function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function assertSampleRate(sampleRate: number): void {
  if (!finitePositive(sampleRate)) {
    throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  }
}
