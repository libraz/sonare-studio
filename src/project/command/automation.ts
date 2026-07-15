import {
  type AutomationParam,
  type AutomationPoint,
  type AutomationTarget,
  automationLaneKey,
  busIdFromAutomationTarget,
  type InsertParamRef,
  isBusAutomationTarget,
  parseInsertAutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
  sanitizeAutomationPoints,
} from '../automation';
import { insertIndexForAutomationRef, masteringIndexForAutomationRef } from '../automation-insert';
import type { MixerStrip } from '../mixer';
import { useProjectStore } from '../store';
import { execute } from './history';
import { currentStrip, type MixerStripTarget } from './mixer-internal';
import { requireTrack } from './utils';

/**
 * Validates that the strip behind an insert lane carries the addressed slot.
 *
 * @param strip Strip the lane targets.
 * @param ref Decoded insert slot reference.
 * @param target Lane target (for the error message).
 * @throws RangeError when the slot index is absent on the strip.
 */
function requireInsertOnStrip(
  strip: MixerStrip,
  ref: InsertParamRef,
  target: AutomationTarget,
): void {
  const index = insertIndexForAutomationRef(strip.inserts, ref);
  if (index === undefined || !strip.inserts[index]) {
    throw new RangeError(
      `Strip ${String(target)} has no insert ${ref.processorId ?? `at index ${String(ref.insertIndex)}`} to automate`,
    );
  }
}

/**
 * Validates an automation lane target/param pair: 'master' is always valid;
 * numeric targets must name an existing track; bus targets must name an
 * existing bus and can automate only faderDb or an insert parameter. An insert
 * parameter is allowed on any strip and is checked against the strip's slots.
 */
function validateAutomationTarget(
  store: ReturnType<typeof useProjectStore>,
  target: AutomationTarget,
  param: AutomationParam,
): void {
  const masteringRef = parseMasteringAutomationParam(param);
  if (masteringRef !== undefined) {
    if (target !== 'master') {
      throw new RangeError('Mastering automation must target the master lane');
    }
    if (masteringIndexForAutomationRef(store.mixer.masteringChain, masteringRef) === undefined) {
      throw new RangeError(
        `Unknown mastering processor: ${masteringRef.processorId ?? String(masteringRef.processorIndex)}`,
      );
    }
    return;
  }
  const instrumentRef = parseInstrumentAutomationParam(param);
  if (instrumentRef !== undefined) {
    if (target === 'master' || isBusAutomationTarget(target)) {
      throw new RangeError('Instrument automation must target a MIDI track');
    }
    const track = requireTrack(store, target);
    if (track.kind !== 'midi') {
      throw new RangeError('Instrument automation requires a MIDI track');
    }
    if (track.instrument?.kind !== 'synth-patch') {
      throw new RangeError('Instrument automation requires a synth-patch instrument');
    }
    return;
  }
  const insertRef = parseInsertAutomationParam(param);
  if (insertRef !== undefined) {
    // The strip lookup also validates the target (unknown track/bus throws).
    const strip = currentStrip(store, target as MixerStripTarget);
    requireInsertOnStrip(strip, insertRef, target);
    return;
  }
  if (target === 'master') return;
  if (isBusAutomationTarget(target)) {
    if (param !== 'faderDb') throw new RangeError('Mixer buses only support fader automation');
    const busId = busIdFromAutomationTarget(target);
    if (!store.mixer.buses.some((bus) => bus.id === busId)) {
      throw new RangeError(`Unknown mixer bus id: ${busId}`);
    }
    return;
  }
  requireTrack(store, target);
}

/** Returns the index of the lane addressing (target, param), or -1. */
function findAutomationLane(
  store: ReturnType<typeof useProjectStore>,
  target: AutomationTarget,
  param: AutomationParam,
): number {
  const key = automationLaneKey(target, param);
  return store.automationLanes.findIndex(
    (lane) => automationLaneKey(lane.target, lane.param) === key,
  );
}

/**
 * Replaces the point list of an automation lane as one undoable edit. Lanes
 * are app-level metadata (the Project has no automation API). Points are
 * sanitized (non-finite/negative positions dropped, values clamped, sorted by
 * PPQ); an empty result removes the lane entirely. A new lane starts enabled;
 * replacing an existing lane preserves its enabled flag.
 *
 * @param target Lane target: a track id or 'master'.
 * @param param Automated parameter.
 * @param points New point list (replaces the lane's points).
 */
export function setAutomationLanePoints(
  target: AutomationTarget,
  param: AutomationParam,
  points: ReadonlyArray<AutomationPoint>,
): void {
  const store = useProjectStore();
  validateAutomationTarget(store, target, param);
  const sanitized = sanitizeAutomationPoints(param, points);
  const index = findAutomationLane(store, target, param);
  if (sanitized.length === 0 && index < 0) return;
  execute(0, () => {
    if (sanitized.length === 0) {
      store.automationLanes = store.automationLanes.filter((_, i) => i !== index);
    } else if (index < 0) {
      store.automationLanes = [
        ...store.automationLanes,
        { target, param, points: sanitized, enabled: true },
      ];
    } else {
      store.automationLanes = store.automationLanes.map((lane, i) =>
        i === index ? { ...lane, points: sanitized } : lane,
      );
    }
    store.refresh();
  });
}

/**
 * Enables or disables an automation lane as one undoable edit. Missing lanes
 * and unchanged values are silent no-ops.
 *
 * @param target Lane target: a track id or 'master'.
 * @param param Automated parameter.
 * @param enabled New enabled state.
 */
export function setAutomationLaneEnabled(
  target: AutomationTarget,
  param: AutomationParam,
  enabled: boolean,
): void {
  const store = useProjectStore();
  const index = findAutomationLane(store, target, param);
  if (index < 0 || store.automationLanes[index].enabled === enabled) return;
  execute(0, () => {
    store.automationLanes = store.automationLanes.map((lane, i) =>
      i === index ? { ...lane, enabled } : lane,
    );
    store.refresh();
  });
}

/**
 * Removes an automation lane as one undoable edit. Missing lanes are a
 * silent no-op.
 *
 * @param target Lane target: a track id or 'master'.
 * @param param Automated parameter.
 */
export function removeAutomationLane(target: AutomationTarget, param: AutomationParam): void {
  const store = useProjectStore();
  const index = findAutomationLane(store, target, param);
  if (index < 0) return;
  execute(0, () => {
    store.automationLanes = store.automationLanes.filter((_, i) => i !== index);
    store.refresh();
  });
}
