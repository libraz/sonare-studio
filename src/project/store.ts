import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ensureWasm } from '@/lib/wasm';
import { audioAssetUri } from '@/persistence/assets';
import type { Project, ProjectMidiEvent } from '@/wasm/index.js';
import {
  annotationsFromDocument,
  DISPLAY_TRANSPOSE_MAX,
  DISPLAY_TRANSPOSE_MIN,
  type ScoreAnnotations,
} from './annotations';
import { type AutomationLaneState, sanitizeAutomationEntries } from './automation';
import {
  chordsFromAnnotation,
  type EditorChordSymbol,
  sanitizeChordSymbols,
  toProjectChordSymbols,
} from './chords';
import { cloneInstrument } from './instrument';
import { cloneCcLanes, isValidChannel, isValidController, sanitizeCcPoints } from './midi-cc';
import {
  noteKey,
  notesToProjectMidiEvents,
  pairEventsIntoNotes,
  type RawNote,
  type SerializedMidiEvent,
} from './midi-events';
import {
  cloneMixerState,
  cloneStrip,
  createDefaultMixerState,
  type ProjectMixerState,
} from './mixer';
import type { DocumentClip, ProjectDocument } from './serialization';
import {
  type ClipCcLane,
  type ClipKind,
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
  type TrackKind,
} from './types';

type WasmModule = typeof import('@/wasm/index.js');

/** Default project tempo in BPM. */
const DEFAULT_TEMPO_BPM = 120;

/** Default clip length: eight 4/4 bars expressed in quarter-note PPQ. */
const DEFAULT_CLIP_LENGTH_PPQ = 32;

/** Default snap grid: divisions per whole note (16 = sixteenth-note grid). */
const DEFAULT_SNAP_DIVISION = 16;

/** Default project sample rate used until an AudioContext provides the real one. */
const DEFAULT_SAMPLE_RATE = 48000;

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

/** Shape of one serialized tempo segment inside the Project JSON document. */
interface SerializedTempoSegment {
  start_ppq: number;
  bpm: number;
  end_bpm?: number;
}

/** Shape of one serialized time signature inside the Project JSON document. */
interface SerializedTimeSignature {
  start_ppq: number;
  numerator: number;
  denominator: number;
}

/** Shape of one serialized track inside the Project JSON document. */
interface SerializedTrack {
  id: number;
  kind: number;
  name: string;
}

/** Shape of one serialized clip fade (the binding nests length and curve). */
interface SerializedClipFade {
  length_ppq?: number;
  curve?: number;
}

/** Shape of one serialized clip inside the Project JSON document. */
interface SerializedClip {
  id: number;
  track_id: number;
  start_ppq: number;
  length_ppq: number;
  source_offset_ppq: number;
  gain: number;
  loop_mode: number;
  loop_length_ppq: number;
  /** Flat fade lengths (older bindings); omitted when not serialized. */
  fade_in_ppq?: number;
  fade_out_ppq?: number;
  /** Nested fade objects (current binding); omitted when not serialized. */
  fade_in?: SerializedClipFade;
  fade_out?: SerializedClipFade;
}

/** Reads a clip fade length from either serialized form, or null. */
function serializedFadePpq(
  flat: number | undefined,
  nested: SerializedClipFade | undefined,
): number | null {
  if (typeof flat === 'number') return flat;
  if (nested && typeof nested.length_ppq === 'number') return nested.length_ppq;
  return null;
}

/** Minimal slice of the Project JSON document this store reads. */
interface SerializedProjectDoc {
  midi_content?: Record<string, unknown>;
  tempo_segments?: SerializedTempoSegment[];
  time_signatures?: SerializedTimeSignature[];
  tracks?: SerializedTrack[];
  clips?: SerializedClip[];
  annotation?: { chords?: unknown };
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

/** Maps a serialized track-kind ordinal to the string form. */
function trackKindFromOrdinal(kind: number): TrackKind {
  if (kind === 0) return 'audio';
  if (kind === 2) return 'aux';
  return 'midi';
}

/** Per-clip note id hints accepted by {@link useProjectStore refresh}. */
export type NoteIdHints =
  | ReadonlyArray<EditorNote>
  | ReadonlyMap<number, ReadonlyArray<EditorNote>>;

/**
 * Re-associates editor ids onto raw notes by exact content key against the
 * given hints. Notes with no matching hint receive fresh ids.
 */
function assignNoteIds(raw: RawNote[], hints: ReadonlyArray<EditorNote>): EditorNote[] {
  const pool = new Map<string, EditorNote[]>();
  for (const hint of hints) {
    const key = noteKey(hint);
    const bucket = pool.get(key) ?? [];
    bucket.push(hint);
    pool.set(key, bucket);
  }
  return raw.map((candidate) => {
    const match = pool.get(noteKey(candidate))?.shift();
    // Prefer the hint's exact field values: durations recovered from the
    // Project are subject to floating-point noise (offPpq - startPpq).
    return match ? { ...match } : { id: nextNoteId++, ...candidate };
  });
}

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
  const tracks = ref<EditorTrack[]>([]);
  /** Clip mirror, ordered by (track order, startPpq, id). */
  const clips = ref<EditorClip[]>([]);
  /** Timeline markers (app-level). */
  const markers = ref<EditorMarker[]>([]);
  /** Chord-track symbols, mirroring the Project's annotation stream. */
  const chords = ref<EditorChordSymbol[]>([]);
  /** Arrangement sections (app-level), ordered by startPpq. */
  const sections = ref<EditorSection[]>([]);
  /** Automation lanes (app-level), one per (target, param) pair. */
  const automationLanes = ref<AutomationLaneState[]>([]);
  /** Project mixer state: master strip + buses (app-level metadata). */
  const mixer = ref<ProjectMixerState>(createDefaultMixerState());
  /** Id of the active (focused) track (-1 when there is none). */
  const activeTrackId = ref(-1);
  /** Id of the active MIDI clip edited by the piano roll (-1 when none). */
  const clipId = ref(-1);
  /** Timeline start of the active clip, in PPQ. */
  const clipStartPpq = ref(0);
  /** Length of the active clip, in PPQ. */
  const clipLengthPpq = ref(0);
  /** Mirror of the active clip's note content, with editor-assigned ids. */
  const notes = ref<EditorNote[]>([]);
  /** Ids of currently selected notes (within the active clip). */
  const selection = ref<Set<number>>(new Set());
  /** Project tempo in BPM (first tempo segment). */
  const tempoBpm = ref(DEFAULT_TEMPO_BPM);
  /** Full tempo map mirror. */
  const tempoSegments = ref<TempoSegment[]>([]);
  /** Time-signature map mirror. */
  const timeSignatures = ref<TimeSignatureSegment[]>([]);
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
  /**
   * Display-only score annotations keyed by clip id then editor note id
   * (app-level metadata; never written to the Project or to MIDI data).
   * Entries whose note no longer exists are ignored by the score pipeline.
   */
  const scoreAnnotations = ref<ScoreAnnotations>({});
  /** Score display transpose in semitones (engraving only; MIDI is never changed). */
  const displayTransposeSemitones = ref(0);
  /** True once init() has created the Project and the default track/clip. */
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

  /** Builds a default track mirror entry for a track first seen in the Project. */
  function defaultTrackMirror(serialized: SerializedTrack, index: number): EditorTrack {
    return {
      id: serialized.id,
      name: serialized.name ?? `Track ${index + 1}`,
      color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
      kind: trackKindFromOrdinal(serialized.kind),
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      order: index,
    };
  }

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
   * @param idHints Id-annotated notes expected to match the Project content.
   */
  function refresh(idHints?: NoteIdHints): void {
    if (!project) return;
    const doc = JSON.parse(project.toJson()) as SerializedProjectDoc;

    // Tempo and meter mirrors.
    const tempoDoc = Array.isArray(doc.tempo_segments) ? doc.tempo_segments : [];
    tempoSegments.value = tempoDoc.map((s) => {
      const segment: TempoSegment = { startPpq: s.start_ppq, bpm: s.bpm };
      if (typeof s.end_bpm === 'number' && s.end_bpm > 0) segment.endBpm = s.end_bpm;
      return segment;
    });
    const bpm = tempoDoc[0]?.bpm;
    if (typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0) tempoBpm.value = bpm;
    const meterDoc = Array.isArray(doc.time_signatures) ? doc.time_signatures : [];
    timeSignatures.value = meterDoc.map((s) => ({
      startPpq: s.start_ppq,
      numerator: s.numerator,
      denominator: s.denominator,
    }));

    // Chord-track mirror: read back the Project's annotation stream (the chord
    // commands write it through annotateChords, so it round-trips here).
    chords.value = chordsFromAnnotation(doc.annotation);

    // Track mirror: structure from the Project, app fields + order from the
    // current mirror; tracks first seen in the Project are appended.
    const docTracks = Array.isArray(doc.tracks) ? doc.tracks : [];
    const docTrackById = new Map(docTracks.map((t) => [t.id, t]));
    const knownIds = new Set(tracks.value.map((t) => t.id));
    const nextTracks: EditorTrack[] = [];
    for (const previous of tracks.value) {
      const serialized = docTrackById.get(previous.id);
      if (!serialized) continue;
      // Group tracks live as aux tracks in the Project; the app-level 'group'
      // kind survives refresh as long as the Project still reports aux.
      const projectKind = trackKindFromOrdinal(serialized.kind);
      nextTracks.push({
        ...previous,
        name: serialized.name ?? previous.name,
        kind: previous.kind === 'group' && projectKind === 'aux' ? 'group' : projectKind,
      });
    }
    for (const serialized of docTracks) {
      if (!knownIds.has(serialized.id)) {
        nextTracks.push(defaultTrackMirror(serialized, nextTracks.length));
      }
    }
    nextTracks.forEach((track, index) => {
      track.order = index;
    });
    tracks.value = nextTracks;
    const trackOrder = new Map(nextTracks.map((track, index) => [track.id, index]));

    // Clip mirror: structure from the Project, names from the current mirror,
    // notes recovered per clip with id hints.
    const hintMap = idHints instanceof Map ? idHints : null;
    const activeHints = Array.isArray(idHints) ? idHints : null;
    const previousClipById = new Map(clips.value.map((clip) => [clip.id, clip]));
    const docClips = Array.isArray(doc.clips) ? doc.clips : [];
    const nextClips: EditorClip[] = docClips
      .filter((serialized) => trackOrder.has(serialized.track_id))
      .map((serialized) => {
        const previous = previousClipById.get(serialized.id);
        const stored = doc.midi_content?.[String(serialized.id)];
        const events = Array.isArray(stored) ? (stored as SerializedMidiEvent[]) : [];
        const hints =
          hintMap?.get(serialized.id) ??
          (activeHints && serialized.id === clipId.value ? activeHints : null) ??
          previous?.notes ??
          [];
        const entry: EditorClip = {
          id: serialized.id,
          trackId: serialized.track_id,
          name: previous?.name ?? `Clip ${serialized.id}`,
          startPpq: serialized.start_ppq,
          lengthPpq: serialized.length_ppq,
          sourceOffsetPpq: serialized.source_offset_ppq ?? 0,
          gain: serialized.gain ?? 1,
          loopEnabled: serialized.loop_mode === 1,
          loopLengthPpq: serialized.loop_length_ppq ?? 0,
          notes: assignNoteIds(pairEventsIntoNotes(events), hints),
        };
        // Clip kind and asset reference are app-level mirror metadata (the
        // Project document does not expose them); fade lengths prefer the
        // serialized values when the binding reports them.
        if (previous?.kind !== undefined) entry.kind = previous.kind;
        if (previous?.assetId !== undefined) entry.assetId = previous.assetId;
        if (previous?.takes !== undefined) {
          entry.takes = previous.takes.map((take) => ({ ...take }));
          if (previous.compSegments !== undefined) {
            entry.compSegments = previous.compSegments.map((segment) => ({ ...segment }));
          }
        }
        if (previous?.warp !== undefined) {
          entry.warp = {
            ...previous.warp,
            ...(previous.warp.anchors !== undefined
              ? { anchors: previous.warp.anchors.map((anchor) => ({ ...anchor })) }
              : {}),
          };
        }
        // CC lanes are app-level metadata, carried forward across refreshes.
        const ccLanes = cloneCcLanes(previous?.ccLanes);
        if (ccLanes !== undefined) entry.ccLanes = ccLanes;
        const fadeIn =
          serializedFadePpq(serialized.fade_in_ppq, serialized.fade_in) ?? previous?.fadeInPpq ?? 0;
        if (fadeIn > 0) entry.fadeInPpq = fadeIn;
        const fadeOut =
          serializedFadePpq(serialized.fade_out_ppq, serialized.fade_out) ??
          previous?.fadeOutPpq ??
          0;
        if (fadeOut > 0) entry.fadeOutPpq = fadeOut;
        return entry;
      });
    nextClips.sort(
      (a, b) =>
        (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0) ||
        a.startPpq - b.startPpq ||
        a.id - b.id,
    );
    clips.value = nextClips;

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
  async function init(options: { sampleRate?: number } = {}): Promise<void> {
    if (project) return;
    const mod = await ensureWasm();
    if (project) return; // another init() call won the race while awaiting
    wasmModule = mod;
    const created = new mod.Project();
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
    activeTrackId.value = trackId;
    clipId.value = newClipId;
    clipStartPpq.value = 0;
    clipLengthPpq.value = DEFAULT_CLIP_LENGTH_PPQ;
    tempoBpm.value = DEFAULT_TEMPO_BPM;
    notes.value = [];
    selection.value = new Set();
    scoreAnnotations.value = {};
    displayTransposeSemitones.value = 0;
    initialized.value = true;
    refresh();
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
    if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) {
      throw new Error(`Unsupported project document schema version: ${doc.schemaVersion}`);
    }
    const mod = await ensureWasm();
    wasmModule = mod;
    const created = new mod.Project();
    try {
      created.setSampleRate(doc.sampleRate > 0 ? doc.sampleRate : DEFAULT_SAMPLE_RATE);
      const tempo =
        doc.tempoSegments.length > 0
          ? doc.tempoSegments
          : [{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }];
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
        const mirrorEntry: EditorTrack = {
          id: trackId,
          name: track.name,
          color: track.color || TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
          kind: track.kind,
          mute: track.mute,
          solo: track.solo,
          volume: track.volume,
          pan: track.pan,
          order: index,
        };
        // Instrument and mixer strip are app metadata introduced by schema
        // version 3; older documents simply have neither (defaults apply).
        if (track.instrument !== undefined)
          mirrorEntry.instrument = cloneInstrument(track.instrument);
        if (track.soloSafe === true) mirrorEntry.soloSafe = true;
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
        if (track.mixer !== undefined) {
          mirrorEntry.mixer = cloneStrip(track.mixer);
          // Insert sidechain sources are stored positionally; rebind them to
          // the freshly assigned track ids after every track exists (below).
        }
        // Track automation rides the track entry; rebind it to the freshly
        // assigned track id (malformed entries are dropped).
        if (track.automation !== undefined) {
          laneMirror.push(...sanitizeAutomationEntries(track.automation, trackId));
        }
        trackMirror.push(mirrorEntry);
        for (const clip of track.clips) {
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
                startPpq: clip.startPpq,
                lengthPpq: clip.lengthPpq,
                sourceOffsetPpq: clip.sourceOffsetPpq,
                gain: clip.gain,
                ...placeholderSourceAudio(),
                sourceUri: audioAssetUri(assetId),
              });
              loadedSourceIds.set(assetId, created.sourceCount());
            } else {
              // Later clips register a throwaway placeholder source and are
              // rebound to the asset's shared source right after.
              newClipId = created.addClip({
                trackId,
                isMidi: false,
                startPpq: clip.startPpq,
                lengthPpq: clip.lengthPpq,
                sourceOffsetPpq: clip.sourceOffsetPpq,
                gain: clip.gain,
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
              startPpq: clip.startPpq,
              lengthPpq: clip.lengthPpq,
              sourceOffsetPpq: clip.sourceOffsetPpq,
              gain: clip.gain,
            });
            if (clip.notes.length > 0) {
              // notesToProjectEvents reads the module-scope wasm handle, which
              // is already set above.
              created.setMidiEvents(newClipId, notesToProjectEvents(clip.notes));
            }
          }
          if (clip.loopEnabled) {
            created.setClipLoop(newClipId, 'loop', clip.loopLengthPpq || clip.lengthPpq);
          }
          clipMeta.set(newClipId, clip);
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

      if (project) project.delete();
      project = created;
      audioSourceIds = loadedSourceIds;
      projectName.value = doc.name || DEFAULT_PROJECT_NAME;
      mixer.value = doc.mixer ? cloneMixerState(doc.mixer) : createDefaultMixerState();
      tracks.value = trackMirror;
      clips.value = [];
      markers.value = doc.markers.map((marker) => ({
        id: nextMarkerId++,
        ppq: marker.ppq,
        name: marker.name,
      }));
      sections.value = doc.sections
        .map((section) => ({
          id: nextSectionId++,
          name: section.name,
          color: section.color || DEFAULT_SECTION_COLOR,
          startPpq: section.startPpq,
          endPpq: section.endPpq,
        }))
        .sort((a, b) => a.startPpq - b.startPpq || a.endPpq - b.endPpq);
      // Older documents have no automation; malformed entries are dropped.
      automationLanes.value = [
        ...laneMirror,
        ...sanitizeAutomationEntries(doc.masterAutomation, 'master'),
      ];
      activeTrackId.value = trackMirror[0]?.id ?? -1;
      clipId.value = firstClipId;
      selection.value = new Set();
      initialized.value = true;
      refresh();
      // Clip names, kinds and asset references are app metadata: apply them
      // after refresh built the clip mirror from the Project.
      clips.value = clips.value.map((clip) => {
        const meta = clipMeta.get(clip.id);
        if (!meta) return clip;
        const next: EditorClip = { ...clip, name: meta.name };
        const kind: ClipKind = meta.kind === 'audio' ? 'audio' : 'midi';
        if (kind === 'audio') {
          next.kind = 'audio';
          if (meta.assetId !== undefined) next.assetId = meta.assetId;
          if ((meta.fadeInPpq ?? 0) > 0) next.fadeInPpq = meta.fadeInPpq as number;
          if ((meta.fadeOutPpq ?? 0) > 0) next.fadeOutPpq = meta.fadeOutPpq as number;
          // Takes/comping are document metadata; malformed selections are
          // re-sanitized on expansion (src/project/comping.ts).
          if (Array.isArray(meta.takes) && meta.takes.length > 0) {
            next.takes = meta.takes
              .filter((take) => typeof take?.assetId === 'string' && take.assetId.length > 0)
              .map((take) => ({ assetId: take.assetId, name: String(take.name ?? '') }));
            if (next.takes.length === 0) {
              delete next.takes;
            } else if (Array.isArray(meta.compSegments) && meta.compSegments.length > 0) {
              next.compSegments = meta.compSegments.map((segment) => ({
                startPpq: Number(segment.startPpq),
                takeIndex: Number(segment.takeIndex),
              }));
            }
          }
          if (
            meta.warp !== undefined &&
            typeof meta.warp.enabled === 'boolean' &&
            Number.isFinite(meta.warp.sourceBpm) &&
            meta.warp.sourceBpm > 0
          ) {
            next.warp = {
              enabled: meta.warp.enabled,
              sourceBpm: meta.warp.sourceBpm,
              ...(Array.isArray(meta.warp.anchors) && meta.warp.anchors.length > 0
                ? {
                    anchors: meta.warp.anchors.map((anchor) => ({
                      ppq: Number(anchor.ppq),
                      sourceSeconds: Number(anchor.sourceSeconds),
                    })),
                  }
                : {}),
            };
          }
        }
        // CC lanes are MIDI-clip metadata; hydrate and re-sanitize them against
        // the clip window (malformed lanes/points drop out).
        if (kind === 'midi' && Array.isArray(meta.ccLanes) && meta.ccLanes.length > 0) {
          const lanes: ClipCcLane[] = [];
          for (const lane of meta.ccLanes) {
            if (!isValidController(lane.controller) || !isValidChannel(lane.channel)) continue;
            const points = sanitizeCcPoints(
              Array.isArray(lane.points) ? lane.points : [],
              clip.lengthPpq,
            );
            if (points.length > 0) {
              lanes.push({ controller: lane.controller, channel: lane.channel, points });
            }
          }
          if (lanes.length > 0) {
            lanes.sort((a, b) => a.controller - b.controller);
            next.ccLanes = lanes;
          }
        }
        return next;
      });
      // Score annotations are content-addressed in the document; re-associate
      // them onto the freshly assigned editor note ids per clip.
      const nextAnnotations: ScoreAnnotations = {};
      for (const clip of clips.value) {
        const meta = clipMeta.get(clip.id);
        if (!meta?.scoreAnnotations || meta.scoreAnnotations.length === 0) continue;
        const byNote = annotationsFromDocument(meta.scoreAnnotations, clip.notes);
        if (Object.keys(byNote).length > 0) nextAnnotations[clip.id] = byNote;
      }
      scoreAnnotations.value = nextAnnotations;
      const transpose = doc.score?.displayTransposeSemitones ?? 0;
      displayTransposeSemitones.value =
        Number.isInteger(transpose) &&
        transpose >= DISPLAY_TRANSPOSE_MIN &&
        transpose <= DISPLAY_TRANSPOSE_MAX
          ? transpose
          : 0;
    } catch (error) {
      // Keep the previous Project alive when the document fails to replay.
      if (project !== created) created.delete();
      throw error;
    }
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
    mixer.value = createDefaultMixerState();
    activeTrackId.value = -1;
    clipId.value = -1;
    clipStartPpq.value = 0;
    clipLengthPpq.value = 0;
    notes.value = [];
    selection.value = new Set();
    tempoBpm.value = DEFAULT_TEMPO_BPM;
    tempoSegments.value = [];
    timeSignatures.value = [];
    snapDivision.value = DEFAULT_SNAP_DIVISION;
    snapEnabled.value = true;
    scaleHighlight.value = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    scoreAnnotations.value = {};
    displayTransposeSemitones.value = 0;
  }

  return {
    projectName,
    tracks,
    clips,
    markers,
    chords,
    sections,
    automationLanes,
    mixer,
    activeTrackId,
    clipId,
    clipStartPpq,
    clipLengthPpq,
    notes,
    selection,
    tempoBpm,
    tempoSegments,
    timeSignatures,
    snapDivision,
    snapEnabled,
    scaleHighlight,
    scoreAnnotations,
    displayTransposeSemitones,
    initialized,
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
