/**
 * Pure declaration helpers shared by realtime sync and offline export.
 *
 * These functions encode the engine-facing interpretation of strip DSP and
 * automation points so live playback and export do not drift when a gate or
 * validity rule changes.
 */

import { type AutomationCurve, automationCurveCode } from '@/project/automation';
import type { MixerStrip } from '@/project/mixer';
import type { EqBand } from '@/wasm/index.js';

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
