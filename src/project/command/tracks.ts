import { assertCanAddEngineBus, cloneStrip, type MixerStrip } from '../mixer';
import { getProject, useProjectStore } from '../store';
import { type EditorTrack, TRACK_COLOR_PALETTE, type TrackKind } from '../types';
import { execute } from './history';
import { requireTrack } from './utils';

/** Optional fields for {@link addTrack}. */
export interface AddTrackInput {
  /** Track display name; defaults to "Track N". */
  name?: string;
  /** Display color; defaults to the next palette color. */
  color?: string;
  /** Track content kind (defaults to 'midi'). */
  kind?: TrackKind;
}

/**
 * Adds a track as one undoable edit (MIDI unless `input.kind` says otherwise).
 *
 * @param input Optional name/color/kind overrides.
 * @returns The stable track id allocated by the Project.
 */
export function addTrack(input: AddTrackInput = {}): number {
  const store = useProjectStore();
  const project = getProject();
  const name = input.name ?? `Track ${store.tracks.length + 1}`;
  const color =
    input.color ?? TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
  const kind = input.kind ?? 'midi';
  // Group tracks are an app-level concept; the wasm Project stores them as
  // aux tracks.
  const projectKind = kind === 'group' ? 'aux' : kind;
  return execute(1, () => {
    const trackId = project.addTrack({ kind: projectKind, name });
    store.tracks = [
      ...store.tracks,
      {
        id: trackId,
        name,
        color,
        kind,
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: store.tracks.length,
      },
    ];
    if (store.activeTrackId < 0) store.activeTrackId = trackId;
    store.refresh();
    return trackId;
  });
}

/**
 * Adds an audio track as one undoable edit (shorthand for
 * {@link addTrack} with kind 'audio').
 *
 * @param input Optional name/color overrides.
 * @returns The stable track id allocated by the Project.
 */
export function addAudioTrack(input: Omit<AddTrackInput, 'kind'> = {}): number {
  return addTrack({ ...input, kind: 'audio' });
}

/**
 * Removes a track and its clips as one undoable edit. The track's automation
 * lanes are dropped in the same step. When the active track is removed, the
 * first remaining track (and its first clip) becomes active.
 *
 * @param trackId Id of the track to remove.
 */
export function removeTrack(trackId: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireTrack(store, trackId);
  execute(1, () => {
    project.removeTrack(trackId);
    store.automationLanes = store.automationLanes.filter((lane) => lane.target !== trackId);
    // Drop group memberships pointing at a removed group and sidechain keys
    // sourced from the removed track.
    store.tracks = store.tracks.map((track) => {
      let next = track;
      if (track.groupId === trackId) {
        next = { ...next };
        delete next.groupId;
      }
      if (track.mixer?.inserts.some((slot) => slot.sidechainSourceTrackId === trackId)) {
        next = next === track ? { ...next } : next;
        next.mixer = {
          ...cloneStrip(track.mixer as MixerStrip),
          inserts: (track.mixer?.inserts ?? []).map((slot) => {
            if (slot.sidechainSourceTrackId !== trackId) return { ...slot };
            const cleared = { ...slot };
            delete cleared.sidechainSourceTrackId;
            return cleared;
          }),
        };
      }
      return next;
    });
    let mixerChanged = false;
    const buses = store.mixer.buses.map((bus) => {
      if (!bus.strip?.inserts.some((slot) => slot.sidechainSourceTrackId === trackId)) return bus;
      mixerChanged = true;
      return {
        ...bus,
        strip: {
          ...cloneStrip(bus.strip),
          inserts: bus.strip.inserts.map((slot) => {
            if (slot.sidechainSourceTrackId !== trackId) return { ...slot };
            const cleared = { ...slot };
            delete cleared.sidechainSourceTrackId;
            return cleared;
          }),
        },
      };
    });
    if (mixerChanged) store.mixer = { ...store.mixer, buses };
    if (store.activeTrackId === trackId) {
      store.activeTrackId = -1;
      store.clipId = -1;
    }
    store.refresh();
  });
}

/**
 * Adds a group (folder/submix) track as one undoable edit. Group tracks have
 * no clips; member tracks assigned via {@link setTrackGroup} route their
 * output through the group's engine bus.
 *
 * @param input Optional name/color overrides.
 * @returns The new track id.
 */
export function addGroupTrack(input: Omit<AddTrackInput, 'kind'> = {}): number {
  const store = useProjectStore();
  assertCanAddEngineBus(store.mixer.buses.length, store.tracks);
  return addTrack({ ...input, kind: 'group' });
}

/**
 * Assigns a track to a group track (or removes the membership with null), as
 * one undoable edit. Group tracks cannot be nested.
 *
 * @param trackId Id of the member track.
 * @param groupId Id of a group track, or null for the master mix.
 */
export function setTrackGroup(trackId: number, groupId: number | null): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (track.kind === 'group') {
    throw new RangeError('Group tracks cannot be nested into another group');
  }
  if (groupId !== null) {
    const group = requireTrack(store, groupId);
    if (group.kind !== 'group') {
      throw new RangeError(`Track ${groupId} is not a group track`);
    }
  }
  if ((track.groupId ?? null) === groupId) return;
  execute(0, () => {
    store.tracks = store.tracks.map((entry) => {
      if (entry.id !== trackId) return entry;
      const next = { ...entry };
      if (groupId === null) delete next.groupId;
      else next.groupId = groupId;
      return next;
    });
    store.refresh();
  });
}

/**
 * Renames a track as one undoable edit (delegates to Project.renameTrack).
 *
 * @param trackId Id of the track to rename.
 * @param name New display name (non-empty).
 */
export function renameTrack(trackId: number, name: string): void {
  const store = useProjectStore();
  const project = getProject();
  const track = requireTrack(store, trackId);
  if (name.length === 0) throw new RangeError('Track name must not be empty');
  if (track.name === name) return;
  execute(1, () => {
    project.renameTrack(trackId, name);
    store.refresh();
  });
}

/**
 * Sets a track's display color as one undoable edit. Color is app-level
 * metadata (the Project has no color API), so only the mirror changes.
 *
 * @param trackId Id of the track.
 * @param color New CSS color string (non-empty).
 */
export function setTrackColor(trackId: number, color: string): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (color.length === 0) throw new RangeError('Track color must not be empty');
  if (track.color === color) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => (t.id === trackId ? { ...t, color } : t));
    store.refresh();
  });
}

/**
 * Sets a track's mute flag as one undoable edit. Mute is mirrored to the
 * engine mixer lane in realtime (no re-scheduling).
 *
 * @param trackId Id of the track.
 * @param mute New mute state.
 */
export function setTrackMute(trackId: number, mute: boolean): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (track.mute === mute) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => (t.id === trackId ? { ...t, mute } : t));
    store.refresh();
  });
}

/**
 * Sets a track's solo flag as one undoable edit. Solo is mirrored to the
 * engine mixer lane in realtime (no re-scheduling).
 *
 * @param trackId Id of the track.
 * @param solo New solo state.
 */
export function setTrackSolo(trackId: number, solo: boolean): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (track.solo === solo) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => (t.id === trackId ? { ...t, solo } : t));
    store.refresh();
  });
}

/**
 * Sets a track's linear volume as one undoable edit. Volume is mirrored to
 * the engine lane fader in realtime (no re-scheduling).
 *
 * @param trackId Id of the track.
 * @param volume New linear volume (finite, >= 0; 1 = unity).
 */
export function setTrackVolume(trackId: number, volume: number): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (!Number.isFinite(volume) || volume < 0) {
    throw new RangeError(`Track volume must be finite and >= 0, got ${volume}`);
  }
  if (track.volume === volume) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => (t.id === trackId ? { ...t, volume } : t));
    store.refresh();
  });
}

/**
 * Sets a track's stereo pan as one undoable edit. Pan is app-level metadata
 * (not applied to playback yet).
 *
 * @param trackId Id of the track.
 * @param pan New pan in [-1, 1].
 */
export function setTrackPan(trackId: number, pan: number): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (!Number.isFinite(pan) || pan < -1 || pan > 1) {
    throw new RangeError(`Track pan must be in [-1, 1], got ${pan}`);
  }
  if (track.pan === pan) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => (t.id === trackId ? { ...t, pan } : t));
    store.refresh();
  });
}

/**
 * Reorders tracks as one undoable edit. Order is app-level display state
 * (the Project has no track-order API).
 *
 * @param orderedIds Permutation of all current track ids, in new order.
 */
export function reorderTracks(orderedIds: ReadonlyArray<number>): void {
  const store = useProjectStore();
  const byId = new Map(store.tracks.map((track) => [track.id, track]));
  if (orderedIds.length !== byId.size || new Set(orderedIds).size !== orderedIds.length) {
    throw new RangeError('reorderTracks requires a permutation of all current track ids');
  }
  for (const id of orderedIds) {
    if (!byId.has(id)) throw new RangeError(`Unknown track id: ${id}`);
  }
  if (store.tracks.every((track, index) => track.id === orderedIds[index])) return;
  execute(0, () => {
    store.tracks = orderedIds.map((id, index) => {
      const track = byId.get(id) as EditorTrack;
      return { ...track, order: index };
    });
    store.refresh();
  });
}
