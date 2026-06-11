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
import { resolveRange, type SampleRange, spliceRange } from './ops';

/** The subset of the libsonare module consumed by the sample editor. */
export interface SampleEditorWasmOps {
  /** Pitch shift by semitones, duration preserved. */
  pitchShift?: (samples: Float32Array, sampleRate: number, semitones: number) => Float32Array;
  /** Time stretch by rate (0.5 = double duration, 2.0 = half duration). */
  timeStretch?: (samples: Float32Array, sampleRate: number, rate: number) => Float32Array;
  /** Click/pop repair. */
  masteringRepairDeclick?: (samples: Float32Array, sampleRate: number) => Float32Array;
  /** Classical (non-ML) broadband denoise. */
  masteringRepairDenoiseClassical?: (samples: Float32Array, sampleRate: number) => Float32Array;
}

/** Which wasm-delegated operations the given module actually provides. */
export interface WasmOpAvailability {
  pitchShift: boolean;
  timeStretch: boolean;
  declick: boolean;
  denoise: boolean;
}

/** Reports availability of the wasm-delegated operations (all false on null). */
export function wasmOpAvailability(
  ops: SampleEditorWasmOps | null | undefined,
): WasmOpAvailability {
  return {
    pitchShift: typeof ops?.pitchShift === 'function',
    timeStretch: typeof ops?.timeStretch === 'function',
    declick: typeof ops?.masteringRepairDeclick === 'function',
    denoise: typeof ops?.masteringRepairDenoiseClassical === 'function',
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
