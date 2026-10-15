/**
 * Pure declaration helpers shared by realtime sync and offline export.
 *
 * These functions encode the engine-facing interpretation of strip DSP and
 * automation points so live playback and export do not drift when a gate or
 * validity rule changes.
 */

import { SILENCE_DB } from '@/lib/db';
import { type AutomationCurve, automationCurveCode } from '@/project/automation';
import {
  clampPan,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  type MixerStrip,
  type PanLawId,
  type PanModeId,
} from '@/project/mixer';
import type { EqBand } from '@/wasm/index.js';

/** Raw libsonare ordinals for the project-facing pan law names. */
const ENGINE_PAN_LAW_CODES: Readonly<Record<PanLawId, number>> = {
  const3dB: 0,
  'const4.5dB': 1,
  const6dB: 2,
  linear0dB: 3,
};

/** Raw libsonare ordinals for the project-facing pan mode names. */
const ENGINE_PAN_MODE_CODES: Readonly<Record<PanModeId, number>> = {
  balance: 0,
  stereoPan: 1,
  dualPan: 2,
};

/** Bus panner state in the numeric shape accepted by scene JSON and setters. */
export interface EngineBusPanState {
  pan: number;
  panLaw: number;
  panMode: number;
  dualPanLeft: number;
  dualPanRight: number;
}

function finitePan(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clampPan(value) : fallback;
}

/** Converts one app strip's optional panner fields to libsonare defaults/codes. */
export function engineBusPanState(strip: MixerStrip | undefined): EngineBusPanState {
  const panLaw = strip?.panLaw ?? DEFAULT_PAN_LAW;
  const panMode = strip?.panMode ?? DEFAULT_PAN_MODE;
  return {
    pan: finitePan(strip?.pan, 0),
    panLaw: ENGINE_PAN_LAW_CODES[panLaw] ?? ENGINE_PAN_LAW_CODES[DEFAULT_PAN_LAW],
    panMode: ENGINE_PAN_MODE_CODES[panMode] ?? ENGINE_PAN_MODE_CODES[DEFAULT_PAN_MODE],
    dualPanLeft: finitePan(strip?.dualPan?.left, -1),
    dualPanRight: finitePan(strip?.dualPan?.right, 1),
  };
}

/** True when running the bus panner would change a neutral bus's output. */
export function engineBusPanHasDsp(strip: MixerStrip | undefined): boolean {
  const state = engineBusPanState(strip);
  return (
    state.pan !== 0 ||
    state.panLaw !== ENGINE_PAN_LAW_CODES[DEFAULT_PAN_LAW] ||
    state.panMode !== ENGINE_PAN_MODE_CODES[DEFAULT_PAN_MODE] ||
    state.dualPanLeft !== -1 ||
    state.dualPanRight !== 1
  );
}

/** Master fader pan is sent separately; these panner details need a strip scene. */
export function engineMasterPannerHasDsp(strip: MixerStrip | undefined): boolean {
  const state = engineBusPanState(strip);
  return (
    state.panLaw !== ENGINE_PAN_LAW_CODES[DEFAULT_PAN_LAW] ||
    state.panMode !== ENGINE_PAN_MODE_CODES[DEFAULT_PAN_MODE] ||
    state.dualPanLeft !== -1 ||
    state.dualPanRight !== 1
  );
}

/** One finite automation point in the shape accepted by the engine. */
export interface EngineAutomationPoint {
  ppq: number;
  value: number;
  curveToNext: number;
}

/** Keeps only finite automation points and encodes their curve id. */
export function engineAutomationPoints(
  points: ReadonlyArray<{ ppq: number; value: number; curve?: AutomationCurve }>,
): EngineAutomationPoint[] {
  return points
    .filter((point) => Number.isFinite(point.ppq) && Number.isFinite(point.value))
    .map((point) => ({
      ppq: point.ppq,
      value: point.value,
      curveToNext: automationCurveCode(point.curve),
    }));
}

/** Encodes automation points and offsets their values by a dB stage such as VCA. */
export function engineAutomationPointsWithValueOffset(
  points: ReadonlyArray<{ ppq: number; value: number; curve?: AutomationCurve }>,
  valueOffset = 0,
): EngineAutomationPoint[] {
  const encoded = engineAutomationPoints(points);
  if (!Number.isFinite(valueOffset) || valueOffset === 0) return encoded;
  return encoded.map((point) => ({ ...point, value: point.value + valueOffset }));
}

/**
 * Encodes absolute fader automation after applying only its VCA offset and
 * independent mute stage. Track volume and strip trim are part of the manual
 * fader baseline, not of an enabled automation lane. Muted lanes retain their
 * timeline points/curve ids but every value is pinned to the engine silence
 * floor, so block automation cannot reopen them.
 */
export function engineFaderAutomationPoints(
  points: ReadonlyArray<{ ppq: number; value: number; curve?: AutomationCurve }>,
  valueOffset = 0,
  muted = false,
): EngineAutomationPoint[] {
  const encoded = engineAutomationPointsWithValueOffset(points, valueOffset);
  return muted ? encoded.map((point) => ({ ...point, value: SILENCE_DB })) : encoded;
}

/** EQ bands that should be declared to the engine for a strip. */
export function engineEqBands(strip: MixerStrip | undefined): EqBand[] {
  return strip?.eq?.enabled ? strip.eq.bands : [];
}

/** True when strip-local scene DSP fields require a strip scene even with no inserts/EQ. */
export function stripSceneFieldsHaveDsp(strip: MixerStrip | undefined): boolean {
  return (
    (strip?.inputTrimDb ?? 0) !== 0 ||
    (strip?.width ?? 1) !== 1 ||
    strip?.polarityInvertLeft === true ||
    strip?.polarityInvertRight === true
  );
}

/** Bus/group strips omit disabled inserts because the engine bus scene has no bypass API. */
export function engineBusStrip(strip: MixerStrip | undefined): MixerStrip | undefined {
  if (!strip) return undefined;
  return { ...strip, inserts: strip.inserts.filter((slot) => slot.enabled) };
}

/**
 * Maps a persisted bus/group insert slot to the index declared by the active
 * engine ABI. New engines declare every slot and bypass disabled processors;
 * legacy engines omit disabled slots and therefore use a compacted index.
 */
export function engineBusInsertAutomationIndex(
  strip: MixerStrip | undefined,
  storeInsertIndex: number,
  supportsBypass: boolean,
): number | undefined {
  const slot = strip?.inserts[storeInsertIndex];
  if (!slot) return undefined;
  if (supportsBypass) return storeInsertIndex;
  if (!slot.enabled) return undefined;
  let engineIndex = 0;
  for (let i = 0; i < storeInsertIndex; i += 1) {
    if (strip.inserts[i]?.enabled) engineIndex += 1;
  }
  return engineIndex;
}

/** True when the current engine bus scene ABI can represent audible bus DSP. */
export function engineBusStripHasDsp(strip: MixerStrip | undefined, includeBusEq = false): boolean {
  const busStrip = engineBusStrip(strip);
  return (
    stripSceneFieldsHaveDsp(strip) ||
    engineBusPanHasDsp(strip) ||
    (busStrip?.inserts.length ?? 0) > 0 ||
    (includeBusEq && engineEqBands(strip).length > 0)
  );
}
