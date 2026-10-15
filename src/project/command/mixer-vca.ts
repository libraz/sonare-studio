import type { VcaGroup } from '../mixer';
import { MAX_STRIP_GAIN_DB, MAX_VCA_GROUPS, MIN_STRIP_GAIN_DB } from '../mixer';
import { useProjectStore } from '../store';
import { type CommandGestureOptions, execute, executeApp, hasPendingGesture } from './history';
import { patchMixerMirror } from './mixer-internal';
import { requireTrack } from './utils';

/**
 * Adds a VCA control group as one undoable edit. A VCA fader offsets the gain
 * of every member track (see {@link setTrackVca}); it carries no audio of its
 * own, so the offset is applied in the realtime mixer sync.
 *
 * @param input Optional id/name overrides.
 * @returns The group id.
 */
export function addVcaGroup(input: { id?: string; name?: string } = {}): string {
  const store = useProjectStore();
  const groups = store.mixer.vcaGroups ?? [];
  if (groups.length >= MAX_VCA_GROUPS) {
    throw new RangeError(`VCA group limit reached (${MAX_VCA_GROUPS})`);
  }
  let id = input.id;
  if (id !== undefined) {
    if (id.length === 0) throw new RangeError('VCA group id must not be empty');
    if (groups.some((group) => group.id === id)) {
      throw new RangeError(`VCA group id already exists: ${id}`);
    }
  } else {
    let n = 1;
    while (groups.some((group) => group.id === `vca-${n}`)) n++;
    id = `vca-${n}`;
  }
  const groupId = id;
  const name = input.name ?? `VCA ${groups.length + 1}`;
  return executeApp(() => {
    store.mixer = {
      ...store.mixer,
      vcaGroups: [...groups, { id: groupId, name, gainDb: 0 }],
    };
    store.refresh();
    return groupId;
  });
}

/**
 * Removes a VCA control group as one undoable edit; member tracks are
 * unassigned in the same step so no track references a missing group.
 *
 * @param groupId Id of the group to remove.
 */
export function removeVcaGroup(groupId: string): void {
  const store = useProjectStore();
  const groups = store.mixer.vcaGroups ?? [];
  if (!groups.some((group) => group.id === groupId)) {
    throw new RangeError(`Unknown VCA group id: ${groupId}`);
  }
  executeApp(() => {
    store.tracks = store.tracks.map((track) => {
      if (track.vcaId !== groupId) return track;
      const next = { ...track };
      delete next.vcaId;
      return next;
    });
    store.mixer = {
      ...store.mixer,
      vcaGroups: groups.filter((group) => group.id !== groupId),
    };
    store.refresh();
  });
}

/**
 * Renames a VCA control group as one undoable edit. Member tracks keep their
 * assignment because the stable group id is unchanged.
 *
 * @param groupId Target group id.
 * @param name New display name (trimmed, non-empty).
 */
export function renameVcaGroup(groupId: string, name: string): void {
  const store = useProjectStore();
  const groups = store.mixer.vcaGroups ?? [];
  const group = groups.find((entry) => entry.id === groupId);
  if (!group) throw new RangeError(`Unknown VCA group id: ${groupId}`);
  const nextName = name.trim();
  if (nextName.length === 0) throw new RangeError('VCA group name must not be empty');
  if (group.name === nextName) return;
  executeApp(() => {
    store.mixer = {
      ...store.mixer,
      vcaGroups: groups.map((entry) =>
        entry.id === groupId ? { ...entry, name: nextName } : entry,
      ),
    };
    store.refresh();
  });
}

/**
 * Sets a VCA group's fader offset in dB. Drag coalescing follows the
 * strip-gain protocol (pass `commit: false` while dragging); the mixer sync
 * re-applies the offset to every member lane.
 *
 * @param groupId Target group id.
 * @param gainDb Offset in dB within the strip-gain range.
 * @param options Gesture coalescing (`commit: false` while dragging).
 */
export function setVcaGroupGain(
  groupId: string,
  gainDb: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const groups = store.mixer.vcaGroups ?? [];
  const group = groups.find((entry) => entry.id === groupId);
  if (!group) throw new RangeError(`Unknown VCA group id: ${groupId}`);
  if (!Number.isFinite(gainDb) || gainDb < MIN_STRIP_GAIN_DB || gainDb > MAX_STRIP_GAIN_DB) {
    throw new RangeError(
      `VCA gain must be within [${MIN_STRIP_GAIN_DB}, ${MAX_STRIP_GAIN_DB}] dB, got ${gainDb}`,
    );
  }
  const key = `vca-gain:${groupId}`;
  if (group.gainDb === gainDb && !hasPendingGesture(key)) return;
  patchMixerMirror(key, options, () => {
    store.mixer = {
      ...store.mixer,
      vcaGroups: (store.mixer.vcaGroups ?? []).map((entry) =>
        entry.id === groupId ? { ...entry, gainDb } : entry,
      ),
    };
  });
}

/** Sets or clears a VCA group's mute flag as one undoable edit. */
export function setVcaGroupMute(groupId: string, mute: boolean): void {
  setVcaGroupBoolean(groupId, 'mute', mute);
}

/** Sets or clears a VCA group's solo flag as one undoable edit. */
export function setVcaGroupSolo(groupId: string, solo: boolean): void {
  setVcaGroupBoolean(groupId, 'solo', solo);
}

/** Shared optional boolean setter for VCA group flags. */
function setVcaGroupBoolean(groupId: string, key: 'mute' | 'solo', value: boolean): void {
  const store = useProjectStore();
  const groups = store.mixer.vcaGroups ?? [];
  const group = groups.find((entry) => entry.id === groupId);
  if (!group) throw new RangeError(`Unknown VCA group id: ${groupId}`);
  if ((group[key] ?? false) === value) return;
  executeApp(() => {
    store.mixer = {
      ...store.mixer,
      vcaGroups: groups.map((entry) =>
        entry.id === groupId ? withVcaFlag(entry, key, value) : entry,
      ),
    };
    store.refresh();
  });
}

/** Sets an optional VCA boolean flag, dropping it when false. */
function withVcaFlag(group: VcaGroup, key: 'mute' | 'solo', value: boolean): VcaGroup {
  const next = { ...group };
  if (value) next[key] = true;
  else delete next[key];
  return next;
}

/**
 * Assigns a track to a VCA group (or clears the assignment) as one undoable
 * edit. The group's fader offset applies to the track's lane in realtime.
 *
 * @param trackId Id of the track.
 * @param groupId Target VCA group id, or null to unassign.
 */
export function setTrackVca(trackId: number, groupId: string | null): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (groupId !== null && !(store.mixer.vcaGroups ?? []).some((group) => group.id === groupId)) {
    throw new RangeError(`Unknown VCA group id: ${groupId}`);
  }
  if ((track.vcaId ?? null) === groupId) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => {
      if (t.id !== trackId) return t;
      const next = { ...t };
      if (groupId === null) delete next.vcaId;
      else next.vcaId = groupId;
      return next;
    });
    store.refresh();
  });
}
