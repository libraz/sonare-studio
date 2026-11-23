import { linearToDb } from '@/lib/db';
import type { ChordFollowMode } from '../chord-follow';
import { sanitizeExpressionMap, type TrackExpressionMap } from '../expression-map';
import {
  assertCanAddEngineBus,
  assertCanAddTracks,
  createDefaultStrip,
  type ProjectMixerState,
} from '../mixer';
import { isValidPitchRange, type PitchRange } from '../pitch-range';
import { getProject, useProjectStore } from '../store';
import { pruneTrackTargetReferences } from '../target-reference-registry';
import { type EditorTrack, TRACK_COLOR_PALETTE, type TrackKind } from '../types';
import { clearProjectClipWarp } from '../warp';
import { type AtomicProjectEdit, execute, executeAtomic } from './history';
import { setStripPan } from './mixer-strip';
import { requireEditableTrack, requireTrack } from './utils';

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
 * Removes score annotations for clips that no longer exist.
 *
 * Score annotations are app-only mirror state, so clip deletion must update
 * them separately from the native Project. Copy the outer record before
 * deleting keys so callers never mutate a snapshot or another mirror value;
 * history captures the previous record and restores it on undo.
 */
export function pruneClipScoreAnnotations(
  store: ReturnType<typeof useProjectStore>,
  clipIds: Iterable<number>,
): void {
  const nextAnnotations = { ...store.scoreAnnotations };
  let changed = false;
  for (const clipId of clipIds) {
    if (!Object.hasOwn(nextAnnotations, clipId)) continue;
    delete nextAnnotations[clipId];
    changed = true;
  }
  if (changed) store.scoreAnnotations = nextAnnotations;
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
  assertCanAddTracks(store.tracks.length);
  const name = input.name ?? `Track ${store.tracks.length + 1}`;
  const color =
    input.color ?? TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
  const kind = input.kind ?? 'midi';
  // A group track takes an engine bus slot of its own.
  if (kind === 'group') assertCanAddEngineBus(store.mixer.buses, store.tracks);
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
 * Removes a track and its clips, dropping its automation lanes and clearing any
 * group memberships / sidechain keys sourced from it, then refreshes the mirror.
 * Only the native `removeTrack` is reported through `edit`, so a mirror step
 * that throws rolls the removal back with the rest of the transaction.
 *
 * @param store The project store to mutate.
 * @param trackId Id of the track to remove.
 * @param edit The enclosing atomic transaction's edit reporter.
 */
function applyTrackRemoval(
  store: ReturnType<typeof useProjectStore>,
  trackId: number,
  edit: AtomicProjectEdit,
): void {
  const project = getProject();
  const removedClipIds = store.clips
    .filter((clip) => clip.trackId === trackId)
    .map((clip) => clip.id);
  edit(1, () => project.removeTrack(trackId));
  pruneClipScoreAnnotations(store, removedClipIds);
  pruneTrackTargetReferences(store, trackId);
  applyTrackRemovalMirror(store, trackId);
  store.refresh();
}

/** Mirror-only cleanup shared by {@link applyTrackRemoval} (no wasm edits). */
function applyTrackRemovalMirror(store: ReturnType<typeof useProjectStore>, trackId: number): void {
  if (store.activeTrackId === trackId) {
    store.activeTrackId = -1;
    store.clipId = -1;
  }
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
  requireTrack(store, trackId);
  const project = getProject();
  executeAtomic((edit) => {
    for (const clip of store.clips.filter((entry) => entry.trackId === trackId)) {
      clearProjectClipWarp(project, clip.id, (mutation) => edit(1, mutation));
    }
    applyTrackRemoval(store, trackId, edit);
  });
}

/** Removes several tracks (and their clips) as one undoable operation. */
export function removeTracks(trackIds: Iterable<number>): void {
  const store = useProjectStore();
  const ids = [...new Set(trackIds)];
  for (const id of ids) requireTrack(store, id);
  if (ids.length === 0) return;
  const selected = new Set(ids);
  const project = getProject();
  executeAtomic((edit) => {
    for (const clip of store.clips.filter((entry) => selected.has(entry.trackId))) {
      clearProjectClipWarp(project, clip.id, (mutation) => edit(1, mutation));
    }
    for (const id of ids) applyTrackRemoval(store, id, edit);
  });
  store.trackSelection = new Set(store.activeTrackId >= 0 ? [store.activeTrackId] : []);
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
  return addTrack({ ...input, kind: 'group' });
}

/**
 * Writes (or, for `undefined`, deletes) one track field on several tracks as
 * one undoable mirror edit.
 */
function patchTracks<K extends keyof EditorTrack>(
  store: ReturnType<typeof useProjectStore>,
  ids: ReadonlySet<number>,
  key: K,
  value: EditorTrack[K] | undefined,
): void {
  execute(0, () => {
    store.tracks = store.tracks.map((track) => {
      if (!ids.has(track.id)) return track;
      const next: Record<string, unknown> = { ...track };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next as unknown as EditorTrack;
    });
    store.refresh();
  });
}

/**
 * Assigns a track to a group track (or removes the membership with null), as
 * one undoable edit. Group tracks cannot be nested.
 *
 * @param trackId Id of the member track.
 * @param groupId Id of a group track, or null for the master mix.
 */
export function setTrackGroup(trackId: number, groupId: number | null): void {
  setTracksGroup([trackId], groupId);
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
  const track = requireEditableTrack(store, trackId);
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
  setTracksColor([trackId], color);
}

/** Applies one display color to several tracks as one undoable operation. */
export function setTracksColor(trackIds: Iterable<number>, color: string): void {
  const store = useProjectStore();
  const ids = new Set(trackIds);
  for (const id of ids) requireTrack(store, id);
  if (color.length === 0) throw new RangeError('Track color must not be empty');
  if (ids.size === 0 || [...ids].every((id) => requireTrack(store, id).color === color)) return;
  patchTracks(store, ids, 'color', color);
}

/** Assigns several non-group tracks to the same output group in one undo step. */
export function setTracksGroup(trackIds: Iterable<number>, groupId: number | null): void {
  const store = useProjectStore();
  const ids = new Set(trackIds);
  const tracks = [...ids].map((id) => requireTrack(store, id));
  if (tracks.some((track) => track.kind === 'group')) {
    throw new RangeError('Group tracks cannot be nested into another group');
  }
  if (groupId !== null) {
    const group = requireTrack(store, groupId);
    if (group.kind !== 'group') throw new RangeError(`Track ${groupId} is not a group track`);
  }
  if (tracks.length === 0 || tracks.every((track) => (track.groupId ?? null) === groupId)) return;
  patchTracks(store, ids, 'groupId', groupId ?? undefined);
}

function setTrackFlag(trackId: number, key: 'mute' | 'solo', value: boolean): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (track[key] === value) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => (t.id === trackId ? { ...t, [key]: value } : t));
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
  setTrackFlag(trackId, 'mute', mute);
}

/**
 * Sets a track's solo flag as one undoable edit. Solo is mirrored to the
 * engine mixer lane in realtime (no re-scheduling).
 *
 * @param trackId Id of the track.
 * @param solo New solo state.
 */
export function setTrackSolo(trackId: number, solo: boolean): void {
  setTrackFlag(trackId, 'solo', solo);
}

/** Returns the mixer with every VCA and return-bus solo cleared. */
function mixerWithoutSolo(mixer: ProjectMixerState): ProjectMixerState {
  return {
    ...mixer,
    vcaGroups: (mixer.vcaGroups ?? []).map((group) => ({ ...group, solo: false })),
    buses: mixer.buses.map((bus) => {
      if (bus.solo !== true) return bus;
      const { solo: _solo, ...cleared } = bus;
      return cleared;
    }),
  };
}

/** Makes one track the only soloed source, clearing track, VCA and return-bus solos atomically. */
export function setExclusiveTrackSolo(trackId: number): void {
  const store = useProjectStore();
  requireTrack(store, trackId);
  execute(0, () => {
    store.tracks = store.tracks.map((track) => ({ ...track, solo: track.id === trackId }));
    store.mixer = mixerWithoutSolo(store.mixer);
    store.refresh();
  });
}

/** Clears every track, VCA and return-bus solo state as one undoable edit. */
export function clearAllSolo(): void {
  const store = useProjectStore();
  if (
    !store.tracks.some((track) => track.solo) &&
    !(store.mixer.vcaGroups ?? []).some((g) => g.solo) &&
    !store.mixer.buses.some((bus) => bus.solo === true)
  )
    return;
  execute(0, () => {
    store.tracks = store.tracks.map((track) => ({ ...track, solo: false }));
    store.mixer = mixerWithoutSolo(store.mixer);
    store.refresh();
  });
}

/**
 * Sets or clears a track's expression map as one undoable edit. The map is
 * applied while the MIDI schedule is built, so stored notes never change and
 * clearing it removes every injected key switch and controller.
 *
 * @param trackId Id of the track.
 * @param map Articulation map, or null to stop mapping articulations.
 */
export function setTrackExpressionMap(trackId: number, map: TrackExpressionMap | null): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  const sanitized = map === null ? undefined : sanitizeExpressionMap(map);
  const current = track.expressionMap;
  if (JSON.stringify(current ?? null) === JSON.stringify(sanitized ?? null)) return;
  patchTracks(store, new Set([trackId]), 'expressionMap', sanitized);
}

/**
 * Sets or clears a track's chord-track follow mode as one undoable edit.
 * While a mode is set, chord-track edits re-voice the track's notes in the
 * same undo entry (see src/project/chord-follow.ts). Switching the mode does
 * not touch existing notes: the follow only reacts to chord changes.
 *
 * @param trackId Id of the track.
 * @param mode Follow mode, or null to stop following.
 */
export function setTrackChordFollow(trackId: number, mode: ChordFollowMode | null): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if ((track.chordFollow ?? null) === mode) return;
  patchTracks(store, new Set([trackId]), 'chordFollow', mode ?? undefined);
}

/**
 * Sets or clears a track's explicit percussion override as one undoable edit.
 * `true` forces percussion, `false` forces harmonic, and `null` clears the
 * override so the drum heuristic classifies the track again. App-level metadata
 * used by harmonic analysis (chord/key estimation); it does not affect playback.
 *
 * @param trackId Id of the track.
 * @param percussion `true`/`false` to override, `null` to fall back to the heuristic.
 */
export function setTrackPercussion(trackId: number, percussion: boolean | null): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if ((track.percussion ?? null) === percussion) return;
  patchTracks(store, new Set([trackId]), 'percussion', percussion ?? undefined);
}

/**
 * Sets or clears a track's playable pitch range as one undoable edit. The
 * range is app-level metadata (see src/project/pitch-range.ts for the
 * standard SATB/instrument presets); placement guidance flags pitches
 * outside it once one is set.
 *
 * @param trackId Id of the track.
 * @param range Inclusive MIDI pitch range, or null to clear it.
 */
export function setTrackPitchRange(trackId: number, range: PitchRange | null): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (range !== null && !isValidPitchRange(range)) {
    throw new RangeError(`Invalid pitch range: ${JSON.stringify(range)}`);
  }
  const current = track.pitchRange ?? null;
  if (
    (current === null && range === null) ||
    (current !== null && range !== null && current.low === range.low && current.high === range.high)
  ) {
    return;
  }
  patchTracks(
    store,
    new Set([trackId]),
    'pitchRange',
    range === null ? undefined : { low: range.low, high: range.high },
  );
}

/**
 * Compatibility entry point for callers that still provide a linear fader
 * value. The value is immediately converted to the canonical strip dB gain;
 * the legacy `track.volume` mirror remains unity.
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
  const gainDb = linearToDb(volume);
  if (track.volume === 1 && track.mixer?.gainDb === gainDb) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) =>
      t.id === trackId
        ? { ...t, volume: 1, mixer: { ...(t.mixer ?? createDefaultStrip()), gainDb } }
        : t,
    );
    store.refresh();
  });
}

/**
 * Compatibility alias for the audible mixer-strip pan command.
 *
 * New UI should call {@link setStripPan} directly. Keeping this name lets old
 * integrations migrate without creating a second, save-only pan value.
 *
 * @param trackId Id of the track.
 * @param pan New pan in [-1, 1].
 */
export function setTrackPan(trackId: number, pan: number): void {
  setStripPan(trackId, pan);
}

/**
 * Sets the audio-input channel used when multi-channel input captures are
 * split across armed audio tracks. The stored channel is zero-based; null
 * restores automatic assignment by armed-track order.
 *
 * @param trackId Id of the audio track.
 * @param channel Zero-based input channel, or null for automatic assignment.
 */
export function setTrackRecordInputChannel(trackId: number, channel: number | null): void {
  setTracksRecordInputChannel([trackId], channel);
}

/** Sets one record input channel on several audio tracks in one undo step; any non-audio id rejects the whole edit. */
export function setTracksRecordInputChannel(
  trackIds: Iterable<number>,
  channel: number | null,
): void {
  const store = useProjectStore();
  const ids = new Set(trackIds);
  const tracks = [...ids].map((id) => requireTrack(store, id));
  if (tracks.some((track) => track.kind !== 'audio')) {
    throw new RangeError('Recording input channel can only be set on audio tracks');
  }
  if (channel !== null && (!Number.isInteger(channel) || channel < 0)) {
    throw new RangeError(`Recording input channel must be a non-negative integer, got ${channel}`);
  }
  if (
    tracks.length === 0 ||
    tracks.every((track) => (track.recordInputChannel ?? null) === channel)
  ) {
    return;
  }
  patchTracks(store, ids, 'recordInputChannel', channel ?? undefined);
}

/**
 * Sets the browser audioinput device recorded onto an audio track when several
 * armed tracks capture distinct physical devices at once. An empty string or
 * null clears the override so the track records from the global input device.
 *
 * @param trackId Id of the audio track.
 * @param deviceId Audioinput device id, or null/empty for the global input.
 */
export function setTrackRecordInputDeviceId(trackId: number, deviceId: string | null): void {
  setTracksRecordInputDeviceId([trackId], deviceId);
}

/** Sets one record input device on several audio tracks in one undo step; any non-audio id rejects the whole edit. */
export function setTracksRecordInputDeviceId(
  trackIds: Iterable<number>,
  deviceId: string | null,
): void {
  const store = useProjectStore();
  const ids = new Set(trackIds);
  const tracks = [...ids].map((id) => requireTrack(store, id));
  if (tracks.some((track) => track.kind !== 'audio')) {
    throw new RangeError('Recording input device can only be set on audio tracks');
  }
  const next = deviceId?.trim() ? deviceId.trim() : null;
  if (
    tracks.length === 0 ||
    tracks.every((track) => (track.recordInputDeviceId ?? null) === next)
  ) {
    return;
  }
  patchTracks(store, ids, 'recordInputDeviceId', next ?? undefined);
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
