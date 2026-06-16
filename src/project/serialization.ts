/**
 * Plain-JSON project document: the contract between the editor state and the
 * persistence layer (which zips it into a project file).
 *
 * The wasm Project has its own toJson()/fromJson() pair, but that format
 * cannot be produced without a live wasm instance, so templates and tests
 * could not build documents from it. This document is instead a plain object
 * built from the store mirror; loading replays it through the Project API
 * (addTrack/addClip/setMidiEvents/...), which rebuilds an equivalent Project.
 */

import { midiLearnTargetScope, withMidiLearnTargetScope } from '@/ui/midi/midi-learn';
import {
  annotationsToDocument,
  type ClipScoreAnnotations,
  type DocumentNoteAnnotation,
  type DocumentScoreSettings,
} from './annotations';
import type { AutomationLaneState, AutomationParam, AutomationPoint } from './automation';
import type { EditorChordSymbol } from './chords';
import { clearHistory } from './commands';
import { cloneInstrument, type TrackInstrument } from './instrument';
import { cloneCcLanes } from './midi-cc';
import {
  cloneMixerState,
  cloneStrip,
  isDefaultMixerState,
  type MixerStrip,
  type ProjectMixerState,
} from './mixer';
import { getProject, useProjectStore } from './store';
import type { ClipKind, EditorClip, EditorNote, TrackKind } from './types';

/**
 * Current schema version written by {@link serializeProject}.
 *
 * Version history:
 * - 1: MIDI-only clips.
 * - 2: clips carry an optional `kind` ('midi' | 'audio'; absent = 'midi'),
 *   audio clips reference an asset by `assetId` and may carry fade lengths.
 *   Audio PCM lives in the OPFS asset store (src/persistence/assets.ts), not
 *   in the document; loading a document does not require the assets to be
 *   present (clips simply stay silent until the asset is restored). A future
 *   .szd revision can bundle referenced assets as extra zip entries (e.g.
 *   "assets/<id>.pcm" + "assets/<id>.json") without a schema change.
 * - 3: tracks carry an optional `instrument` (NativeSynth preset/patch or a
 *   SoundFont reference) and an optional `mixer` channel strip; the document
 *   carries an optional project `mixer` state (master strip + buses).
 *   SoundFont binaries live in the OPFS font store (src/project/fonts.ts),
 *   referenced by id only. All new fields are omitted when default, so v1/v2
 *   documents load unchanged with defaults injected.
 *   Additionally (still version 3, additive): clips may carry optional
 *   display-only `scoreAnnotations` (content-addressed, see
 *   src/project/annotations.ts) and the document may carry an optional
 *   `score` settings block. Both are omitted when empty/default, so every
 *   existing version-3 document remains valid and loaders that predate the
 *   fields simply ignore them.
 *   Additionally (still version 3, additive): tracks may carry optional
 *   `automation` lanes and the document an optional `masterAutomation` list
 *   (mixer parameter automation, see src/project/automation.ts). Lane targets
 *   are positional — a track's lanes live on its track entry and master lanes
 *   at the document level — because track ids are session-scoped and loading
 *   assigns fresh ones. Both fields are omitted when empty, so every existing
 *   version-3 document remains valid and loaders that predate them simply
 *   ignore them.
 *   Additionally (still version 3, additive): MIDI clips may carry optional
 *   `ccLanes` (continuous-controller automation, see src/project/midi-cc.ts),
 *   omitted when the clip has none, so every existing version-3 document
 *   remains valid and loaders that predate the field simply ignore it.
 *   Additionally (still version 3, additive): the document may carry an
 *   optional `chords` list (the project chord track, see src/project/chords.ts)
 *   replayed onto the Project through annotateChords; omitted when empty.
 *   Additionally (still version 3, additive): MIDI clips may carry optional
 *   `pitchBendLanes` imported from SMF pitch-bend events and emitted during
 *   realtime playback/export; omitted when absent.
 *   Additionally (still version 3, additive): MIDI clips may carry optional
 *   `channelPressureLanes` and `polyPressureLanes` imported from aftertouch
 *   events and emitted during realtime playback/export; omitted when absent.
 *   Additionally (still version 3, additive): the document may carry an optional
 *   `midiCcBindings` list (MIDI-learn CC mappings, see src/ui/midi/midi-learn.ts)
 *   restored into the session learn handle on load; omitted when there are none.
 *
 * Loaders accept any version up to this one; version-1 documents load
 * unchanged (every clip is MIDI).
 */
export const PROJECT_DOCUMENT_SCHEMA_VERSION = 3;

/** One note inside a document clip (an {@link EditorNote} without its id). */
export type DocumentNote = Omit<EditorNote, 'id'>;

/** One clip inside a document track. */
export interface DocumentClip {
  /** Clip display name. */
  name: string;
  /** Timeline start in PPQ (>= 0). */
  startPpq: number;
  /** Clip length in PPQ (> 0). */
  lengthPpq: number;
  /** Offset of the clip window into its source, in PPQ (>= 0). */
  sourceOffsetPpq: number;
  /** Linear playback gain (>= 0). */
  gain: number;
  /** True when the clip loops its window. */
  loopEnabled: boolean;
  /** Loop length in PPQ (0 = full clip window). */
  loopLengthPpq: number;
  /** Note content in source-relative PPQ (empty for audio clips). */
  notes: DocumentNote[];
  /** Clip content kind; absent (schema version 1) = 'midi'. */
  kind?: ClipKind;
  /** Audio asset id resolved against the OPFS asset store; audio clips only. */
  assetId?: string;
  /** Fade-in length in PPQ (> 0 when present); audio clips only. */
  fadeInPpq?: number;
  /** Fade-out length in PPQ (> 0 when present); audio clips only. */
  fadeOutPpq?: number;
  /** Alternative recordings (cycle takes); audio clips only, omitted when none. */
  takes?: Array<{ assetId: string; name: string }>;
  /** Comp selection over `takes` (clip-window-relative); omitted when absent. */
  compSegments?: Array<{ startPpq: number; takeIndex: number }>;
  /** Tempo-follow (warp) state; omitted when the clip plays at its recorded rate. */
  warp?: {
    enabled: boolean;
    sourceBpm: number;
    anchors?: Array<{ ppq: number; sourceSeconds: number }>;
  };
  /**
   * Continuous-controller (CC) automation lanes (MIDI clips); omitted when the
   * clip carries none. Positions are clip-window-relative PPQ, values 0-127.
   */
  ccLanes?: Array<{
    controller: number;
    channel: number;
    points: Array<{ ppq: number; value: number }>;
  }>;
  /**
   * Pitch-bend lanes (MIDI clips); omitted when the clip carries none.
   * Values are 14-bit MIDI pitch-bend units, 8192 = center.
   */
  pitchBendLanes?: Array<{
    channel: number;
    points: Array<{ ppq: number; value: number }>;
  }>;
  /** Channel pressure / monophonic aftertouch lanes (MIDI clips). */
  channelPressureLanes?: Array<{
    channel: number;
    points: Array<{ ppq: number; value: number }>;
  }>;
  /** Polyphonic key pressure lanes (MIDI clips), scoped to channel + pitch. */
  polyPressureLanes?: Array<{
    channel: number;
    pitch: number;
    points: Array<{ ppq: number; value: number }>;
  }>;
  /**
   * Display-only score annotations of this clip's notes, content-addressed
   * (editor note ids are session-scoped); omitted when the clip has none.
   */
  scoreAnnotations?: DocumentNoteAnnotation[];
}

/**
 * One automation lane of a document. The lane target is positional: lanes on
 * a track entry automate that track, lanes in `masterAutomation` automate the
 * master strip (track ids are session-scoped, so documents never store them).
 */
export interface DocumentAutomationLane {
  /** Automated parameter. */
  param: AutomationParam;
  /** Points sorted by ascending PPQ. */
  points: AutomationPoint[];
  /** Whether the lane is applied during playback. */
  enabled: boolean;
}

/** One track of the document, with its clips. */
export interface DocumentTrack {
  /** Track display name. */
  name: string;
  /** Display color as a CSS color string. */
  color: string;
  /** Track content kind. */
  kind: TrackKind;
  /** Playback mute flag. */
  mute: boolean;
  /** Playback solo flag. */
  solo: boolean;
  /** Linear track volume (>= 0, 1 = unity). */
  volume: number;
  /** Stereo pan in [-1, 1]. */
  pan: number;
  /** Clips on this track, ordered by timeline start. */
  clips: DocumentClip[];
  /** Track instrument; absent (schema < 3) = the default synth preset. */
  instrument?: TrackInstrument;
  /** Mixer channel strip; absent (schema < 3) = a neutral strip. */
  mixer?: MixerStrip;
  /** Automation lanes targeting this track; absent = none. */
  automation?: DocumentAutomationLane[];
  /**
   * Positional index of the group track this track is a member of (track ids
   * are session-scoped, so documents store the index); absent = master mix.
   */
  groupIndex?: number;
  /** Solo-safe flag; absent = not solo-safe. */
  soloSafe?: boolean;
  /** Id of the VCA control group this track belongs to; absent = unassigned. */
  vcaId?: string;
  /** Frozen state: the track's baked pre-fader render; absent = not frozen. */
  frozen?: { assetId: string };
}

/** One timeline marker of the document. */
export interface DocumentMarker {
  /** Marker position in PPQ (>= 0). */
  ppq: number;
  /** Marker display name. */
  name: string;
}

/** One arrangement section of the document. */
export interface DocumentSection {
  /** Section display name. */
  name: string;
  /** Display color as a CSS color string. */
  color: string;
  /** Section start in PPQ (>= 0). */
  startPpq: number;
  /** Section end in PPQ (> startPpq). */
  endPpq: number;
}

/** One tempo segment of the document. */
export interface DocumentTempoSegment {
  /** Segment start in PPQ. */
  startPpq: number;
  /** Tempo in BPM at the segment start (> 0). */
  bpm: number;
  /** Optional ramp end tempo in BPM. */
  endBpm?: number;
}

/** One time-signature segment of the document. */
export interface DocumentTimeSignature {
  /** Segment start in PPQ. */
  startPpq: number;
  /** Beats per bar. */
  numerator: number;
  /** Beat unit (e.g. 4 or 8). */
  denominator: number;
}

/** One persisted MIDI-learn CC binding of the document. */
export interface DocumentMidiCcBinding {
  /**
   * Target id (mixer / insert / instrument); see src/ui/midi/midi-learn.ts.
   * When {@link trackScoped} is true the id's scope is a positional track index
   * (session track ids are reassigned on load), rebound on {@link loadProjectDocument}.
   */
  target: string;
  /** MIDI channel (0-15). */
  channel: number;
  /** Controller number (0-127). */
  controller: number;
  /** True when `target`'s scope is a track index awaiting load-time rebinding. */
  trackScoped?: boolean;
}

/** Plain JSON-able snapshot of a whole project. */
export interface ProjectDocument {
  /** Schema version; see {@link PROJECT_DOCUMENT_SCHEMA_VERSION}. */
  schemaVersion: number;
  /** Project display name. */
  name: string;
  /** Project sample rate in Hz. */
  sampleRate: number;
  /** Tempo map (at least one segment in documents produced by serialize). */
  tempoSegments: DocumentTempoSegment[];
  /** Time-signature map (may be empty = project default). */
  timeSignatures: DocumentTimeSignature[];
  /** Tracks in display order, each with its clips and notes. */
  tracks: DocumentTrack[];
  /** Timeline markers ordered by position. */
  markers: DocumentMarker[];
  /** Arrangement sections ordered by start position. */
  sections: DocumentSection[];
  /** Automation lanes targeting the master strip; absent = none. */
  masterAutomation?: DocumentAutomationLane[];
  /** Chord-track symbols ordered by position; absent/empty = no chord track. */
  chords?: EditorChordSymbol[];
  /** Project mixer state; absent (schema < 3 or all-default) = defaults. */
  mixer?: ProjectMixerState;
  /** Score display settings; absent = defaults (no display transpose). */
  score?: DocumentScoreSettings;
  /** MIDI-learn CC bindings; absent/empty = none. */
  midiCcBindings?: DocumentMidiCcBinding[];
}

/** Deep-copies a clip mirror entry into the document shape (no session ids). */
function toDocumentClip(
  clip: EditorClip,
  annotations?: Readonly<ClipScoreAnnotations>,
): DocumentClip {
  const out: DocumentClip = {
    name: clip.name,
    startPpq: clip.startPpq,
    lengthPpq: clip.lengthPpq,
    sourceOffsetPpq: clip.sourceOffsetPpq,
    gain: clip.gain,
    loopEnabled: clip.loopEnabled,
    loopLengthPpq: clip.loopLengthPpq,
    notes: clip.notes.map(toDocumentNote),
    kind: clip.kind ?? 'midi',
  };
  if (clip.assetId !== undefined) out.assetId = clip.assetId;
  if (clip.fadeInPpq !== undefined) out.fadeInPpq = clip.fadeInPpq;
  if (clip.fadeOutPpq !== undefined) out.fadeOutPpq = clip.fadeOutPpq;
  if (clip.takes !== undefined && clip.takes.length > 0) {
    out.takes = clip.takes.map((take) => ({ ...take }));
    if (clip.compSegments !== undefined && clip.compSegments.length > 0) {
      out.compSegments = clip.compSegments.map((segment) => ({ ...segment }));
    }
  }
  if (clip.warp !== undefined) {
    out.warp = {
      enabled: clip.warp.enabled,
      sourceBpm: clip.warp.sourceBpm,
      ...(clip.warp.anchors !== undefined && clip.warp.anchors.length > 0
        ? { anchors: clip.warp.anchors.map((anchor) => ({ ...anchor })) }
        : {}),
    };
  }
  const ccLanes = cloneCcLanes(clip.ccLanes);
  if (ccLanes !== undefined) out.ccLanes = ccLanes;
  if (clip.pitchBendLanes !== undefined && clip.pitchBendLanes.length > 0) {
    out.pitchBendLanes = clip.pitchBendLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.channelPressureLanes !== undefined && clip.channelPressureLanes.length > 0) {
    out.channelPressureLanes = clip.channelPressureLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.polyPressureLanes !== undefined && clip.polyPressureLanes.length > 0) {
    out.polyPressureLanes = clip.polyPressureLanes.map((lane) => ({
      channel: lane.channel,
      pitch: lane.pitch,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (annotations !== undefined) {
    // Annotations are re-addressed by note content (orphans drop out here).
    const entries = annotationsToDocument(annotations, clip.notes);
    if (entries.length > 0) out.scoreAnnotations = entries;
  }
  return out;
}

/** Deep-copies a store lane into the document shape (placement carries the target). */
function toDocumentAutomationLane(lane: AutomationLaneState): DocumentAutomationLane {
  return {
    param: lane.param,
    points: lane.points.map((point) => ({ ...point })),
    enabled: lane.enabled,
  };
}

/** Deep-copies a note, dropping the editor id. */
function toDocumentNote(note: EditorNote): DocumentNote {
  const out: DocumentNote = {
    pitch: note.pitch,
    velocity: note.velocity,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel,
  };
  if (note.offVelocity !== undefined) out.offVelocity = note.offVelocity;
  return out;
}

/**
 * Serializes the current project (store mirror + Project sample rate) into a
 * plain {@link ProjectDocument}. The result contains no session ids and is
 * safe to JSON.stringify.
 *
 * @returns A document that {@link loadProjectDocument} restores losslessly.
 * @throws Error when the project store is not initialized.
 */
export function serializeProject(): ProjectDocument {
  const store = useProjectStore();
  const project = getProject();
  const doc: ProjectDocument = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: store.projectName,
    sampleRate: project.getSampleRate(),
    tempoSegments: store.tempoSegments.map((segment) => ({ ...segment })),
    timeSignatures: store.timeSignatures.map((segment) => ({ ...segment })),
    tracks: store.tracks.map((track) => {
      const out: DocumentTrack = {
        name: track.name,
        color: track.color,
        kind: track.kind,
        mute: track.mute,
        solo: track.solo,
        volume: track.volume,
        pan: track.pan,
        clips: store.clips
          .filter((clip) => clip.trackId === track.id)
          .map((clip) => toDocumentClip(clip, store.scoreAnnotations[clip.id])),
      };
      if (track.instrument !== undefined) out.instrument = cloneInstrument(track.instrument);
      if (track.mixer !== undefined) {
        out.mixer = cloneStrip(track.mixer);
        // Insert sidechain sources are session track ids; store them as
        // positional indices (dangling references drop out).
        for (const slot of out.mixer.inserts) {
          if (slot.sidechainSourceTrackId === undefined) continue;
          const sourceIndex = store.tracks.findIndex(
            (entry) => entry.id === slot.sidechainSourceTrackId,
          );
          delete slot.sidechainSourceTrackId;
          if (sourceIndex >= 0) {
            (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex = sourceIndex;
          }
        }
      }
      if (track.groupId !== undefined) {
        const groupIndex = store.tracks.findIndex((entry) => entry.id === track.groupId);
        if (groupIndex >= 0) out.groupIndex = groupIndex;
      }
      if (track.soloSafe === true) out.soloSafe = true;
      // VCA group ids are app-level strings, stable within a document, so they
      // round-trip directly (dangling ids are dropped on load).
      if (track.vcaId !== undefined) out.vcaId = track.vcaId;
      if (track.frozen !== undefined) out.frozen = { ...track.frozen };
      // Track automation rides the track entry (track ids are session-scoped,
      // so a document never stores lane targets); omitted when there is none.
      const automation = store.automationLanes.filter((lane) => lane.target === track.id);
      if (automation.length > 0) out.automation = automation.map(toDocumentAutomationLane);
      return out;
    }),
    markers: store.markers.map((marker) => ({ ppq: marker.ppq, name: marker.name })),
    sections: store.sections.map((section) => ({
      name: section.name,
      color: section.color,
      startPpq: section.startPpq,
      endPpq: section.endPpq,
    })),
  };
  // Master automation lanes are omitted while there are none, so documents
  // from automation-less sessions look exactly like older ones. Numeric-target
  // lanes were captured on their track entries above (lanes whose track no
  // longer exists drop out naturally).
  const masterLanes = store.automationLanes.filter((lane) => lane.target === 'master');
  if (masterLanes.length > 0) doc.masterAutomation = masterLanes.map(toDocumentAutomationLane);
  // The chord track is omitted while empty, so chord-less documents look
  // exactly like older ones (the loader replays it through annotateChords).
  if (store.chords.length > 0) doc.chords = store.chords.map((chord) => ({ ...chord }));
  // The project mixer state is omitted while it is entirely default, so
  // documents from mixer-less sessions look exactly like older ones.
  if (!isDefaultMixerState(store.mixer)) doc.mixer = cloneMixerState(store.mixer);
  // Score display settings are likewise omitted while default.
  if (store.displayTransposeSemitones !== 0) {
    doc.score = { displayTransposeSemitones: store.displayTransposeSemitones };
  }
  // MIDI-learn CC bindings are app-level metadata; omitted while there are none.
  // Track-scoped targets embed a session track id, so they are stored with the
  // track's positional index (rebound on load); 'master' targets are stable and
  // stored verbatim. Dangling track bindings drop out. Sorted for determinism.
  if (store.midiCcBindings.size > 0) {
    const entries: DocumentMidiCcBinding[] = [];
    for (const [target, binding] of store.midiCcBindings.entries()) {
      const scope = midiLearnTargetScope(target);
      if (scope === null) continue;
      const out: DocumentMidiCcBinding = {
        target,
        channel: binding.channel,
        controller: binding.controller,
      };
      if (scope !== 'master') {
        const index = store.tracks.findIndex((track) => track.id === scope);
        if (index < 0) continue;
        const portable = withMidiLearnTargetScope(target, index);
        if (portable === null) continue;
        out.target = portable;
        out.trackScoped = true;
      }
      entries.push(out);
    }
    if (entries.length > 0) {
      doc.midiCcBindings = entries.sort((a, b) =>
        a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
      );
    }
  }
  return doc;
}

/**
 * Rebuilds the wasm Project and the store mirror from a document, replacing
 * any open project, then clears the undo/redo history (a loaded document is
 * the new baseline, not an undoable edit).
 *
 * @param doc Document from {@link serializeProject} or a template.
 */
export async function loadProjectDocument(doc: ProjectDocument): Promise<void> {
  const store = useProjectStore();
  await store.loadDocument(doc);
  clearHistory();
}
