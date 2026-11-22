import { type Ref, ref, shallowReactive, shallowRef } from 'vue';
import { MEBIBYTE } from '@/lib/bytes';
import { cloneScoreAnnotations, type ScoreAnnotations } from '../annotations';
import { type AutomationLaneState, cloneAutomationLane } from '../automation';
import type { EditorChordSymbol } from '../chords';
import { cloneInstrument, type ExternalMidiInstrument } from '../instrument';
import { assignMidiLaneFields, cloneMidiLaneFields } from '../midi-lane-kinds';
import type { MidiCcBinding } from '../midi-learn-targets';
import { cloneMixerState, cloneStrip, type ProjectMixerState } from '../mixer';
import { getProject, PROJECT_MAX_UNDO_DEPTH, setHistoryResetHook, useProjectStore } from '../store';
import type {
  EditorClip,
  EditorMarker,
  EditorNote,
  EditorSection,
  EditorTrack,
  TimeSignatureSegment,
} from '../types';

/**
 * Maximum number of edits kept in the local history. When it overflows, the
 * oldest entry is dropped and undo stops there even though the Project
 * history may reach further back.
 */
const MAX_HISTORY = 100;

/** Default memory budget for detached mirror snapshots (64 MiB). */
export const DEFAULT_HISTORY_BYTE_BUDGET = 64 * MEBIBYTE;

let historyByteBudget = DEFAULT_HISTORY_BYTE_BUDGET;
let historyBytes = 0;
/** Sum of native Project history entries represented by local history. */
let historyProjectEdits = 0;

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
  projectExternalMidi: ExternalMidiInstrument | null;
  mixer: ProjectMixerState;
  scoreAnnotations: ScoreAnnotations;
  /** App-only additive grouping metadata for the WASM-owned meter map. */
  timeSignatures: TimeSignatureSegment[];
  /** Chord track, for the omitted tones the annotation encoding cannot carry. */
  chords: EditorChordSymbol[];
  displayTransposeSemitones: number;
  activeTrackId: number;
  activeClipId: number;
  selection: number[];
  /** State owned outside Pinia but participating in command undo/redo. */
  contributedState: Map<string, unknown>;
}

interface HistoryStateContributor<T> {
  capture(): T;
  restore(state: T): void;
}

// This registry can be populated while `history.ts` is still evaluating:
// store -> serialization -> mixer snapshots imports this module and registers
// its state contributor. Keep the binding hoisted and initialize lazily so the
// registration path is safe across that module cycle.
// biome-ignore lint/suspicious/noVar: this module-cycle boundary requires a hoisted binding.
var historyStateContributors: Map<string, HistoryStateContributor<unknown>> | undefined;

function registeredHistoryStateContributors(): Map<string, HistoryStateContributor<unknown>> {
  historyStateContributors ??= new Map<string, HistoryStateContributor<unknown>>();
  return historyStateContributors;
}

/** Registers non-store persisted state that must follow command undo/redo. */
export function registerHistoryStateContributor<T>(
  id: string,
  contributor: HistoryStateContributor<T>,
): void {
  registeredHistoryStateContributors().set(id, contributor as HistoryStateContributor<unknown>);
}

/** Mirror state a post-edit reconciler compares across one command. */
export interface PostEditSnapshot {
  readonly tracks: ReadonlyArray<EditorTrack>;
  readonly clips: ReadonlyArray<EditorClip>;
  readonly chords: ReadonlyArray<EditorChordSymbol>;
  readonly timeSignatures: ReadonlyArray<TimeSignatureSegment>;
}

/** What a post-edit reconciler sees once a forward command's action has succeeded. */
export interface PostEditContext {
  /** Mirror before the command. */
  before: PostEditSnapshot;
  /** Mirror after the action; entries equal to `before` share its objects. */
  after: PostEditSnapshot;
  store: ReturnType<typeof useProjectStore>;
  /** Project edits already counted in this history entry. */
  projectEdits: number;
}

/**
 * Brings dependent state in line with a forward edit inside the same history
 * entry. Returns the Project edits it applied, or undefined when it left the
 * mirror untouched; it must undo its own Project edits before failing.
 */
export type PostEditReconciler = (context: PostEditContext) => number | undefined;

// Same module-cycle constraint as the state contributors above.
// biome-ignore lint/suspicious/noVar: this module-cycle boundary requires a hoisted binding.
var postEditReconcilers: Map<string, PostEditReconciler> | undefined;
let reconciling = false;

/**
 * Registers a reconciler run by {@link execute} and {@link executeAtomic}
 * after the action succeeds and before the entry is pushed. Undo, redo and
 * commands issued from inside a reconciler do not run reconcilers.
 */
export function registerPostEditReconciler(id: string, reconciler: PostEditReconciler): void {
  postEditReconcilers ??= new Map<string, PostEditReconciler>();
  postEditReconcilers.set(id, reconciler);
}

/** Runs the registered reconcilers; `changed` is false when none touched the mirror. */
function reconcileAfterEdit(
  store: ReturnType<typeof useProjectStore>,
  before: PostEditSnapshot,
  after: PostEditSnapshot,
  projectEdits: number,
): { projectEdits: number; changed: boolean } {
  if (reconciling || postEditReconcilers === undefined) return { projectEdits: 0, changed: false };
  let added = 0;
  let changed = false;
  reconciling = true;
  try {
    for (const reconciler of postEditReconcilers.values()) {
      const applied = reconciler({ before, after, store, projectEdits: projectEdits + added });
      if (applied === undefined) continue;
      changed = true;
      added += applied;
    }
  } finally {
    reconciling = false;
  }
  return { projectEdits: added, changed };
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
  /** Conservative retained-size estimate, counting shared objects once per entry. */
  byteSize: number;
}

export interface HistoryReferencedMediaIds {
  assetIds: Set<string>;
  fontIds: Set<string>;
}

// The containers must notify shell computed values when entries are pushed,
// popped or cleared. Keep them shallow so detached entries and their large
// snapshots remain plain objects with their existing identity.
const undoStack = shallowReactive<HistoryEntry[]>([]);
const redoStack = shallowReactive<HistoryEntry[]>([]);
let lastSnapshot: MirrorSnapshot | null = null;

const editRevisionCounter = ref(0);

/**
 * Monotonic count of committed document changes (execute, atomic execute,
 * app-level commands, gesture steps, undo and redo). Watch it instead of
 * deep-watching the mirror to learn that the document changed.
 */
export const editRevision: Readonly<Ref<number>> = editRevisionCounter;

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = Object.keys(aRecord);
  if (keys.length !== Object.keys(bRecord).length) return false;
  return keys.every((key) => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
}

function shareArrayByKey<T>(
  previous: ReadonlyArray<T> | undefined,
  next: T[],
  keyOf: (value: T) => string | number,
): T[] {
  if (!previous || previous.length === 0 || next.length === 0) return next;
  const previousByKey = new Map(previous.map((value) => [keyOf(value), value]));
  let allShared = previous.length === next.length;
  const shared = next.map((value, index) => {
    const candidate = previousByKey.get(keyOf(value));
    const resolved = candidate !== undefined && deepEqual(candidate, value) ? candidate : value;
    if (resolved !== previous[index]) allShared = false;
    return resolved;
  });
  return allShared ? (previous as T[]) : shared;
}

function shareClip(previous: EditorClip | undefined, next: EditorClip): EditorClip {
  if (!previous) return next;
  if (deepEqual(previous, next)) return previous;
  next.notes = shareArrayByKey(previous.notes, next.notes, (note) => note.id);
  if (previous.takes && next.takes && deepEqual(previous.takes, next.takes)) {
    next.takes = previous.takes;
  }
  if (
    previous.compSegments &&
    next.compSegments &&
    deepEqual(previous.compSegments, next.compSegments)
  ) {
    next.compSegments = previous.compSegments;
  }
  if (previous.warp && next.warp && deepEqual(previous.warp, next.warp)) next.warp = previous.warp;
  for (const key of [
    'ccLanes',
    'pitchBendLanes',
    'programChangeLanes',
    'channelPressureLanes',
    'polyPressureLanes',
  ] as const) {
    if (deepEqual(previous[key], next[key])) next[key] = previous[key] as never;
  }
  return next;
}

function shareSnapshot(previous: MirrorSnapshot | null, next: MirrorSnapshot): MirrorSnapshot {
  if (!previous) return next;
  next.tracks = shareArrayByKey(previous.tracks, next.tracks, (track) => track.id);
  const previousClips = new Map(previous.clips.map((clip) => [clip.id, clip]));
  next.clips = next.clips.map((clip) => shareClip(previousClips.get(clip.id), clip));
  if (
    previous.clips.length === next.clips.length &&
    next.clips.every((clip, index) => clip === previous.clips[index])
  ) {
    next.clips = previous.clips;
  }
  next.markers = shareArrayByKey(previous.markers, next.markers, (marker) => marker.id);
  next.sections = shareArrayByKey(previous.sections, next.sections, (section) => section.id);
  next.automationLanes = shareArrayByKey(
    previous.automationLanes,
    next.automationLanes,
    (lane) => `${lane.target}|${lane.param}`,
  );
  if (deepEqual(previous.timeSignatures, next.timeSignatures)) {
    next.timeSignatures = previous.timeSignatures;
  }
  if (deepEqual(previous.chords, next.chords)) next.chords = previous.chords;
  for (const key of [
    'midiCcBindings',
    'projectExternalMidi',
    'mixer',
    'scoreAnnotations',
    'selection',
    'contributedState',
  ] as const) {
    if (deepEqual(previous[key], next[key])) next[key] = previous[key] as never;
  }
  return next;
}

function estimateRetainedBytes(value: unknown, seen: WeakSet<object>): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return 16 + value.length * 2;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 4;
  if (typeof value !== 'object') return 16;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return 32 + value.byteLength;
  if (value instanceof ArrayBuffer) return 32 + value.byteLength;
  if (Array.isArray(value)) {
    return (
      24 +
      value.length * 8 +
      value.reduce((sum, item) => sum + estimateRetainedBytes(item, seen), 0)
    );
  }
  if (value instanceof Map) {
    let bytes = 48 + value.size * 24;
    for (const [key, item] of value) {
      bytes += estimateRetainedBytes(key, seen) + estimateRetainedBytes(item, seen);
    }
    return bytes;
  }
  let bytes = 48;
  for (const [key, item] of Object.entries(value)) {
    bytes += 16 + key.length * 2 + estimateRetainedBytes(item, seen);
  }
  return bytes;
}

function historyEntry(
  before: MirrorSnapshot,
  after: MirrorSnapshot,
  projectEdits: number,
): HistoryEntry {
  const seen = new WeakSet<object>();
  return {
    projectEdits,
    before,
    after,
    byteSize: estimateRetainedBytes(before, seen) + estimateRetainedBytes(after, seen),
  };
}

function dropUnreachableSnapshotMemo(): void {
  if (
    lastSnapshot !== null &&
    ![...undoStack, ...redoStack].some(
      (entry) => entry.before === lastSnapshot || entry.after === lastSnapshot,
    )
  ) {
    lastSnapshot = null;
  }
}

/** Deep-copies a note list into plain objects (detached from reactivity). */
export function cloneNotes(notes: ReadonlyArray<EditorNote>): EditorNote[] {
  return notes.map((note) => ({ ...note }));
}

/** Deep-copies a track mirror entry (instrument/mixer are nested objects). */
function cloneTrack(track: EditorTrack): EditorTrack {
  const next: EditorTrack = { ...track };
  if (track.instrument !== undefined) next.instrument = cloneInstrument(track.instrument);
  if (track.mixer !== undefined) next.mixer = cloneStrip(track.mixer);
  if (track.leadFollow !== undefined) {
    next.leadFollow = {
      leadTrackId: track.leadFollow.leadTrackId,
      stash: track.leadFollow.stash.map((entry) => ({
        clipId: entry.clipId,
        note: { ...entry.note },
      })),
    };
  }
  return next;
}

/** Deep-copies a clip mirror entry. */
function cloneClip(clip: EditorClip): EditorClip {
  const next: EditorClip = { ...clip, notes: cloneNotes(clip.notes) };
  if (clip.takes !== undefined) next.takes = clip.takes.map((take) => ({ ...take }));
  if (clip.compSegments !== undefined) {
    next.compSegments = clip.compSegments.map((segment) => ({ ...segment }));
  }
  if (clip.midiTakes !== undefined) {
    next.midiTakes = clip.midiTakes.map((take) => ({
      name: take.name,
      notes: take.notes.map((note) => ({ ...note })),
      ...cloneMidiLaneFields(take),
    }));
  }
  if (clip.midiCompSegments !== undefined) {
    next.midiCompSegments = clip.midiCompSegments.map((segment) => ({ ...segment }));
  }
  if (clip.warp !== undefined) {
    next.warp = {
      ...clip.warp,
      ...(clip.warp.anchors !== undefined
        ? { anchors: clip.warp.anchors.map((anchor) => ({ ...anchor })) }
        : {}),
    };
  }
  assignMidiLaneFields(next, cloneMidiLaneFields(clip));
  if (clip.smfSysEx !== undefined && clip.smfSysEx.length > 0) {
    next.smfSysEx = clip.smfSysEx.map((packet) => ({ ...packet, data: [...packet.data] }));
  } else {
    delete next.smfSysEx;
  }
  return next;
}

/** Captures the current mirror state for undo/redo restoration. */
function captureSnapshot(
  store: ReturnType<typeof useProjectStore>,
  previous: MirrorSnapshot | null = lastSnapshot,
): MirrorSnapshot {
  const contributedState = new Map<string, unknown>();
  for (const [id, contributor] of registeredHistoryStateContributors()) {
    contributedState.set(id, contributor.capture());
  }
  return shareSnapshot(previous, {
    tracks: store.tracks.map(cloneTrack),
    clips: store.clips.map(cloneClip),
    markers: store.markers.map((marker) => ({ ...marker })),
    sections: store.sections.map((section) => ({ ...section })),
    automationLanes: store.automationLanes.map(cloneAutomationLane),
    midiCcBindings: cloneMidiCcBindings(store.midiCcBindings),
    projectExternalMidi:
      store.projectExternalMidi === null
        ? null
        : (cloneInstrument(store.projectExternalMidi) as ExternalMidiInstrument),
    mixer: cloneMixerState(store.mixer),
    scoreAnnotations: cloneScoreAnnotations(store.scoreAnnotations),
    timeSignatures: store.timeSignatures.map((segment) => ({
      ...segment,
      ...(segment.grouping !== undefined ? { grouping: [...segment.grouping] } : {}),
    })),
    chords: store.chords.map((chord) => ({
      ...chord,
      ...(chord.extensions !== undefined ? { extensions: [...chord.extensions] } : {}),
      ...(chord.omissions !== undefined ? { omissions: [...chord.omissions] } : {}),
    })),
    displayTransposeSemitones: store.displayTransposeSemitones,
    activeTrackId: store.activeTrackId,
    activeClipId: store.clipId,
    selection: [...store.selection],
    contributedState,
  });
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
  store.projectExternalMidi =
    snapshot.projectExternalMidi === null
      ? null
      : (cloneInstrument(snapshot.projectExternalMidi) as ExternalMidiInstrument);
  store.mixer = cloneMixerState(snapshot.mixer);
  store.scoreAnnotations = cloneScoreAnnotations(snapshot.scoreAnnotations);
  // The Project keeps numerator/denominator but not app-level additive beat
  // groups. Seed its read-back with the snapshot so refresh can retain them.
  store.timeSignatures = snapshot.timeSignatures.map((segment) => ({
    ...segment,
    ...(segment.grouping !== undefined ? { grouping: [...segment.grouping] } : {}),
  }));
  store.displayTransposeSemitones = snapshot.displayTransposeSemitones;
  for (const [id, state] of snapshot.contributedState) {
    registeredHistoryStateContributors().get(id)?.restore(state);
  }
  // Keep the requested view when it still exists; otherwise fall back to the
  // snapshot's own (always-consistent) active ids.
  const trackExists = store.tracks.some((track) => track.id === view.activeTrackId);
  const clipExists = store.clips.some((clip) => clip.id === view.activeClipId);
  store.activeTrackId = trackExists ? view.activeTrackId : snapshot.activeTrackId;
  store.clipId = clipExists ? view.activeClipId : snapshot.activeClipId;
  const hints = new Map(snapshot.clips.map((clip) => [clip.id, clip.notes]));
  // Same reasoning as the meter groups above: the Project keeps a chord's
  // quality but not the intrinsic tones the symbol declares silent, so the
  // chord read-back is seeded from the snapshot rather than from the mirror the
  // undo is leaving behind.
  store.refresh(hints, snapshot.chords);
  const alive = new Set(store.notes.map((note) => note.id));
  store.selection = new Set(snapshot.selection.filter((id) => alive.has(id)));
}

function foldSnapshotMediaIds(snapshot: MirrorSnapshot, refs: HistoryReferencedMediaIds): void {
  for (const track of snapshot.tracks) {
    if (track.frozen?.assetId) refs.assetIds.add(track.frozen.assetId);
    if (track.instrument?.kind === 'sf2' && track.instrument.fontId) {
      refs.fontIds.add(track.instrument.fontId);
    }
  }
  for (const clip of snapshot.clips) {
    if (clip.assetId) refs.assetIds.add(clip.assetId);
    for (const take of clip.takes ?? []) {
      if (take.assetId) refs.assetIds.add(take.assetId);
    }
  }
}

/**
 * Returns media ids still reachable from undo/redo history. Save-time GC must
 * preserve these because the live document can legitimately drop an asset
 * (unfreeze/delete) and later restore it through undo.
 */
export function collectHistoryReferencedMediaIds(): HistoryReferencedMediaIds {
  const refs: HistoryReferencedMediaIds = { assetIds: new Set(), fontIds: new Set() };
  for (const entry of [...undoStack, ...redoStack]) {
    foldSnapshotMediaIds(entry.before, refs);
    foldSnapshotMediaIds(entry.after, refs);
  }
  if (pendingGesture.value) foldSnapshotMediaIds(pendingGesture.value.before, refs);
  return refs;
}

/** Pushes a finished history entry, trimming overflow and dropping redo. */
function clearRedoStack(): void {
  for (const redo of redoStack) {
    historyBytes -= redo.byteSize;
    historyProjectEdits -= redo.projectEdits;
  }
  redoStack.length = 0;
  historyBytes = Math.max(0, historyBytes);
  historyProjectEdits = Math.max(0, historyProjectEdits);
}

function pushHistory(entry: HistoryEntry): void {
  validateProjectEditCount(entry.projectEdits);
  editRevisionCounter.value += 1;
  clearRedoStack();
  undoStack.push(entry);
  historyBytes += entry.byteSize;
  historyProjectEdits += entry.projectEdits;
  lastSnapshot = entry.after;
  while (
    undoStack.length > 1 &&
    (undoStack.length > MAX_HISTORY ||
      historyBytes > historyByteBudget ||
      historyProjectEdits > PROJECT_MAX_UNDO_DEPTH)
  ) {
    const removed = undoStack.shift();
    if (!removed) break;
    historyBytes -= removed.byteSize;
    historyProjectEdits -= removed.projectEdits;
  }
  historyBytes = Math.max(0, historyBytes);
  historyProjectEdits = Math.max(0, historyProjectEdits);
  dropUnreachableSnapshotMemo();
}

function validateProjectEditCount(projectEdits: number): void {
  if (!Number.isInteger(projectEdits) || projectEdits < 0) {
    throw new RangeError(`Project edit count must be a non-negative integer`);
  }
  if (projectEdits > PROJECT_MAX_UNDO_DEPTH) {
    throw new RangeError(
      `Project edit count ${projectEdits} exceeds native undo depth ${PROJECT_MAX_UNDO_DEPTH}`,
    );
  }
}

/** Runtime statistics for diagnostics and memory-pressure tests. */
export function historyBudgetStats(): {
  undoEntries: number;
  redoEntries: number;
  bytes: number;
  accountedBytes: number;
  budgetBytes: number;
  projectEdits: number;
  projectEditBudget: number;
} {
  return {
    undoEntries: undoStack.length,
    redoEntries: redoStack.length,
    bytes: historyBytes,
    accountedBytes: [...undoStack, ...redoStack].reduce(
      (total, entry) => total + entry.byteSize,
      0,
    ),
    budgetBytes: historyByteBudget,
    projectEdits: historyProjectEdits,
    projectEditBudget: PROJECT_MAX_UNDO_DEPTH,
  };
}

/**
 * Changes the snapshot byte budget and immediately evicts oldest entries.
 * The newest reachable undo entry is never evicted solely for exceeding a
 * byte budget: a successful edit must remain undoable even when its detached
 * mirror snapshot is larger than the configured budget by itself.
 */
export function configureHistoryByteBudget(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`History byte budget must be finite and >= 0, got ${bytes}`);
  }
  historyByteBudget = Math.floor(bytes);
  while (historyBytes > historyByteBudget) {
    const removed = undoStack.length > 1 ? undoStack.shift() : redoStack.shift();
    if (!removed) break;
    historyBytes -= removed.byteSize;
    historyProjectEdits -= removed.projectEdits;
  }
  historyBytes = Math.max(0, historyBytes);
  historyProjectEdits = Math.max(0, historyProjectEdits);
  dropUnreachableSnapshotMemo();
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

const pendingGesture = shallowRef<PendingGesture | null>(null);

/** Key that overrides every gesture key while a group scope is active. */
let activeGestureGroup: string | null = null;

/**
 * Runs `action` with every gesture command inside it sharing one pending
 * gesture under `groupKey`, so several targets moved by one controller stream
 * coalesce into a single history entry instead of flushing each other.
 */
export function withGestureGroup<T>(groupKey: string, action: () => T): T {
  const previous = activeGestureGroup;
  activeGestureGroup = groupKey;
  try {
    return action();
  } finally {
    activeGestureGroup = previous;
  }
}

/** True when an uncommitted gesture with this key (or the active group) is in flight. */
export function hasPendingGesture(key: string): boolean {
  const pending = pendingGesture.value;
  return pending !== null && (pending.key === key || pending.key === activeGestureGroup);
}

/**
 * Closes any uncommitted gesture into one history entry. Called before every
 * unrelated command and before undo/redo, so a drag interrupted by another
 * edit still undoes as a single step.
 */
function flushPendingGesture(): void {
  if (!pendingGesture.value) return;
  const store = useProjectStore();
  const before = pendingGesture.value.before;
  pendingGesture.value = null;
  pushHistory(historyEntry(before, captureSnapshot(store, before), 0));
}

/**
 * Runs a mutating command as one undoable history entry.
 *
 * The action performs the Project calls and mirror updates (including the
 * final store.refresh). `projectEdits` must equal the number of Project
 * history entries the action produced.
 */
export function execute<T>(projectEdits: number, action: () => T): T {
  validateProjectEditCount(projectEdits);
  flushPendingGesture();
  const store = useProjectStore();
  const before = captureSnapshot(store);
  const result = action();
  let after = captureSnapshot(store, before);
  const reconciled = reconcileAfterEdit(store, before, after, projectEdits);
  if (reconciled.changed) after = captureSnapshot(store, before);
  pushHistory(historyEntry(before, after, projectEdits + reconciled.projectEdits));
  return result;
}

export type AtomicProjectEdit = <T>(projectEdits: number, mutation: () => T) => T;

/**
 * Runs a multi-call Project command with failure rollback. Each successful
 * native mutation is reported through `edit`; if a later mutation or mirror
 * update throws, exactly those entries are undone and the pre-command mirror
 * is restored. On success all calls become one local undo entry.
 */
export function executeAtomic<T>(action: (edit: AtomicProjectEdit) => T): T {
  flushPendingGesture();
  const store = useProjectStore();
  const project = getProject();
  const before = captureSnapshot(store);
  let completedProjectEdits = 0;
  const edit: AtomicProjectEdit = (projectEdits, mutation) => {
    validateProjectEditCount(projectEdits);
    if (completedProjectEdits + projectEdits > PROJECT_MAX_UNDO_DEPTH) {
      throw new RangeError(
        `Atomic project edit count ${completedProjectEdits + projectEdits} exceeds native undo depth ${PROJECT_MAX_UNDO_DEPTH}`,
      );
    }
    const result = mutation();
    completedProjectEdits += projectEdits;
    return result;
  };
  try {
    const result = action(edit);
    let after = captureSnapshot(store, before);
    const reconciled = reconcileAfterEdit(store, before, after, completedProjectEdits);
    completedProjectEdits += reconciled.projectEdits;
    if (reconciled.changed) after = captureSnapshot(store, before);
    pushHistory(historyEntry(before, after, completedProjectEdits));
    return result;
  } catch (error) {
    for (let index = 0; index < completedProjectEdits; index++) project.undo();
    // The partial edits invalidated native redo; keeping the local entries would replay the rolled-back edit.
    if (completedProjectEdits > 0) clearRedoStack();
    restoreSnapshot(store, before, {
      activeTrackId: before.activeTrackId,
      activeClipId: before.activeClipId,
    });
    throw error;
  }
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
export function executeApp<T>(action: () => T, ownGesture?: { key: string; commit: boolean }): T {
  const store = useProjectStore();
  const gesture =
    ownGesture && activeGestureGroup !== null
      ? { key: activeGestureGroup, commit: ownGesture.commit }
      : ownGesture;
  if (gesture && !gesture.commit) {
    if (pendingGesture.value && pendingGesture.value.key !== gesture.key) flushPendingGesture();
    if (!pendingGesture.value) {
      pendingGesture.value = { key: gesture.key, before: captureSnapshot(store) };
    }
    // The mirror diverges from the last committed entry, so redo is stale.
    clearRedoStack();
    editRevisionCounter.value += 1;
    return action();
  }
  if (gesture && pendingGesture.value && pendingGesture.value.key === gesture.key) {
    const before = pendingGesture.value.before;
    pendingGesture.value = null;
    try {
      return action();
    } finally {
      // A refused final value still leaves the gesture's accepted steps to undo.
      pushHistory(historyEntry(before, captureSnapshot(store, before), 0));
    }
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
  lastSnapshot = entry.before;
  const view = resolveView(store, entry.before, entry.after, entry.before);
  for (let i = 0; i < entry.projectEdits; i++) project.undo();
  restoreSnapshot(store, entry.before, view);
  editRevisionCounter.value += 1;
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
  lastSnapshot = entry.after;
  const view = resolveView(store, entry.before, entry.after, entry.after);
  for (let i = 0; i < entry.projectEdits; i++) project.redo();
  restoreSnapshot(store, entry.after, view);
  editRevisionCounter.value += 1;
  return true;
}

/** True when at least one edit can be undone. */
export function canUndo(): boolean {
  return undoStack.length > 0 || pendingGesture.value !== null;
}

/** True when at least one undone edit can be redone. */
export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Drops all local undo/redo history; call alongside the store's dispose(). */
export function clearHistory(): void {
  // Keep the native history aligned with the local stacks. This is also
  // called by store.dispose(), before the Project handle is deleted; the
  // explicit not-initialized guard keeps setup calls harmless.
  try {
    getProject().clearHistory();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('Project store is not initialized;')
    ) {
      throw error;
    }
  }
  undoStack.length = 0;
  redoStack.length = 0;
  pendingGesture.value = null;
  historyBytes = 0;
  historyProjectEdits = 0;
  lastSnapshot = null;
  historyByteBudget = DEFAULT_HISTORY_BYTE_BUDGET;
}

// Let the store drop history as part of dispose() so the two never drift.
setHistoryResetHook(clearHistory);
