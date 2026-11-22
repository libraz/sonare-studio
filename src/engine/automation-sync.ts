/**
 * Realtime automation synchronisation: mirrors the store's automation lanes
 * (fader dB / pan, insert and mastering parameters, and a MIDI track's
 * NativeSynth parameters) onto the engine's reserved automation parameters,
 * transmitting only what changed.
 *
 * Engine contract (libsonare):
 * - automationParamId resolves the reserved parameter id of a strip
 *   parameter; a numeric target DECLARES a mixer lane for unknown track ids,
 *   so ids are only resolved for tracks the mixer sync already declared
 *   (options.knownTrackIds) — lanes for other targets are skipped.
 * - setAutomationLane replaces the whole lane in one call; an empty array
 *   clears it. An installed lane is applied every audio block (playing or
 *   not) and overrides manual setStripGain/setStripPan for that parameter.
 *   Clearing returns the target to the last manual value the engine received,
 *   whichever of the two reaches the audio thread first; a target that never
 *   received one keeps the lane's last value, so options.restoreParam pushes
 *   the manual value on every clear.
 */

import {
  type AutomationLaneState,
  type AutomationParam,
  type AutomationTarget,
  busIdFromAutomationTarget,
  isBusAutomationTarget,
  parseInsertAutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import { resolveAutomationId } from './automation-ids';
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
  /** Increments whenever logical bus ids are reassigned to engine bus numbers. */
  busMappingGeneration?: () => number;
  /** Increments whenever a strip scene can have cleared installed automation. */
  sceneGeneration?: () => number;
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
  /**
   * Engine MIDI destination hosting a track's NativeSynth, or undefined while
   * the track hosts none; instrument lanes resolve against it.
   */
  instrumentDestinationFor?: (trackId: number) => number | undefined;
  /** Current VCA fader offset for a numeric target, in dB. */
  vcaOffsetFor?: (trackId: number) => number;
  /** Effective track/VCA mute for a numeric fader target. */
  effectiveMuteFor?: (trackId: number) => boolean;
  /** True when a temporary mixer mode must override this lane (for example PFL). */
  suppressParam?: (target: AutomationTarget, param: AutomationParam) => boolean;
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
  mappingSensitive: boolean;
  mappingGeneration: number;
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
  let lastBusMappingGeneration = options.busMappingGeneration?.() ?? 0;
  let lastSceneGeneration = options.sceneGeneration?.() ?? 0;

  const clearLane = (paramId: number, lane: InstalledLane): void => {
    handle.engine.setAutomationLane(paramId, []);
    options.restoreParam(lane.target, lane.param);
  };

  const sync = (lanes: ReadonlyArray<AutomationLaneState>): void => {
    const busMappingGeneration = options.busMappingGeneration?.() ?? 0;
    const sceneGeneration = options.sceneGeneration?.() ?? 0;
    if (sceneGeneration !== lastSceneGeneration) {
      // A retained strip scene can be replayed by a structural mixer command.
      // Its automation side channels are cleared with it, so forget and
      // explicitly replace every previously installed lane before publishing
      // the current set below.
      for (const [paramId, lane] of installed) clearLane(paramId, lane);
      installed.clear();
      lastSceneGeneration = sceneGeneration;
    }
    if (busMappingGeneration !== lastBusMappingGeneration) {
      // Bus numbers are positional. Clear old mappings before installing any
      // lane at a reassigned number, then restore each logical target's base
      // value through the new mapping.
      for (const [paramId, lane] of installed) {
        if (!lane.mappingSensitive) continue;
        clearLane(paramId, lane);
        installed.delete(paramId);
      }
      lastBusMappingGeneration = busMappingGeneration;
    }
    const knownTracks = new Set(options.knownTrackIds());
    const effectiveParamIds = new Set<number>();
    const publishLane = (
      paramId: number,
      lane: AutomationLaneState,
      points: ReturnType<typeof engineAutomationPoints>,
      mappingSensitive: boolean,
    ): void => {
      effectiveParamIds.add(paramId);
      const json = JSON.stringify(points);
      const previous = installed.get(paramId);
      if (
        previous &&
        (previous.target !== lane.target ||
          previous.param !== lane.param ||
          (previous.mappingSensitive && previous.mappingGeneration !== busMappingGeneration))
      ) {
        clearLane(paramId, previous);
        installed.delete(paramId);
      } else if (previous?.json === json) {
        return;
      }
      handle.engine.setAutomationLane(paramId, points);
      installed.set(paramId, {
        target: lane.target,
        param: lane.param,
        json,
        mappingSensitive,
        mappingGeneration: busMappingGeneration,
      });
    };
    for (const lane of lanes) {
      if (!lane.enabled) continue;
      if (options.suppressParam?.(lane.target, lane.param)) continue;
      const instrumentRef = parseInstrumentAutomationParam(lane.param);
      if (instrumentRef) {
        if (typeof lane.target !== 'number') continue;
        const destinationId = options.instrumentDestinationFor?.(lane.target);
        if (destinationId === undefined) continue;
        const instrumentId = resolveAutomationId(() =>
          handle.engine.resolveInstrumentAutomationId(destinationId, instrumentRef.paramName),
        );
        if (instrumentId === undefined) continue;
        const points = engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        publishLane(instrumentId, lane, points, false);
        continue;
      }
      let paramId: number | undefined;
      let mappingSensitive = false;
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
        const insertId = resolveAutomationId(() =>
          handle.engine.resolveStripInsertAutomationId(
            'master',
            insertIndex,
            masteringRef.paramName,
          ),
        );
        if (insertId === undefined) continue;
        paramId = insertId;
      }
      const insertRef = parseInsertAutomationParam(lane.param);
      if (paramId === undefined && insertRef) {
        // Insert-parameter lane: the engine resolves the JSON-key name to the
        // reserved insert-automation id (and the strip selector) from its own
        // strip state. An unresolved id means the strip, insert, or key is not
        // (yet) known to the engine, so the lane is skipped this pass.
        const storeInsertIndex =
          insertRef.insertIndex ??
          (insertRef.processorId
            ? options.insertStoreIndexFor?.(lane.target, insertRef.processorId)
            : undefined);
        if (storeInsertIndex === undefined) continue;
        let insertId: number | undefined;
        if (lane.target === 'master') {
          insertId = resolveAutomationId(() =>
            handle.engine.resolveStripInsertAutomationId(
              'master',
              storeInsertIndex,
              insertRef.paramName,
            ),
          );
        } else if (isBusAutomationTarget(lane.target)) {
          const storeBusId = busIdFromAutomationTarget(lane.target);
          const busId = options.busIdFor?.(storeBusId);
          if (busId === undefined) continue;
          mappingSensitive = true;
          const insertIndex =
            options.busInsertIndexFor?.(storeBusId, storeInsertIndex) ??
            (options.busInsertIndexFor ? undefined : storeInsertIndex);
          if (insertIndex === undefined) continue;
          insertId = resolveAutomationId(() =>
            handle.engine.resolveBusInsertAutomationId(busId, insertIndex, insertRef.paramName),
          );
        } else {
          const groupBusId =
            typeof lane.target === 'number' ? options.groupBusIdFor?.(lane.target) : undefined;
          if (groupBusId !== undefined) {
            mappingSensitive = true;
            const insertIndex =
              options.groupInsertIndexFor?.(lane.target as number, storeInsertIndex) ??
              (options.groupInsertIndexFor ? undefined : storeInsertIndex);
            if (insertIndex === undefined) continue;
            insertId = resolveAutomationId(() =>
              handle.engine.resolveBusInsertAutomationId(
                groupBusId,
                insertIndex,
                insertRef.paramName,
              ),
            );
            if (insertId === undefined) continue;
            paramId = insertId;
            const points = engineAutomationPoints(lane.points);
            if (points.length === 0) continue;
            publishLane(paramId, lane, points, mappingSensitive);
            continue;
          }
          if (!knownTracks.has(lane.target)) continue;
          const trackId = lane.target;
          insertId = resolveAutomationId(() =>
            handle.engine.resolveStripInsertAutomationId(
              trackId,
              storeInsertIndex,
              insertRef.paramName,
            ),
          );
        }
        if (insertId === undefined) continue;
        paramId = insertId;
      } else if (paramId === undefined && isBusAutomationTarget(lane.target)) {
        if (lane.param !== 'faderDb') continue;
        const busId = options.busIdFor?.(busIdFromAutomationTarget(lane.target));
        if (busId === undefined) continue;
        mappingSensitive = true;
        paramId = resolveAutomationId(() => handle.engine.resolveBusAutomationId(busId, 'faderDb'));
        if (paramId === undefined) continue;
      } else if (paramId === undefined) {
        if (!isMixerAutomationParam(lane.param)) continue;
        const groupBusId =
          typeof lane.target === 'number' ? options.groupBusIdFor?.(lane.target) : undefined;
        if (groupBusId !== undefined) {
          if (lane.param !== 'faderDb') continue;
          mappingSensitive = true;
          paramId = resolveAutomationId(() =>
            handle.engine.resolveBusAutomationId(groupBusId, 'faderDb'),
          );
        } else {
          const mixerTarget = lane.target;
          const mixerParam = lane.param;
          if (mixerTarget !== 'master' && typeof mixerTarget !== 'number') continue;
          if (mixerTarget !== 'master' && !knownTracks.has(mixerTarget)) continue;
          paramId = resolveAutomationId(() =>
            handle.engine.resolveStripAutomationId(mixerTarget, mixerParam),
          );
        }
        if (paramId === undefined) continue;
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
      publishLane(paramId, lane, points, mappingSensitive);
    }
    for (const [paramId, lane] of installed) {
      if (effectiveParamIds.has(paramId)) continue;
      clearLane(paramId, lane);
      installed.delete(paramId);
    }
  };

  return { sync, installedParamIds: () => [...installed.keys()] };
}
