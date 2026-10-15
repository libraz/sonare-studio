import { type AutomationLaneState, parseInsertAutomationParam } from './automation';
import {
  migrateAutomationLanesToProcessorIds,
  remapInsertLanesAfterRemoval,
  remapInsertLanesAfterReorder,
  remapMasteringLanesAfterRemoval,
  remapMasteringLanesAfterReorder,
} from './automation-insert';
import {
  type MidiCcBinding,
  type MidiLearnScope,
  midiLearnInsertTargetId,
  midiLearnMasteringTargetId,
  midiLearnTargetScope,
  parseMidiLearnInsertTargetId,
  parseMidiLearnMasteringTargetId,
} from './midi-learn-targets';
import { cloneStrip, type MixerStrip, type ProjectMixerState } from './mixer';
import type { useProjectStore } from './store';
import type { EditorTrack } from './types';

type ProjectStore = ReturnType<typeof useProjectStore>;
export type ProcessorReferenceTarget = number | 'master' | `bus:${string}`;

/** External registries (currently mixer snapshots) that retain target references. */
export interface TargetReferenceContributor {
  pruneTrack(trackId: number): void;
}

const contributors = new Set<TargetReferenceContributor>();

/** Registers a non-store target registry for centralized prune operations. */
export function registerTargetReferenceContributor(contributor: TargetReferenceContributor): void {
  contributors.add(contributor);
}

/** Returns a strip with references to one sidechain source removed. */
export function pruneStripTrackReferences(strip: MixerStrip, trackId: number): MixerStrip {
  if (
    !strip.inserts.some(
      (slot) =>
        slot.sidechainSourceTrackId === trackId || slot.sidechainSourceGroupTrackId === trackId,
    )
  )
    return strip;
  const next = cloneStrip(strip);
  next.inserts = next.inserts.map((slot) => {
    if (slot.sidechainSourceTrackId !== trackId && slot.sidechainSourceGroupTrackId !== trackId)
      return slot;
    const cleared = { ...slot };
    if (cleared.sidechainSourceTrackId === trackId) delete cleared.sidechainSourceTrackId;
    if (cleared.sidechainSourceGroupTrackId === trackId) delete cleared.sidechainSourceGroupTrackId;
    return cleared;
  });
  return next;
}

/** Rebuilds the in-place binding map while preserving its reactive identity. */
function remapMidiTargets(store: ProjectStore, mapId: (id: string) => string | null): void {
  const next = new Map<string, MidiCcBinding>();
  for (const [id, binding] of store.midiCcBindings) {
    const mapped = mapId(id);
    if (mapped !== null && !next.has(mapped)) next.set(mapped, { ...binding });
  }
  store.midiCcBindings.clear();
  for (const [id, binding] of next) store.midiCcBindings.set(id, binding);
}

/**
 * Prunes every store/external reference to a removed track: automation, MIDI
 * learn, group membership, all strip sidechains (including master), and
 * contributed registries such as mixer snapshots.
 */
export function pruneTrackTargetReferences(store: ProjectStore, trackId: number): void {
  store.automationLanes = store.automationLanes.filter((lane) => lane.target !== trackId);
  remapMidiTargets(store, (id) => (midiLearnTargetScope(id) === trackId ? null : id));
  store.tracks = store.tracks.map((track) => {
    let next = track;
    if (track.groupId === trackId) {
      next = { ...next };
      delete next.groupId;
    }
    if (track.mixer) {
      const mixer = pruneStripTrackReferences(track.mixer, trackId);
      if (mixer !== track.mixer) next = { ...next, mixer };
    }
    return next;
  });
  const master = pruneStripTrackReferences(store.mixer.master, trackId);
  const buses = store.mixer.buses.map((bus) => {
    if (!bus.strip) return bus;
    const strip = pruneStripTrackReferences(bus.strip, trackId);
    return strip === bus.strip ? bus : { ...bus, strip };
  });
  if (
    master !== store.mixer.master ||
    buses.some((bus, index) => bus !== store.mixer.buses[index])
  ) {
    store.mixer = { ...store.mixer, master, buses };
  }
  for (const contributor of contributors) contributor.pruneTrack(trackId);
}

function sameMidiScope(target: ProcessorReferenceTarget, scope: MidiLearnScope): boolean {
  return (target === 'master' || typeof target === 'number') && target === scope;
}

function insertStripForScope(store: ProjectStore, scope: MidiLearnScope): MixerStrip | undefined {
  return scope === 'master'
    ? store.mixer.master
    : store.tracks.find((track) => track.id === scope)?.mixer;
}

/**
 * Validates one processor-parameter MIDI target against the current mixer and
 * upgrades legacy positional ids to stable processor ids. Non-processor MIDI
 * targets pass through unchanged.
 */
export function normalizeProcessorMidiLearnTarget(store: ProjectStore, id: string): string | null {
  const insert = parseMidiLearnInsertTargetId(id);
  if (insert) {
    const slots = insertStripForScope(store, insert.scope)?.inserts ?? [];
    if (insert.processorId !== undefined) {
      return slots.some((slot) => slot.id === insert.processorId) ? id : null;
    }
    const slot = insert.index === undefined ? undefined : slots[insert.index];
    return slot?.id ? midiLearnInsertTargetId(insert.scope, slot.id, insert.paramId) : null;
  }

  const mastering = parseMidiLearnMasteringTargetId(id);
  if (mastering) {
    const processors = store.mixer.masteringChain?.processors ?? [];
    if (mastering.processorId !== undefined) {
      return processors.some((processor) => processor.id === mastering.processorId) ? id : null;
    }
    const processor = mastering.index === undefined ? undefined : processors[mastering.index];
    return processor?.id ? midiLearnMasteringTargetId(processor.id, mastering.paramId) : null;
  }

  return id;
}

/** Drops invalid processor bindings and migrates surviving positional ids in place. */
export function reconcileProcessorTargetReferences(store: ProjectStore): void {
  store.automationLanes = normalizeProcessorAutomationLanes(
    store.automationLanes,
    store.mixer,
    store.tracks,
  );
  remapMidiTargets(store, (id) => normalizeProcessorMidiLearnTarget(store, id));
}

/**
 * Validates processor automation against a detached final mixer plan and
 * upgrades surviving legacy positional tokens to stable processor ids.
 * Non-processor lanes pass through unchanged.
 */
export function normalizeProcessorAutomationLanes(
  lanes: ReadonlyArray<AutomationLaneState>,
  mixer: ProjectMixerState,
  tracks: ReadonlyArray<EditorTrack>,
): AutomationLaneState[] {
  return migrateAutomationLanesToProcessorIds(
    lanes,
    {
      trackStrips: new Map(tracks.map((track) => [track.id, track.mixer])),
      master: mixer.master,
      busStrips: new Map(mixer.buses.map((bus) => [bus.id, bus.strip])),
    },
    mixer.masteringChain,
  );
}

/** Prunes/remaps automation and MIDI learn references after an insert removal. */
export function pruneInsertProcessorReferences(
  store: ProjectStore,
  target: ProcessorReferenceTarget,
  removedIndex: number,
  removedProcessorId?: string,
): void {
  store.automationLanes = remapInsertLanesAfterRemoval(
    store.automationLanes,
    target,
    removedIndex,
    removedProcessorId,
  );
  remapMidiTargets(store, (id) => {
    const ref = parseMidiLearnInsertTargetId(id);
    if (!ref || !sameMidiScope(target, ref.scope)) return id;
    if (ref.processorId !== undefined) return ref.processorId === removedProcessorId ? null : id;
    if (ref.index === undefined || ref.index === removedIndex) return null;
    return ref.index > removedIndex
      ? midiLearnInsertTargetId(ref.scope, ref.index - 1, ref.paramId)
      : id;
  });
}

/** Keeps legacy positional references aligned during insert reorder; stable ids do not change. */
export function reorderInsertProcessorReferences(
  store: ProjectStore,
  target: ProcessorReferenceTarget,
  fromIndex: number,
  toIndex: number,
): void {
  store.automationLanes = remapInsertLanesAfterReorder(
    store.automationLanes,
    target,
    fromIndex,
    toIndex,
  );
  remapMidiTargets(store, (id) => {
    const ref = parseMidiLearnInsertTargetId(id);
    if (!ref || ref.processorId !== undefined || !sameMidiScope(target, ref.scope)) return id;
    const index = ref.index;
    if (index === undefined) return null;
    let next = index;
    if (index === fromIndex) next = toIndex;
    else if (fromIndex < toIndex && index > fromIndex && index <= toIndex) next = index - 1;
    else if (fromIndex > toIndex && index >= toIndex && index < fromIndex) next = index + 1;
    return next === index ? id : midiLearnInsertTargetId(ref.scope, next, ref.paramId);
  });
}

/**
 * Drops references to the old slot identity when a replacement changes the
 * processor type. Positional references at this slot are also unsafe: unlike
 * a reorder, they describe the old processor and cannot be rebound to the
 * replacement's parameter set. References to other slots remain untouched.
 */
export function pruneReplacedInsertReferences(
  store: ProjectStore,
  target: ProcessorReferenceTarget,
  index: number,
  oldProcessorId?: string,
): void {
  store.automationLanes = store.automationLanes.filter((lane) => {
    if (lane.target !== target) return true;
    const ref = parseInsertAutomationParam(lane.param);
    if (ref === undefined) return true;
    return ref.processorId !== oldProcessorId && ref.insertIndex !== index;
  });
  remapMidiTargets(store, (id) => {
    const ref = parseMidiLearnInsertTargetId(id);
    if (!ref || !sameMidiScope(target, ref.scope)) return id;
    const replaced =
      (oldProcessorId !== undefined && ref.processorId === oldProcessorId) || ref.index === index;
    return replaced ? null : id;
  });
}

/** Prunes/remaps mastering automation and MIDI learn after processor removal. */
export function pruneMasteringProcessorReferences(
  store: ProjectStore,
  removedIndex: number,
  removedProcessorId?: string,
): void {
  store.automationLanes = remapMasteringLanesAfterRemoval(
    store.automationLanes,
    removedIndex,
    removedProcessorId,
  );
  remapMidiTargets(store, (id) => {
    const ref = parseMidiLearnMasteringTargetId(id);
    if (!ref) return id;
    if (ref.processorId !== undefined) return ref.processorId === removedProcessorId ? null : id;
    if (ref.index === undefined || ref.index === removedIndex) return null;
    return ref.index > removedIndex ? midiLearnMasteringTargetId(ref.index - 1, ref.paramId) : id;
  });
}

/** Keeps legacy mastering indices aligned during reorder; stable ids remain unchanged. */
export function reorderMasteringProcessorReferences(
  store: ProjectStore,
  fromIndex: number,
  toIndex: number,
): void {
  store.automationLanes = remapMasteringLanesAfterReorder(
    store.automationLanes,
    fromIndex,
    toIndex,
  );
  remapMidiTargets(store, (id) => {
    const ref = parseMidiLearnMasteringTargetId(id);
    if (!ref || ref.processorId !== undefined) return id;
    const index = ref.index;
    if (index === undefined) return null;
    let next = index;
    if (index === fromIndex) next = toIndex;
    else if (fromIndex < toIndex && index > fromIndex && index <= toIndex) next = index - 1;
    else if (fromIndex > toIndex && index >= toIndex && index < fromIndex) next = index + 1;
    return next === index ? id : midiLearnMasteringTargetId(next, ref.paramId);
  });
}
