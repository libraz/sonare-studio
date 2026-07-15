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
  type AutomationTarget,
  busIdFromAutomationTarget,
  isBusAutomationTarget,
  parseInsertAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import type { EngineHandle } from './engine';
import { engineAutomationPoints, engineFaderAutomationPoints } from './engine-declaration';

type MixerAutomationParam = 'faderDb' | 'pan';

function isMixerAutomationParam(param: AutomationParam): param is MixerAutomationParam {
  return param === 'faderDb' || param === 'pan';
}

/** Options for {@link createAutomationSync}. */
export interface AutomationSyncOptions {
  /** Track ids already declared as engine mixer lanes (safe to resolve). */
  knownTrackIds: () => readonly number[];
  /** Engine bus number for a project bus id, or undefined when not declared. */
  busIdFor?: (storeBusId: string) => number | undefined;
  /** Engine bus number for a group track id, or undefined when not declared/not a group. */
  groupBusIdFor?: (trackId: number) => number | undefined;
  /** Engine insert index for a store bus insert slot, after disabled slots are omitted. */
  busInsertIndexFor?: (storeBusId: string, storeInsertIndex: number) => number | undefined;
  /** Engine insert index for a group-track insert slot, after disabled slots are omitted. */
  groupInsertIndexFor?: (trackId: number, storeInsertIndex: number) => number | undefined;
  /** Engine master-strip insert index for a mastering-chain processor slot. */
  masteringInsertIndexFor?: (processorIndex: number) => number | undefined;
  /** Current mastering-chain index for a stable processor identity. */
  masteringProcessorIndexFor?: (processorId: string) => number | undefined;
  /** Current store insert index for a stable processor identity on a lane target. */
  insertStoreIndexFor?: (target: AutomationTarget, processorId: string) => number | undefined;
  /** Current VCA gain offset for a track/group target, in dB. */
  vcaOffsetFor?: (trackId: number) => number;
  /** Effective track/VCA mute for a numeric fader target. */
  effectiveMuteFor?: (trackId: number) => boolean;
  /** Re-pushes the manual strip value after a lane has been cleared. */
  restoreParam: (target: AutomationTarget, param: AutomationParam) => void;
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
  target: AutomationTarget;
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
      let paramId: number | undefined;
      const masteringRef = parseMasteringAutomationParam(lane.param);
      if (masteringRef) {
        if (lane.target !== 'master') continue;
        const processorIndex =
          masteringRef.processorIndex ??
          (masteringRef.processorId
            ? options.masteringProcessorIndexFor?.(masteringRef.processorId)
            : undefined);
        if (processorIndex === undefined) continue;
        const insertIndex = options.masteringInsertIndexFor?.(processorIndex);
        if (insertIndex === undefined) continue;
        const insertId = handle.engine.resolveMasterInsertAutomationId(
          insertIndex,
          masteringRef.paramName,
        );
        if (!Number.isFinite(insertId) || insertId < 0) continue;
        paramId = insertId;
      }
      const insertRef = parseInsertAutomationParam(lane.param);
      if (paramId === undefined && insertRef) {
        // Insert-parameter lane: the engine resolves the JSON-key name to the
        // reserved insert-automation id (and the strip selector) from its own
        // strip state. A negative result means the strip, insert, or key is not
        // (yet) known to the engine, so the lane is skipped this pass.
        const storeInsertIndex =
          insertRef.insertIndex ??
          (insertRef.processorId
            ? options.insertStoreIndexFor?.(lane.target, insertRef.processorId)
            : undefined);
        if (storeInsertIndex === undefined) continue;
        let insertId: number;
        if (lane.target === 'master') {
          insertId = handle.engine.resolveMasterInsertAutomationId(
            storeInsertIndex,
            insertRef.paramName,
          );
        } else if (isBusAutomationTarget(lane.target)) {
          const storeBusId = busIdFromAutomationTarget(lane.target);
          const busId = options.busIdFor?.(storeBusId);
          if (busId === undefined) continue;
          const insertIndex =
            options.busInsertIndexFor?.(storeBusId, storeInsertIndex) ??
            (options.busInsertIndexFor ? undefined : storeInsertIndex);
          if (insertIndex === undefined) continue;
          insertId = handle.engine.resolveBusInsertAutomationId(
            busId,
            insertIndex,
            insertRef.paramName,
          );
        } else {
          const groupBusId =
            typeof lane.target === 'number' ? options.groupBusIdFor?.(lane.target) : undefined;
          if (groupBusId !== undefined) {
            const insertIndex =
              options.groupInsertIndexFor?.(lane.target as number, storeInsertIndex) ??
              (options.groupInsertIndexFor ? undefined : storeInsertIndex);
            if (insertIndex === undefined) continue;
            insertId = handle.engine.resolveBusInsertAutomationId(
              groupBusId,
              insertIndex,
              insertRef.paramName,
            );
            if (!Number.isFinite(insertId) || insertId < 0) continue;
            paramId = insertId;
            const points = engineAutomationPoints(lane.points);
            if (points.length === 0) continue;
            effectiveParamIds.add(paramId);
            const json = JSON.stringify(points);
            if (installed.get(paramId)?.json === json) continue;
            handle.engine.setAutomationLane(paramId, points);
            installed.set(paramId, { target: lane.target, param: lane.param, json });
            continue;
          }
          if (!knownTracks.has(lane.target)) continue;
          insertId = handle.engine.resolveTrackInsertAutomationId(
            lane.target,
            storeInsertIndex,
            insertRef.paramName,
          );
        }
        if (!Number.isFinite(insertId) || insertId < 0) continue;
        paramId = insertId;
      } else if (paramId === undefined && isBusAutomationTarget(lane.target)) {
        if (lane.param !== 'faderDb') continue;
        const busId = options.busIdFor?.(busIdFromAutomationTarget(lane.target));
        if (busId === undefined) continue;
        paramId = handle.engine.busAutomationParamId(busId);
      } else if (paramId === undefined) {
        if (!isMixerAutomationParam(lane.param)) continue;
        const groupBusId =
          typeof lane.target === 'number' ? options.groupBusIdFor?.(lane.target) : undefined;
        if (groupBusId !== undefined) {
          if (lane.param !== 'faderDb') continue;
          paramId = handle.engine.busAutomationParamId(groupBusId);
        } else {
          const mixerTarget = lane.target;
          if (mixerTarget !== 'master' && typeof mixerTarget !== 'number') continue;
          if (mixerTarget !== 'master' && !knownTracks.has(mixerTarget)) continue;
          paramId = handle.engine.automationParamId(mixerTarget, lane.param);
        }
      }
      const points =
        typeof lane.target === 'number' && lane.param === 'faderDb'
          ? engineFaderAutomationPoints(
              lane.points,
              options.vcaOffsetFor?.(lane.target) ?? 0,
              options.effectiveMuteFor?.(lane.target) ?? false,
            )
          : engineAutomationPoints(lane.points);
      if (points.length === 0) continue;
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
