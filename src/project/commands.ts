import { audioAssetUri, loadAssetMeta } from '@/persistence/assets';
import {
  allocateMarkerId,
  allocateNoteId,
  allocateSectionId,
  getAudioSourceId,
  getProject,
  notesToProjectEvents,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from './store';
import {
  DEFAULT_SECTION_COLOR,
  type EditorClip,
  type EditorMarker,
  type EditorNote,
  type EditorNoteUpdate,
  type EditorSection,
  type EditorTrack,
  type NewEditorNote,
  type TempoSegment,
  type TimeSignatureSegment,
  TRACK_COLOR_PALETTE,
  type TrackKind,
} from './types';

/** Default note-on velocity for newly created notes. */
const DEFAULT_VELOCITY = 96;

/**
 * Maximum number of edits kept in the local history. When it overflows, the
 * oldest entry is dropped and undo stops there even though the Project
 * history may reach further back.
 */
const MAX_HISTORY = 100;

/**
 * Snapshot of the reactive mirror taken around every command.
 *
 * Project.undo()/redo() is authoritative for everything the Project stores
 * (track/clip structure, names, timing, note events, tempo, meter). These
 * snapshots restore what the Project does not know about: editor note ids,
 * track colors/mute/solo/volume/pan/order, clip names, markers, sections and
 * the active track/clip.
 */
interface MirrorSnapshot {
  tracks: EditorTrack[];
  clips: EditorClip[];
  markers: EditorMarker[];
  sections: EditorSection[];
  activeTrackId: number;
  activeClipId: number;
}

/**
 * One undoable command. `projectEdits` is the number of entries the command
 * pushed onto the wasm Project history (0 for app-metadata-only commands);
 * undo/redo replay exactly that many Project.undo()/redo() calls.
 */
interface HistoryEntry {
  projectEdits: number;
  before: MirrorSnapshot;
  after: MirrorSnapshot;
}

const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];

/** Deep-copies a note list into plain objects (detached from reactivity). */
function cloneNotes(notes: ReadonlyArray<EditorNote>): EditorNote[] {
  return notes.map((note) => ({ ...note }));
}

/** Deep-copies a clip mirror entry. */
function cloneClip(clip: EditorClip): EditorClip {
  return { ...clip, notes: cloneNotes(clip.notes) };
}

/** Captures the current mirror state for undo/redo restoration. */
function captureSnapshot(store: ReturnType<typeof useProjectStore>): MirrorSnapshot {
  return {
    tracks: store.tracks.map((track) => ({ ...track })),
    clips: store.clips.map(cloneClip),
    markers: store.markers.map((marker) => ({ ...marker })),
    sections: store.sections.map((section) => ({ ...section })),
    activeTrackId: store.activeTrackId,
    activeClipId: store.clipId,
  };
}

/**
 * Restores app-level mirror state from a snapshot and refreshes from the
 * Project, using the snapshot's per-clip notes as id hints. Call after the
 * matching Project.undo()/redo() calls so structural state parses back.
 */
function restoreSnapshot(
  store: ReturnType<typeof useProjectStore>,
  snapshot: MirrorSnapshot,
): void {
  store.tracks = snapshot.tracks.map((track) => ({ ...track }));
  store.clips = snapshot.clips.map(cloneClip);
  store.markers = snapshot.markers.map((marker) => ({ ...marker }));
  store.sections = snapshot.sections.map((section) => ({ ...section }));
  store.activeTrackId = snapshot.activeTrackId;
  store.clipId = snapshot.activeClipId;
  const hints = new Map(snapshot.clips.map((clip) => [clip.id, clip.notes]));
  store.refresh(hints);
}

/**
 * Runs a mutating command as one undoable history entry.
 *
 * The action performs the Project calls and mirror updates (including the
 * final store.refresh). `projectEdits` must equal the number of Project
 * history entries the action produced.
 */
function execute<T>(projectEdits: number, action: () => T): T {
  const store = useProjectStore();
  const before = captureSnapshot(store);
  const result = action();
  const after = captureSnapshot(store);
  undoStack.push({ projectEdits, before, after });
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  return result;
}

/** Throws RangeError when a note has out-of-range or non-finite fields. */
function validateNote(note: Omit<EditorNote, 'id'>): void {
  if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
    throw new RangeError(`Note pitch must be an integer in [0, 127], got ${note.pitch}`);
  }
  if (!Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) {
    throw new RangeError(`Note velocity must be an integer in [1, 127], got ${note.velocity}`);
  }
  if (!Number.isInteger(note.channel) || note.channel < 0 || note.channel > 15) {
    throw new RangeError(`Note channel must be an integer in [0, 15], got ${note.channel}`);
  }
  if (!Number.isFinite(note.startPpq) || note.startPpq < 0) {
    throw new RangeError(`Note startPpq must be finite and >= 0, got ${note.startPpq}`);
  }
  if (!Number.isFinite(note.durationPpq) || note.durationPpq <= 0) {
    throw new RangeError(`Note durationPpq must be finite and > 0, got ${note.durationPpq}`);
  }
  if (
    note.offVelocity !== undefined &&
    (!Number.isInteger(note.offVelocity) || note.offVelocity < 1 || note.offVelocity > 127)
  ) {
    throw new RangeError(
      `Note offVelocity must be an integer in [1, 127], got ${note.offVelocity}`,
    );
  }
}

/** Throws RangeError when a PPQ value is not finite or negative. */
function validatePpq(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and >= 0, got ${value}`);
  }
}

/** Returns the mirror track with the given id, or throws RangeError. */
function requireTrack(store: ReturnType<typeof useProjectStore>, trackId: number): EditorTrack {
  const track = store.tracks.find((t) => t.id === trackId);
  if (!track) throw new RangeError(`Unknown track id: ${trackId}`);
  return track;
}

/** Returns the mirror clip with the given id, or throws RangeError. */
function requireClip(store: ReturnType<typeof useProjectStore>, clipId: number): EditorClip {
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip) throw new RangeError(`Unknown clip id: ${clipId}`);
  return clip;
}

/**
 * Copies app-level audio metadata (kind, asset reference) from a source clip
 * onto a derived clip mirror entry (duplicate/split results). Fades are not
 * copied: the Project owns them for clips it derives.
 */
function withAudioMetadata(target: EditorClip, source: EditorClip): EditorClip {
  if (source.kind === undefined && source.assetId === undefined) return target;
  const next: EditorClip = { ...target };
  if (source.kind !== undefined) next.kind = source.kind;
  if (source.assetId !== undefined) next.assetId = source.assetId;
  return next;
}

/**
 * Applies a new note list to the active clip as one undoable edit: validates,
 * replaces the clip's events in the Project (setMidiEvents = one entry on the
 * project history), then refreshes the mirror using `nextNotes` as id hints.
 */
function commit(nextNotes: EditorNote[]): void {
  const store = useProjectStore();
  const project = getProject();
  if (store.clipId < 0) throw new Error('No active clip to edit');
  for (const note of nextNotes) validateNote(note);
  execute(1, () => {
    project.setMidiEvents(store.clipId, notesToProjectEvents(nextNotes));
    store.refresh(nextNotes);
  });
}

/**
 * Adds a note to the active clip.
 *
 * @param input Note fields; velocity defaults to 96 and channel to 0.
 * @returns The editor id assigned to the new note.
 */
export function addNote(input: NewEditorNote): number {
  const store = useProjectStore();
  const note: EditorNote = {
    id: allocateNoteId(),
    pitch: input.pitch,
    velocity: input.velocity ?? DEFAULT_VELOCITY,
    startPpq: input.startPpq,
    durationPpq: input.durationPpq,
    channel: input.channel ?? 0,
  };
  if (input.offVelocity !== undefined) note.offVelocity = input.offVelocity;
  commit([...cloneNotes(store.notes), note]);
  return note.id;
}

/**
 * Applies partial edits (move / resize / velocity / channel) to existing
 * notes as one undoable edit. Updates referencing unknown ids are ignored;
 * the call is a no-op when nothing matches.
 *
 * @param updates Per-note partial edits addressed by editor id.
 */
export function updateNotes(updates: ReadonlyArray<EditorNoteUpdate>): void {
  const store = useProjectStore();
  const byId = new Map(updates.map((update) => [update.id, update]));
  let changed = false;
  const next = store.notes.map((note) => {
    const update = byId.get(note.id);
    if (!update) return { ...note };
    changed = true;
    const merged: EditorNote = {
      ...note,
      pitch: update.pitch ?? note.pitch,
      velocity: update.velocity ?? note.velocity,
      startPpq: update.startPpq ?? note.startPpq,
      durationPpq: update.durationPpq ?? note.durationPpq,
      channel: update.channel ?? note.channel,
    };
    if (update.offVelocity !== undefined) merged.offVelocity = update.offVelocity;
    return merged;
  });
  if (!changed) return;
  commit(next);
}

/**
 * Deletes notes by editor id as one undoable edit. Unknown ids are ignored;
 * the call is a no-op when nothing matches.
 *
 * @param ids Editor ids of the notes to delete.
 */
export function deleteNotes(ids: Iterable<number>): void {
  const store = useProjectStore();
  const drop = new Set(ids);
  const next = store.notes.filter((note) => !drop.has(note.id)).map((note) => ({ ...note }));
  if (next.length === store.notes.length) return;
  commit(next);
}

/**
 * Replaces the selection. Ids without a matching note are dropped. Selection
 * is editor-only state: it does not touch the Project and is not undoable.
 *
 * @param ids Editor ids to select.
 */
export function setSelection(ids: Iterable<number>): void {
  const store = useProjectStore();
  const alive = new Set(store.notes.map((note) => note.id));
  store.selection = new Set([...ids].filter((id) => alive.has(id)));
}

/**
 * Snaps a PPQ position to a regular local grid with adjustable strength.
 *
 * @param ppq Position to snap.
 * @param gridPpq Grid step in PPQ (> 0).
 * @param strength 0..1 interpolation toward the grid line.
 * @returns The (partially) snapped position.
 */
function snapPpqToLocalGrid(ppq: number, gridPpq: number, strength: number): number {
  const target = Math.round(ppq / gridPpq) * gridPpq;
  return ppq + (target - ppq) * strength;
}

/**
 * Quantizes the start positions of the selected notes to the snap grid as one
 * undoable edit. Project.snapToGrid only snaps to the project's beat grid, so
 * it is used when the editor grid is exactly one beat (snapDivision = 4);
 * finer or coarser grids use equivalent local snap math.
 *
 * @param strength 0..1 interpolation toward the grid (default 1 = full snap).
 */
export function quantizeSelection(strength = 1): void {
  const store = useProjectStore();
  if (store.selection.size === 0) return;
  const project = getProject();
  const gridPpq = 4 / store.snapDivision;
  let changed = false;
  const next = store.notes.map((note) => {
    if (!store.selection.has(note.id)) return { ...note };
    const snapped =
      gridPpq === 1
        ? project.snapToGrid(note.startPpq, strength)
        : snapPpqToLocalGrid(note.startPpq, gridPpq, strength);
    if (snapped === note.startPpq) return { ...note };
    changed = true;
    return { ...note, startPpq: Math.max(0, snapped) };
  });
  if (changed) commit(next);
}

// ---------------------------------------------------------------------------
// Track commands
// ---------------------------------------------------------------------------

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
  return execute(1, () => {
    const trackId = project.addTrack({ kind, name });
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
 * Removes a track and its clips as one undoable edit. When the active track
 * is removed, the first remaining track (and its first clip) becomes active.
 *
 * @param trackId Id of the track to remove.
 */
export function removeTrack(trackId: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireTrack(store, trackId);
  execute(1, () => {
    project.removeTrack(trackId);
    if (store.activeTrackId === trackId) {
      store.activeTrackId = -1;
      store.clipId = -1;
    }
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
 * Sets a track's mute flag as one undoable edit. Mute is app-level state
 * applied when (re)scheduling clips into the engine.
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
 * Sets a track's solo flag as one undoable edit. Solo is app-level state
 * applied when (re)scheduling clips into the engine.
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
 * Sets a track's linear volume as one undoable edit. Volume is app-level
 * state folded into clip gain when (re)scheduling.
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

// ---------------------------------------------------------------------------
// Clip commands
// ---------------------------------------------------------------------------

/** Fields for {@link addMidiClip}. */
export interface AddMidiClipInput {
  /** Id of the track the clip belongs to. */
  trackId: number;
  /** Timeline start in PPQ (>= 0). Defaults to 0. */
  startPpq?: number;
  /** Clip length in PPQ (> 0). */
  lengthPpq: number;
  /** Clip display name (app-level); defaults to "Clip N". */
  name?: string;
}

/**
 * Adds an empty MIDI clip to a track as one undoable edit.
 *
 * Project.addClip registers a backing source and the clip itself, which are
 * two entries on the Project history; undo reverts both at once.
 *
 * @param input Clip placement and optional name.
 * @returns The stable clip id allocated by the Project.
 */
export function addMidiClip(input: AddMidiClipInput): number {
  const store = useProjectStore();
  const project = getProject();
  requireTrack(store, input.trackId);
  const startPpq = input.startPpq ?? 0;
  validatePpq(startPpq, 'Clip startPpq');
  if (!Number.isFinite(input.lengthPpq) || input.lengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${input.lengthPpq}`);
  }
  return execute(2, () => {
    const newClipId = project.addClip({
      trackId: input.trackId,
      isMidi: true,
      startPpq,
      lengthPpq: input.lengthPpq,
    });
    if (input.name !== undefined) {
      // Seed the mirror entry so refresh keeps the app-level name.
      store.clips = [
        ...store.clips,
        {
          id: newClipId,
          trackId: input.trackId,
          name: input.name,
          startPpq,
          lengthPpq: input.lengthPpq,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [],
        },
      ];
    }
    store.refresh();
    return newClipId;
  });
}

/** Fields for {@link addAudioClip}. */
export interface AddAudioClipInput {
  /** Id of the track the clip belongs to. */
  trackId: number;
  /** Audio asset id from src/persistence/assets.ts. */
  assetId: string;
  /** Timeline start in PPQ (>= 0). Defaults to 0. */
  startPpq?: number;
  /**
   * Clip length in PPQ (> 0). Defaults to the full asset duration converted
   * at the current project tempo (which requires the asset metadata to be
   * loadable from the asset store).
   */
  lengthPpq?: number;
  /** Linear playback gain (>= 0). Defaults to 1. */
  gain?: number;
  /** Clip display name (app-level); defaults to "Clip N". */
  name?: string;
}

/**
 * Adds an audio clip referencing a stored asset as one undoable edit.
 *
 * The wasm Project registers one audio source per asset: the first clip of an
 * asset registers a by-reference source (sourceUri "asset:<id>", two entries
 * on the Project history, like addMidiClip), later clips of the same asset
 * are rebound to that source via Project.setClipSource (three entries). Undo
 * reverts the whole command at once either way.
 *
 * The clip's PCM stays in the asset store; playback loads it when scheduling
 * (src/project/scheduling.ts).
 *
 * @param input Clip placement, asset reference and optional overrides.
 * @returns The stable clip id allocated by the Project.
 */
export async function addAudioClip(input: AddAudioClipInput): Promise<number> {
  const store = useProjectStore();
  const project = getProject();
  requireTrack(store, input.trackId);
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    throw new RangeError('Audio clip assetId must not be empty');
  }
  const startPpq = input.startPpq ?? 0;
  validatePpq(startPpq, 'Clip startPpq');
  if (input.gain !== undefined && (!Number.isFinite(input.gain) || input.gain < 0)) {
    throw new RangeError(`Clip gain must be finite and >= 0, got ${input.gain}`);
  }
  let lengthPpq = input.lengthPpq;
  if (lengthPpq === undefined) {
    // Default length: the asset's duration in beats at the current tempo.
    const meta = await loadAssetMeta(input.assetId);
    lengthPpq = (meta.numFrames / meta.sampleRate) * (store.tempoBpm / 60);
  }
  if (!Number.isFinite(lengthPpq) || lengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${lengthPpq}`);
  }
  const finalLengthPpq = lengthPpq;
  const gain = input.gain ?? 1;
  // Reuse the asset's registered source when it is still on the Project
  // (undo may have rolled the registration back; then re-register).
  const known = getAudioSourceId(input.assetId);
  const sourceId =
    known !== undefined && known >= 1 && known <= project.sourceCount() ? known : undefined;
  return execute(sourceId === undefined ? 2 : 3, () => {
    const newClipId = project.addClip({
      trackId: input.trackId,
      isMidi: false,
      startPpq,
      lengthPpq: finalLengthPpq,
      gain,
      // The binding requires non-empty inline audio on every clip-source
      // registration; the real PCM stays in the asset store (the source is
      // by-reference via its "asset:<id>" URI).
      ...placeholderSourceAudio(),
      ...(sourceId === undefined ? { sourceUri: audioAssetUri(input.assetId) } : {}),
    });
    if (sourceId === undefined) {
      setAudioSourceId(input.assetId, project.sourceCount());
    } else {
      project.setClipSource(newClipId, sourceId);
    }
    // Seed the mirror entry so refresh keeps the kind/asset metadata.
    store.clips = [
      ...store.clips,
      {
        id: newClipId,
        trackId: input.trackId,
        name: input.name ?? `Clip ${newClipId}`,
        startPpq,
        lengthPpq: finalLengthPpq,
        sourceOffsetPpq: 0,
        gain,
        loopEnabled: false,
        loopLengthPpq: 0,
        notes: [],
        kind: 'audio',
        assetId: input.assetId,
      },
    ];
    store.refresh();
    return newClipId;
  });
}

/**
 * Removes a clip as one undoable edit. When the active clip is removed, the
 * first remaining clip of the active track becomes active.
 *
 * @param clipId Id of the clip to remove.
 */
export function deleteClip(clipId: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  execute(1, () => {
    project.removeClip(clipId);
    if (store.clipId === clipId) store.clipId = -1;
    store.refresh();
  });
}

/**
 * Renames a clip as one undoable edit. Clip names are app-level metadata
 * (the Project has no clip-name API), so only the mirror changes.
 *
 * @param clipId Id of the clip.
 * @param name New display name (non-empty).
 */
export function renameClip(clipId: number, name: string): void {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (name.length === 0) throw new RangeError('Clip name must not be empty');
  if (clip.name === name) return;
  execute(0, () => {
    store.clips = store.clips.map((c) => (c.id === clipId ? { ...c, name } : c));
    store.refresh();
  });
}

/**
 * Moves a clip to a new timeline start (and optionally another track) as one
 * undoable edit (delegates to Project.moveClip).
 *
 * @param clipId Id of the clip to move.
 * @param newStartPpq New timeline start in PPQ (>= 0).
 * @param newTrackId Optional destination track id.
 */
export function moveClip(clipId: number, newStartPpq: number, newTrackId?: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  if (newTrackId !== undefined) requireTrack(store, newTrackId);
  execute(1, () => {
    if (newTrackId === undefined) project.moveClip(clipId, newStartPpq);
    else project.moveClip(clipId, newStartPpq, newTrackId);
    store.refresh();
  });
}

/**
 * Duplicates a clip at a new timeline start on the same track as one undoable
 * edit (delegates to Project.duplicateClip; MIDI content is copied by the
 * Project). The copy inherits the source clip's display name.
 *
 * @param clipId Id of the clip to duplicate.
 * @param newStartPpq Timeline start of the copy in PPQ (>= 0).
 * @returns The stable clip id of the copy.
 */
export function duplicateClip(clipId: number, newStartPpq: number): number {
  const store = useProjectStore();
  const project = getProject();
  const source = requireClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  const name = source.name;
  const sourceMeta = { ...source };
  return execute(1, () => {
    const copyId = project.duplicateClip(clipId, newStartPpq);
    store.refresh();
    store.clips = store.clips.map((c) =>
      c.id === copyId ? withAudioMetadata({ ...c, name }, sourceMeta) : c,
    );
    return copyId;
  });
}

/**
 * Splits a clip at a timeline position as one undoable edit (delegates to
 * Project.splitClip; the Project partitions MIDI content and source offsets).
 * The right half inherits the source clip's display name.
 *
 * @param clipId Id of the clip to split.
 * @param splitPpq Timeline split position, strictly inside the clip.
 * @returns The stable clip id of the right half.
 */
export function splitClip(clipId: number, splitPpq: number): number {
  const store = useProjectStore();
  const project = getProject();
  const source = requireClip(store, clipId);
  if (
    !Number.isFinite(splitPpq) ||
    splitPpq <= source.startPpq ||
    splitPpq >= source.startPpq + source.lengthPpq
  ) {
    const end = source.startPpq + source.lengthPpq;
    throw new RangeError(
      `Split position ${splitPpq} must lie strictly inside the clip [${source.startPpq}, ${end}]`,
    );
  }
  const name = source.name;
  const sourceMeta = { ...source };
  return execute(1, () => {
    const rightId = project.splitClip(clipId, splitPpq);
    store.refresh();
    store.clips = store.clips.map((c) =>
      c.id === rightId ? withAudioMetadata({ ...c, name }, sourceMeta) : c,
    );
    return rightId;
  });
}

/**
 * Trims a clip's timeline start and length as one undoable edit (delegates to
 * Project.trimClip; the Project adjusts the source offset accordingly).
 *
 * @param clipId Id of the clip to trim.
 * @param newStartPpq New timeline start in PPQ (>= 0).
 * @param newLengthPpq New length in PPQ (> 0).
 */
export function trimClip(clipId: number, newStartPpq: number, newLengthPpq: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  if (!Number.isFinite(newLengthPpq) || newLengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${newLengthPpq}`);
  }
  execute(1, () => {
    project.trimClip(clipId, newStartPpq, newLengthPpq);
    store.refresh();
  });
}

/**
 * Sets a clip's loop mode and loop length as one undoable edit (delegates to
 * Project.setClipLoop).
 *
 * @param clipId Id of the clip.
 * @param loopEnabled True to loop the clip window.
 * @param loopLengthPpq Loop length in PPQ (> 0); defaults to the clip length.
 */
export function setClipLoop(clipId: number, loopEnabled: boolean, loopLengthPpq?: number): void {
  const store = useProjectStore();
  const project = getProject();
  const clip = requireClip(store, clipId);
  if (loopLengthPpq !== undefined && (!Number.isFinite(loopLengthPpq) || loopLengthPpq <= 0)) {
    throw new RangeError(`Loop length must be finite and > 0, got ${loopLengthPpq}`);
  }
  execute(1, () => {
    if (loopEnabled) project.setClipLoop(clipId, 'loop', loopLengthPpq ?? clip.lengthPpq);
    else project.setClipLoop(clipId, 'off');
    store.refresh();
  });
}

/**
 * Sets a clip's linear playback gain as one undoable edit (delegates to
 * Project.setClipGain).
 *
 * @param clipId Id of the clip.
 * @param gain New linear gain (finite, >= 0).
 */
export function setClipGain(clipId: number, gain: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  if (!Number.isFinite(gain) || gain < 0) {
    throw new RangeError(`Clip gain must be finite and >= 0, got ${gain}`);
  }
  execute(1, () => {
    project.setClipGain(clipId, gain);
    store.refresh();
  });
}

/**
 * Sets a clip's fade-in/fade-out lengths as one undoable edit (delegates to
 * Project.setClipFade). Pass undefined or 0 to clear a fade. Playback applies
 * fades to audio clips only (src/project/scheduling.ts multiplies the buffer
 * edges); the prerendered MIDI path ignores them.
 *
 * @param clipId Id of the clip.
 * @param fadeInPpq Fade-in length in PPQ (finite, >= 0; 0/undefined = none).
 * @param fadeOutPpq Fade-out length in PPQ (finite, >= 0; 0/undefined = none).
 */
export function setClipFades(clipId: number, fadeInPpq?: number, fadeOutPpq?: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  for (const [value, label] of [
    [fadeInPpq, 'Clip fadeInPpq'],
    [fadeOutPpq, 'Clip fadeOutPpq'],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new RangeError(`${label} must be finite and >= 0, got ${value}`);
    }
  }
  const fadeIn = fadeInPpq ?? 0;
  const fadeOut = fadeOutPpq ?? 0;
  execute(1, () => {
    project.setClipFade(clipId, { lengthPpq: fadeIn }, { lengthPpq: fadeOut });
    store.refresh();
    // Mirror fallback for bindings that do not serialize fades in toJson():
    // pin the values we just set (0 clears the field).
    store.clips = store.clips.map((c) => {
      if (c.id !== clipId) return c;
      const { fadeInPpq: _oldIn, fadeOutPpq: _oldOut, ...rest } = c;
      return {
        ...rest,
        ...(fadeIn > 0 ? { fadeInPpq: fadeIn } : {}),
        ...(fadeOut > 0 ? { fadeOutPpq: fadeOut } : {}),
      };
    });
  });
}

/**
 * Makes a clip the active piano-roll clip. Editor-only state: not undoable.
 * The active track follows the clip and the note selection is cleared.
 *
 * @param clipId Id of the clip to activate.
 */
export function setActiveClip(clipId: number): void {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (store.clipId === clipId) return;
  store.clipId = clipId;
  store.activeTrackId = clip.trackId;
  store.selection = new Set();
  store.refresh();
}

/**
 * Makes a track the active track. Editor-only state: not undoable. The first
 * clip of the track (by timeline position) becomes the active clip, or no
 * clip when the track is empty.
 *
 * @param trackId Id of the track to activate.
 */
export function setActiveTrack(trackId: number): void {
  const store = useProjectStore();
  requireTrack(store, trackId);
  store.activeTrackId = trackId;
  const first = store.clips.find((clip) => clip.trackId === trackId) ?? null;
  store.clipId = first?.id ?? -1;
  store.selection = new Set();
  store.refresh();
}

// ---------------------------------------------------------------------------
// Marker / section / tempo / meter commands
// ---------------------------------------------------------------------------

/**
 * Adds or updates a timeline marker as one undoable edit. Markers are
 * app-level metadata: the Project's setMarker has no matching removal or
 * listing API, so the mirror is authoritative and the Project is not written.
 *
 * @param markerId Id of the marker to update, or null/0 to create one.
 * @param ppq Marker position in PPQ (>= 0).
 * @param name Marker display name.
 * @returns The stable marker id (the new id when one was created).
 */
export function setMarker(markerId: number | null, ppq: number, name: string): number {
  const store = useProjectStore();
  validatePpq(ppq, 'Marker ppq');
  if (markerId !== null && markerId !== 0 && !store.markers.some((m) => m.id === markerId)) {
    throw new RangeError(`Unknown marker id: ${markerId}`);
  }
  return execute(0, () => {
    if (markerId === null || markerId === 0) {
      const id = allocateMarkerId();
      store.markers = [...store.markers, { id, ppq, name }].sort(
        (a, b) => a.ppq - b.ppq || a.id - b.id,
      );
      store.refresh();
      return id;
    }
    store.markers = store.markers
      .map((m) => (m.id === markerId ? { ...m, ppq, name } : m))
      .sort((a, b) => a.ppq - b.ppq || a.id - b.id);
    store.refresh();
    return markerId;
  });
}

/**
 * Removes a timeline marker as one undoable edit. Unknown ids are a no-op.
 *
 * @param markerId Id of the marker to remove.
 */
export function removeMarker(markerId: number): void {
  const store = useProjectStore();
  if (!store.markers.some((m) => m.id === markerId)) return;
  execute(0, () => {
    store.markers = store.markers.filter((m) => m.id !== markerId);
    store.refresh();
  });
}

/** Input shape for {@link setSections}; ids are preserved when provided. */
export interface SectionInput {
  /** Existing section id to preserve; omitted = a new id is allocated. */
  id?: number;
  /** Section display name. */
  name: string;
  /** Display color; defaults to the shared section color. */
  color?: string;
  /** Section start in PPQ (>= 0). */
  startPpq: number;
  /** Section end in PPQ (> startPpq). */
  endPpq: number;
}

/**
 * Replaces the section list as one undoable edit. Sections are app-level
 * metadata (the Project has no section API); the list is kept sorted by
 * start position.
 *
 * @param sections New section list; entries with an id keep it.
 */
export function setSections(sections: ReadonlyArray<SectionInput>): void {
  const store = useProjectStore();
  for (const section of sections) {
    validatePpq(section.startPpq, 'Section startPpq');
    if (!Number.isFinite(section.endPpq) || section.endPpq <= section.startPpq) {
      throw new RangeError(
        `Section endPpq must be > startPpq, got [${section.startPpq}, ${section.endPpq}]`,
      );
    }
  }
  execute(0, () => {
    store.sections = sections
      .map((section) => ({
        id: section.id ?? allocateSectionId(),
        name: section.name,
        color: section.color ?? DEFAULT_SECTION_COLOR,
        startPpq: section.startPpq,
        endPpq: section.endPpq,
      }))
      .sort((a, b) => a.startPpq - b.startPpq || a.endPpq - b.endPpq || a.id - b.id);
    store.refresh();
  });
}

/**
 * Replaces the project's tempo map as one undoable edit (delegates to
 * Project.setTempoSegments).
 *
 * @param segments Non-empty tempo segments sorted by ascending startPpq.
 */
export function setTempoSegments(segments: ReadonlyArray<TempoSegment>): void {
  const store = useProjectStore();
  const project = getProject();
  if (segments.length === 0) throw new RangeError('Tempo map must contain at least one segment');
  segments.forEach((segment, index) => {
    validatePpq(segment.startPpq, 'Tempo segment startPpq');
    if (!Number.isFinite(segment.bpm) || segment.bpm <= 0) {
      throw new RangeError(`Tempo bpm must be finite and > 0, got ${segment.bpm}`);
    }
    if (index > 0 && segment.startPpq <= segments[index - 1].startPpq) {
      throw new RangeError('Tempo segments must have strictly ascending startPpq');
    }
  });
  execute(1, () => {
    project.setTempoSegments(
      segments.map((s) => ({ startPpq: s.startPpq, bpm: s.bpm, endBpm: s.endBpm ?? 0 })),
    );
    store.refresh();
  });
}

/**
 * Replaces the project's time-signature map as one undoable edit (delegates
 * to Project.setTimeSignatures).
 *
 * @param segments Non-empty meter segments sorted by ascending startPpq.
 */
export function setTimeSignatures(segments: ReadonlyArray<TimeSignatureSegment>): void {
  const store = useProjectStore();
  const project = getProject();
  if (segments.length === 0) {
    throw new RangeError('Time-signature map must contain at least one segment');
  }
  segments.forEach((segment, index) => {
    validatePpq(segment.startPpq, 'Time-signature startPpq');
    if (!Number.isInteger(segment.numerator) || segment.numerator < 1) {
      throw new RangeError('Time-signature numerator must be a positive integer');
    }
    if (!Number.isInteger(segment.denominator) || segment.denominator < 1) {
      throw new RangeError('Time-signature denominator must be a positive integer');
    }
    if (index > 0 && segment.startPpq <= segments[index - 1].startPpq) {
      throw new RangeError('Time-signature segments must have strictly ascending startPpq');
    }
  });
  execute(1, () => {
    project.setTimeSignatures(segments.map((s) => ({ ...s })));
    store.refresh();
  });
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

/**
 * Undoes the most recent command: replays the matching number of
 * Project.undo() calls (authoritative for Project-owned state) and restores
 * the app-level mirror snapshot so editor ids, app metadata and the active
 * track/clip stay stable.
 *
 * @returns True when an edit was undone, false when the history was empty.
 */
export function undo(): boolean {
  const entry = undoStack.pop();
  if (!entry) return false;
  const store = useProjectStore();
  const project = getProject();
  redoStack.push(entry);
  for (let i = 0; i < entry.projectEdits; i++) project.undo();
  restoreSnapshot(store, entry.before);
  return true;
}

/**
 * Redoes the most recently undone command by replaying Project.redo() and
 * restoring the matching app-level mirror snapshot.
 *
 * @returns True when an edit was redone, false when nothing was undone.
 */
export function redo(): boolean {
  const entry = redoStack.pop();
  if (!entry) return false;
  const store = useProjectStore();
  const project = getProject();
  undoStack.push(entry);
  for (let i = 0; i < entry.projectEdits; i++) project.redo();
  restoreSnapshot(store, entry.after);
  return true;
}

/** True when at least one edit can be undone. */
export function canUndo(): boolean {
  return undoStack.length > 0;
}

/** True when at least one undone edit can be redone. */
export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Drops all local undo/redo history; call alongside the store's dispose(). */
export function clearHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}
