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
import { ensureWasm } from '@/lib/wasm';
import type { MasteringPreset, RirDiagnostic } from '@/wasm/index.js';
import {
  type MatchEqAnalysis,
  parseMatchEqCurve,
  parseReferenceLoudness,
  parseTonalBalance,
} from './match-eq-analysis';
import {
  type DetectedNote,
  downmixToMono,
  onsetSecondsToFrames,
  silenceSplitMarkers,
} from './onsets';
import { resolveRange, type SampleRange, spliceRange } from './ops';

/** The subset of the libsonare module consumed by the sample editor. */
export type SampleEditorWasmOps = Partial<
  Pick<
    typeof import('@/wasm/index.js'),
    | 'pitchShift'
    | 'pitchCorrectToMidi'
    | 'pitchYin'
    | 'pitchPyin'
    | 'pitchCorrectToMidiTimevarying'
    | 'estimateTuning'
    | 'scaleQuantizeMidi'
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
    | 'detectOnsets'
    | 'splitSilence'
    | 'noteSegments'
    | 'noteMove'
    | 'roomMorph'
    | 'synthesizeRir'
    | 'estimateRoom'
    | 'analyzeImpulseResponse'
    | 'detectAcoustic'
    | 'spectralEdit'
    | 'masteringPairProcess'
    | 'masteringPairAnalyze'
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
  detectOnsets: boolean;
  splitSilence: boolean;
  matchEq: boolean;
  matchEqAnalyze: boolean;
  roomMorph: boolean;
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
    pitchCorrect: typeof ops?.pitchCorrectToMidi === 'function',
    pitchCorrectTimevarying:
      typeof ops?.pitchCorrectToMidiTimevarying === 'function' &&
      (typeof ops?.pitchPyin === 'function' || typeof ops?.pitchYin === 'function'),
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
    detectOnsets: typeof ops?.detectOnsets === 'function',
    splitSilence: typeof ops?.splitSilence === 'function',
    matchEq: typeof ops?.masteringPairProcess === 'function',
    matchEqAnalyze: typeof ops?.masteringPairAnalyze === 'function',
    roomMorph: typeof ops?.roomMorph === 'function',
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
 * Runs a repair over the range. A stereo pair goes through the linked stereo
 * form when the module has one, so both channels take the same repair
 * decisions; otherwise each channel is repaired on its own.
 */
function applyRepairToRange(
  channels: ReadonlyArray<Float32Array>,
  range: SampleRange | null | undefined,
  mono: (segment: Float32Array) => Float32Array,
  stereo?: (left: Float32Array, right: Float32Array) => { left: Float32Array; right: Float32Array },
): Float32Array[] {
  if (channels.length !== 2 || stereo === undefined) return applyToRange(channels, range, mono);
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
  const out = stereo(
    channels[0].slice(resolved.startFrame, resolved.endFrame),
    channels[1].slice(resolved.startFrame, resolved.endFrame),
  );
  const frames = Math.min(out.left.length, out.right.length);
  return spliceRange(channels, resolved, [out.left.slice(0, frames), out.right.slice(0, frames)]);
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
  const correct = ops.pitchCorrectToMidiTimevarying;
  const detect = ops.pitchPyin ?? ops.pitchYin;
  if (typeof correct !== 'function' || typeof detect !== 'function') {
    throw new Error('Time-varying pitch correction is unavailable in this libsonare build');
  }
  if (!Number.isInteger(targetMidi) || targetMidi < 0 || targetMidi > 127) {
    throw new RangeError(`targetMidi must be an integer in [0, 127], got ${targetMidi}`);
  }
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
  const segments = channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame));
  const hopLength = 512;
  const contour = detect(
    downmixToMono(segments),
    sampleRate,
    2048,
    hopLength,
    undefined,
    undefined,
    undefined,
    true,
  );
  const f0 = contour.f0;
  if (!f0 || f0.length === 0 || !Array.from(f0).some((hz) => hz > 0 && Number.isFinite(hz))) {
    throw new Error('Could not detect a pitch contour in the selection');
  }
  const voiced =
    contour.voicedFlag && contour.voicedFlag.length === f0.length
      ? Int32Array.from(contour.voicedFlag, (flag) => (flag ? 1 : 0))
      : undefined;
  const corrected = segments.map((segment) =>
    correct(segment, f0, targetMidi, sampleRate, hopLength, voiced),
  );
  const minFrames = Math.min(...corrected.map((segment) => segment.length));
  const planar = corrected.map((segment) =>
    segment.length === minFrames ? segment : segment.slice(0, minFrames),
  );
  return spliceRange(channels, resolved, planar);
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
  // 12-TET step index is the MIDI number the engine's pitch ops expect.
  const currentMidi = stepOf(medianF0);
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
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  }
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
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
  const edit = {
    startSample: resolved.startFrame,
    endSample: resolved.endFrame,
    lowHz: options.lowHz,
    highHz: options.highHz,
    gainDb: options.gainDb,
    mode: options.mode,
  };
  const processed = channels.map((channel) =>
    fn(channel, sampleRate, [edit], { nFft: 2048, hopLength: 512, window: 'hann' }),
  );
  const minFrames = Math.min(...processed.map((segment) => segment.length));
  return processed.map((segment) =>
    segment.length === minFrames ? segment : segment.slice(0, minFrames),
  );
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
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`rate must be > 0, got ${rate}`);
  }
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
  const stretched = channels.map((channel) =>
    fn(channel, sampleRate, {
      onsetSample: resolved.startFrame,
      offsetSample: resolved.endFrame,
      stretchRatio: 1 / rate,
    }),
  );
  const minFrames = Math.min(...stretched.map((segment) => segment.length));
  return stretched.map((segment) =>
    segment.length === minFrames ? segment : segment.slice(0, minFrames),
  );
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
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot process an empty range');
  }
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
  const minFrames = Math.min(...moved.map((segment) => segment.length));
  return moved.map((segment) =>
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
  const stereo = ops.masteringRepairDeclickStereo;
  return applyRepairToRange(
    channels,
    range,
    (segment) => fn(segment, sampleRate),
    stereo && ((left, right) => stereo(left, right, sampleRate)),
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
    range,
    (segment) => mono(segment, sampleRate, preset).samples,
    (left, right) => stereo(left, right, sampleRate, preset),
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
    range,
    (segment) => fn(segment, sampleRate, options),
    stereo && ((left, right) => stereo(left, right, sampleRate, options)),
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
    range,
    (segment) => fn(segment, sampleRate),
    stereo && ((left, right) => stereo(left, right, sampleRate)),
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
    range,
    (segment) => fn(segment, sampleRate),
    stereo && ((left, right) => stereo(left, right, sampleRate)),
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
    range,
    (segment) => fn(segment, sampleRate),
    stereo && ((left, right) => stereo(left, right, sampleRate)),
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
    range,
    (segment) => fn(segment, sampleRate),
    stereo && ((left, right) => stereo(left, right, sampleRate)),
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

/** F0 hop for note detection, matching the pitch-correction contour. */
const NOTE_DETECT_HOP = 512;
/** F0 analysis window, matching the pitch-correction contour. */
const NOTE_DETECT_FRAME = 2048;
/**
 * Pitch step that starts a new note, in cents. A semitone is 100, so the
 * threshold has to sit below that to separate adjacent semitones — and above
 * the depth of a vibrato, or every cycle of one becomes its own note. Measured
 * on held tones, 70-90 holds a +/-60 cent vibrato as one note while still
 * splitting a semitone step; 100 merges the semitones, 50 (the library default)
 * breaks a +/-50 cent vibrato into a note per cycle. A vibrato wider than a
 * semitone cannot be held together at any threshold.
 */
const NOTE_DETECT_THRESHOLD_CENTS = 80;

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
  const detect = ops.pitchPyin ?? ops.pitchYin;
  if (typeof segment !== 'function' || typeof detect !== 'function') {
    throw new Error('Note detection is unavailable in this libsonare build');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  }
  const mono = downmixToMono(channels);
  const contour = detect(
    mono,
    sampleRate,
    NOTE_DETECT_FRAME,
    NOTE_DETECT_HOP,
    undefined,
    undefined,
    undefined,
    true,
  );
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
    const startFrame = Math.max(0, Math.round(region.startSeconds * sampleRate));
    const endFrame = Math.min(mono.length, Math.round(region.endSeconds * sampleRate));
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

/** Resamples a mono reference so pair DSP sees one shared frequency axis. */
export function resampleMatchEqReference(
  reference: Float32Array,
  referenceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (!Number.isFinite(referenceSampleRate) || referenceSampleRate <= 0) {
    throw new RangeError(`referenceSampleRate must be > 0, got ${referenceSampleRate}`);
  }
  if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
    throw new RangeError(`targetSampleRate must be > 0, got ${targetSampleRate}`);
  }
  if (referenceSampleRate === targetSampleRate || reference.length <= 1) return reference;
  const outputFrames = Math.max(
    1,
    Math.round((reference.length * targetSampleRate) / referenceSampleRate),
  );
  const output = new Float32Array(outputFrames);
  if (outputFrames === 1) {
    output[0] = reference[0];
    return output;
  }
  const step = (reference.length - 1) / (outputFrames - 1);
  for (let index = 0; index < outputFrames; index += 1) {
    const position = index * step;
    const before = Math.floor(position);
    const after = Math.min(reference.length - 1, before + 1);
    const amount = position - before;
    output[index] = reference[before] + (reference[after] - reference[before]) * amount;
  }
  return output;
}

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
 * @param referenceSampleRate Reference rate; resampled to `sampleRate` before DSP.
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
  referenceSampleRate = sampleRate,
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
  const rateMatchedReference = resampleMatchEqReference(reference, referenceSampleRate, sampleRate);
  const mix = Number.isFinite(amount) ? Math.min(Math.max(amount, 0), 1) : 1;
  return applyToRange(channels, range, (segment) => {
    if (mix <= 0) return segment;
    const matched = fn(MATCH_EQ_PROCESSOR, segment, rateMatchedReference, sampleRate).samples;
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
 * @param referenceSampleRate Reference rate; resampled to `sampleRate` before analysis.
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
  referenceSampleRate = sampleRate,
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
  const rateMatchedReference = resampleMatchEqReference(reference, referenceSampleRate, sampleRate);
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot analyze an empty range');
  }
  const source = downmixToMono(
    channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame)),
  );
  return {
    curve: parseMatchEqCurve(fn(MATCH_EQ_CURVE, source, rateMatchedReference, sampleRate)),
    tonalBalance: parseTonalBalance(
      fn(MATCH_TONAL_BALANCE, source, rateMatchedReference, sampleRate),
    ),
    loudness: parseReferenceLoudness(
      fn(MATCH_REFERENCE_LOUDNESS, source, rateMatchedReference, sampleRate),
    ),
  };
}

/** Audio rendered through a synthesized room, with what the synthesis changed. */
export interface RoomRenderResult {
  channels: Float32Array[];
  /**
   * Diagnostics from the room synthesis, each naming a way the rendered room
   * differs from the requested one.
   */
  diagnostics: RirDiagnostic[];
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
 * @param airAbsorption Adds atmospheric absorption at the reference climate,
 *   which shortens the high bands of a large room.
 * @throws Error when the module does not provide roomMorph.
 * @throws RangeError on a non-positive sample rate or no channels.
 */
export function roomMorphChannels(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  preset: RoomMorphPreset,
  wet: number,
  airAbsorption = false,
): RoomRenderResult {
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
    ...(airAbsorption ? { airAbsorptionEnabled: true } : {}),
  };
  const processed = channels.map((channel) => fn(channel, sampleRate, options));
  const minFrames = Math.min(...processed.map((result) => result.audio.length));
  return {
    channels: processed.map(({ audio }) =>
      audio.length === minFrames ? audio : audio.slice(0, minFrames),
    ),
    // Every channel goes through the same room, so the first one speaks for all.
    diagnostics: processed[0].diagnostics,
  };
}

/**
 * Synthesizes a mono room impulse response from a room preset. The result is
 * returned as planar audio so it can be stored as a normal sample-editor
 * version and used elsewhere in the project.
 *
 * @throws Error when the module does not provide synthesizeRir or reports an
 *   invalid geometry.
 * @throws RangeError on a non-positive sample rate.
 */
export function synthesizeRirChannels(
  ops: SampleEditorWasmOps,
  sampleRate: number,
  preset: RoomMorphPreset,
  airAbsorption = false,
): RoomRenderResult {
  const fn = ops.synthesizeRir;
  if (typeof fn !== 'function') {
    throw new Error('RIR synthesis is unavailable in this libsonare build');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  }
  const result = fn({
    sampleRate,
    lengthM: preset.lengthM,
    widthM: preset.widthM,
    heightM: preset.heightM,
    materialPreset: preset.materialPreset,
    ...(airAbsorption ? { airAbsorptionEnabled: true } : {}),
  });
  if (result.hasError || result.rir.length === 0) {
    throw new Error('RIR synthesis failed for the selected room');
  }
  return { channels: [result.rir], diagnostics: result.diagnostics };
}

/** Display-oriented subset of libsonare's room estimation result. */
export interface RoomEstimateSummary {
  volume: number;
  length: number;
  width: number;
  height: number;
  drrDb: number;
  confidence: number;
  rt60Mid: number;
  absorptionMean: number;
}

interface AcousticAnalysisResult {
  rt60: number;
  edt: number;
  c50: number;
  c80: number;
  d50: number;
  rt60Bands: Float32Array;
  edtBands: Float32Array;
  c50Bands: Float32Array;
  c80Bands: Float32Array;
  confidence: number;
  isBlind: boolean;
}

/** Display-oriented subset of libsonare's acoustic analysis result. */
export interface AcousticAnalysisSummary {
  kind: 'impulse' | 'blind';
  rt60: number;
  edt: number;
  c50: number;
  c80: number;
  d50: number;
  confidence: number;
  rt60Mean: number;
  edtMean: number;
  isBlind: boolean;
}

function averageFinite(values: ArrayLike<number> | undefined, min = -Infinity): number {
  const finite = Array.from(values ?? []).filter((value) => Number.isFinite(value) && value >= min);
  return finite.length > 0
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : Number.NaN;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function monoSelection(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  }
  const resolved = resolveRange(channels, range);
  if (resolved.endFrame <= resolved.startFrame) {
    throw new RangeError('Cannot analyze an empty range');
  }
  return downmixToMono(
    channels.map((channel) => channel.slice(resolved.startFrame, resolved.endFrame)),
  );
}

function acousticSummary(
  result: AcousticAnalysisResult,
  kind: AcousticAnalysisSummary['kind'],
): AcousticAnalysisSummary {
  return {
    kind,
    rt60: result.rt60,
    edt: result.edt,
    c50: result.c50,
    c80: result.c80,
    d50: result.d50,
    confidence: result.confidence,
    rt60Mean: averageFinite(result.rt60Bands, 0),
    edtMean: averageFinite(result.edtBands, 0),
    isBlind: result.isBlind,
  };
}

/**
 * True when the estimate measured a room shape. The estimator reports NaN
 * dimensions when no decay is measurable.
 */
export function roomEstimateHasGeometry(estimate: RoomEstimateSummary): boolean {
  return (
    finitePositive(estimate.length) &&
    finitePositive(estimate.width) &&
    finitePositive(estimate.height)
  );
}

/** Converts blind room-estimation output into a preset usable by RIR and roomMorph. */
export function roomEstimateToPreset(estimate: RoomEstimateSummary): RoomMorphPreset {
  if (!roomEstimateHasGeometry(estimate)) {
    throw new RangeError('Room estimate has invalid dimensions');
  }
  const { length, width, height } = estimate;
  const absorption = estimate.absorptionMean;
  let materialPreset = 2;
  if (Number.isFinite(absorption)) {
    if (absorption < 0.18) materialPreset = 1;
    else if (absorption >= 0.5) materialPreset = 4;
    else if (absorption >= 0.35) materialPreset = 3;
  }
  return { lengthM: length, widthM: width, heightM: height, materialPreset };
}

/**
 * Estimates an equivalent room from the selection (or whole file). The source
 * is downmixed to mono and passed to libsonare's blind/IR room estimator.
 *
 * @throws Error when the module does not provide estimateRoom.
 * @throws RangeError on a non-positive sample rate or empty range.
 */
export function estimateRoomRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): RoomEstimateSummary {
  const fn = ops.estimateRoom;
  if (typeof fn !== 'function') {
    throw new Error('Room estimation is unavailable in this libsonare build');
  }
  const mono = monoSelection(channels, sampleRate, range);
  const estimate = fn(mono, sampleRate, { mode: 0, nOctaveBands: 6 });
  const rt60Mid = averageFinite(estimate.rt60Bands, 0);
  return {
    volume: estimate.volume,
    length: estimate.length,
    width: estimate.width,
    height: estimate.height,
    drrDb: estimate.drrDb,
    confidence: estimate.confidence,
    rt60Mid,
    absorptionMean: averageFinite(estimate.absorptionBands, 0),
  };
}

/**
 * Analyzes a selected impulse response and returns acoustic clarity/decay
 * metrics. Intended for generated/imported RIR assets in the sample editor.
 *
 * @throws Error when the module does not provide analyzeImpulseResponse.
 * @throws RangeError on a non-positive sample rate or empty range.
 */
export function analyzeImpulseResponseRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): AcousticAnalysisSummary {
  const fn = ops.analyzeImpulseResponse;
  if (typeof fn !== 'function') {
    throw new Error('Impulse response analysis is unavailable in this libsonare build');
  }
  const mono = monoSelection(channels, sampleRate, range);
  return acousticSummary(fn(mono, sampleRate, 6), 'impulse');
}

/**
 * Runs libsonare's blind acoustic detector over the selection (or whole file).
 *
 * @throws Error when the module does not provide detectAcoustic.
 * @throws RangeError on a non-positive sample rate or empty range.
 */
export function detectAcousticRange(
  ops: SampleEditorWasmOps,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  range?: SampleRange | null,
): AcousticAnalysisSummary {
  const fn = ops.detectAcoustic;
  if (typeof fn !== 'function') {
    throw new Error('Acoustic detection is unavailable in this libsonare build');
  }
  const mono = monoSelection(channels, sampleRate, range);
  return acousticSummary(fn(mono, sampleRate, { nOctaveBands: 6 }), 'blind');
}
