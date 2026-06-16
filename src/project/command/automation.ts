import {
  type AutomationParam,
  type AutomationPoint,
  automationLaneKey,
  sanitizeAutomationPoints,
} from '../automation';
import { useProjectStore } from '../store';
import { execute } from './history';
import { requireTrack } from './utils';

/**
 * Validates an automation lane target: 'master' is always valid; numeric
 * targets must name an existing track (throws RangeError otherwise).
 */
function validateAutomationTarget(
  store: ReturnType<typeof useProjectStore>,
  target: number | 'master',
): void {
  if (target !== 'master') requireTrack(store, target);
}

/** Returns the index of the lane addressing (target, param), or -1. */
function findAutomationLane(
  store: ReturnType<typeof useProjectStore>,
  target: number | 'master',
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
  target: number | 'master',
  param: AutomationParam,
  points: ReadonlyArray<AutomationPoint>,
): void {
  const store = useProjectStore();
  validateAutomationTarget(store, target);
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
  target: number | 'master',
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
export function removeAutomationLane(target: number | 'master', param: AutomationParam): void {
  const store = useProjectStore();
  const index = findAutomationLane(store, target, param);
  if (index < 0) return;
  execute(0, () => {
    store.automationLanes = store.automationLanes.filter((_, i) => i !== index);
    store.refresh();
  });
}
