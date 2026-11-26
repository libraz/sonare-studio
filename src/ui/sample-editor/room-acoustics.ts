/**
 * Room acoustics for the sample editor: rendering audio through a synthesized
 * room, synthesizing a room impulse response, and the blind room and acoustic
 * estimators, reduced to display-oriented summaries. Every function takes the
 * injected libsonare surface, like the other wasm-delegated operations.
 */

import type { AcousticResult, MaterialPresetName, RirDiagnostic } from '@libraz/libsonare';
import { clamp, minOf } from '@/lib/math';
import type { SampleRange } from './ops';
import {
  analysisMono,
  assertSampleRate,
  finitePositive,
  type SampleEditorWasmOps,
} from './wasm-ops';

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
 * a libsonare wall-material preset.
 */
export interface RoomMorphPreset {
  lengthM: number;
  widthM: number;
  heightM: number;
  materialPreset: MaterialPresetName;
}

/**
 * Applies a synthesized room's reverberant character to every channel. Room
 * reverb is a whole-signal effect whose impulse response runs past the input,
 * so this always processes the full channel (no sub-range) and returns
 * latency-compensated, tail-extended buffers that are longer than the input.
 * A stereo pair is heard by a spaced receiver pair (when the module has
 * roomMorphStereo) so the room differs between the channels; other layouts
 * convolve each channel against the same room. Results are trimmed to the
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
  assertSampleRate(sampleRate);
  if (channels.length === 0) {
    throw new RangeError('Cannot process an empty channel list');
  }
  const options = {
    lengthM: preset.lengthM,
    widthM: preset.widthM,
    heightM: preset.heightM,
    materialPreset: preset.materialPreset,
    wet: Number.isFinite(wet) ? clamp(wet, 0, 1) : 0.35,
    ...(airAbsorption ? { airAbsorptionEnabled: true } : {}),
  };
  const stereo = ops.roomMorphStereo;
  if (channels.length === 2 && typeof stereo === 'function') {
    const { left, right, diagnostics } = stereo({
      left: channels[0],
      right: channels[1],
      sampleRate,
      ...options,
    });
    const frames = Math.min(left.length, right.length);
    return {
      channels: [left.slice(0, frames), right.slice(0, frames)],
      diagnostics,
    };
  }
  const processed = channels.map((channel) => fn(channel, sampleRate, options));
  const minFrames = minOf(processed.map((result) => result.audio.length));
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
  assertSampleRate(sampleRate);
  const result = fn({
    sampleRate,
    lengthM: preset.lengthM,
    widthM: preset.widthM,
    heightM: preset.heightM,
    materialPreset: preset.materialPreset,
    ...(airAbsorption ? { airAbsorptionEnabled: true } : {}),
  });
  if (result.rir.length === 0) {
    throw new Error('RIR synthesis failed for the selected room');
  }
  return { channels: [result.rir], diagnostics: result.diagnostics };
}

/** Display-oriented subset of libsonare's room estimation result. */
export interface RoomEstimateSummary {
  volume?: number;
  length?: number;
  width?: number;
  height?: number;
  drrDb?: number;
  confidence: number;
  rt60Mid?: number;
  absorptionMean?: number;
}

/** Display-oriented subset of libsonare's acoustic analysis result. */
export interface AcousticAnalysisSummary {
  kind: 'impulse' | 'blind';
  rt60?: number;
  edt?: number;
  c50?: number;
  c80?: number;
  d50?: number;
  confidence: number;
  rt60Mean?: number;
  edtMean?: number;
  isBlind: boolean;
}

function averageFinite(values: ArrayLike<number> | undefined, min = -Infinity): number | undefined {
  const finite = Array.from(values ?? []).filter((value) => Number.isFinite(value) && value >= min);
  return finite.length > 0
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : undefined;
}

function acousticSummary(
  result: AcousticResult,
  kind: AcousticAnalysisSummary['kind'],
): AcousticAnalysisSummary {
  const rt60Mean = averageFinite(result.rt60Bands, 0);
  const edtMean = averageFinite(result.edtBands, 0);
  return {
    kind,
    ...(result.rt60 === undefined ? {} : { rt60: result.rt60 }),
    ...(result.edt === undefined ? {} : { edt: result.edt }),
    ...(result.c50 === undefined ? {} : { c50: result.c50 }),
    ...(result.c80 === undefined ? {} : { c80: result.c80 }),
    ...(result.d50 === undefined ? {} : { d50: result.d50 }),
    confidence: result.confidence,
    ...(rt60Mean === undefined ? {} : { rt60Mean }),
    ...(edtMean === undefined ? {} : { edtMean }),
    isBlind: result.isBlind,
  };
}

/** Formats a measured value with its unit suffix, or uses the label for an unmeasured value. */
export function formatMeasure(
  value: number | undefined,
  digits: number,
  suffix: string,
  unmeasured = '—',
): string {
  if (value === Number.POSITIVE_INFINITY) return `∞${suffix}`;
  if (value === Number.NEGATIVE_INFINITY) return `-∞${suffix}`;
  return value !== undefined && Number.isFinite(value)
    ? `${value.toFixed(digits)}${suffix}`
    : unmeasured;
}

/**
 * True when the estimate measured a room shape. Dimensions are absent when no
 * decay is measurable.
 */
export function roomEstimateHasGeometry(
  estimate: RoomEstimateSummary,
): estimate is RoomEstimateSummary & { length: number; width: number; height: number } {
  return (
    estimate.length !== undefined &&
    finitePositive(estimate.length) &&
    estimate.width !== undefined &&
    finitePositive(estimate.width) &&
    estimate.height !== undefined &&
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
  let materialPreset: MaterialPresetName = 'wood';
  if (absorption !== undefined && Number.isFinite(absorption)) {
    if (absorption < 0.18) materialPreset = 'concrete';
    else if (absorption >= 0.5) materialPreset = 'carpet';
    else if (absorption >= 0.35) materialPreset = 'curtain';
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
  assertSampleRate(sampleRate);
  const mono = analysisMono(channels, range);
  const estimate = fn(mono, sampleRate, { mode: 'auto', nOctaveBands: 6 });
  const rt60Mid = averageFinite(estimate.rt60Bands, 0);
  const absorptionMean = averageFinite(estimate.bandAbsorption, 0);
  return {
    ...(estimate.volume === undefined ? {} : { volume: estimate.volume }),
    ...(estimate.lengthM === undefined ? {} : { length: estimate.lengthM }),
    ...(estimate.widthM === undefined ? {} : { width: estimate.widthM }),
    ...(estimate.heightM === undefined ? {} : { height: estimate.heightM }),
    ...(estimate.drrDb === undefined ? {} : { drrDb: estimate.drrDb }),
    confidence: estimate.confidence,
    ...(rt60Mid === undefined ? {} : { rt60Mid }),
    ...(absorptionMean === undefined ? {} : { absorptionMean }),
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
  assertSampleRate(sampleRate);
  const mono = analysisMono(channels, range);
  return acousticSummary(fn(mono, sampleRate, { nOctaveBands: 6 }), 'impulse');
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
  assertSampleRate(sampleRate);
  const mono = analysisMono(channels, range);
  return acousticSummary(fn(mono, sampleRate, { nOctaveBands: 6 }), 'blind');
}
