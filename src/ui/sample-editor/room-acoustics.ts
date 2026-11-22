/**
 * Room acoustics for the sample editor: rendering audio through a synthesized
 * room, synthesizing a room impulse response, and the blind room and acoustic
 * estimators, reduced to display-oriented summaries. Every function takes the
 * injected libsonare surface, like the other wasm-delegated operations.
 */

import type { MaterialPresetName, RirDiagnostic } from '@libraz/libsonare';
import { clamp } from '@/lib/math';
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
  let materialPreset: MaterialPresetName = 'wood';
  if (Number.isFinite(absorption)) {
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
  return {
    volume: estimate.volume,
    length: estimate.lengthM,
    width: estimate.widthM,
    height: estimate.heightM,
    drrDb: estimate.drrDb,
    confidence: estimate.confidence,
    rt60Mid,
    absorptionMean: averageFinite(estimate.bandAbsorption, 0),
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
