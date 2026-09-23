import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { detectScaleHighlightFromTracks } from '@/compose/key';
import { ensureWasm } from '@/lib/wasm';
import {
  type MidiCcBinding,
  midiLearnTargetScope,
  migrateMidiLearnTargetToProcessorId,
  sanitizeMidiCcBindings,
  withMidiLearnTargetScope,
} from '@/ui/midi/midi-learn';
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
import { chordsFromAnnotation, type EditorChordSymbol } from './chords';
import {
  type ControlSurfaceSettings,
  clampBankOffset,
  defaultControlSurfaceSettings,
  sanitizeControlSurfaceSettings,
} from './control-surface';
import { normalizeGenerationSeed } from './generation';
import type { GrooveTemplate } from './groove';
import { cloneInstrument, type ExternalMidiInstrument } from './instrument';
import {
  cloneMixerState,
  createDefaultMixerState,
  engineBusCount,
  ensureMixerProcessorIds,
  ensureProcessorIds,
  MAX_MIXER_BUSES,
  normalizeMixerSoloMode,
  type ProjectMixerState,
} from './mixer';
import {
  adoptProject,
  allocateMarkerId,
  allocateNoteId,
  allocateSectionId,
  currentAudioSourceIds,
  currentProject,
  currentWasmModule,
  DEFAULT_CLIP_LENGTH_PPQ,
  DEFAULT_PROJECT_NAME,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_SNAP_DIVISION,
  DEFAULT_TEMPO_BPM,
  DEFAULT_TRACK_NAME,
  getAudioSourceId,
  getProject,
  getWasmModule,
  idCounters,
  notesToProjectEvents,
  PROJECT_MAX_UNDO_DEPTH,
  placeholderSourceAudio,
  resetProjectRuntime,
  restoreIdCounters,
  restoreProject,
  runHistoryReset,
  setAudioSourceId,
  setHistoryResetHook,
  setWasmModule,
} from './runtime';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from './serialization';
import {
  applyDocumentClipMetadata,
  hydrateProjectFromDocument,
  restoreDocumentScoreAnnotations,
} from './store-load';
import {
  buildClipMirror,
  buildTrackMirror,
  type NoteIdHints,
  type NoteProvenanceHints,
  refreshTempoMeter,
  type SerializedProjectDoc,
} from './store-refresh';
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

type InsertWithDocumentSidechainIndex = {
  sidechainSourceIndex?: number;
  sidechainSourceTrackId?: number;
};

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

/** Per-clip note id hints accepted by {@link useProjectStore refresh}. */
export type { NoteIdHints, NoteProvenanceHints };
// The wasm handle and its counters live in ./runtime; `./store` stays the
// import point for them so a caller reaches for one module, not two.
export {
  allocateMarkerId,
  allocateNoteId,
  allocateSectionId,
  getAudioSourceId,
  getProject,
  getWasmModule,
  notesToProjectEvents,
  PROJECT_MAX_UNDO_DEPTH,
  placeholderSourceAudio,
  setAudioSourceId,
  setHistoryResetHook,
};

/**
 * Pinia store mirroring the wasm Project for the arrangement and the
 * piano-roll editor.
 *
 * State is a read model: every mutating command writes to the Project first
 * (src/project/commands.ts) and then calls {@link refresh} to re-read it.
 * Track/clip structure, names (tracks), timing, gain and loop state come from
 * the Project; app-only fields (track color/mute/solo/volume/pan/order, clip
 * names, markers, sections) live in this mirror and are merged in by id.
 *
 * Two neighbours carry the rest of the job. `./runtime` owns the wasm handle
 * and the counters that hang off it, which outlive any one store instance;
 * `./store-load` turns a serialized document into a filled Project, which this
 * store then adopts. What is left here is the mirror and the readings over it.
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
  const generationSeed = ref(0);
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
   * Whether the current {@link scaleHighlight} was estimated from the project's
   * notes instead of chosen (editor-only, not undoable and never written to the
   * document — an estimate is re-derived on every load, so persisting it would
   * turn a guess into an authored key). The theory card hedges its readings
   * while this is set.
   */
  const scaleHighlightEstimated = ref(false);
  /**
   * Whether the last lead-follow reconcile was skipped because thinning would
   * exceed the undo budget or a write failed (editor-only, not undoable and
   * never persisted). Cleared by the next reconcile that completes.
   */
  const leadFollowDeferred = ref(false);
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
    const mod = currentWasmModule();
    const config = scaleHighlight.value;
    if (!initialized.value || !mod || !config.enabled) {
      return Array.from({ length: 12 }, () => false);
    }
    return Array.from({ length: 12 }, (_, pc) =>
      mod.scalePitchClassEnabled(config.rootPc, config.modeMask, pc),
    );
  });

  /**
   * The key detection installed on the last load, kept so a later write can be
   * told apart from it. Null once the estimate no longer stands.
   */
  let estimatedKey: { rootPc: number; modeMask: number } | null = null;

  /**
   * Applies a scale highlight the user chose, which is what makes the key
   * theirs: an estimate stops being reported (and starts being persisted) even
   * when they land on exactly the key detection had guessed, since settling on
   * a reading is a decision the app must not keep second-guessing.
   *
   * This is the contract for every key-editing surface. The watch below is only
   * a backstop for code that assigns `scaleHighlight` directly.
   *
   * @param config The chosen scale highlight.
   */
  function setScaleHighlight(config: ScaleHighlightConfig): void {
    scaleHighlight.value = { ...config };
    scaleHighlightEstimated.value = false;
    estimatedKey = null;
  }

  /**
   * Shows or hides the scale highlight without touching the key it draws.
   *
   * Visibility is not authorship: hiding the highlight says nothing about which
   * key the piece is in, so an estimate stays an estimate (and stays out of the
   * document) across the toggle.
   *
   * @param enabled Whether the highlight is drawn.
   */
  function setScaleHighlightEnabled(enabled: boolean): void {
    scaleHighlight.value = { ...scaleHighlight.value, enabled };
  }

  // Backstop for writers that bypass setScaleHighlight and assign the ref
  // directly: a key other than the detected one cannot be an estimate, whoever
  // wrote it. Only the two key fields are watched, so the visibility toggle
  // above passes through without disturbing the flag.
  watch(
    () => [scaleHighlight.value.rootPc, scaleHighlight.value.modeMask] as const,
    ([rootPc, modeMask]) => {
      if (!scaleHighlightEstimated.value) return;
      if (rootPc === estimatedKey?.rootPc && modeMask === estimatedKey.modeMask) return;
      scaleHighlightEstimated.value = false;
      estimatedKey = null;
    },
  );

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
   * A transform that rewrites content defeats content matching, so a clip the
   * engine baked passes {@link NoteProvenanceHints} instead and the ids follow
   * the engine's own per-event origins.
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
    const live = currentProject();
    if (!live) return;
    const doc = JSON.parse(live.toJson()) as SerializedProjectDoc;

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
    const current = currentProject();
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
    setWasmModule(mod);
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
    adoptProject(created, new Map());
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
    generationSeed.value = 0;
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
    const previousWasmModuleAtEntry = currentWasmModule();
    const mod = await ensureWasm();
    let restorePreviousState: (() => void) | null = null;
    setWasmModule(mod);
    const created = new mod.Project();
    try {
      const { trackMirror, laneMirror, clipMeta, loadedSourceIds, firstClipId, documentChords } =
        hydrateProjectFromDocument(created, doc);

      // Keep the previous Project and complete mirror snapshot alive until the
      // new Project plus every app-only field has hydrated successfully.
      // refresh() reads the module-scope Project, so a temporary publish is
      // necessary; the rollback closure makes that publish transactional.
      const previousProject = currentProject();
      const previousAudioSourceIds = currentAudioSourceIds();
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
        generationSeed: generationSeed.value,
        snapDivision: snapDivision.value,
        snapBar: snapBar.value,
        quantizeStrength: quantizeStrength.value,
        quantizeSwing: quantizeSwing.value,
        snapEnabled: snapEnabled.value,
        scaleHighlight: scaleHighlight.value,
        scaleHighlightEstimated: scaleHighlightEstimated.value,
        scoreAnnotations: scoreAnnotations.value,
        displayTransposeSemitones: displayTransposeSemitones.value,
        scoreDisplaySettings: scoreDisplaySettings.value,
        initialized: initialized.value,
        counters: idCounters(),
      };
      restorePreviousState = () => {
        restoreProject(previousProject, previousWasmModuleAtEntry, previousAudioSourceIds);
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
        generationSeed.value = previousState.generationSeed;
        snapDivision.value = previousState.snapDivision;
        snapBar.value = previousState.snapBar;
        quantizeStrength.value = previousState.quantizeStrength;
        quantizeSwing.value = previousState.quantizeSwing;
        snapEnabled.value = previousState.snapEnabled;
        scaleHighlight.value = previousState.scaleHighlight;
        scaleHighlightEstimated.value = previousState.scaleHighlightEstimated;
        scoreAnnotations.value = previousState.scoreAnnotations;
        displayTransposeSemitones.value = previousState.displayTransposeSemitones;
        scoreDisplaySettings.value = previousState.scoreDisplaySettings;
        initialized.value = previousState.initialized;
        restoreIdCounters(previousState.counters);
        midiCcBindings.value.clear();
        for (const [target, binding] of previousMidiCcBindings) {
          midiCcBindings.value.set(target, binding);
        }
      };
      adoptProject(created, loadedSourceIds);
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
        id: allocateMarkerId(),
        ppq: marker.ppq,
        name: marker.name,
      }));
      sections.value = doc.sections
        .filter(isDocumentSection)
        .map((section) => ({
          id: allocateSectionId(),
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
      generationSeed.value = normalizeGenerationSeed(doc.generationSeed);
      const scale = doc.scaleHighlight;
      const authoredScale =
        scale !== undefined &&
        typeof scale.enabled === 'boolean' &&
        Number.isInteger(scale.rootPc) &&
        scale.rootPc >= 0 &&
        scale.rootPc < 12 &&
        Number.isInteger(scale.modeMask) &&
        scale.modeMask >= 0 &&
        scale.modeMask < 1 << 12
          ? { enabled: scale.enabled, rootPc: scale.rootPc, modeMask: scale.modeMask }
          : null;
      // A document that names no key used to be read as C major, which every
      // theory surface then measured the music against without saying so.
      // Estimate one from what was loaded instead; C major remains the answer
      // only when there is nothing to estimate from (an empty project, or notes
      // that settle on no tonic).
      const estimated =
        authoredScale === null
          ? detectScaleHighlightFromTracks(
              tracks.value.map((track) => ({
                track,
                notes: clips.value
                  .filter((clip) => clip.trackId === track.id)
                  .flatMap((clip) =>
                    clip.notes.map((clipNote) => ({
                      ...clipNote,
                      startPpq: clip.startPpq + clipNote.startPpq,
                    })),
                  ),
              })),
            )
          : null;
      scaleHighlight.value = authoredScale ??
        estimated ?? { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
      scaleHighlightEstimated.value = estimated !== null;
      estimatedKey =
        estimated !== null ? { rootPc: estimated.rootPc, modeMask: estimated.modeMask } : null;
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
    runHistoryReset();
    currentProject()?.delete();
    resetProjectRuntime();
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
    generationSeed.value = 0;
    snapDivision.value = DEFAULT_SNAP_DIVISION;
    snapBar.value = false;
    quantizeStrength.value = 1;
    quantizeSwing.value = 0;
    grooveTemplate.value = null;
    snapEnabled.value = true;
    scaleHighlight.value = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    scaleHighlightEstimated.value = false;
    leadFollowDeferred.value = false;
    estimatedKey = null;
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
    generationSeed,
    snapDivision,
    snapBar,
    quantizeStrength,
    quantizeSwing,
    grooveTemplate,
    snapEnabled,
    scaleHighlight,
    scaleHighlightEstimated,
    leadFollowDeferred,
    setScaleHighlight,
    setScaleHighlightEnabled,
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
