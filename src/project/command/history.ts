import type { MidiCcBinding } from '@/ui/midi/midi-learn';
import { cloneScoreAnnotations, type ScoreAnnotations } from '../annotations';
import { type AutomationLaneState, cloneAutomationLane } from '../automation';
import { cloneInstrument } from '../instrument';
import { cloneCcLanes } from '../midi-cc';
import { cloneMixerState, cloneStrip, type ProjectMixerState } from '../mixer';
import { getProject, setHistoryResetHook, useProjectStore } from '../store';
import type { EditorClip, EditorMarker, EditorNote, EditorSection, EditorTrack } from '../types';

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
 * track colors/mute/solo/volume/pan/order/instrument/mixer, clip names,
 * markers, sections, automation lanes, the project mixer state and the
 * active track/clip.
 */
interface MirrorSnapshot {
  tracks: EditorTrack[];
  clips: EditorClip[];
  markers: EditorMarker[];
  sections: EditorSection[];
  automationLanes: AutomationLaneState[];
  midiCcBindings: Map<string, MidiCcBinding>;
  mixer: ProjectMixerState;
  scoreAnnotations: ScoreAnnotations;
  displayTransposeSemitones: number;
  activeTrackId: number;
  activeClipId: number;
}

/** Deep-copies the MIDI-learn binding map into a detached plain map. */
function cloneMidiCcBindings(
  bindings: ReadonlyMap<string, MidiCcBinding>,
): Map<string, MidiCcBinding> {
  const next = new Map<string, MidiCcBinding>();
  for (const [id, binding] of bindings) next.set(id, { ...binding });
  return next;
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
export function cloneNotes(notes: ReadonlyArray<EditorNote>): EditorNote[] {
  return notes.map((note) => ({ ...note }));
}

/** Deep-copies a track mirror entry (instrument/mixer are nested objects). */
function cloneTrack(track: EditorTrack): EditorTrack {
  const next: EditorTrack = { ...track };
  if (track.instrument !== undefined) next.instrument = cloneInstrument(track.instrument);
  if (track.mixer !== undefined) next.mixer = cloneStrip(track.mixer);
  return next;
}

/** Deep-copies a clip mirror entry. */
function cloneClip(clip: EditorClip): EditorClip {
  const next: EditorClip = { ...clip, notes: cloneNotes(clip.notes) };
  if (clip.takes !== undefined) next.takes = clip.takes.map((take) => ({ ...take }));
  if (clip.compSegments !== undefined) {
    next.compSegments = clip.compSegments.map((segment) => ({ ...segment }));
  }
  if (clip.warp !== undefined) {
    next.warp = {
      ...clip.warp,
      ...(clip.warp.anchors !== undefined
        ? { anchors: clip.warp.anchors.map((anchor) => ({ ...anchor })) }
        : {}),
    };
  }
  const ccLanes = cloneCcLanes(clip.ccLanes);
  if (ccLanes !== undefined) next.ccLanes = ccLanes;
  else delete next.ccLanes;
  if (clip.pitchBendLanes !== undefined && clip.pitchBendLanes.length > 0) {
    next.pitchBendLanes = clip.pitchBendLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  } else {
    delete next.pitchBendLanes;
  }
  if (clip.channelPressureLanes !== undefined && clip.channelPressureLanes.length > 0) {
    next.channelPressureLanes = clip.channelPressureLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  } else {
    delete next.channelPressureLanes;
  }
  if (clip.polyPressureLanes !== undefined && clip.polyPressureLanes.length > 0) {
    next.polyPressureLanes = clip.polyPressureLanes.map((lane) => ({
      channel: lane.channel,
      pitch: lane.pitch,
      points: lane.points.map((point) => ({ ...point })),
    }));
  } else {
    delete next.polyPressureLanes;
  }
  return next;
}

/** Captures the current mirror state for undo/redo restoration. */
function captureSnapshot(store: ReturnType<typeof useProjectStore>): MirrorSnapshot {
  return {
    tracks: store.tracks.map(cloneTrack),
    clips: store.clips.map(cloneClip),
    markers: store.markers.map((marker) => ({ ...marker })),
    sections: store.sections.map((section) => ({ ...section })),
    automationLanes: store.automationLanes.map(cloneAutomationLane),
    midiCcBindings: cloneMidiCcBindings(store.midiCcBindings),
    mixer: cloneMixerState(store.mixer),
    scoreAnnotations: cloneScoreAnnotations(store.scoreAnnotations),
    displayTransposeSemitones: store.displayTransposeSemitones,
    activeTrackId: store.activeTrackId,
    activeClipId: store.clipId,
  };
}

/**
 * Resolves which active track/clip the view should show after an undo/redo.
 *
 * Editor navigation between commands (setActiveClip/setActiveTrack) is not
 * recorded in history, so undoing an unrelated command must not yank the view
 * back to wherever it happened to be when that command ran. The view therefore
 * stays put unless the command being undone/redone *itself* moved the active
 * track/clip (e.g. delete/create), in which case the target snapshot's value is
 * restored.
 *
 * @param store The project store (read for the current live view).
 * @param before The undone command's pre-state snapshot.
 * @param after The undone command's post-state snapshot.
 * @param target The snapshot being restored (before for undo, after for redo).
 * @returns The active track/clip ids the view should adopt.
 */
function resolveView(
  store: ReturnType<typeof useProjectStore>,
  before: MirrorSnapshot,
  after: MirrorSnapshot,
  target: MirrorSnapshot,
): { activeTrackId: number; activeClipId: number } {
  return {
    activeTrackId:
      before.activeTrackId === after.activeTrackId ? store.activeTrackId : target.activeTrackId,
    activeClipId: before.activeClipId === after.activeClipId ? store.clipId : target.activeClipId,
  };
}

/**
 * Restores app-level mirror state from a snapshot and refreshes from the
 * Project, using the snapshot's per-clip notes as id hints. Call after the
 * matching Project.undo()/redo() calls so structural state parses back.
 *
 * @param store The project store to restore into.
 * @param snapshot The snapshot to restore (before for undo, after for redo).
 * @param view The active track/clip the view should adopt (see resolveView);
 *   a target that no longer exists falls back to the snapshot's own ids.
 */
function restoreSnapshot(
  store: ReturnType<typeof useProjectStore>,
  snapshot: MirrorSnapshot,
  view: { activeTrackId: number; activeClipId: number },
): void {
  store.tracks = snapshot.tracks.map(cloneTrack);
  store.clips = snapshot.clips.map(cloneClip);
  store.markers = snapshot.markers.map((marker) => ({ ...marker }));
  store.sections = snapshot.sections.map((section) => ({ ...section }));
  store.automationLanes = snapshot.automationLanes.map(cloneAutomationLane);
  // The binding map's identity is shared with the MIDI-learn composable, so
  // restore its contents in place rather than replacing the map.
  store.midiCcBindings.clear();
  for (const [id, binding] of snapshot.midiCcBindings) {
    store.midiCcBindings.set(id, { ...binding });
  }
  store.mixer = cloneMixerState(snapshot.mixer);
  store.scoreAnnotations = cloneScoreAnnotations(snapshot.scoreAnnotations);
  store.displayTransposeSemitones = snapshot.displayTransposeSemitones;
  // Keep the requested view when it still exists; otherwise fall back to the
  // snapshot's own (always-consistent) active ids.
  const trackExists = store.tracks.some((track) => track.id === view.activeTrackId);
  const clipExists = store.clips.some((clip) => clip.id === view.activeClipId);
  store.activeTrackId = trackExists ? view.activeTrackId : snapshot.activeTrackId;
  store.clipId = clipExists ? view.activeClipId : snapshot.activeClipId;
  const hints = new Map(snapshot.clips.map((clip) => [clip.id, clip.notes]));
  store.refresh(hints);
}

/** Pushes a finished history entry, trimming overflow and dropping redo. */
function pushHistory(entry: HistoryEntry): void {
  undoStack.push(entry);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

/**
 * A continuous-drag gesture in flight: non-commit edits update the mirror
 * but defer their history entry; the entry's `before` snapshot is the state
 * captured when the gesture started.
 */
interface PendingGesture {
  key: string;
  before: MirrorSnapshot;
}

let pendingGesture: PendingGesture | null = null;

/** True when an uncommitted gesture with this key is in flight. */
export function hasPendingGesture(key: string): boolean {
  return pendingGesture !== null && pendingGesture.key === key;
}

/**
 * Closes any uncommitted gesture into one history entry. Called before every
 * unrelated command and before undo/redo, so a drag interrupted by another
 * edit still undoes as a single step.
 */
function flushPendingGesture(): void {
  if (!pendingGesture) return;
  const store = useProjectStore();
  const before = pendingGesture.before;
  pendingGesture = null;
  pushHistory({ projectEdits: 0, before, after: captureSnapshot(store) });
}

/**
 * Runs a mutating command as one undoable history entry.
 *
 * The action performs the Project calls and mirror updates (including the
 * final store.refresh). `projectEdits` must equal the number of Project
 * history entries the action produced.
 */
export function execute<T>(projectEdits: number, action: () => T): T {
  flushPendingGesture();
  const store = useProjectStore();
  const before = captureSnapshot(store);
  const result = action();
  const after = captureSnapshot(store);
  pushHistory({ projectEdits, before, after });
  return result;
}

/** Options shared by commands that support continuous-drag coalescing. */
export interface CommandGestureOptions {
  /**
   * Pass false while a drag is in flight: the edit is applied to the mirror
   * immediately but merged into one pending history entry. The final call of
   * the gesture (commit omitted or true) closes the entry, so the whole drag
   * undoes in a single step. Interleaving any other command (or undo/redo)
   * also closes the pending entry.
   */
  commit?: boolean;
}

/**
 * Runs an app-metadata-only command (no wasm Project edits) with optional
 * gesture coalescing: same-key non-commit calls share one history entry whose
 * `before` snapshot is the gesture start.
 */
export function executeApp<T>(action: () => T, gesture?: { key: string; commit: boolean }): T {
  const store = useProjectStore();
  if (gesture && !gesture.commit) {
    if (pendingGesture && pendingGesture.key !== gesture.key) flushPendingGesture();
    if (!pendingGesture) pendingGesture = { key: gesture.key, before: captureSnapshot(store) };
    // The mirror diverges from the last committed entry, so redo is stale.
    redoStack.length = 0;
    return action();
  }
  if (gesture && pendingGesture && pendingGesture.key === gesture.key) {
    const before = pendingGesture.before;
    pendingGesture = null;
    const result = action();
    pushHistory({ projectEdits: 0, before, after: captureSnapshot(store) });
    return result;
  }
  return execute(0, action);
}

/**
 * Undoes the most recent command: replays the matching number of
 * Project.undo() calls (authoritative for Project-owned state) and restores
 * the app-level mirror snapshot so editor ids, app metadata and the active
 * track/clip stay stable.
 *
 * @returns True when an edit was undone, false when the history was empty.
 */
export function undo(): boolean {
  flushPendingGesture();
  const entry = undoStack.pop();
  if (!entry) return false;
  const store = useProjectStore();
  const project = getProject();
  redoStack.push(entry);
  const view = resolveView(store, entry.before, entry.after, entry.before);
  for (let i = 0; i < entry.projectEdits; i++) project.undo();
  restoreSnapshot(store, entry.before, view);
  return true;
}

/**
 * Redoes the most recently undone command by replaying Project.redo() and
 * restoring the matching app-level mirror snapshot.
 *
 * @returns True when an edit was redone, false when nothing was undone.
 */
export function redo(): boolean {
  flushPendingGesture();
  const entry = redoStack.pop();
  if (!entry) return false;
  const store = useProjectStore();
  const project = getProject();
  undoStack.push(entry);
  const view = resolveView(store, entry.before, entry.after, entry.after);
  for (let i = 0; i < entry.projectEdits; i++) project.redo();
  restoreSnapshot(store, entry.after, view);
  return true;
}

/** True when at least one edit can be undone. */
export function canUndo(): boolean {
  return undoStack.length > 0 || pendingGesture !== null;
}

/** True when at least one undone edit can be redone. */
export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Drops all local undo/redo history; call alongside the store's dispose(). */
export function clearHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  pendingGesture = null;
}

// Let the store drop history as part of dispose() so the two never drift.
setHistoryResetHook(clearHistory);
