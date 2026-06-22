/**
 * Wasm-delegated offline operations for the sample editor: pitch shift,
 * time stretch and the repair processors (declick, denoise). The libsonare
 * functions are one-shot mono Float32Array transforms, so each operation maps
 * them per channel over the selected range and splices the result back.
 *
 * The module surface is injected (and the loader kept separate) so unit
 * tests can run against plain mock functions.
 */

import { ensureWasm } from '@/lib/wasm';
import {
  type MatchEqAnalysis,
  parseMatchEqCurve,
  parseReferenceLoudness,
  parseTonalBalance,
} from './match-eq-analysis';
import { downmixToMono, onsetSecondsToFrames, silenceSplitMarkers } from './onsets';
import { resolveRange, type SampleRange, spliceRange } from './ops';

/** The subset of the libsonare module consumed by the sample editor. */
export interface SampleEditorWasmOps {
  /** Pitch shift by semitones, duration preserved. */
  pitchShift?: (samples: Float32Array, sampleRate: number, semitones: number) => Float32Array;
  /**
   * Monophonic pitch correction to a target MIDI note. With `currentMidi`
   * omitted the source pitch is auto-detected, so the whole segment is retuned
   * to `targetMidi`; duration is preserved.
   */
  pitchCorrectToMidi?: (
    samples: Float32Array,
    sampleRate?: number,
    currentMidi?: number,
    targetMidi?: number,
  ) => Float32Array;
  /** Monophonic pitch tracker; only `medianF0` (Hz, 0 when unvoiced) is used. */
  pitchYin?: (samples: Float32Array, sampleRate?: number) => { medianF0: number };
  /**
   * Global tuning estimate: the deviation from A440 as a
   * fraction of a semitone in (-0.5, 0.5] (positive = sharp).
   */
  estimateTuning?: (samples: Float32Array, sampleRate?: number) => number;
  /**
   * Snaps a (float) MIDI note to the nearest enabled scale degree, where
   * `modeMask` is a 12-bit mask of intervals relative to `root`.
   */
  scaleQuantizeMidi?: (
    root: number,
    modeMask: number,
    midi: number,
    referenceMidi?: number,
  ) => number;
  /**
   * Voice change: shifts pitch and formants independently in one pass.
   * `pitchSemitones` transposes; `formantFactor` > 1 brightens, < 1 darkens.
   */
  voiceChange?: (
    samples: Float32Array,
    sampleRate?: number,
    options?: { pitchSemitones?: number; formantFactor?: number },
  ) => Float32Array;
  /** Time stretch by rate (0.5 = double duration, 2.0 = half duration). */
  timeStretch?: (samples: Float32Array, sampleRate: number, rate: number) => Float32Array;
  /**
   * Note stretch: time-stretches just the region [onsetSample, offsetSample) by
   * `stretchRatio` (0.5 = double duration, 2.0 = half) while preserving the
   * note's attack transient. Operates on the whole buffer (the rest is left
   * untouched) so the stretched region blends at its edges.
   */
  noteStretch?: (
    samples: Float32Array,
    sampleRate?: number,
    options?: { onsetSample?: number; offsetSample?: number; stretchRatio?: number },
  ) => Float32Array;
  /** Harmonic component (HPSS), isolating sustained/tonal content. */
  harmonic?: (samples: Float32Array, sampleRate: number) => Float32Array;
  /** Percussive component (HPSS), isolating transient/noisy content. */
  percussive?: (samples: Float32Array, sampleRate: number) => Float32Array;
  /** Click/pop repair. */
  masteringRepairDeclick?: (samples: Float32Array, sampleRate: number) => Float32Array;
  /** Classical (non-ML) broadband denoise. */
  masteringRepairDenoiseClassical?: (samples: Float32Array, sampleRate: number) => Float32Array;
  /** Transient onset detection; returns onset times in seconds. */
  detectOnsets?: (samples: Float32Array, sampleRate: number) => Float32Array;
  /**
   * Silence-based splitter. Returns a flat list of sample positions bounding
   * the non-silent regions ([start0, end0, start1, end1, …]); `topDb` is the
   * silence threshold below the signal peak.
   */
  splitSilence?: (samples: Float32Array, topDb?: number) => ArrayLike<number>;
  /**
   * Acoustic room simulation: convolves the mono signal with a synthesized
   * room impulse response and returns a latency-compensated, tail-extended
   * buffer (longer than the input). Only present when libsonare was built with
   * acoustic-simulation support.
   */
  roomMorph?: (
    samples: Float32Array,
    sampleRate: number,
    options?: Record<string, number | boolean>,
  ) => Float32Array;
  /**
   * Reference-pair processor. For 'match.applyMatchEq' it EQ-matches `source`
   * to `reference`'s tonal balance and returns the processed mono samples.
   */
  masteringPairProcess?: (
    processorName: string,
    source: Float32Array,
    reference: Float32Array,
    sampleRate?: number,
    params?: Record<string, number | boolean>,
  ) => { samples: Float32Array; sampleRate: number };
  /**
   * Reference-pair analysis. For 'match.matchEqCurve' / 'match.tonalBalance' /
   * 'match.referenceLoudness' it compares `source` to `reference` and returns a
   * JSON string (parsed by the match-eq-analysis module).
   */
  masteringPairAnalyze?: (
    analysisName: string,
    source: Float32Array,
    reference: Float32Array,
    sampleRate?: number,
    params?: Record<string, number | boolean>,
  ) => string;
}

/** Which wasm-delegated operations the given module actually provides. */
export interface WasmOpAvailability {
  pitchShift: boolean;
  pitchCorrect: boolean;
  tuneReference: boolean;
  scaleCorrect: boolean;
  voiceChange: boolean;
  harmonic: boolean;
  percussive: boolean;
  timeStretch: boolean;
  noteStretch: boolean;
  declick: boolean;
  denoise: boolean;
  detectOnsets: boolean;
  splitSilence: boolean;
  matchEq: boolean;
  matchEqAnalyze: boolean;
  roomMorph: boolean;
}

/** Reports availability of the wasm-delegated operations (all false on null). */
export function wasmOpAvailability(
  ops: SampleEditorWasmOps | null | undefined,
): WasmOpAvailability {
  return {
    pitchShift: typeof ops?.pitchShift === 'function',
    pitchCorrect: typeof ops?.pitchCorrectToMidi === 'function',
    tuneReference:
      typeof ops?.estimateTuning === 'function' && typeof ops?.pitchShift === 'function',
    scaleCorrect:
      typeof ops?.pitchYin === 'function' &&
      typeof ops?.scaleQuantizeMidi === 'function' &&
      typeof ops?.pitchCorrectToMidi === 'function',
    voiceChange: typeof ops?.voiceChange === 'function',
    harmonic: typeof ops?.harmonic === 'function',
    percussive: typeof ops?.percussive === 'function',
    timeStretch: typeof ops?.timeStretch === 'function',
    noteStretch: typeof ops?.noteStretch === 'function',
    declick: typeof ops?.masteringRepairDeclick === 'function',
    denoise: typeof ops?.masteringRepairDenoiseClassical === 'function',
    detectOnsets: typeof ops?.detectOnsets === 'function',
    splitSilence: typeof ops?.splitSilence === 'function',
    matchEq: typeof ops?.masteringPairProcess === 'function',
    matchEqAnalyze: typeof ops?.masteringPairAnalyze === 'function',
    roomMorph: typeof ops?.roomMorph === 'function',
  };
}

/**
 * Loads the libsonare module for the wasm-delegated operations. Returns null
 * when the module cannot be initialized (the editor then disables those
 * operations instead of failing).
 */
export async function loadSampleEditorWasm(): Promise<SampleEditorWasmOps | null> {
  try {
    return (await ensureWasm()) as unknown as SampleEditorWasmOps;
  } catch {
    return null;
  }
}

/**
 * Runs a mono segment transform per channel over the range (whole file when
 * omitted) and splices the results back. Output segments of unequal lengths
 * (some processors are off by a frame between channels) are trimmed to the
 * shortest so the result stays planar.
 */
function applyToRange(
  channels: ReadonlyArray<Float32Array>,
  range: SampleRange | null | undefined,
  transform: (segment: Float32Array) => Float32Array,
): Float32Array[] {
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
  const segments = channels.map((channel) =>
    transform(channel.slice(resolved.startFrame, resolved.endFrame)),
  );
  const minFrames = Math.min(...segments.map((segment) => segment.length));
  const planar = segments.map((segment) =>
    segment.length === minFrames ? segment : segment.slice(0, minFrames),
  );
  return spliceRange(channels, resolved, planar);
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
  return applyToRange(channels, range, (segment) => fn(segment, sampleRate, semitones));
}

/**
 * Retunes the range to a target MIDI note (monophonic pitch correction).
 * The source pitch is auto-detected, so the segment is corrected to
 * `targetMidi` with its duration preserved.
 *
 * @param targetMidi - Target note as a MIDI number in [0, 127].
 * @throws Error when the module does not provide pitchCorrectToMidi.
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
  if (typeof fn !== 'function') {
    throw new Error('Pitch correction is unavailable in this libsonare build');
  }
  if (!Number.isInteger(targetMidi) || targetMidi < 0 || targetMidi > 127) {
    throw new RangeError(`targetMidi must be an integer in [0, 127], got ${targetMidi}`);
  }
  return applyToRange(channels, range, (segment) => fn(segment, sampleRate, undefined, targetMidi));
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
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
  const segments = channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame));
  const tuning = detect(downmixToMono(segments), sampleRate);
  if (!Number.isFinite(tuning)) {
    throw new Error('Could not detect a tuning offset in the selection');
  }
  const semitones = -tuning;
  const corrected = segments.map((segment) => shift(segment, sampleRate, semitones));
  const minFrames = Math.min(...corrected.map((segment) => segment.length));
  const planar = corrected.map((segment) =>
    segment.length === minFrames ? segment : segment.slice(0, minFrames),
  );
  return spliceRange(channels, resolved, planar);
}

/** 12-TET MIDI number of a frequency (A4 = 440 Hz = MIDI 69). */
function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
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
  const detect = ops.pitchYin;
  const quantize = ops.scaleQuantizeMidi;
  const correct = ops.pitchCorrectToMidi;
  if (
    typeof detect !== 'function' ||
    typeof quantize !== 'function' ||
    typeof correct !== 'function'
  ) {
    throw new Error('Scale correction is unavailable in this libsonare build');
  }
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
  const segments = channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame));
  const medianF0 = detect(downmixToMono(segments), sampleRate).medianF0;
  if (!(medianF0 > 0)) {
    throw new Error('Could not detect a pitch to correct in the selection');
  }
  const currentMidi = hzToMidi(medianF0);
  const targetMidi = quantize(root, modeMask, currentMidi);
  const corrected = segments.map((segment) =>
    correct(segment, sampleRate, currentMidi, targetMidi),
  );
  const minFrames = Math.min(...corrected.map((segment) => segment.length));
  const planar = corrected.map((segment) =>
    segment.length === minFrames ? segment : segment.slice(0, minFrames),
  );
  return spliceRange(channels, resolved, planar);
}

/**
 * Voice-changes the range, shifting pitch and formants independently in one
 * pass (duration preserved). Each channel is processed separately.
 *
 * @param pitchSemitones - Pitch transpose in semitones (0 = unchanged).
 * @param formantFactor - Formant scale (> 1 brighter, < 1 darker, 1 = neutral).
 * @throws Error when the module does not provide voiceChange.
 * @throws RangeError when pitchSemitones is not finite or formantFactor <= 0.
 */
export function voiceChangeRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  pitchSemitones: number,
  formantFactor: number,
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
  return applyToRange(channels, range, (segment) =>
    fn(segment, sampleRate, { pitchSemitones, formantFactor }),
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
  return applyToRange(channels, range, (segment) => fn(segment, sampleRate));
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
  return applyToRange(channels, range, (segment) => fn(segment, sampleRate));
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
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`rate must be > 0, got ${rate}`);
  }
  return applyToRange(channels, range, (segment) => fn(segment, sampleRate, rate));
}

/**
 * Note-stretches the range by a ratio (0.5 = double duration, 2.0 = half),
 * preserving the note's attack transient. Unlike {@link timeStretchRange} the
 * whole buffer is passed with the range as the region bounds, so the stretched
 * note blends into the surrounding audio at its edges; the total length changes
 * with the ratio. Intended for a selection holding a single note. Each channel
 * is processed with the same region and ratio (kept planar by trimming to the
 * shortest result).
 *
 * @param stretchRatio Stretch ratio (> 0; 0.5 doubles, 2.0 halves duration).
 * @throws Error when the module does not provide noteStretch.
 * @throws RangeError when stretchRatio is not > 0 or the range is empty.
 */
export function noteStretchRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  stretchRatio: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.noteStretch;
  if (typeof fn !== 'function') {
    throw new Error('Note stretch is unavailable in this libsonare build');
  }
  if (!Number.isFinite(stretchRatio) || stretchRatio <= 0) {
    throw new RangeError(`stretchRatio must be > 0, got ${stretchRatio}`);
  }
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
  const stretched = channels.map((channel) =>
    fn(channel, sampleRate, {
      onsetSample: resolved.startFrame,
      offsetSample: resolved.endFrame,
      stretchRatio,
    }),
  );
  const minFrames = Math.min(...stretched.map((segment) => segment.length));
  return stretched.map((segment) =>
    segment.length === minFrames ? segment : segment.slice(0, minFrames),
  );
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
  return applyToRange(channels, range, (segment) => fn(segment, sampleRate));
}

/**
 * Denoises the range (classical spectral denoiser).
 *
 * @throws Error when the module does not provide
 *   masteringRepairDenoiseClassical.
 */
export function denoiseRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array[] {
  const fn = ops.masteringRepairDenoiseClassical;
  if (typeof fn !== 'function') {
    throw new Error('Denoise is unavailable in this libsonare build');
  }
  return applyToRange(channels, range, (segment) => fn(segment, sampleRate));
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
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  }
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
  return silenceSplitMarkers(fn(mono, topDb), mono.length);
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
 * @param ops Wasm op surface (must provide masteringPairProcess).
 * @param channels Source channels (planar).
 * @param sampleRate Source sample rate in Hz (> 0).
 * @param reference Mono reference samples (non-empty).
 * @param range Range to match (whole file when omitted).
 * @param amount Match strength in [0, 1] (defaults to 1 = fully matched);
 *   non-finite values are treated as 1.
 * @throws Error when the module does not provide masteringPairProcess.
 * @throws RangeError on a non-positive sample rate or an empty reference.
 */
export function matchEqToReference(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  reference: Float32Array,
  range?: SampleRange | null,
  amount = 1,
): Float32Array[] {
  const fn = ops.masteringPairProcess;
  if (typeof fn !== 'function') {
    throw new Error('Match EQ is unavailable in this libsonare build');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  }
  if (reference.length === 0) {
    throw new RangeError('Reference audio is empty');
  }
  const mix = Number.isFinite(amount) ? Math.min(Math.max(amount, 0), 1) : 1;
  return applyToRange(channels, range, (segment) => {
    if (mix <= 0) return segment;
    const matched = fn(MATCH_EQ_PROCESSOR, segment, reference, sampleRate).samples;
    if (mix >= 1) return matched;
    // Parallel match: blend the dry segment (mix=0) with the matched version
    // (mix=1). abCrossfade requires equal-length operands, which holds because
    // apply_match_eq preserves the input length.
    return fn(MATCH_EQ_CROSSFADE_PROCESSOR, segment, matched, sampleRate, { mix }).samples;
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
 * @param ops Wasm op surface (must provide masteringPairAnalyze).
 * @param channels Source channels (planar).
 * @param sampleRate Source sample rate in Hz (> 0).
 * @param reference Mono reference samples (non-empty).
 * @param range Range to analyze (whole file when omitted).
 * @throws Error when the module does not provide masteringPairAnalyze.
 * @throws RangeError on a non-positive sample rate, an empty reference or an
 *   empty range.
 */
export function analyzeMatchEqToReference(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  reference: Float32Array,
  range?: SampleRange | null,
): MatchEqAnalysis {
  const fn = ops.masteringPairAnalyze;
  if (typeof fn !== 'function') {
    throw new Error('Match EQ analysis is unavailable in this libsonare build');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  }
  if (reference.length === 0) {
    throw new RangeError('Reference audio is empty');
  }
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot analyze an empty range');
  }
  const source = downmixToMono(
    channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame)),
  );
  return {
    curve: parseMatchEqCurve(fn(MATCH_EQ_CURVE, source, reference, sampleRate)),
    tonalBalance: parseTonalBalance(fn(MATCH_TONAL_BALANCE, source, reference, sampleRate)),
    loudness: parseReferenceLoudness(fn(MATCH_REFERENCE_LOUDNESS, source, reference, sampleRate)),
  };
}

/**
 * A room shape for {@link roomMorphChannels}: shoebox dimensions in metres plus
 * a libsonare wall-material preset (1 concrete, 2 wood, 3 curtain, 4 carpet,
 * 5 glass).
 */
export interface RoomMorphPreset {
  lengthM: number;
  widthM: number;
  heightM: number;
  materialPreset: number;
}

/**
 * Applies a synthesized room's reverberant character to every channel. Room
 * reverb is a whole-signal effect whose impulse response runs past the input,
 * so this always processes the full channel (no sub-range) and returns
 * latency-compensated, tail-extended buffers that are longer than the input.
 * Each channel is convolved against the same room; results are trimmed to the
 * shortest to stay planar.
 *
 * @param ops Wasm op surface (must provide roomMorph).
 * @param channels Source channels (planar, non-empty).
 * @param sampleRate Source sample rate in Hz (> 0).
 * @param preset Target room shape and wall material.
 * @param wet Wet/dry mix in [0, 1] (0 = dry, 1 = fully wet); non-finite
 *   values fall back to 0.35.
 * @throws Error when the module does not provide roomMorph.
 * @throws RangeError on a non-positive sample rate or no channels.
 */
export function roomMorphChannels(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  preset: RoomMorphPreset,
  wet: number,
): Float32Array[] {
  const fn = ops.roomMorph;
  if (typeof fn !== 'function') {
    throw new Error('Room reverb is unavailable in this libsonare build');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  }
  if (channels.length === 0) {
    throw new RangeError('Cannot process an empty channel list');
  }
  const options = {
    lengthM: preset.lengthM,
    widthM: preset.widthM,
    heightM: preset.heightM,
    materialPreset: preset.materialPreset,
    wet: Number.isFinite(wet) ? Math.min(Math.max(wet, 0), 1) : 0.35,
  };
  const processed = channels.map((channel) => fn(channel, sampleRate, options));
  const minFrames = Math.min(...processed.map((segment) => segment.length));
  return processed.map((segment) =>
    segment.length === minFrames ? segment : segment.slice(0, minFrames),
  );
}
