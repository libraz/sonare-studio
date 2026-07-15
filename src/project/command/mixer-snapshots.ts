/**
 * Mixer snapshot slot state.
 *
 * Four persisted slots (A-D) hold captured mixer snapshots for quick
 * comparison of the audible mix. The project serializer converts session track
 * ids to positional indices so saved snapshots can be restored after load.
 *
 * Recall applies the snapshot through the undoable {@link applyMixerSnapshot}
 * command, so a snapshot switch is itself undoable.
 */

import { markRaw, reactive } from 'vue';
import {
  type AutomationLaneState,
  busAutomationTarget,
  busIdFromAutomationTarget,
  cloneAutomationLane,
  isBusAutomationTarget,
} from '../automation';
import { canonicalJson } from '../hash';
import {
  cloneMixerState,
  cloneStrip,
  createDefaultStrip,
  type MixerStrip,
  type ProjectMixerState,
} from '../mixer';
import { useProjectStore } from '../store';
import {
  pruneStripTrackReferences,
  registerTargetReferenceContributor,
} from '../target-reference-registry';
import type { EditorTrack } from '../types';
import { executeApp, registerHistoryStateContributor } from './history';

// ---------------------------------------------------------------------------
// Mixer snapshots (capture/restore of the audible mix)
// ---------------------------------------------------------------------------

/** One track's captured mix state within a {@link MixerSnapshot}. */
export interface MixerSnapshotTrack {
  /** Track id the entry restores onto (matched by id; missing tracks skipped). */
  id: number;
  /** Captured channel strip (gain/pan/inserts/EQ/sends/output routing). */
  mixer: MixerStrip;
  /** Captured mute flag. */
  mute: boolean;
  /** Captured solo flag. */
  solo: boolean;
  /** Captured solo-safe flag (omitted when not solo-safe). */
  soloSafe?: boolean;
  /** Captured VCA group membership (omitted when unassigned). */
  vcaId?: string;
}

/**
 * A snapshot of the audible mixer state for comparison: the project mixer
 * state (master strip, buses, VCA groups, mastering chain) plus each track's
 * strip and mix flags.
 */
export interface MixerSnapshot {
  /** Project mixer state (master, buses, VCA groups, mastering chain). */
  mixer: ProjectMixerState;
  /** Per-track captured strip and mix flags, in capture order. */
  tracks: MixerSnapshotTrack[];
  /** Mixer-scoped automation lanes, currently bus fader automation. */
  automationLanes?: AutomationLaneState[];
}

/**
 * Builds a snapshot from raw mixer state and tracks (pure; exported for
 * tests). All nested data is deep-copied so the snapshot is detached from the
 * live store.
 *
 * @param mixer Project mixer state to capture.
 * @param tracks Tracks whose strips and mix flags to capture.
 * @returns A detached snapshot.
 */
export function buildMixerSnapshot(
  mixer: ProjectMixerState,
  tracks: ReadonlyArray<EditorTrack>,
  automationLanes: ReadonlyArray<AutomationLaneState> = [],
): MixerSnapshot {
  const validBusIds = new Set(mixer.buses.map((bus) => bus.id));
  const mixerAutomationLanes = automationLanes
    .filter(
      (lane) =>
        isBusAutomationTarget(lane.target) &&
        validBusIds.has(busIdFromAutomationTarget(lane.target)),
    )
    .map(cloneAutomationLane);
  const snapshot: MixerSnapshot = {
    mixer: cloneMixerState(mixer),
    tracks: tracks.map((track) => {
      const entry: MixerSnapshotTrack = {
        id: track.id,
        mixer: cloneStrip(track.mixer ?? createDefaultStrip()),
        mute: track.mute,
        solo: track.solo,
      };
      if (track.soloSafe !== undefined) entry.soloSafe = track.soloSafe;
      if (track.vcaId !== undefined) entry.vcaId = track.vcaId;
      return entry;
    }),
  };
  if (mixerAutomationLanes.length > 0) snapshot.automationLanes = mixerAutomationLanes;
  return snapshot;
}

/**
 * Restores a track's send routing against a valid bus-id set: drops sends to
 * buses that no longer exist and clears an output-bus that is gone (routing it
 * back to the master mix), so the restored strip never references a missing
 * bus (which the engine would reject).
 */
function sanitizeStripRouting(strip: MixerStrip, validBusIds: ReadonlySet<string>): MixerStrip {
  const next = cloneStrip(strip);
  next.sends = next.sends.filter((send) => validBusIds.has(send.busId));
  if (next.outputBusId !== undefined && !validBusIds.has(next.outputBusId)) {
    delete next.outputBusId;
  }
  return next;
}

/**
 * Computes the store state to apply when restoring a snapshot (pure; exported
 * for tests). Restores the project mixer state wholesale and, for each current
 * track also present in the snapshot, its captured strip and mix flags. Tracks
 * absent from the snapshot keep their current strip and flags. Every track's
 * send routing is sanitized against the restored bus set, and VCA membership
 * against the restored VCA groups, so the result is always engine-valid.
 *
 * @param snapshot The snapshot to restore.
 * @param currentTracks The tracks currently in the store.
 * @returns The mixer state and tracks to assign back to the store.
 */
export function mergeMixerSnapshot(
  snapshot: MixerSnapshot,
  currentTracks: ReadonlyArray<EditorTrack>,
  currentAutomationLanes: ReadonlyArray<AutomationLaneState> = [],
): { mixer: ProjectMixerState; tracks: EditorTrack[]; automationLanes: AutomationLaneState[] } {
  const mixer = cloneMixerState(snapshot.mixer);
  const validBusIds = new Set(mixer.buses.map((bus) => bus.id));
  const validVcaIds = new Set((mixer.vcaGroups ?? []).map((group) => group.id));
  const byId = new Map(snapshot.tracks.map((entry) => [entry.id, entry]));
  const tracks = currentTracks.map((track) => {
    const entry = byId.get(track.id);
    const next: EditorTrack = { ...track };
    if (entry) {
      next.mixer = entry.mixer;
      next.mute = entry.mute;
      next.solo = entry.solo;
      if (entry.soloSafe !== undefined) next.soloSafe = entry.soloSafe;
      else delete next.soloSafe;
      if (entry.vcaId !== undefined) next.vcaId = entry.vcaId;
      else delete next.vcaId;
    }
    if (next.mixer) next.mixer = sanitizeStripRouting(next.mixer, validBusIds);
    if (next.vcaId !== undefined && !validVcaIds.has(next.vcaId)) delete next.vcaId;
    return next;
  });
  const restoredBusTargets = new Set([...validBusIds].map(busAutomationTarget));
  const automationLanes = currentAutomationLanes
    .filter((lane) => !isBusAutomationTarget(lane.target))
    .map(cloneAutomationLane);
  for (const lane of snapshot.automationLanes ?? []) {
    if (!isBusAutomationTarget(lane.target) || !restoredBusTargets.has(lane.target)) continue;
    automationLanes.push(cloneAutomationLane(lane));
  }
  return { mixer, tracks, automationLanes };
}

/**
 * Captures the current mixer state as a snapshot for A/B comparison.
 *
 * @returns A detached snapshot of the live mixer state.
 */
export function captureMixerSnapshot(): MixerSnapshot {
  const store = useProjectStore();
  return buildMixerSnapshot(store.mixer, store.tracks, store.automationLanes);
}

/**
 * Restores a previously captured mixer snapshot as one undoable edit. The
 * audible mix (faders/pan/inserts/EQ/sends/buses/VCA/mute/solo) reverts to the
 * snapshot for tracks and buses that still exist; the engine resyncs from the
 * store mutation. Tracks added since the snapshot keep their settings.
 *
 * @param snapshot The snapshot to restore.
 */
export function applyMixerSnapshot(snapshot: MixerSnapshot): void {
  const store = useProjectStore();
  executeApp(() => {
    const { mixer, tracks, automationLanes } = mergeMixerSnapshot(
      snapshot,
      store.tracks,
      store.automationLanes,
    );
    store.mixer = mixer;
    store.tracks = tracks;
    store.automationLanes = automationLanes;
    store.refresh();
  });
}

// ---------------------------------------------------------------------------
// Snapshot slots
// ---------------------------------------------------------------------------

export const MIXER_SNAPSHOT_SLOTS = ['A', 'B', 'C', 'D'] as const;

/** One mixer snapshot slot. */
export type MixerSnapshotSlot = (typeof MIXER_SNAPSHOT_SLOTS)[number];

interface SnapshotRegistry {
  snapshots: Record<MixerSnapshotSlot, MixerSnapshot | null>;
  /** Slot last stored or recalled (drives the active highlight). */
  active: MixerSnapshotSlot | null;
}

const slots = reactive<SnapshotRegistry>({
  snapshots: { A: null, B: null, C: null, D: null },
  active: null,
});

/** The supported snapshot slots in display order. */
export function mixerSnapshotSlots(): readonly MixerSnapshotSlot[] {
  return MIXER_SNAPSHOT_SLOTS;
}

/**
 * True when a slot holds a snapshot.
 *
 * @param slot Slot to query.
 */
export function mixerSnapshotFilled(slot: MixerSnapshotSlot): boolean {
  return slots.snapshots[slot] !== null;
}

/** The slot last stored or recalled, or null when none is active. */
export function activeMixerSnapshotSlot(): MixerSnapshotSlot | null {
  return slots.active;
}

/**
 * Captures the current mixer state into a slot and marks it active.
 *
 * @param slot Destination slot.
 */
export function saveMixerSnapshot(slot: MixerSnapshotSlot): void {
  // markRaw: the snapshot is plain data we never mutate, so skip deep proxying.
  slots.snapshots[slot] = markRaw(captureMixerSnapshot());
  slots.active = slot;
}

/**
 * Restores the snapshot in a slot (no-op when empty) as one undoable edit and
 * marks the slot active.
 *
 * @param slot Slot to recall.
 * @returns True when a snapshot was restored, false when the slot was empty.
 */
export function recallMixerSnapshot(slot: MixerSnapshotSlot): boolean {
  const snapshot = slots.snapshots[slot];
  if (!snapshot) return false;
  applyMixerSnapshot(snapshot);
  slots.active = slot;
  return true;
}

/** Clears all slots. */
export function clearMixerSnapshots(): void {
  for (const slot of MIXER_SNAPSHOT_SLOTS) slots.snapshots[slot] = null;
  slots.active = null;
}

/** Plain slot state used by project serialization. */
export interface MixerSnapshotSlotState {
  snapshots: Partial<Record<MixerSnapshotSlot, MixerSnapshot>>;
  active: MixerSnapshotSlot | null;
}

/** Returns deep-copied snapshot slot state for persistence. */
export function exportMixerSnapshotSlots(): MixerSnapshotSlotState {
  const snapshots: Partial<Record<MixerSnapshotSlot, MixerSnapshot>> = {};
  for (const slot of MIXER_SNAPSHOT_SLOTS) {
    const snapshot = slots.snapshots[slot];
    if (snapshot) snapshots[slot] = markRaw(JSON.parse(JSON.stringify(snapshot)) as MixerSnapshot);
  }
  return { snapshots, active: slots.active };
}

/** Deterministic reactive signature used by dirty/autosave state tracking. */
export function mixerSnapshotSlotsKey(): string {
  return canonicalJson(exportMixerSnapshotSlots());
}

/** Replaces the current slot registry from persisted snapshot state. */
export function importMixerSnapshotSlots(state: MixerSnapshotSlotState | null): void {
  clearMixerSnapshots();
  if (!state) return;
  for (const slot of MIXER_SNAPSHOT_SLOTS) {
    const snapshot = state.snapshots[slot];
    if (snapshot) slots.snapshots[slot] = markRaw(snapshot);
  }
  slots.active = state.active && slots.snapshots[state.active] ? state.active : null;
}

/** Drops a removed track and every sidechain reference to it from all slots. */
export function pruneMixerSnapshotTrackReferences(trackId: number): void {
  for (const slot of MIXER_SNAPSHOT_SLOTS) {
    const snapshot = slots.snapshots[slot];
    if (!snapshot) continue;
    const mixer = cloneMixerState(snapshot.mixer);
    mixer.master = pruneStripTrackReferences(mixer.master, trackId);
    mixer.buses = mixer.buses.map((bus) =>
      bus.strip ? { ...bus, strip: pruneStripTrackReferences(bus.strip, trackId) } : bus,
    );
    slots.snapshots[slot] = markRaw({
      ...snapshot,
      mixer,
      tracks: snapshot.tracks
        .filter((track) => track.id !== trackId)
        .map((track) => ({
          ...track,
          mixer: pruneStripTrackReferences(track.mixer, trackId),
        })),
    });
  }
}

registerHistoryStateContributor<MixerSnapshotSlotState>('mixer-snapshot-slots', {
  capture: exportMixerSnapshotSlots,
  restore: importMixerSnapshotSlots,
});
registerTargetReferenceContributor({ pruneTrack: pruneMixerSnapshotTrackReferences });
