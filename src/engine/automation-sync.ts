/**
 * Realtime automation synchronisation: mirrors the store's automation lanes
 * (fader dB / pan on a track or the master strip) onto the engine's reserved
 * mixer automation parameters, transmitting only what changed.
 *
 * Engine contract (libsonare):
 * - automationParamId resolves the reserved parameter id of a strip
 *   parameter; a numeric target DECLARES a mixer lane for unknown track ids,
 *   so ids are only resolved for tracks the mixer sync already declared
 *   (options.knownTrackIds) — lanes for other targets are skipped.
 * - setAutomationLane replaces the whole lane in one call; an empty array
 *   clears it. An installed lane is applied every audio block (playing or
 *   not) and overrides manual setStripGain/setStripPan for that parameter.
 *   Clearing leaves the engine at the last automated value, so
 *   options.restoreParam must re-push the manual strip value afterwards.
 */

import {
  type AutomationLaneState,
  type AutomationParam,
  automationCurveCode,
} from '@/project/automation';
import type { EngineHandle } from './engine';

/** Options for {@link createAutomationSync}. */
export interface AutomationSyncOptions {
  /** Track ids already declared as engine mixer lanes (safe to resolve). */
  knownTrackIds: () => readonly number[];
  /** Re-pushes the manual strip value after a lane has been cleared. */
  restoreParam: (target: number | 'master', param: AutomationParam) => void;
}

/** Mirrors store automation lanes onto a running engine. */
export interface AutomationSync {
  /** Diffs and pushes the effective lanes to the engine. */
  sync(lanes: ReadonlyArray<AutomationLaneState>): void;
  /** Engine parameter ids currently holding an installed lane. */
  installedParamIds(): readonly number[];
}

/** Bookkeeping for one installed engine lane, kept for change detection. */
interface InstalledLane {
  target: number | 'master';
  param: AutomationParam;
  json: string;
}

/**
 * Creates an automation sync bound to one engine handle. Create a fresh
 * instance per engine start: the installed-lane memory restarts with the
 * engine. Engine errors propagate to the caller; a failed lane is re-sent on
 * the next sync.
 *
 * @param handle Running engine handle from createEngine.
 * @param options Known-track lookup and the manual-value restore callback.
 * @returns The sync facade.
 */
export function createAutomationSync(
  handle: EngineHandle,
  options: AutomationSyncOptions,
): AutomationSync {
  const installed = new Map<number, InstalledLane>();

  const sync = (lanes: ReadonlyArray<AutomationLaneState>): void => {
    const knownTracks = new Set(options.knownTrackIds());
    const effectiveParamIds = new Set<number>();
    for (const lane of lanes) {
      if (!lane.enabled) continue;
      if (lane.target !== 'master' && !knownTracks.has(lane.target)) continue;
      const points = lane.points
        .filter((point) => Number.isFinite(point.ppq) && Number.isFinite(point.value))
        .map((point) => ({
          ppq: point.ppq,
          value: point.value,
          curveToNext: automationCurveCode(point.curve),
        }));
      if (points.length === 0) continue;
      const paramId = handle.engine.automationParamId(lane.target, lane.param);
      effectiveParamIds.add(paramId);
      const json = JSON.stringify(points);
      if (installed.get(paramId)?.json === json) continue;
      handle.engine.setAutomationLane(paramId, points);
      installed.set(paramId, { target: lane.target, param: lane.param, json });
    }
    for (const [paramId, lane] of installed) {
      if (effectiveParamIds.has(paramId)) continue;
      handle.engine.setAutomationLane(paramId, []);
      options.restoreParam(lane.target, lane.param);
      installed.delete(paramId);
    }
  };

  return { sync, installedParamIds: () => [...installed.keys()] };
}
