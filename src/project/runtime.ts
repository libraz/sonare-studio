/**
 * The wasm Project handle and the process-wide counters that hang off it.
 *
 * These live outside Vue reactivity on purpose: wrapping an embind handle in a
 * reactive proxy would intercept its internal slots and add per-call overhead.
 * They also outlive any one store instance, which is why they sit here rather
 * than inside the store — the store is a read-model mirror of what this module
 * holds, and both the store and the document loader need to reach it without
 * importing each other.
 *
 * Everything that replaces or clears the handle goes through the small API at
 * the bottom, so the points where the open project changes are countable.
 */

import type { Project, ProjectMidiEvent } from '@/wasm/index.js';
import { notesToProjectMidiEvents, type RawNote } from './midi-events';

type WasmModule = typeof import('@/wasm/index.js');

export type { WasmModule };

/** Default clip length: eight 4/4 bars expressed in quarter-note PPQ. */
export const DEFAULT_CLIP_LENGTH_PPQ = 32;

/** Default snap grid: divisions per whole note (16 = sixteenth-note grid). */
export const DEFAULT_SNAP_DIVISION = 16;

/** Default project sample rate used until an AudioContext provides the real one. */
export const DEFAULT_SAMPLE_RATE = 48000;

/** Default name of the track created by init(). */
export const DEFAULT_TRACK_NAME = 'Piano';

/** Default project display name. */
export const DEFAULT_PROJECT_NAME = 'Untitled';

/**
 * Mirrors libsonare's bounded Project history rather than relying on its
 * engine default. The command layer accounts for every native edit represented
 * by local history and evicts whole entries before this limit is exceeded.
 */
export const PROJECT_MAX_UNDO_DEPTH = 512;

/** Keeps malformed persisted numeric fields from reaching the wasm ABI. */
export function finiteAtLeast(value: unknown, minimum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback;
}

let wasmModule: WasmModule | null = null;
let project: Project | null = null;
let nextNoteId = 1;
let nextMarkerId = 1;
let nextSectionId = 1;
// Audio sources are registered on the wasm Project once per asset; this map
// remembers the Project-side source id per asset id for the current Project
// instance (reset whenever the Project is replaced). It is advisory: callers
// must re-validate entries against project.sourceCount() because undo can
// roll source registrations back (see addAudioClip in src/project/commands.ts).
let audioSourceIds = new Map<string, number>();

// Optional hook the command layer registers so disposing the store also drops
// the undo/redo history; without it, history snapshots would dangle against a
// deleted Project. Kept as a hook to avoid a store -> command-layer import.
// `history.ts` can register while this module is still evaluating through a
// command-module import cycle. `var` is deliberately used here so that early
// registration observes `undefined` rather than the temporal dead zone, and
// the later declaration does not overwrite the registered callback.
// biome-ignore lint/suspicious/noVar: this module-cycle boundary requires a hoisted binding.
var historyResetHook: (() => void) | null | undefined;

/**
 * Registers a callback invoked when the store is disposed, to clear the
 * command-layer undo/redo history and keep the two in lockstep. Called once by
 * the history module at import time.
 */
export function setHistoryResetHook(hook: (() => void) | null): void {
  historyResetHook = hook;
}

/** Runs the registered history reset, if the command layer registered one. */
export function runHistoryReset(): void {
  historyResetHook?.();
}

/**
 * Returns the live wasm Project handle.
 *
 * @throws Error when the project store has not been initialized yet.
 */
export function getProject(): Project {
  if (!project) throw new Error('Project store is not initialized; call init() first');
  return project;
}

/**
 * Returns the initialized libsonare wasm module.
 *
 * @throws Error when the project store has not been initialized yet.
 */
export function getWasmModule(): WasmModule {
  if (!wasmModule) throw new Error('Project store is not initialized; call init() first');
  return wasmModule;
}

/** Allocates a fresh editor note id (monotonic, never reused in a session). */
export function allocateNoteId(): number {
  return nextNoteId++;
}

/** Allocates a fresh editor marker id (monotonic, never reused in a session). */
export function allocateMarkerId(): number {
  return nextMarkerId++;
}

/** Allocates a fresh editor section id (monotonic, never reused in a session). */
export function allocateSectionId(): number {
  return nextSectionId++;
}

/**
 * Returns the wasm Project source id previously registered for an asset, or
 * undefined. Entries can be stale after undo; validate against
 * project.sourceCount() before reuse.
 */
export function getAudioSourceId(assetId: string): number | undefined {
  return audioSourceIds.get(assetId);
}

/** Records the wasm Project source id registered for an asset. */
export function setAudioSourceId(assetId: string, sourceId: number): void {
  audioSourceIds.set(assetId, sourceId);
}

/**
 * Placeholder inline PCM attached when registering an audio clip source.
 *
 * The binding rejects non-MIDI clips without non-empty audio data, while the
 * app streams the real PCM from the asset store at schedule time
 * (src/project/scheduling.ts) — sources are by-reference via their
 * "asset:<id>" URI. One silent frame keeps the wasm-side copy minimal.
 */
export function placeholderSourceAudio(): {
  audio: Float32Array;
  audioChannels: number;
  audioSampleRate: number;
} {
  return { audio: new Float32Array(1), audioChannels: 1, audioSampleRate: DEFAULT_SAMPLE_RATE };
}

/**
 * Expands editor notes into a sorted flat event list for setMidiEvents.
 * Note-offs sort before note-ons at the same PPQ so a repeated pitch releases
 * before it retriggers.
 *
 * @param notes Notes to expand (editor ids, when present, are ignored).
 * @returns Packed events accepted by Project.setMidiEvents.
 */
export function notesToProjectEvents(notes: ReadonlyArray<RawNote>): ProjectMidiEvent[] {
  return notesToProjectMidiEvents(notes, getWasmModule());
}

// --- Replacing what is open ------------------------------------------------
//
// Loading a document builds a second Project and only adopts it once every
// app-only field has hydrated, so these read and write the handle separately
// rather than as one step.

/** The module handle, or null before the first init. */
export function currentWasmModule(): WasmModule | null {
  return wasmModule;
}

/** Publishes the wasm module, which init resolves before building a Project. */
export function setWasmModule(module: WasmModule): void {
  wasmModule = module;
}

/** The open Project, or null before the first init. */
export function currentProject(): Project | null {
  return project;
}

/** The asset-to-source map of the open Project. */
export function currentAudioSourceIds(): Map<string, number> {
  return audioSourceIds;
}

/** Makes a Project the open one, together with the sources registered on it. */
export function adoptProject(next: Project, sourceIds: Map<string, number>): void {
  project = next;
  audioSourceIds = sourceIds;
}

/** Restores a Project, module and source map captured before a failed load. */
export function restoreProject(
  previous: Project | null,
  module: WasmModule | null,
  sourceIds: Map<string, number>,
): void {
  project = previous;
  wasmModule = module;
  audioSourceIds = sourceIds;
}

/** The id counters, for a caller that must be able to put them back. */
export function idCounters(): { note: number; marker: number; section: number } {
  return { note: nextNoteId, marker: nextMarkerId, section: nextSectionId };
}

/** Rewinds the id counters to a previously captured set. */
export function restoreIdCounters(counters: {
  note: number;
  marker: number;
  section: number;
}): void {
  nextNoteId = counters.note;
  nextMarkerId = counters.marker;
  nextSectionId = counters.section;
}

/** Drops the open Project and every counter that belonged to it. */
export function resetProjectRuntime(): void {
  project = null;
  audioSourceIds = new Map();
  nextNoteId = 1;
  nextMarkerId = 1;
  nextSectionId = 1;
}
