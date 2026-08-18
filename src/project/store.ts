import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { linearToDb } from '@/lib/db';
import { ensureWasm } from '@/lib/wasm';
import { audioAssetUri } from '@/persistence/assets';
import {
  type MidiCcBinding,
  midiLearnTargetScope,
  migrateMidiLearnTargetToProcessorId,
  sanitizeMidiCcBindings,
  withMidiLearnTargetScope,
} from '@/ui/midi/midi-learn';
import type { Project, ProjectMidiEvent } from '@/wasm/index.js';
import {
  createDefaultScoreDisplaySettings,
  DISPLAY_TRANSPOSE_MAX,
  DISPLAY_TRANSPOSE_MIN,
  type ScoreAnnotations,
  type ScoreDisplaySettings,
  scoreDisplaySettingsFromDocument,
} from './annotations';
import {
  type AutomationLaneState,
  busAutomationTarget,
  sanitizeAutomationEntries,
} from './automation';
import {
  migrateAutomationLanesToProcessorIds,
  pruneInsertLanesAgainstStrips,
} from './automation-insert';
import {
  chordsFromAnnotation,
  type EditorChordSymbol,
  sanitizeChordSymbols,
  toProjectChordSymbols,
} from './chords';
import {
  type ControlSurfaceSettings,
  clampBankOffset,
  defaultControlSurfaceSettings,
  sanitizeControlSurfaceSettings,
} from './control-surface';
import { sanitizeExpressionMap } from './expression-map';
import { isExternalStemRole } from './external-stems';
import { sanitizeProvenance } from './generation';
import type { GrooveTemplate } from './groove';
import { cloneInstrument, type ExternalMidiInstrument } from './instrument';
import { notesToProjectMidiEvents, type RawNote } from './midi-events';
import { isMidiFxNoop, sanitizeMidiFxConfig } from './midi-fx';
import {
  cloneMixerState,
  cloneStrip,
  createDefaultMixerState,
  createDefaultStrip,
  engineBusCount,
  ensureMixerProcessorIds,
  ensureProcessorIds,
  MAX_MIXER_BUSES,
  normalizeMixerSoloMode,
  type ProjectMixerState,
} from './mixer';
import {
  type DocumentClip,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from './serialization';
import { applyDocumentClipMetadata, restoreDocumentScoreAnnotations } from './store-load';
import {
  buildClipMirror,
  buildTrackMirror,
  type NoteIdHints,
  refreshTempoMeter,
  type SerializedProjectDoc,
} from './store-refresh';
import { normalizeTempoMap } from './tempo-map';
import {
  DEFAULT_SECTION_COLOR,
  type EditorClip,
  type EditorMarker,
  type EditorNote,
  type EditorSection,
  type EditorTrack,
  MAJOR_MODE_MASK,
  type ScaleHighlightConfig,
  type TempoSegment,
  type TimeSignatureSegment,
  TRACK_COLOR_PALETTE,
} from './types';
import { installProjectClipWarp, sanitizeClipWarp } from './warp';

type WasmModule = typeof import('@/wasm/index.js');

type InsertWithDocumentSidechainIndex = {
  sidechainSourceIndex?: number;
  sidechainSourceTrackId?: number;
};

/** Default project tempo in BPM. */
const DEFAULT_TEMPO_BPM = 120;

/** Default clip length: eight 4/4 bars expressed in quarter-note PPQ. */
const DEFAULT_CLIP_LENGTH_PPQ = 32;

function isDocumentMarker(value: unknown): value is { ppq: number; name: string } {
  if (typeof value !== 'object' || value === null) return false;
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.ppq === 'number' &&
    Number.isFinite(marker.ppq) &&
    marker.ppq >= 0 &&
    typeof marker.name === 'string'
  );
}

function isDocumentSection(
  value: unknown,
): value is { name: string; color: string; startPpq: number; endPpq: number } {
  if (typeof value !== 'object' || value === null) return false;
  const section = value as Record<string, unknown>;
  return (
    typeof section.name === 'string' &&
    typeof section.color === 'string' &&
    typeof section.startPpq === 'number' &&
    Number.isFinite(section.startPpq) &&
    section.startPpq >= 0 &&
    typeof section.endPpq === 'number' &&
    Number.isFinite(section.endPpq) &&
    section.endPpq > section.startPpq
  );
}

/**
 * Mirrors libsonare's bounded Project history rather than relying on its
 * engine default. The command layer accounts for every native edit represented
 * by local history and evicts whole entries before this limit is exceeded.
 */
export const PROJECT_MAX_UNDO_DEPTH = 512;

/** Default snap grid: divisions per whole note (16 = sixteenth-note grid). */
const DEFAULT_SNAP_DIVISION = 16;

function resolveStripSidechainSourceIds(
  inserts: InsertWithDocumentSidechainIndex[] | undefined,
  trackMirror: EditorTrack[],
): void {
  for (const slot of inserts ?? []) {
    const sourceIndex = slot.sidechainSourceIndex;
    if (
      sourceIndex !== undefined &&
      Number.isInteger(sourceIndex) &&
      sourceIndex >= 0 &&
      sourceIndex < trackMirror.length
    ) {
      slot.sidechainSourceTrackId = trackMirror[sourceIndex].id;
    }
    delete slot.sidechainSourceIndex;
  }
}

/** Default project sample rate used until an AudioContext provides the real one. */
const DEFAULT_SAMPLE_RATE = 48000;

/** Keeps malformed persisted numeric fields from reaching the wasm ABI. */
function finiteAtLeast(value: unknown, minimum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback;
}

/** Default name of the track created by init(). */
const DEFAULT_TRACK_NAME = 'Piano';

/** Default project display name. */
const DEFAULT_PROJECT_NAME = 'Untitled';

// The wasm Project is the single source of truth for arrangement content and
// lives outside Vue reactivity on purpose (module scope, not store state):
// wrapping an embind handle in a reactive proxy would intercept its internal
// slots and add per-call overhead. The Pinia store below is a read-model
// mirror that is refreshed from the Project after every mutating command.
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
 * Registers a callback invoked by {@link dispose} to clear the command-layer
 * undo/redo history, keeping the two in lockstep. Called once by the history
 * module at import time.
 */
export function setHistoryResetHook(hook: (() => void) | null): void {
  historyResetHook = hook;
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

/** Per-clip note id hints accepted by {@link useProjectStore refresh}. */
export type { NoteIdHints };

/**
 * Pinia store mirroring the wasm Project for the arrangement and the
 * piano-roll editor.
 *
 * State is a read model: every mutating command writes to the Project first
 * (src/project/commands.ts) and then calls {@link refresh} to re-read it.
 * Track/clip structure, names (tracks), timing, gain and loop state come from
 * the Project; app-only fields (track color/mute/solo/volume/pan/order, clip
 * names, markers, sections) live in this mirror and are merged in by id.
 */
export const useProjectStore = defineStore('project', () => {
  /** Project display name (app-level metadata, used by persistence). */
  const projectName = ref(DEFAULT_PROJECT_NAME);
  /** Track mirror in display order. */
  const tracks = shallowRef<EditorTrack[]>([]);
  /** Clip mirror, ordered by (track order, startPpq, id). */
  const clips = shallowRef<EditorClip[]>([]);
  /** Timeline markers (app-level). */
  const markers = ref<EditorMarker[]>([]);
  /** Chord-track symbols, mirroring the Project's annotation stream. */
  const chords = ref<EditorChordSymbol[]>([]);
  /** Arrangement sections (app-level), ordered by startPpq. */
  const sections = ref<EditorSection[]>([]);
  /** Automation lanes (app-level), one per (target, param) pair. */
  const automationLanes = ref<AutomationLaneState[]>([]);
  /**
   * MIDI-learn CC bindings (app-level), keyed by target id. Persisted with the
   * project; the map identity is stable across loads (mutated in place) so the
   * MIDI-learn handle can hold a long-lived reference.
   */
  const midiCcBindings = ref(new Map<string, MidiCcBinding>());
  /**
   * Control-surface configuration (app-level): protocol, ports and the bank
   * window that bank-slot bindings resolve through. Persisted with the project
   * so a surface layout survives a reload.
   */
  const controlSurface = ref<ControlSurfaceSettings>(defaultControlSurfaceSettings());
  /** Project mixer state: master strip + buses (app-level metadata). */
  const mixer = ref<ProjectMixerState>(createDefaultMixerState());
  /** Shared External MIDI route tracks can opt into. */
  const projectExternalMidi = ref<ExternalMidiInstrument | null>(null);
  /** Id of the active (focused) track (-1 when there is none). */
  const activeTrackId = ref(-1);
  /** Arrangement tracks selected together for bulk header operations. */
  const trackSelection = ref<Set<number>>(new Set());
  /** Id of the active MIDI clip edited by the piano roll (-1 when none). */
  const clipId = ref(-1);
  /** Arrangement clip ids selected together; the active clip is included when present. */
  const clipSelection = ref<Set<number>>(new Set());
  /** Timeline start of the active clip, in PPQ. */
  const clipStartPpq = ref(0);
  /** Length of the active clip, in PPQ. */
  const clipLengthPpq = ref(0);
  /** Mirror of the active clip's note content, with editor-assigned ids. */
  const notes = shallowRef<EditorNote[]>([]);
  /** Ids of currently selected notes (within the active clip). */
  const selection = ref<Set<number>>(new Set());
  /** Project tempo in BPM (first tempo segment). */
  const tempoBpm = ref(DEFAULT_TEMPO_BPM);
  /** Full tempo map mirror. */
  const tempoSegments = ref<TempoSegment[]>([]);
  /** Time-signature map mirror. */
  const timeSignatures = ref<TimeSignatureSegment[]>([]);
  /** Opening pickup/anacrusis length in PPQ (0 = no pickup). */
  const pickupLengthPpq = ref(0);
  /** Snap grid divisions per whole note (16 = sixteenth-note grid). */
  const snapDivision = ref(DEFAULT_SNAP_DIVISION);
  /** Whether snapping targets complete meter-aware bars instead of note divisions. */
  const snapBar = ref(false);
  /** Quantize strength, from 0 (no move) to 1 (full snap). */
  const quantizeStrength = ref(1);
  /** Straight-grid swing applied by selection quantize, in percent (0-100). */
  const quantizeSwing = ref(0);
  /**
   * Groove captured from a reference performance (editor-only, not undoable
   * and not part of the Project document).
   */
  const grooveTemplate = ref<GrooveTemplate | null>(null);
  /** Whether grid snapping is applied to note edits (editor-only, not undoable). */
  const snapEnabled = ref(true);
  /** Scale highlight configuration (defaults to C major). */
  const scaleHighlight = ref<ScaleHighlightConfig>({
    enabled: true,
    rootPc: 0,
    modeMask: MAJOR_MODE_MASK,
  });
  /**
   * Display-only score annotations keyed by clip id then editor note id
   * (app-level metadata; never written to the Project or to MIDI data).
   * Entries whose note no longer exists are ignored by the score pipeline.
   */
  const scoreAnnotations = ref<ScoreAnnotations>({});
  /** Score display transpose in semitones (engraving only; MIDI is never changed). */
  const displayTransposeSemitones = ref(0);
  /** Project-owned score toolbar, page-layout and display settings. */
  const scoreDisplaySettings = ref<ScoreDisplaySettings>(createDefaultScoreDisplaySettings());
  /** True once init() has created the Project and the default track/clip. */
  const initialized = ref(false);
  /**
   * Monotonic identity of the live project document. Async operations capture
   * this value and must not commit after a successful load/init or disposal.
   */
  const documentGeneration = ref(0);

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

  /** The active track mirror entry, or null. */
  const activeTrack = computed<EditorTrack | null>(
    () => tracks.value.find((track) => track.id === activeTrackId.value) ?? null,
  );

  /** The active clip mirror entry, or null. */
  const activeClip = computed<EditorClip | null>(
    () => clips.value.find((clip) => clip.id === clipId.value) ?? null,
  );

  /** Clips grouped by owning track id, in mirror order. */
  const clipsByTrack = computed<Map<number, EditorClip[]>>(() => {
    const map = new Map<number, EditorClip[]>();
    for (const track of tracks.value) map.set(track.id, []);
    for (const clip of clips.value) {
      const bucket = map.get(clip.trackId) ?? [];
      bucket.push(clip);
      map.set(clip.trackId, bucket);
    }
    return map;
  });

  /**
   * Re-reads the mirror from the Project (the source of truth).
   *
   * The Project has no track/clip/MIDI getters, so read-back parses toJson().
   * Track and clip structure replaces the mirror; app-only fields are merged
   * from the current mirror by id (commands restore the mirror from history
   * snapshots before calling refresh, so undo keeps app metadata too). Track
   * display order follows the current mirror; tracks first seen in the
   * Project are appended.
   *
   * Editor note ids are re-associated by exact note content: pass an array of
   * id-annotated notes as hints for the active clip (the common command
   * path), or a Map keyed by clip id for multi-clip restores. Clips without
   * hints fall back to their current mirror notes. Notes with no match
   * receive fresh ids; the selection is pruned to surviving ids.
   *
   * The Project keeps a chord's quality ordinal but not the intrinsic tones the
   * app-level symbol declares silent, so the chord read-back is seeded the same
   * way: pass the chords expected in the Project and their omissions survive.
   * Without a hint the current mirror is used, which is what every caller that
   * is not itself rewriting the chord track wants.
   *
   * @param idHints Id-annotated notes expected to match the Project content.
   * @param chordHints Chord symbols expected to match the Project content.
   */
  function refresh(idHints?: NoteIdHints, chordHints?: ReadonlyArray<EditorChordSymbol>): void {
    if (!project) return;
    const doc = JSON.parse(project.toJson()) as SerializedProjectDoc;

    // Tempo and meter mirrors.
    const tempoMeter = refreshTempoMeter(doc, timeSignatures.value);
    tempoSegments.value = tempoMeter.tempoSegments;
    if (tempoMeter.tempoBpm !== null) tempoBpm.value = tempoMeter.tempoBpm;
    timeSignatures.value = tempoMeter.timeSignatures;

    // Chord-track mirror: read back the Project's annotation stream (the chord
    // commands write it through annotateChords, so it round-trips here), seeded
    // with the omitted tones the annotation encoding cannot carry.
    chords.value = chordsFromAnnotation(doc.annotation, chordHints ?? chords.value);

    // Track mirror: structure from the Project, app fields + order from the
    // current mirror; tracks first seen in the Project are appended.
    const { tracks: nextTracks, trackOrder } = buildTrackMirror(doc, tracks.value);
    tracks.value = nextTracks;
    trackSelection.value = new Set([...trackSelection.value].filter((id) => trackOrder.has(id)));

    // Clip mirror: structure from the Project, names from the current mirror,
    // notes recovered per clip with id hints.
    const nextClips = buildClipMirror(
      doc,
      clips.value,
      trackOrder,
      clipId.value,
      idHints,
      allocateNoteId,
    );
    clips.value = nextClips;
    const liveClipIds = new Set(nextClips.map((clip) => clip.id));
    clipSelection.value = new Set([...clipSelection.value].filter((id) => liveClipIds.has(id)));

    // Active track/clip fixup: a live active clip pins the active track;
    // otherwise fall back to the first clip of the active (or first) track.
    const active = nextClips.find((clip) => clip.id === clipId.value) ?? null;
    if (active) {
      activeTrackId.value = active.trackId;
    } else {
      if (!trackOrder.has(activeTrackId.value)) {
        activeTrackId.value = nextTracks[0]?.id ?? -1;
      }
      const fallback = nextClips.find((clip) => clip.trackId === activeTrackId.value) ?? null;
      clipId.value = fallback?.id ?? -1;
    }
    if (trackSelection.value.size === 0 && activeTrackId.value >= 0) {
      trackSelection.value = new Set([activeTrackId.value]);
    }
    const current = nextClips.find((clip) => clip.id === clipId.value) ?? null;
    clipStartPpq.value = current?.startPpq ?? 0;
    clipLengthPpq.value = current?.lengthPpq ?? 0;
    notes.value = current ? current.notes.map((note) => ({ ...note })) : [];

    const alive = new Set(notes.value.map((note) => note.id));
    selection.value = new Set([...selection.value].filter((id) => alive.has(id)));
  }

  /**
   * Initializes the wasm module and creates the Project with a default tempo
   * of 120 BPM and one MIDI track holding one empty 8-bar clip. Safe to call
   * more than once; later calls are no-ops while a Project is alive.
   *
   * @param options Optional overrides (sampleRate defaults to 48000 Hz).
   */
  function applySampleRateIfProvided(options: { sampleRate?: number }): boolean {
    const current = project;
    if (!current) return false;
    if (options.sampleRate !== undefined && options.sampleRate > 0) {
      current.setSampleRate(options.sampleRate);
    }
    return true;
  }

  async function init(options: { sampleRate?: number } = {}): Promise<void> {
    if (applySampleRateIfProvided(options)) return;
    const mod = await ensureWasm();
    // Another init() call may have won the race while awaiting; still apply
    // the caller's concrete hardware rate when provided.
    if (applySampleRateIfProvided(options)) return;
    wasmModule = mod;
    const created = new mod.Project();
    created.setMaxUndoDepth(PROJECT_MAX_UNDO_DEPTH);
    created.setSampleRate(options.sampleRate ?? DEFAULT_SAMPLE_RATE);
    created.setTempoSegments([{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }]);
    const trackId = created.addTrack({ kind: 'midi', name: DEFAULT_TRACK_NAME });
    const newClipId = created.addClip({
      trackId,
      isMidi: true,
      startPpq: 0,
      lengthPpq: DEFAULT_CLIP_LENGTH_PPQ,
    });
    project = created;
    audioSourceIds = new Map();
    projectName.value = DEFAULT_PROJECT_NAME;
    mixer.value = createDefaultMixerState();
    projectExternalMidi.value = null;
    tracks.value = [
      {
        id: trackId,
        name: DEFAULT_TRACK_NAME,
        color: TRACK_COLOR_PALETTE[0],
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: 0,
      },
    ];
    clips.value = [];
    markers.value = [];
    chords.value = [];
    sections.value = [];
    automationLanes.value = [];
    midiCcBindings.value.clear();
    controlSurface.value = defaultControlSurfaceSettings();
    activeTrackId.value = trackId;
    clipId.value = newClipId;
    clipStartPpq.value = 0;
    clipLengthPpq.value = DEFAULT_CLIP_LENGTH_PPQ;
    tempoBpm.value = DEFAULT_TEMPO_BPM;
    pickupLengthPpq.value = 0;
    notes.value = [];
    selection.value = new Set();
    scoreAnnotations.value = {};
    displayTransposeSemitones.value = 0;
    scoreDisplaySettings.value = createDefaultScoreDisplaySettings();
    initialized.value = true;
    refresh();
    // Initialization edits establish the document baseline, not user
    // commands. Keep them out of the native undo window so the command-layer
    // projectEdits budget has the same origin as the local history.
    created.clearHistory();
    documentGeneration.value += 1;
  }

  /**
   * Rebuilds the wasm Project and this mirror from a {@link ProjectDocument}.
   *
   * Any live Project is released first. The document is replayed through the
   * Project API (addTrack/addClip/setMidiEvents/...), so the rebuilt Project
   * is equivalent to the serialized one; all editor ids are allocated fresh.
   * Call clearHistory() from src/project/commands.ts after loading (the
   * loadProjectDocument wrapper in src/project/serialization.ts does).
   *
   * @param doc Document produced by serializeProject() or a template.
   */
  async function loadDocument(doc: ProjectDocument): Promise<void> {
    if (
      !Number.isInteger(doc.schemaVersion) ||
      doc.schemaVersion < 1 ||
      doc.schemaVersion > PROJECT_DOCUMENT_SCHEMA_VERSION
    ) {
      throw new Error(`Unsupported project document schema version: ${doc.schemaVersion}`);
    }
    const engineBusTotal = engineBusCount(doc.mixer?.buses.length ?? 0, doc.tracks);
    if (engineBusTotal > MAX_MIXER_BUSES) {
      throw new RangeError(`Mixer bus limit exceeded (${engineBusTotal}/${MAX_MIXER_BUSES})`);
    }
    const previousWasmModuleAtEntry = wasmModule;
    const mod = await ensureWasm();
    let restorePreviousState: (() => void) | null = null;
    wasmModule = mod;
    const created = new mod.Project();
    try {
      created.setMaxUndoDepth(PROJECT_MAX_UNDO_DEPTH);
      created.setSampleRate(doc.sampleRate > 0 ? doc.sampleRate : DEFAULT_SAMPLE_RATE);
      const tempo =
        doc.tempoSegments.length > 0
          ? doc.tempoSegments
          : [{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }];
      const normalizedTempo = normalizeTempoMap(tempo, DEFAULT_TEMPO_BPM);
      created.setTempoSegments(
        tempo.map((s) => ({ startPpq: s.startPpq, bpm: s.bpm, endBpm: s.endBpm ?? 0 })),
      );
      if (doc.timeSignatures.length > 0) {
        created.setTimeSignatures(doc.timeSignatures.map((s) => ({ ...s })));
      }
      const trackMirror: EditorTrack[] = [];
      const laneMirror: AutomationLaneState[] = [];
      const clipMeta = new Map<number, DocumentClip>();
      const loadedSourceIds = new Map<string, number>();
      let firstClipId = -1;
      doc.tracks.forEach((track, index) => {
        // Group tracks are an app-level concept; the wasm Project stores them
        // as aux tracks.
        const projectKind = track.kind === 'group' ? 'aux' : track.kind;
        const trackId = created.addTrack({ kind: projectKind, name: track.name });
        const documentPan =
          Number.isFinite(track.pan) && track.pan >= -1 && track.pan <= 1 ? track.pan : 0;
        const importedStrip = track.mixer !== undefined ? cloneStrip(track.mixer) : undefined;
        // Schema-v3 files written before the audible-pan migration may only
        // carry DocumentTrack.pan. Promote it into MixerStrip.pan on load.
        // Group buses have no pan DSP, so reject their persisted no-op value
        // by centering both the strip and compatibility mirror.
        if (importedStrip !== undefined) {
          importedStrip.pan =
            track.kind !== 'group' &&
            Number.isFinite(importedStrip.pan) &&
            importedStrip.pan >= -1 &&
            importedStrip.pan <= 1
              ? importedStrip.pan
              : track.kind === 'group'
                ? 0
                : documentPan;
        }
        const audiblePan = track.kind === 'group' ? 0 : (importedStrip?.pan ?? documentPan);
        let migratedStrip =
          importedStrip ??
          (track.kind !== 'group' && audiblePan !== 0
            ? { ...createDefaultStrip(), pan: audiblePan }
            : undefined);
        // `volume` was the pre-v4 linear fader field. Keep accepting it from
        // old documents, but fold it into the canonical dB strip gain before
        // exposing the mirror so a later fader edit cannot double-count it.
        const legacyVolume = finiteAtLeast(track.volume, 0, 1);
        if (legacyVolume !== 1) {
          migratedStrip = cloneStrip(migratedStrip ?? createDefaultStrip());
          migratedStrip.gainDb += linearToDb(legacyVolume);
        }
        const mirrorEntry: EditorTrack = {
          id: trackId,
          name: track.name,
          color: track.color || TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
          kind: track.kind,
          mute: track.mute,
          solo: track.solo,
          // Retained only as a v3 document compatibility mirror. New runtime
          // state and all subsequent saves keep it at unity.
          volume: 1,
          pan: audiblePan,
          order: index,
        };
        if (typeof track.musicXmlPartId === 'string' && track.musicXmlPartId.length > 0) {
          mirrorEntry.musicXmlPartId = track.musicXmlPartId;
        }
        // Instrument and mixer strip are app metadata introduced by schema
        // version 3; older documents simply have neither (defaults apply).
        if (track.instrument !== undefined)
          mirrorEntry.instrument = cloneInstrument(track.instrument);
        if (track.externalMidiMode === 'project') mirrorEntry.externalMidiMode = 'project';
        // Restore the live MIDI-FX transform; drop a no-op so an identity entry
        // never lingers in the mirror or re-serializes.
        if (track.midiFx !== undefined) {
          const midiFx = sanitizeMidiFxConfig(track.midiFx);
          if (!isMidiFxNoop(midiFx)) mirrorEntry.midiFx = midiFx;
        }
        if (track.soloSafe === true) mirrorEntry.soloSafe = true;
        if (typeof track.percussion === 'boolean') mirrorEntry.percussion = track.percussion;
        const generated = sanitizeProvenance(track.generated);
        if (generated !== undefined) mirrorEntry.generated = generated;
        if (track.chordFollow === 'chordTones' || track.chordFollow === 'root') {
          mirrorEntry.chordFollow = track.chordFollow;
        }
        const expressionMap = sanitizeExpressionMap(track.expressionMap);
        if (expressionMap !== undefined) mirrorEntry.expressionMap = expressionMap;
        // Restore the VCA assignment only when the referenced group survives in
        // the document mixer, so dangling ids never leak into the session.
        if (
          typeof track.vcaId === 'string' &&
          (doc.mixer?.vcaGroups ?? []).some((group) => group.id === track.vcaId)
        ) {
          mirrorEntry.vcaId = track.vcaId;
        }
        if (
          track.frozen !== undefined &&
          typeof track.frozen.assetId === 'string' &&
          track.frozen.assetId.length > 0
        ) {
          mirrorEntry.frozen = { assetId: track.frozen.assetId };
        }
        if (
          track.kind === 'audio' &&
          Number.isInteger(track.recordInputChannel) &&
          (track.recordInputChannel as number) >= 0
        ) {
          mirrorEntry.recordInputChannel = track.recordInputChannel as number;
        }
        if (
          track.kind === 'audio' &&
          typeof track.recordInputDeviceId === 'string' &&
          track.recordInputDeviceId.length > 0
        ) {
          mirrorEntry.recordInputDeviceId = track.recordInputDeviceId;
        }
        if (migratedStrip !== undefined) {
          mirrorEntry.mixer = migratedStrip;
          // Insert sidechain sources are stored positionally; rebind them to
          // the freshly assigned track ids after every track exists (below).
        }
        // Track automation rides the track entry; rebind it to the freshly
        // assigned track id (malformed entries are dropped).
        if (track.automation !== undefined) {
          laneMirror.push(
            ...sanitizeAutomationEntries(track.automation, trackId).filter(
              (lane) => !(track.kind === 'group' && lane.param === 'pan'),
            ),
          );
        }
        trackMirror.push(mirrorEntry);
        for (const clip of track.clips) {
          const startPpq = finiteAtLeast(clip.startPpq, 0, 0);
          const lengthPpq = finiteAtLeast(clip.lengthPpq, Number.EPSILON, 1);
          const sourceOffsetPpq = finiteAtLeast(clip.sourceOffsetPpq, 0, 0);
          const gain = finiteAtLeast(clip.gain, 0, 1);
          const safeClip: DocumentClip = {
            ...clip,
            startPpq,
            lengthPpq,
            sourceOffsetPpq,
            gain,
          };
          const isAudio = clip.kind === 'audio' && typeof clip.assetId === 'string';
          let newClipId: number;
          if (isAudio) {
            const assetId = clip.assetId as string;
            const existingSource = loadedSourceIds.get(assetId);
            if (existingSource === undefined) {
              // First clip of this asset registers the by-reference source
              // (with the placeholder PCM the binding insists on).
              newClipId = created.addClip({
                trackId,
                isMidi: false,
                startPpq,
                lengthPpq,
                sourceOffsetPpq,
                gain,
                ...placeholderSourceAudio(),
                sourceUri: audioAssetUri(assetId),
              });
              loadedSourceIds.set(assetId, created.sourceCount());
              // External-stem provenance rides the source, so replay it once
              // per asset, on the clip that registered the source.
              if (isExternalStemRole(clip.externalStemRole)) {
                created.setAudioSourceMetadata(
                  created.sourceCount(),
                  typeof clip.contentHash === 'string' ? clip.contentHash : '',
                  clip.externalStemRole,
                );
              }
            } else {
              // Later clips register a throwaway placeholder source and are
              // rebound to the asset's shared source right after.
              newClipId = created.addClip({
                trackId,
                isMidi: false,
                startPpq,
                lengthPpq,
                sourceOffsetPpq,
                gain,
                ...placeholderSourceAudio(),
              });
              created.setClipSource(newClipId, existingSource);
            }
            if ((clip.fadeInPpq ?? 0) > 0 || (clip.fadeOutPpq ?? 0) > 0) {
              created.setClipFade(
                newClipId,
                { lengthPpq: clip.fadeInPpq ?? 0 },
                { lengthPpq: clip.fadeOutPpq ?? 0 },
              );
            }
          } else {
            newClipId = created.addClip({
              trackId,
              isMidi: true,
              startPpq,
              lengthPpq,
              sourceOffsetPpq,
              gain,
            });
            if (clip.notes.length > 0) {
              // notesToProjectEvents reads the module-scope wasm handle, which
              // is already set above.
              created.setMidiEvents(newClipId, notesToProjectEvents(clip.notes));
            }
          }
          if (clip.loopEnabled) {
            created.setClipLoop(
              newClipId,
              'loop',
              finiteAtLeast(clip.loopLengthPpq, Number.EPSILON, lengthPpq),
            );
          }
          if (
            isAudio &&
            clip.warp !== undefined &&
            typeof clip.warp.enabled === 'boolean' &&
            Number.isFinite(clip.warp.sourceBpm) &&
            clip.warp.sourceBpm > 0
          ) {
            installProjectClipWarp(
              created,
              {
                id: newClipId,
                startPpq,
                lengthPpq,
                sourceOffsetPpq,
                warp: sanitizeClipWarp(clip.warp, lengthPpq),
              },
              normalizedTempo,
            );
          }
          clipMeta.set(newClipId, safeClip);
          if (firstClipId < 0) firstClipId = newClipId;
        }
      });

      // Resolve positional group membership and insert sidechain sources onto
      // the freshly assigned track ids (out-of-range or self references drop).
      doc.tracks.forEach((track, index) => {
        const entry = trackMirror[index];
        if (!entry) return;
        if (
          track.groupIndex !== undefined &&
          Number.isInteger(track.groupIndex) &&
          track.groupIndex >= 0 &&
          track.groupIndex < trackMirror.length &&
          track.groupIndex !== index &&
          trackMirror[track.groupIndex].kind === 'group'
        ) {
          entry.groupId = trackMirror[track.groupIndex].id;
        }
        const inserts = track.mixer?.inserts ?? [];
        inserts.forEach((slot, slotIndex) => {
          const sourceIndex = (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex;
          if (
            entry.kind === 'group' ||
            sourceIndex === undefined ||
            !Number.isInteger(sourceIndex) ||
            sourceIndex < 0 ||
            sourceIndex >= trackMirror.length ||
            sourceIndex === index
          ) {
            return;
          }
          const target = entry.mixer?.inserts[slotIndex];
          if (target) target.sidechainSourceTrackId = trackMirror[sourceIndex].id;
        });
        // The positional document field must not survive in the mirror (it
        // would re-serialize stale after track reorders).
        for (const slot of entry.mixer?.inserts ?? []) {
          delete (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex;
        }
      });

      // Replay the chord-track annotation stream onto the rebuilt Project so it
      // round-trips through refresh() below (chords are read back from toJson).
      const documentChords = sanitizeChordSymbols(doc.chords ?? []);
      if (documentChords.length > 0) {
        created.annotateChords(toProjectChordSymbols(documentChords));
      }

      // Keep the previous Project and complete mirror snapshot alive until the
      // new Project plus every app-only field has hydrated successfully.
      // refresh() reads the module-scope Project, so a temporary publish is
      // necessary; the rollback closure makes that publish transactional.
      const previousProject = project;
      const previousAudioSourceIds = audioSourceIds;
      const previousMidiCcBindings = new Map(midiCcBindings.value);
      const previousState = {
        projectName: projectName.value,
        tracks: tracks.value,
        clips: clips.value,
        markers: markers.value,
        chords: chords.value,
        sections: sections.value,
        automationLanes: automationLanes.value,
        controlSurface: controlSurface.value,
        mixer: mixer.value,
        projectExternalMidi: projectExternalMidi.value,
        activeTrackId: activeTrackId.value,
        clipId: clipId.value,
        clipStartPpq: clipStartPpq.value,
        clipLengthPpq: clipLengthPpq.value,
        notes: notes.value,
        selection: selection.value,
        tempoBpm: tempoBpm.value,
        tempoSegments: tempoSegments.value,
        timeSignatures: timeSignatures.value,
        pickupLengthPpq: pickupLengthPpq.value,
        snapDivision: snapDivision.value,
        snapBar: snapBar.value,
        quantizeStrength: quantizeStrength.value,
        quantizeSwing: quantizeSwing.value,
        snapEnabled: snapEnabled.value,
        scaleHighlight: scaleHighlight.value,
        scoreAnnotations: scoreAnnotations.value,
        displayTransposeSemitones: displayTransposeSemitones.value,
        scoreDisplaySettings: scoreDisplaySettings.value,
        initialized: initialized.value,
        nextNoteId,
        nextMarkerId,
        nextSectionId,
      };
      restorePreviousState = () => {
        project = previousProject;
        wasmModule = previousWasmModuleAtEntry;
        audioSourceIds = previousAudioSourceIds;
        projectName.value = previousState.projectName;
        tracks.value = previousState.tracks;
        clips.value = previousState.clips;
        markers.value = previousState.markers;
        chords.value = previousState.chords;
        sections.value = previousState.sections;
        automationLanes.value = previousState.automationLanes;
        controlSurface.value = previousState.controlSurface;
        mixer.value = previousState.mixer;
        projectExternalMidi.value = previousState.projectExternalMidi;
        activeTrackId.value = previousState.activeTrackId;
        clipId.value = previousState.clipId;
        clipStartPpq.value = previousState.clipStartPpq;
        clipLengthPpq.value = previousState.clipLengthPpq;
        notes.value = previousState.notes;
        selection.value = previousState.selection;
        tempoBpm.value = previousState.tempoBpm;
        tempoSegments.value = previousState.tempoSegments;
        timeSignatures.value = previousState.timeSignatures;
        pickupLengthPpq.value = previousState.pickupLengthPpq;
        snapDivision.value = previousState.snapDivision;
        snapBar.value = previousState.snapBar;
        quantizeStrength.value = previousState.quantizeStrength;
        quantizeSwing.value = previousState.quantizeSwing;
        snapEnabled.value = previousState.snapEnabled;
        scaleHighlight.value = previousState.scaleHighlight;
        scoreAnnotations.value = previousState.scoreAnnotations;
        displayTransposeSemitones.value = previousState.displayTransposeSemitones;
        scoreDisplaySettings.value = previousState.scoreDisplaySettings;
        initialized.value = previousState.initialized;
        nextNoteId = previousState.nextNoteId;
        nextMarkerId = previousState.nextMarkerId;
        nextSectionId = previousState.nextSectionId;
        midiCcBindings.value.clear();
        for (const [target, binding] of previousMidiCcBindings) {
          midiCcBindings.value.set(target, binding);
        }
      };
      project = created;
      audioSourceIds = loadedSourceIds;
      projectName.value = doc.name || DEFAULT_PROJECT_NAME;
      mixer.value = doc.mixer
        ? cloneMixerState({
            ...doc.mixer,
            ...(normalizeMixerSoloMode(doc.mixer.soloMode) === 'inPlace'
              ? { soloMode: undefined }
              : { soloMode: normalizeMixerSoloMode(doc.mixer.soloMode) }),
            master: { ...doc.mixer.master, sends: [] },
            buses: doc.mixer.buses.map(({ automation: _automation, ...bus }) => bus),
          })
        : createDefaultMixerState();
      resolveStripSidechainSourceIds(
        mixer.value.master.inserts as InsertWithDocumentSidechainIndex[],
        trackMirror,
      );
      for (const bus of mixer.value.buses) {
        resolveStripSidechainSourceIds(
          bus.strip?.inserts as InsertWithDocumentSidechainIndex[] | undefined,
          trackMirror,
        );
      }
      ensureMixerProcessorIds(mixer.value);
      for (const track of trackMirror) {
        if (track.mixer) ensureProcessorIds(track.mixer.inserts);
      }
      projectExternalMidi.value = doc.externalMidiDefault
        ? (cloneInstrument(doc.externalMidiDefault) as ExternalMidiInstrument)
        : null;
      tracks.value = trackMirror;
      clips.value = [];
      markers.value = doc.markers.filter(isDocumentMarker).map((marker) => ({
        id: nextMarkerId++,
        ppq: marker.ppq,
        name: marker.name,
      }));
      sections.value = doc.sections
        .filter(isDocumentSection)
        .map((section) => ({
          id: nextSectionId++,
          name: section.name,
          color: section.color || DEFAULT_SECTION_COLOR,
          startPpq: section.startPpq,
          endPpq: section.endPpq,
        }))
        .sort((a, b) => a.startPpq - b.startPpq || a.endPpq - b.endPpq);
      // Older documents have no automation; malformed entries are dropped.
      // Insert lanes are then pruned against the restored strips so a slot
      // index past the strip's insert count never lingers.
      const insertLaneContext = {
        trackStrips: new Map(trackMirror.map((track) => [track.id, track.mixer])),
        master: mixer.value.master,
        busStrips: new Map(mixer.value.buses.map((bus) => [bus.id, bus.strip])),
      };
      automationLanes.value = pruneInsertLanesAgainstStrips(
        migrateAutomationLanesToProcessorIds(
          [
            ...laneMirror,
            ...sanitizeAutomationEntries(doc.masterAutomation, 'master'),
            ...(doc.mixer?.buses.flatMap((bus) =>
              sanitizeAutomationEntries(bus.automation, busAutomationTarget(bus.id)),
            ) ?? []),
          ],
          insertLaneContext,
          mixer.value.masteringChain,
        ),
        insertLaneContext,
      );
      // CC bindings are mutated in place to keep the map identity stable for
      // any long-lived MIDI-learn handle; malformed entries are dropped.
      // Track-scoped targets hold a positional index, rebound to the freshly
      // assigned track id (a dangling index drops the binding).
      midiCcBindings.value.clear();
      for (const binding of sanitizeMidiCcBindings(doc.midiCcBindings)) {
        let target: string | null = binding.target;
        if (binding.trackScoped) {
          const index = midiLearnTargetScope(binding.target);
          const mapped = typeof index === 'number' ? trackMirror[index] : undefined;
          target = mapped ? withMidiLearnTargetScope(binding.target, mapped.id) : null;
        }
        if (target !== null) {
          target = migrateMidiLearnTargetToProcessorId(target, {
            insert: (scope, index) => {
              const strip =
                scope === 'master'
                  ? mixer.value.master
                  : trackMirror.find((track) => track.id === scope)?.mixer;
              return strip?.inserts[index]?.id;
            },
            mastering: (index) => mixer.value.masteringChain?.processors[index]?.id,
          });
        }
        if (target === null) continue;
        midiCcBindings.value.set(target, {
          channel: binding.channel,
          controller: binding.controller,
          ...(binding.kind && binding.kind !== 'cc' ? { kind: binding.kind } : {}),
          ...(binding.parameter !== undefined ? { parameter: binding.parameter } : {}),
        });
      }
      // The bank offset is stored as written but clamped against the loaded
      // track count, so a window saved on a bigger session still lands on a
      // real track here.
      const surface = sanitizeControlSurfaceSettings(doc.controlSurface);
      controlSurface.value = {
        ...surface,
        bankOffset: clampBankOffset(surface.bankOffset, trackMirror.length, surface.bankSize),
      };
      activeTrackId.value = trackMirror[0]?.id ?? -1;
      clipId.value = firstClipId;
      selection.value = new Set();
      // The native Project does not serialize additive groups. Seed its
      // read-back with the document's app-side meter metadata.
      timeSignatures.value = doc.timeSignatures.map((segment) => ({
        ...segment,
        ...(segment.grouping !== undefined ? { grouping: [...segment.grouping] } : {}),
      }));
      initialized.value = true;
      // The document, not the annotation stream, records which chord tones are
      // silent, so the chord read-back is seeded from what was loaded rather
      // than from the outgoing session's mirror.
      refresh(undefined, documentChords);
      // Loading establishes a new document baseline; the replay edits used to
      // hydrate the native Project must not consume user undo depth.
      created.clearHistory();
      // Clip names, kinds and asset references are app metadata: apply them
      // after refresh built the clip mirror from the Project.
      clips.value = applyDocumentClipMetadata(clips.value, clipMeta);
      // Score annotations are content-addressed in the document; re-associate
      // them onto the freshly assigned editor note ids per clip.
      scoreAnnotations.value = restoreDocumentScoreAnnotations(clips.value, clipMeta);
      const transpose = doc.score?.displayTransposeSemitones ?? 0;
      displayTransposeSemitones.value =
        Number.isInteger(transpose) &&
        transpose >= DISPLAY_TRANSPOSE_MIN &&
        transpose <= DISPLAY_TRANSPOSE_MAX
          ? transpose
          : 0;
      scoreDisplaySettings.value = scoreDisplaySettingsFromDocument(doc.score);
      pickupLengthPpq.value =
        typeof doc.pickupLengthPpq === 'number' &&
        Number.isFinite(doc.pickupLengthPpq) &&
        doc.pickupLengthPpq > 0
          ? doc.pickupLengthPpq
          : 0;
      const scale = doc.scaleHighlight;
      scaleHighlight.value =
        scale !== undefined &&
        typeof scale.enabled === 'boolean' &&
        Number.isInteger(scale.rootPc) &&
        scale.rootPc >= 0 &&
        scale.rootPc < 12 &&
        Number.isInteger(scale.modeMask) &&
        scale.modeMask >= 0 &&
        scale.modeMask < 1 << 12
          ? { enabled: scale.enabled, rootPc: scale.rootPc, modeMask: scale.modeMask }
          : { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
      documentGeneration.value += 1;
      restorePreviousState = null;
      try {
        previousProject?.delete();
      } catch {
        // The new state is already complete; a destructor failure must not
        // roll it back to an object that may have been partially released.
      }
    } catch (error) {
      if (restorePreviousState) restorePreviousState();
      created.delete();
      throw error;
    }
  }

  /**
   * Releases the wasm Project and resets the mirror. The command layer's
   * undo/redo history is dropped through the registered reset hook so its
   * snapshots cannot dangle against the deleted Project.
   */
  function dispose(): void {
    documentGeneration.value += 1;
    historyResetHook?.();
    if (project) {
      project.delete();
      project = null;
    }
    audioSourceIds = new Map();
    nextNoteId = 1;
    nextMarkerId = 1;
    nextSectionId = 1;
    initialized.value = false;
    projectName.value = DEFAULT_PROJECT_NAME;
    tracks.value = [];
    clips.value = [];
    markers.value = [];
    chords.value = [];
    sections.value = [];
    automationLanes.value = [];
    midiCcBindings.value.clear();
    controlSurface.value = defaultControlSurfaceSettings();
    mixer.value = createDefaultMixerState();
    projectExternalMidi.value = null;
    activeTrackId.value = -1;
    trackSelection.value = new Set();
    clipId.value = -1;
    clipSelection.value = new Set();
    clipStartPpq.value = 0;
    clipLengthPpq.value = 0;
    notes.value = [];
    selection.value = new Set();
    tempoBpm.value = DEFAULT_TEMPO_BPM;
    tempoSegments.value = [];
    timeSignatures.value = [];
    pickupLengthPpq.value = 0;
    snapDivision.value = DEFAULT_SNAP_DIVISION;
    snapBar.value = false;
    quantizeStrength.value = 1;
    quantizeSwing.value = 0;
    grooveTemplate.value = null;
    snapEnabled.value = true;
    scaleHighlight.value = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    scoreAnnotations.value = {};
    displayTransposeSemitones.value = 0;
    scoreDisplaySettings.value = createDefaultScoreDisplaySettings();
  }

  return {
    projectName,
    tracks,
    clips,
    markers,
    chords,
    sections,
    automationLanes,
    midiCcBindings,
    controlSurface,
    mixer,
    projectExternalMidi,
    activeTrackId,
    trackSelection,
    clipId,
    clipSelection,
    clipStartPpq,
    clipLengthPpq,
    notes,
    selection,
    tempoBpm,
    tempoSegments,
    timeSignatures,
    pickupLengthPpq,
    snapDivision,
    snapBar,
    quantizeStrength,
    quantizeSwing,
    grooveTemplate,
    snapEnabled,
    scaleHighlight,
    scoreAnnotations,
    displayTransposeSemitones,
    scoreDisplaySettings,
    initialized,
    documentGeneration,
    highlightedPitchClasses,
    selectedNotes,
    activeTrack,
    activeClip,
    clipsByTrack,
    init,
    loadDocument,
    refresh,
    dispose,
  };
});
