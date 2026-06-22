/**
 * Mixer A/B snapshot session state.
 *
 * Two session-only slots (A and B) hold captured mixer snapshots for quick
 * A/B comparison of the audible mix. Like the undo/redo history this is session
 * state — not part of the persisted project — and is cleared when a project is
 * loaded (see clearMixerSnapshots, called from loadProjectDocument) so a
 * snapshot taken in one project never restores onto another.
 *
 * Recall applies the snapshot through the undoable {@link applyMixerSnapshot}
 * command, so an A/B switch is itself undoable.
 */

import { markRaw, reactive } from 'vue';
import { applyMixerSnapshot, captureMixerSnapshot, type MixerSnapshot } from './mixer';

/** One of the two A/B snapshot slots. */
export type MixerSnapshotSlot = 'A' | 'B';

interface SnapshotRegistry {
  A: MixerSnapshot | null;
  B: MixerSnapshot | null;
  /** Slot last stored or recalled (drives the active highlight). */
  active: MixerSnapshotSlot | null;
}

const slots = reactive<SnapshotRegistry>({ A: null, B: null, active: null });

/**
 * True when a slot holds a snapshot.
 *
 * @param slot Slot to query.
 */
export function mixerSnapshotFilled(slot: MixerSnapshotSlot): boolean {
  return slots[slot] !== null;
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
  slots[slot] = markRaw(captureMixerSnapshot());
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
  const snapshot = slots[slot];
  if (!snapshot) return false;
  applyMixerSnapshot(snapshot);
  slots.active = slot;
  return true;
}

/** Clears both slots; call when a project is loaded. */
export function clearMixerSnapshots(): void {
  slots.A = null;
  slots.B = null;
  slots.active = null;
}
