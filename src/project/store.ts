import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ensureWasm } from '@/lib/wasm';
import type { Project } from '@/wasm/index.js';
import { type EditorNote, MAJOR_MODE_MASK, type ScaleHighlightConfig } from './types';

type WasmModule = typeof import('@/wasm/index.js');

/** Default project tempo in BPM. */
const DEFAULT_TEMPO_BPM = 120;

/** Default clip length: eight 4/4 bars expressed in quarter-note PPQ. */
const DEFAULT_CLIP_LENGTH_PPQ = 32;

/** Default snap grid: divisions per whole note (16 = sixteenth-note grid). */
const DEFAULT_SNAP_DIVISION = 16;

/** Default project sample rate used until an AudioContext provides the real one. */
const DEFAULT_SAMPLE_RATE = 48000;

// The wasm Project is the single source of truth for clip content and lives
// outside Vue reactivity on purpose (module scope, not store state): wrapping
// an embind handle in a reactive proxy would intercept its internal slots and
// add per-call overhead. The Pinia store below is a read-model mirror that is
// refreshed from the Project after every mutating command.
let wasmModule: WasmModule | null = null;
let project: Project | null = null;
let nextNoteId = 1;

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

/** UMP message-type nibble for MIDI 1.0 channel-voice words. */
const UMP_MIDI1_CHANNEL_VOICE = 0x2;
/** MIDI 1.0 note-off status nibble. */
const STATUS_NOTE_OFF = 0x8;
/** MIDI 1.0 note-on status nibble. */
const STATUS_NOTE_ON = 0x9;

/** Shape of one serialized MIDI event inside the Project JSON document. */
interface SerializedMidiEvent {
  ppq: number;
  data0: number;
  data1: number;
}

/** Shape of one serialized tempo segment inside the Project JSON document. */
interface SerializedTempoSegment {
  start_ppq: number;
  bpm: number;
}

/** Minimal slice of the Project JSON document this store reads. */
interface SerializedProjectDoc {
  midi_content?: Record<string, unknown>;
  tempo_segments?: SerializedTempoSegment[];
}

/** A note-on or note-off boundary decoded from a packed UMP word. */
interface DecodedNoteEvent {
  ppq: number;
  kind: 'on' | 'off';
  channel: number;
  pitch: number;
  velocity: number;
}

/** An editor note without its id, as recovered from the Project. */
type RawNote = Omit<EditorNote, 'id'>;

/**
 * Decodes a packed UMP MIDI 1.0 channel-voice word into a note boundary.
 *
 * @param ppq Event position in PPQ.
 * @param data0 Packed 32-bit UMP word.
 * @returns The decoded boundary, or null for non-note events.
 */
function decodeNoteEvent(ppq: number, data0: number): DecodedNoteEvent | null {
  if (((data0 >>> 28) & 0xf) !== UMP_MIDI1_CHANNEL_VOICE) return null;
  const status = (data0 >>> 20) & 0xf;
  const channel = (data0 >>> 16) & 0xf;
  const pitch = (data0 >>> 8) & 0x7f;
  const velocity = data0 & 0x7f;
  if (status === STATUS_NOTE_ON && velocity > 0) {
    return { ppq, kind: 'on', channel, pitch, velocity };
  }
  if (status === STATUS_NOTE_OFF || status === STATUS_NOTE_ON) {
    // A note-on with velocity 0 is a note-off per MIDI 1.0 semantics.
    return {
      ppq,
      kind: 'off',
      channel,
      pitch,
      velocity: status === STATUS_NOTE_OFF ? velocity : 0,
    };
  }
  return null;
}

/**
 * Pairs serialized note-on/note-off events back into notes.
 *
 * Events are matched FIFO per (channel, pitch); note-offs sort before
 * note-ons at the same PPQ so back-to-back repeats pair correctly.
 * Unmatched boundaries and non-note events (CC, pitch bend, ...) are dropped;
 * the editor only manages note content in its clip.
 *
 * @param events Serialized events from the Project JSON document.
 * @returns Recovered notes sorted by start position.
 */
function pairEventsIntoNotes(events: ReadonlyArray<SerializedMidiEvent>): RawNote[] {
  const decoded: DecodedNoteEvent[] = [];
  for (const event of events) {
    const note = decodeNoteEvent(event.ppq, event.data0);
    if (note) decoded.push(note);
  }
  decoded.sort(
    (a, b) =>
      a.ppq - b.ppq ||
      (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1) ||
      a.pitch - b.pitch ||
      a.channel - b.channel,
  );
  const pending = new Map<string, Array<{ startPpq: number; velocity: number }>>();
  const out: RawNote[] = [];
  for (const event of decoded) {
    const key = `${event.channel}:${event.pitch}`;
    if (event.kind === 'on') {
      const queue = pending.get(key) ?? [];
      queue.push({ startPpq: event.ppq, velocity: event.velocity });
      pending.set(key, queue);
      continue;
    }
    const on = pending.get(key)?.shift();
    if (!on || event.ppq <= on.startPpq) continue;
    const note: RawNote = {
      pitch: event.pitch,
      velocity: on.velocity,
      startPpq: on.startPpq,
      durationPpq: event.ppq - on.startPpq,
      channel: event.channel,
    };
    if (event.velocity > 0) note.offVelocity = event.velocity;
    out.push(note);
  }
  out.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch || a.channel - b.channel);
  return out;
}

/** PPQ values are keyed at micro-PPQ resolution to absorb float round-trip noise. */
const KEY_PPQ_SCALE = 1e6;

/** Builds the content key used to re-associate editor ids after a refresh. */
function noteKey(note: RawNote): string {
  return [
    note.pitch,
    note.velocity,
    Math.round(note.startPpq * KEY_PPQ_SCALE),
    Math.round(note.durationPpq * KEY_PPQ_SCALE),
    note.channel,
    note.offVelocity ?? 0,
  ].join('|');
}

/**
 * Pinia store mirroring the wasm Project for the piano-roll editor.
 *
 * State is a read model: every mutating command writes to the Project first
 * (src/project/commands.ts) and then calls {@link refresh} to re-read it.
 */
export const useProjectStore = defineStore('project', () => {
  /** Id of the edited MIDI clip inside the Project (-1 before init). */
  const clipId = ref(-1);
  /** Timeline start of the edited clip, in PPQ. */
  const clipStartPpq = ref(0);
  /** Length of the edited clip, in PPQ. */
  const clipLengthPpq = ref(0);
  /** Mirror of the clip's note content, with editor-assigned ids. */
  const notes = ref<EditorNote[]>([]);
  /** Ids of currently selected notes. */
  const selection = ref<Set<number>>(new Set());
  /** Project tempo in BPM (first tempo segment). */
  const tempoBpm = ref(DEFAULT_TEMPO_BPM);
  /** Snap grid divisions per whole note (16 = sixteenth-note grid). */
  const snapDivision = ref(DEFAULT_SNAP_DIVISION);
  /** Whether grid snapping is applied to note edits (editor-only, not undoable). */
  const snapEnabled = ref(true);
  /** Scale highlight configuration (defaults to C major). */
  const scaleHighlight = ref<ScaleHighlightConfig>({
    enabled: true,
    rootPc: 0,
    modeMask: MAJOR_MODE_MASK,
  });
  /** True once init() has created the Project and the default clip. */
  const initialized = ref(false);

  /**
   * Highlight flags per pitch class (index 0 = C, ... 11 = B), delegated to
   * the libsonare scalePitchClassEnabled helper. All false while the store is
   * uninitialized or highlighting is disabled.
   */
  const highlightedPitchClasses = computed<boolean[]>(() => {
    const mod = wasmModule;
    const config = scaleHighlight.value;
    if (!initialized.value || !mod || !config.enabled) {
      return Array.from({ length: 12 }, () => false);
    }
    return Array.from({ length: 12 }, (_, pc) =>
      mod.scalePitchClassEnabled(config.rootPc, config.modeMask, pc),
    );
  });

  /** Currently selected notes, in mirror order. */
  const selectedNotes = computed<EditorNote[]>(() =>
    notes.value.filter((note) => selection.value.has(note.id)),
  );

  /**
   * Initializes the wasm module and creates the Project with a default tempo
   * of 120 BPM and one empty 8-bar MIDI clip. Safe to call more than once;
   * later calls are no-ops while a Project is alive.
   *
   * @param options Optional overrides (sampleRate defaults to 48000 Hz).
   */
  async function init(options: { sampleRate?: number } = {}): Promise<void> {
    if (project) return;
    const mod = await ensureWasm();
    if (project) return; // another init() call won the race while awaiting
    wasmModule = mod;
    const created = new mod.Project();
    created.setSampleRate(options.sampleRate ?? DEFAULT_SAMPLE_RATE);
    created.setTempoSegments([{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }]);
    const clip = created.addMidiClip(0, DEFAULT_CLIP_LENGTH_PPQ);
    project = created;
    clipId.value = clip.clipId;
    clipStartPpq.value = 0;
    clipLengthPpq.value = DEFAULT_CLIP_LENGTH_PPQ;
    tempoBpm.value = DEFAULT_TEMPO_BPM;
    notes.value = [];
    selection.value = new Set();
    initialized.value = true;
    refresh();
  }

  /**
   * Re-reads the mirror from the Project (the source of truth).
   *
   * The Project has no MIDI event getter, so read-back parses toJson() and
   * pairs the clip's note-on/note-off events into notes. Editor ids are then
   * re-associated by exact note content against `idHints` (or the current
   * mirror when omitted): commands pass the note list they just wrote, and
   * undo/redo pass the historical snapshot, so ids stay stable. Notes with no
   * match receive fresh ids; the selection is pruned to surviving ids.
   *
   * @param idHints Id-annotated notes expected to match the Project content.
   */
  function refresh(idHints?: ReadonlyArray<EditorNote>): void {
    if (!project || clipId.value < 0) return;
    const doc = JSON.parse(project.toJson()) as SerializedProjectDoc;
    const stored = doc.midi_content?.[String(clipId.value)];
    const events = Array.isArray(stored) ? (stored as SerializedMidiEvent[]) : [];
    const raw = pairEventsIntoNotes(events);

    const pool = new Map<string, EditorNote[]>();
    for (const hint of idHints ?? notes.value) {
      const key = noteKey(hint);
      const bucket = pool.get(key) ?? [];
      bucket.push(hint);
      pool.set(key, bucket);
    }
    const next = raw.map((candidate) => {
      const match = pool.get(noteKey(candidate))?.shift();
      // Prefer the hint's exact field values: durations recovered from the
      // Project are subject to floating-point noise (offPpq - startPpq).
      return match ? { ...match } : { id: nextNoteId++, ...candidate };
    });
    notes.value = next;

    const alive = new Set(next.map((note) => note.id));
    selection.value = new Set([...selection.value].filter((id) => alive.has(id)));

    const bpm = doc.tempo_segments?.[0]?.bpm;
    if (typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0) tempoBpm.value = bpm;
  }

  /**
   * Releases the wasm Project and resets the mirror. Call clearHistory() from
   * src/project/commands.ts alongside this to drop the undo/redo snapshots.
   */
  function dispose(): void {
    if (project) {
      project.delete();
      project = null;
    }
    nextNoteId = 1;
    initialized.value = false;
    clipId.value = -1;
    clipStartPpq.value = 0;
    clipLengthPpq.value = 0;
    notes.value = [];
    selection.value = new Set();
    tempoBpm.value = DEFAULT_TEMPO_BPM;
    snapDivision.value = DEFAULT_SNAP_DIVISION;
    snapEnabled.value = true;
    scaleHighlight.value = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  }

  return {
    clipId,
    clipStartPpq,
    clipLengthPpq,
    notes,
    selection,
    tempoBpm,
    snapDivision,
    snapEnabled,
    scaleHighlight,
    initialized,
    highlightedPitchClasses,
    selectedNotes,
    init,
    refresh,
    dispose,
  };
});
