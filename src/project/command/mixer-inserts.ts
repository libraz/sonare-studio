import {
  assertKnownBusDestination,
  assertNoBusRoutingCycle,
  groupBusTopologyId,
  mixerBusTopology,
} from '../bus-topology';
import {
  cloneStrip,
  createProcessorId,
  type InsertSlot,
  isSoloProcessor,
  type MixerSidechainSource,
} from '../mixer';
import { editedProcessorParams } from '../processor-controls';
import { useProjectStore } from '../store';
import {
  pruneInsertProcessorReferences,
  pruneReplacedInsertReferences,
  reorderInsertProcessorReferences,
} from '../target-reference-registry';
import { type CommandGestureOptions, executeApp, hasPendingGesture } from './history';
import { validateInsertParams } from './insert-params';
import {
  currentStrip,
  isMixerBusStripTarget,
  type MixerStripTarget,
  mixerBusIdFromTarget,
  patchMixerMirror,
  requireInsert,
  sidechainTargetTopologyId,
  writeStrip,
} from './mixer-internal';
import { requireTrack } from './utils';

/** Reads the one sidechain namespace carried by an insert slot. */
function sidechainSourceFromSlot(
  slot: Pick<
    InsertSlot,
    'sidechainSourceTrackId' | 'sidechainSourceBusId' | 'sidechainSourceGroupTrackId'
  >,
): MixerSidechainSource | null {
  const sources: MixerSidechainSource[] = [];
  if (slot.sidechainSourceTrackId !== undefined) {
    sources.push({ kind: 'track', trackId: slot.sidechainSourceTrackId });
  }
  if (slot.sidechainSourceBusId !== undefined) {
    sources.push({ kind: 'bus', busId: slot.sidechainSourceBusId });
  }
  if (slot.sidechainSourceGroupTrackId !== undefined) {
    sources.push({ kind: 'group', trackId: slot.sidechainSourceGroupTrackId });
  }
  if (sources.length > 1) {
    throw new RangeError('Insert sidechain source must use one namespace');
  }
  return sources[0] ?? null;
}

/** True when two sidechain sources address the same namespace and id. */
function sameSidechainSource(
  a: MixerSidechainSource | null,
  b: MixerSidechainSource | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'bus') return b.kind === 'bus' && a.busId === b.busId;
  return b.kind !== 'bus' && a.kind === b.kind && a.trackId === b.trackId;
}

/** Returns bus/group graph ids carried by an insert sidechain slot. */
function sidechainTopologySources(
  slot: Pick<InsertSlot, 'sidechainSourceBusId' | 'sidechainSourceGroupTrackId'>,
): string[] {
  const sources: string[] = [];
  if (slot.sidechainSourceBusId !== undefined) sources.push(slot.sidechainSourceBusId);
  if (slot.sidechainSourceGroupTrackId !== undefined) {
    sources.push(groupBusTopologyId(slot.sidechainSourceGroupTrackId));
  }
  return sources;
}

/**
 * Removes the destination insert's previous bus/group sidechain edges before
 * validating a replacement. This lets a slot switch from one source to
 * another without treating its old edge as a newly introduced cycle.
 */
function topologyWithoutInsertSidechain(
  store: ReturnType<typeof useProjectStore>,
  target: MixerStripTarget,
  previousSlot: Pick<InsertSlot, 'sidechainSourceBusId' | 'sidechainSourceGroupTrackId'>,
) {
  const targetId = sidechainTargetTopologyId(store, target);
  const previousSources = new Set(sidechainTopologySources(previousSlot));
  const nodes = mixerBusTopology(
    store.mixer,
    store.tracks
      .filter((track) => track.kind === 'group')
      .map((track) => ({ id: track.id, mixer: track.mixer })),
  );
  if (targetId === undefined || previousSources.size === 0) return nodes;
  return nodes.map((node) =>
    node.id === targetId
      ? {
          ...node,
          sidechainSources: (node.sidechainSources ?? []).filter(
            (source) => !previousSources.has(source),
          ),
        }
      : node,
  );
}

/**
 * Reports whether `trackId` is keyed, directly or through other track lanes'
 * inserts, from `keyTrackId`. The engine renders lanes in key order, so a new
 * key edge closing such a path is refused there.
 */
function trackKeyedBy(
  store: ReturnType<typeof useProjectStore>,
  trackId: number,
  keyTrackId: number,
): boolean {
  const visited = new Set<number>();
  const pending = [trackId];
  while (pending.length > 0) {
    const current = pending.pop() as number;
    if (visited.has(current)) continue;
    visited.add(current);
    const track = store.tracks.find((entry) => entry.id === current);
    if (track?.kind === 'group') continue;
    for (const slot of track?.mixer?.inserts ?? []) {
      const source = slot.sidechainSourceTrackId;
      if (source === undefined) continue;
      if (source === keyTrackId) return true;
      pending.push(source);
    }
  }
  return false;
}

/** Validates a track/bus/group source before a slot is written. */
function validateInsertSidechainSource(
  store: ReturnType<typeof useProjectStore>,
  target: MixerStripTarget,
  source: MixerSidechainSource | null,
  previousSlot?: InsertSlot,
): void {
  const targetTrack = typeof target === 'number' ? requireTrack(store, target) : undefined;
  if (targetTrack && source !== null && source.kind !== 'track' && targetTrack.kind !== 'group') {
    throw new RangeError('Ordinary track inserts can only use track sidechain keys');
  }
  if (source?.kind === 'track') {
    const sourceTrack = requireTrack(store, source.trackId);
    if (sourceTrack.kind === 'group') {
      throw new RangeError(
        `Track ${source.trackId} is a group bus; use a group sidechain key instead`,
      );
    }
    if (targetTrack?.id === source.trackId) {
      throw new RangeError('An insert cannot key from its own track');
    }
    if (
      targetTrack?.kind !== 'group' &&
      targetTrack !== undefined &&
      trackKeyedBy(store, source.trackId, targetTrack.id)
    ) {
      throw new RangeError(
        `Track ${source.trackId} is already keyed from track ${targetTrack.id}; keys cannot form a cycle`,
      );
    }
  }
  if (source?.kind === 'group') {
    const sourceTrack = requireTrack(store, source.trackId);
    if (sourceTrack.kind !== 'group') {
      throw new RangeError(`Track ${source.trackId} is not a group bus`);
    }
    if (targetTrack?.kind === 'group' && targetTrack.id === source.trackId) {
      throw new RangeError('A group insert cannot key from its own group bus');
    }
  }
  if (source?.kind === 'bus') {
    if (!store.mixer.buses.some((bus) => bus.id === source.busId)) {
      throw new RangeError(`Unknown mixer bus id: ${source.busId}`);
    }
    if (isMixerBusStripTarget(target) && mixerBusIdFromTarget(target) === source.busId) {
      throw new RangeError('A bus insert cannot key from its own bus');
    }
  }

  const sourceBusId =
    source?.kind === 'bus'
      ? source.busId
      : source?.kind === 'group'
        ? groupBusTopologyId(source.trackId)
        : undefined;
  const targetBusId = sidechainTargetTopologyId(store, target);
  if (sourceBusId === undefined || targetBusId === undefined) return;
  const nodes = topologyWithoutInsertSidechain(store, target, previousSlot ?? {});
  const knownBusIds = new Set(nodes.map((node) => node.id));
  assertKnownBusDestination(sourceBusId, knownBusIds, targetBusId);
  assertNoBusRoutingCycle(nodes, sourceBusId, targetBusId);
}

function sidechainSourceFields(
  source: MixerSidechainSource | null,
): Pick<
  InsertSlot,
  'sidechainSourceTrackId' | 'sidechainSourceBusId' | 'sidechainSourceGroupTrackId'
> {
  if (source?.kind === 'track') return { sidechainSourceTrackId: source.trackId };
  if (source?.kind === 'bus') return { sidechainSourceBusId: source.busId };
  if (source?.kind === 'group') return { sidechainSourceGroupTrackId: source.trackId };
  return {};
}

/**
 * Appends an insert slot to a strip as one undoable edit. The processor is a
 * wasm catalog name (masteringProcessorNames / masteringInsertNames); track
 * and master inserts are audible in realtime (mirrored to the engine strip,
 * see src/engine/strip-sync.ts).
 *
 * @param target Track id or 'master'.
 * @param processor Processor catalog name (non-empty).
 * @param params Initial parameter overrides (camelCase keys).
 * @returns The index of the new slot.
 */
export function addInsert(
  target: MixerStripTarget,
  processor: string,
  params: Record<string, number | boolean> = {},
): number {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (typeof processor !== 'string' || processor.length === 0) {
    throw new RangeError('Insert processor name must not be empty');
  }
  if (!isSoloProcessor(processor)) throw new RangeError(`Unknown insert processor: ${processor}`);
  validateInsertParams(params);
  return executeApp(() => {
    const next = cloneStrip(strip);
    next.inserts = [
      ...next.inserts,
      { id: createProcessorId(), processor, params: { ...params }, enabled: true },
    ];
    writeStrip(store, target, next);
    store.refresh();
    return next.inserts.length - 1;
  });
}

/**
 * Removes an insert slot as one undoable edit. Insert-parameter automation
 * lanes targeting this strip are remapped in the same edit (the removed slot's
 * lane drops, later slots shift down by one), so undo restores both the strip
 * and the lanes together.
 *
 * @param target Track id or 'master'.
 * @param index Slot index (later slots shift down).
 */
export function removeInsert(target: MixerStripTarget, index: number): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  const removed = requireInsert(strip, index);
  executeApp(() => {
    const next = cloneStrip(strip);
    next.inserts = next.inserts.filter((_, i) => i !== index);
    writeStrip(store, target, next);
    pruneInsertProcessorReferences(store, target, index, removed.id);
    store.refresh();
  });
}

/**
 * Moves an insert slot to a new position within a strip as one undoable edit.
 * Insert-parameter automation lanes targeting this strip follow their slot to
 * the new index (see {@link remapInsertLanesAfterReorder}), so undo restores
 * both the chain order and the lanes together. The destination is clamped into
 * range; a no-op move (same position) does nothing.
 *
 * @param target Track id or 'master'.
 * @param fromIndex Slot index to move.
 * @param toIndex Destination index (clamped into [0, inserts.length - 1]).
 */
export function reorderInsert(target: MixerStripTarget, fromIndex: number, toIndex: number): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  requireInsert(strip, fromIndex);
  const clamped = Math.min(strip.inserts.length - 1, Math.max(0, Math.trunc(toIndex)));
  if (clamped === fromIndex) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    const inserts = [...next.inserts];
    const [moved] = inserts.splice(fromIndex, 1);
    inserts.splice(clamped, 0, moved);
    next.inserts = inserts;
    writeStrip(store, target, next);
    reorderInsertProcessorReferences(store, target, fromIndex, clamped);
    store.refresh();
  });
}

/**
 * Enables or bypasses an insert slot as one undoable edit.
 *
 * @param target Track id or 'master'.
 * @param index Slot index.
 * @param enabled New enabled state.
 */
export function setInsertEnabled(target: MixerStripTarget, index: number, enabled: boolean): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  const slot = requireInsert(strip, index);
  if (slot.enabled === enabled) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    next.inserts[index] = { ...next.inserts[index], enabled };
    writeStrip(store, target, next);
    store.refresh();
  });
}

/**
 * Replaces an insert's processor settings as one atomic edit. Replacing with
 * the same processor type retains the destination id, so existing automation
 * and MIDI bindings remain attached. A different processor gets a fresh id and
 * references to the old parameter set are pruned in the same edit.
 */
export function replaceInsert(
  target: MixerStripTarget,
  index: number,
  source: Omit<InsertSlot, 'id'>,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  const destination = requireInsert(strip, index);
  if (source.processor.length === 0)
    throw new RangeError('Insert processor name must not be empty');
  validateInsertParams(source.params);
  const normalizedSource = sidechainSourceFromSlot(source);
  validateInsertSidechainSource(store, target, normalizedSource, destination);
  executeApp(() => {
    const next = cloneStrip(strip);
    const processorChanged = destination.processor !== source.processor;
    const slot: InsertSlot = {
      id: processorChanged ? createReplacementProcessorId(next) : destination.id,
      processor: source.processor,
      enabled: source.enabled,
      params: { ...source.params },
      ...sidechainSourceFields(normalizedSource),
    };
    next.inserts[index] = slot;
    writeStrip(store, target, next);
    if (processorChanged) {
      pruneReplacedInsertReferences(store, target, index, destination.id);
    }
    store.refresh();
  });
}

/** Creates a fresh slot identity without colliding with a sibling insert. */
function createReplacementProcessorId(strip: ReturnType<typeof cloneStrip>): string {
  const used = new Set<string>();
  for (const slot of strip.inserts) {
    if (slot.id !== undefined) used.add(slot.id);
  }
  let id = createProcessorId();
  while (used.has(id)) id = createProcessorId();
  return id;
}

/**
 * Sets (or clears with null) the sidechain key source of an insert as one
 * undoable edit. The legacy numeric source form remains shorthand for a track
 * sidechain; bus and group sources use an explicit discriminant because their
 * ids have different namespaces.
 *
 * @param target Track, return-bus, or master strip owning the insert.
 * @param index Insert slot index.
 * @param source Track id, `{ kind: 'bus', busId }`, `{ kind: 'group', trackId }`, or null.
 */
export function setInsertSidechain(
  target: MixerStripTarget,
  index: number,
  source: number | MixerSidechainSource | null,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  const slot = requireInsert(strip, index);
  const normalized =
    typeof source === 'number' ? { kind: 'track' as const, trackId: source } : source;
  validateInsertSidechainSource(store, target, normalized, slot);
  if (sameSidechainSource(sidechainSourceFromSlot(slot), normalized)) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    const updated = { ...next.inserts[index] };
    delete updated.sidechainSourceTrackId;
    delete updated.sidechainSourceBusId;
    delete updated.sidechainSourceGroupTrackId;
    if (normalized?.kind === 'track') updated.sidechainSourceTrackId = normalized.trackId;
    if (normalized?.kind === 'bus') updated.sidechainSourceBusId = normalized.busId;
    if (normalized?.kind === 'group') updated.sidechainSourceGroupTrackId = normalized.trackId;
    next.inserts[index] = updated;
    writeStrip(store, target, next);
    store.refresh();
  });
}

/**
 * Sets one parameter of an insert slot as one undoable edit.
 *
 * @param target Track id or 'master'.
 * @param index Slot index.
 * @param param Parameter name (camelCase, see masteringInsertParamNames).
 * @param value New value (finite number or boolean).
 * @param options Gesture coalescing for knob drags.
 */
export function setInsertParam(
  target: MixerStripTarget,
  index: number,
  param: string,
  value: number | boolean,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  const slot = requireInsert(strip, index);
  if (param.length === 0) throw new RangeError('Insert param name must not be empty');
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`Insert param "${param}" must be finite, got ${value}`);
  }
  const key = `insert-param:${String(target)}:${index}:${param}`;
  const resetsAmpOverrides =
    slot.processor === 'saturation.ampSim' &&
    param === 'presetIndex' &&
    Object.keys(slot.params).some((name) => name !== 'presetIndex');
  if (slot.params[param] === value && !resetsAmpOverrides && !hasPendingGesture(key)) return;
  patchMixerMirror(key, options, () => {
    const next = cloneStrip(strip);
    next.inserts[index] = {
      ...next.inserts[index],
      // Choosing a new amp rig replaces the old rig's custom knob settings.
      // Keeping them would make the newly selected preset sound like a hybrid
      // while the UI still names it as the untouched new rig.
      params:
        slot.processor === 'saturation.ampSim' && param === 'presetIndex'
          ? { presetIndex: value }
          : editedProcessorParams(slot.processor, next.inserts[index].params, param, value),
    };
    writeStrip(store, target, next);
  });
}
