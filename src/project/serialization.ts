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

import { linearToDb } from '@/lib/db';
import { midiLearnTargetScope, withMidiLearnTargetScope } from '@/ui/midi/midi-learn';
import {
  annotationsToDocument,
  type ClipScoreAnnotations,
  createDefaultScoreDisplaySettings,
  type DocumentNoteAnnotation,
  type DocumentScoreSettings,
} from './annotations';
import {
  type AutomationLaneState,
  type AutomationParam,
  type AutomationPoint,
  busAutomationTarget,
  cloneAutomationLane,
  isBusAutomationTarget,
} from './automation';
import type { EditorChordSymbol } from './chords';
import {
  exportMixerSnapshotSlots,
  importMixerSnapshotSlots,
  MIXER_SNAPSHOT_SLOTS,
  type MixerSnapshot,
  type MixerSnapshotSlot,
  type MixerSnapshotSlotState,
  type MixerSnapshotTrack,
} from './command/mixer-snapshots';
import { clearHistory } from './commands';
import { type ControlSurfaceSettings, controlSurfaceSettingsAreDefault } from './control-surface';
import type { TrackExpressionMap } from './expression-map';
import type { ExternalStemRole } from './external-stems';
import type { TrackProvenance } from './generation';
import {
  cloneInstrument,
  type ExternalMidiInstrument,
  type TrackInstrument,
  validateTrackInstrument,
} from './instrument';
import { cloneCcLanes } from './midi-cc';
import { isMidiFxNoop, type MidiFxConfig, sanitizeMidiFxConfig } from './midi-fx';
import {
  cloneMixerState,
  cloneStrip,
  createDefaultStrip,
  isDefaultMixerState,
  type MixerBus,
  type MixerStrip,
  type ProjectMixerState,
} from './mixer';
import { getProject, useProjectStore } from './store';
import { normalizeProcessorMidiLearnTarget } from './target-reference-registry';
import {
  type ClipExpressionCurve,
  type ClipKind,
  type EditorClip,
  type EditorNote,
  MAJOR_MODE_MASK,
  type MidiClipTake,
  type SmfSysExPacket,
  type TrackKind,
} from './types';

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
 *   ignore them. A lane's `param` may, besides 'faderDb'/'pan', be an
 *   stable insert-parameter token "insert-id:<processorId>:<paramName>" (see
 *   src/project/automation.ts) automating a processor of the targeted track;
 *   legacy positional "insert:<index>:..." tokens migrate on load.
 *   Additionally (still version 3, additive): audio tracks may carry optional
 *   `recordInputChannel`, a zero-based microphone input channel used when
 *   splitting a multi-channel input recording across armed tracks, and optional
 *   `recordInputDeviceId`, the preferred audioinput device recorded onto the
 *   track when several armed tracks capture distinct devices at once.
 *   strip; older loaders drop the lane as an unknown param, so this stays
 *   additive within version 3.
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
 *   `programChangeLanes` imported from SMF program-change events and emitted
 *   during realtime playback/export; omitted when absent.
 *   Additionally (still version 3, additive): MIDI clips may carry optional
 *   `channelPressureLanes` and `polyPressureLanes` imported from aftertouch
 *   events and emitted during realtime playback/export; omitted when absent.
 *   Additionally (still version 3, additive): the document may carry an optional
 *   `midiCcBindings` list (MIDI-learn CC mappings, see src/ui/midi/midi-learn.ts)
 *   restored into the session learn handle on load; omitted when there are none.
 *   Additionally (still version 3, additive): the document may carry an
 *   optional `externalMidiDefault` route, and tracks may opt into it with
 *   `externalMidiMode: "project"`.
 *   Additionally (still version 3, additive): audio clips imported from an
 *   external source separation may carry `externalStemRole` and `contentHash`,
 *   replayed onto their audio source on load. Both are omitted for every other
 *   clip, so documents written before them load unchanged and loaders that
 *   predate them simply ignore the fields.
 *   Additionally (still version 3, additive): the document may carry an
 *   optional `generationSeed` and tracks an optional `generated` record (see
 *   src/project/generation.ts), together saying which part wrote a track and
 *   from what. Both are omitted when there is nothing to say, so documents
 *   written before them load as "nothing was generated here" and loaders that
 *   predate them simply ignore the fields.
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
  /**
   * Role of an externally separated stem (see src/project/external-stems.ts);
   * absent for audio that did not come from a stem import.
   */
  externalStemRole?: ExternalStemRole;
  /** Content hash of the clip's audio source; absent without stem provenance. */
  contentHash?: string;
  /** Fade-in length in PPQ (> 0 when present); audio clips only. */
  fadeInPpq?: number;
  /** Fade-out length in PPQ (> 0 when present); audio clips only. */
  fadeOutPpq?: number;
  /** Alternative recordings (cycle takes); audio clips only, omitted when none. */
  takes?: Array<{ assetId: string; name: string }>;
  /** Comp selection over `takes` (clip-window-relative); omitted when absent. */
  compSegments?: Array<{ startPpq: number; takeIndex: number; crossfadePpq?: number }>;
  /** Alternative MIDI performances captured during cycle recording. */
  midiTakes?: MidiClipTake[];
  /** Index into `midiTakes` represented by this clip's playable content. */
  midiActiveTakeIndex?: number;
  /** Range selection over MIDI takes, clip-window-relative. */
  midiCompSegments?: Array<{ startPpq: number; takeIndex: number }>;
  /** Tempo-follow (warp) state; omitted when the clip plays at its recorded rate. */
  warp?: {
    enabled: boolean;
    sourceBpm: number;
    sourceStartSeconds?: number;
    sourceEndSeconds?: number;
    anchors?: Array<{ ppq: number; sourceSeconds: number }>;
  };
  /**
   * Continuous-controller (CC) automation lanes (MIDI clips); omitted when the
   * clip carries none. Positions are clip-window-relative PPQ, values 0-127.
   */
  ccLanes?: Array<{
    controller: number;
    channel: number;
    points: Array<{ ppq: number; value: number; curve?: ClipExpressionCurve }>;
  }>;
  /**
   * Pitch-bend lanes (MIDI clips); omitted when the clip carries none.
   * Values are 14-bit MIDI pitch-bend units, 8192 = center.
   */
  pitchBendLanes?: Array<{
    channel: number;
    points: Array<{ ppq: number; value: number; curve?: ClipExpressionCurve }>;
  }>;
  /** Program-change lanes (MIDI clips), scoped to channel. */
  programChangeLanes?: Array<{
    channel: number;
    points: Array<{ ppq: number; program: number }>;
  }>;
  /** Channel pressure / monophonic aftertouch lanes (MIDI clips). */
  channelPressureLanes?: Array<{
    channel: number;
    points: Array<{ ppq: number; value: number; curve?: ClipExpressionCurve }>;
  }>;
  /** Polyphonic key pressure lanes (MIDI clips), scoped to channel + pitch. */
  polyPressureLanes?: Array<{
    channel: number;
    pitch: number;
    points: Array<{ ppq: number; value: number; curve?: ClipExpressionCurve }>;
  }>;
  /** Opaque SMF SysEx packets, preserved for later SMF re-export only. */
  smfSysEx?: SmfSysExPacket[];
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

/** Mixer bus persisted in a project document, with optional bus automation. */
export type DocumentMixerBus = MixerBus & {
  /** Automation lanes targeting this bus; absent = none. */
  automation?: DocumentAutomationLane[];
};

/** Project mixer document shape, allowing automation on each bus entry. */
export type DocumentMixerState = Omit<ProjectMixerState, 'buses'> & {
  /** Send buses with optional automation lanes. */
  buses: DocumentMixerBus[];
};

/** One track of the document, with its clips. */
export interface DocumentTrack {
  /** Track display name. */
  name: string;
  /** Stable MusicXML `<part>` id this track originated from, when imported. */
  musicXmlPartId?: string;
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
  /** Compatibility mirror of mixer.pan; group tracks are always centered. */
  pan: number;
  /** Clips on this track, ordered by timeline start. */
  clips: DocumentClip[];
  /** Track instrument; absent (schema < 3) = the default synth preset. */
  instrument?: TrackInstrument;
  /** External MIDI route source; absent = use this track's own instrument. */
  externalMidiMode?: 'project';
  /** Live non-destructive MIDI-FX transform; absent = none. */
  midiFx?: MidiFxConfig;
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
  /**
   * Explicit percussion override; absent = classify by heuristic. Persists both
   * `true` (force percussion) and `false` (force harmonic).
   */
  percussion?: boolean;
  /** How the track was generated; absent = no recorded generation origin. */
  generated?: TrackProvenance;
  /** Id of the VCA control group this track belongs to; absent = unassigned. */
  vcaId?: string;
  /** Chord-track follow mode; absent = the track ignores the chord track. */
  chordFollow?: 'chordTones' | 'root';
  /** Articulation-to-MIDI map; absent = articulations stay display-only. */
  expressionMap?: TrackExpressionMap;
  /** Frozen state: the track's baked pre-fader render; absent = not frozen. */
  frozen?: { assetId: string };
  /** Zero-based microphone input channel for multi-track audio recording. */
  recordInputChannel?: number;
  /** Preferred audioinput device id for multi-device audio recording. */
  recordInputDeviceId?: string;
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
  /** Optional additive beat groups, e.g. `[2, 2, 3]` for 7/8. */
  grouping?: number[];
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
  /** Binding family. Omitted means a legacy CC binding. */
  kind?: 'cc' | 'rpn' | 'nrpn';
  /** RPN/NRPN parameter number (0-16383), when `kind` is not `cc`. */
  parameter?: number;
  /** True when `target`'s scope is a track index awaiting load-time rebinding. */
  trackScoped?: boolean;
}

/** Document-portable mixer snapshot track entry (track id becomes index). */
export interface DocumentMixerSnapshotTrack extends Omit<MixerSnapshotTrack, 'id'> {
  /** Track index in the serialized document. */
  trackIndex: number;
}

/** Document-portable mixer snapshot. */
export interface DocumentMixerSnapshot extends Omit<MixerSnapshot, 'tracks'> {
  /** Per-track captured strip and mix flags, keyed by document track index. */
  tracks: DocumentMixerSnapshotTrack[];
}

/** Persisted mixer snapshot slots. */
export interface DocumentMixerSnapshotSlots {
  /** Snapshot slots keyed by A-D. */
  slots: Partial<Record<MixerSnapshotSlot, DocumentMixerSnapshot>>;
  /** Last active slot, omitted when no persisted slot is active. */
  active?: MixerSnapshotSlot;
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
  /** Length of an opening anacrusis/pickup measure in PPQ; absent = full first bar. */
  pickupLengthPpq?: number;
  /**
   * The project seed every generated part is addressed under; absent = 0.
   * Persisted so a saved project regenerates the parts it was written with.
   */
  generationSeed?: number;
  /** Project key/scale highlight; absent means the C-major default. */
  scaleHighlight?: { enabled: boolean; rootPc: number; modeMask: number };
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
  mixer?: DocumentMixerState;
  /** Project-level External MIDI route; tracks opt into it per entry. */
  externalMidiDefault?: ExternalMidiInstrument;
  /** Score display settings; absent = defaults (no display transpose). */
  score?: DocumentScoreSettings;
  /** MIDI-learn CC bindings; absent/empty = none. */
  midiCcBindings?: DocumentMidiCcBinding[];
  /** Control-surface configuration; absent = defaults (no surface). */
  controlSurface?: ControlSurfaceSettings;
  /** Persisted mixer snapshot slots; absent/empty = none. */
  mixerSnapshots?: DocumentMixerSnapshotSlots;
}

/** Converts track-scoped insert sidechain ids to document track indices. */
function stripWithSidechainSourceIndices(
  strip: MixerStrip,
  tracks: ReadonlyArray<{ id: number }>,
  allowSidechain = true,
): MixerStrip {
  const out = cloneStrip(strip);
  for (const slot of out.inserts) {
    if (slot.sidechainSourceTrackId === undefined) continue;
    const sourceIndex = tracks.findIndex((entry) => entry.id === slot.sidechainSourceTrackId);
    delete slot.sidechainSourceTrackId;
    if (allowSidechain && sourceIndex >= 0) {
      (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex = sourceIndex;
    }
  }
  return out;
}

/** Converts document track-index sidechain references back to session track ids. */
function stripWithSidechainSourceIds(
  strip: MixerStrip,
  tracks: ReadonlyArray<{ id: number }>,
  allowSidechain = true,
): MixerStrip {
  const out = cloneStrip(strip);
  for (const slot of out.inserts) {
    const sourceIndex = (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
    delete (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
    if (allowSidechain && typeof sourceIndex === 'number' && Number.isInteger(sourceIndex)) {
      const source = tracks[sourceIndex];
      if (source) slot.sidechainSourceTrackId = source.id;
    }
  }
  return out;
}

/** Converts mixer-scope sidechain ids to document track indices. */
function mixerWithSidechainSourceIndices(
  mixer: ProjectMixerState,
  tracks: ReadonlyArray<{ id: number }>,
): ProjectMixerState {
  const out = cloneMixerState(mixer);
  out.master = stripWithSidechainSourceIndices(out.master, tracks);
  for (const bus of out.buses) {
    if (bus.strip !== undefined) bus.strip = stripWithSidechainSourceIndices(bus.strip, tracks);
  }
  return out;
}

/** Rebinds mixer-scope document sidechain indices to session track ids. */
function resolveMixerSidechainSourceIds(
  mixer: ProjectMixerState,
  tracks: ReadonlyArray<{ id: number }>,
): void {
  const resolveStrip = (strip: MixerStrip): void => {
    for (const slot of strip.inserts) {
      const sourceIndex = (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
      delete (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
      if (
        typeof sourceIndex === 'number' &&
        Number.isInteger(sourceIndex) &&
        sourceIndex >= 0 &&
        sourceIndex < tracks.length
      ) {
        slot.sidechainSourceTrackId = tracks[sourceIndex].id;
      }
    }
  };
  resolveStrip(mixer.master);
  for (const bus of mixer.buses) {
    if (bus.strip !== undefined) resolveStrip(bus.strip);
  }
}

/** Converts in-memory mixer snapshot slots to document-portable slots. */
function toDocumentMixerSnapshotSlots(
  state: MixerSnapshotSlotState,
  tracks: ReadonlyArray<{ id: number }>,
): DocumentMixerSnapshotSlots | undefined {
  const slots: Partial<Record<MixerSnapshotSlot, DocumentMixerSnapshot>> = {};
  for (const slot of MIXER_SNAPSHOT_SLOTS) {
    const snapshot = state.snapshots[slot];
    if (!snapshot) continue;
    const entries = snapshot.tracks.flatMap((entry) => {
      const trackIndex = tracks.findIndex((track) => track.id === entry.id);
      if (trackIndex < 0) return [];
      const track = tracks[trackIndex] as { id: number; kind?: string };
      return [
        {
          ...entry,
          trackIndex,
          mixer: stripWithSidechainSourceIndices(entry.mixer, tracks, track.kind !== 'group'),
          id: undefined,
        },
      ];
    });
    slots[slot] = {
      mixer: mixerWithSidechainSourceIndices(snapshot.mixer, tracks),
      tracks: entries.map(({ id: _id, ...entry }) => entry),
      ...(snapshot.automationLanes !== undefined
        ? {
            automationLanes: snapshot.automationLanes.flatMap((lane) => {
              if (typeof lane.target !== 'number') return [cloneAutomationLane(lane)];
              const trackIndex = tracks.findIndex((track) => track.id === lane.target);
              return trackIndex < 0 ? [] : [{ ...cloneAutomationLane(lane), target: trackIndex }];
            }),
          }
        : {}),
    };
  }
  if (Object.keys(slots).length === 0) return undefined;
  return {
    slots,
    ...(state.active && slots[state.active] ? { active: state.active } : {}),
  };
}

/** Converts document mixer snapshot slots back to session-track-id slots. */
function fromDocumentMixerSnapshotSlots(
  docSlots: DocumentMixerSnapshotSlots | undefined,
  tracks: ReadonlyArray<{ id: number }>,
): MixerSnapshotSlotState | null {
  if (!docSlots) return null;
  const snapshots: Partial<Record<MixerSnapshotSlot, MixerSnapshot>> = {};
  for (const slot of MIXER_SNAPSHOT_SLOTS) {
    const snapshot = docSlots.slots[slot];
    if (!snapshot) continue;
    const mixer = cloneMixerState(snapshot.mixer);
    resolveMixerSidechainSourceIds(mixer, tracks);
    snapshots[slot] = {
      mixer,
      tracks: snapshot.tracks.flatMap((entry) => {
        const track = tracks[entry.trackIndex];
        if (!track) return [];
        return [
          {
            id: track.id,
            mixer: stripWithSidechainSourceIds(
              entry.mixer,
              tracks,
              (track as { kind?: string }).kind !== 'group',
            ),
            mute: entry.mute,
            solo: entry.solo,
            ...(entry.volume !== undefined ? { volume: entry.volume } : {}),
            ...(entry.soloSafe !== undefined ? { soloSafe: entry.soloSafe } : {}),
            ...(entry.vcaId !== undefined ? { vcaId: entry.vcaId } : {}),
          },
        ];
      }),
      ...(snapshot.automationLanes !== undefined
        ? {
            automationLanes: snapshot.automationLanes.flatMap((lane) => {
              if (typeof lane.target !== 'number') return [cloneAutomationLane(lane)];
              const track = tracks[lane.target];
              return track ? [{ ...cloneAutomationLane(lane), target: track.id }] : [];
            }),
          }
        : {}),
    };
  }
  return {
    snapshots,
    active: docSlots.active && snapshots[docSlots.active] ? docSlots.active : null,
  };
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
  if (clip.externalStemRole !== undefined) out.externalStemRole = clip.externalStemRole;
  if (clip.contentHash !== undefined) out.contentHash = clip.contentHash;
  if (clip.fadeInPpq !== undefined) out.fadeInPpq = clip.fadeInPpq;
  if (clip.fadeOutPpq !== undefined) out.fadeOutPpq = clip.fadeOutPpq;
  if (clip.takes !== undefined && clip.takes.length > 0) {
    out.takes = clip.takes.map((take) => ({ ...take }));
    if (clip.compSegments !== undefined && clip.compSegments.length > 0) {
      out.compSegments = clip.compSegments.map((segment) => ({ ...segment }));
    }
  }
  if (clip.midiTakes !== undefined && clip.midiTakes.length > 0) {
    out.midiTakes = clip.midiTakes.map((take) => ({
      name: take.name,
      notes: take.notes.map((note) => ({ ...note })),
      ...(take.ccLanes !== undefined
        ? {
            ccLanes: take.ccLanes.map((lane) => ({
              ...lane,
              points: lane.points.map((point) => ({ ...point })),
            })),
          }
        : {}),
      ...(take.pitchBendLanes !== undefined
        ? {
            pitchBendLanes: take.pitchBendLanes.map((lane) => ({
              ...lane,
              points: lane.points.map((point) => ({ ...point })),
            })),
          }
        : {}),
      ...(take.programChangeLanes !== undefined
        ? {
            programChangeLanes: take.programChangeLanes.map((lane) => ({
              ...lane,
              points: lane.points.map((point) => ({ ...point })),
            })),
          }
        : {}),
      ...(take.channelPressureLanes !== undefined
        ? {
            channelPressureLanes: take.channelPressureLanes.map((lane) => ({
              ...lane,
              points: lane.points.map((point) => ({ ...point })),
            })),
          }
        : {}),
      ...(take.polyPressureLanes !== undefined
        ? {
            polyPressureLanes: take.polyPressureLanes.map((lane) => ({
              ...lane,
              points: lane.points.map((point) => ({ ...point })),
            })),
          }
        : {}),
    }));
    out.midiActiveTakeIndex = Math.min(
      Math.max(0, clip.midiActiveTakeIndex ?? clip.midiTakes.length - 1),
      clip.midiTakes.length - 1,
    );
    if (clip.midiCompSegments !== undefined && clip.midiCompSegments.length > 0) {
      out.midiCompSegments = clip.midiCompSegments.map((segment) => ({
        startPpq: segment.startPpq,
        takeIndex: segment.takeIndex,
      }));
    }
  }
  if (clip.warp !== undefined) {
    out.warp = {
      enabled: clip.warp.enabled,
      sourceBpm: clip.warp.sourceBpm,
      ...(clip.warp.sourceStartSeconds !== undefined
        ? { sourceStartSeconds: clip.warp.sourceStartSeconds }
        : {}),
      ...(clip.warp.sourceEndSeconds !== undefined
        ? { sourceEndSeconds: clip.warp.sourceEndSeconds }
        : {}),
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
  if (clip.programChangeLanes !== undefined && clip.programChangeLanes.length > 0) {
    out.programChangeLanes = clip.programChangeLanes.map((lane) => ({
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
  if (clip.smfSysEx !== undefined && clip.smfSysEx.length > 0) {
    out.smfSysEx = clip.smfSysEx.map((packet) => ({ ...packet, data: [...packet.data] }));
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
      const audiblePan = track.kind === 'group' ? 0 : (track.mixer?.pan ?? track.pan);
      const legacyVolume = Number.isFinite(track.volume) && track.volume >= 0 ? track.volume : 1;
      const needsVolumeMigration = legacyVolume !== 1;
      const out: DocumentTrack = {
        name: track.name,
        color: track.color,
        kind: track.kind,
        mute: track.mute,
        solo: track.solo,
        // v4 canonical form: the audible fader lives in mixer.gainDb. Keep a
        // unity value only because the v3 document shape is still consumed by
        // older readers.
        volume: 1,
        // Compatibility mirror for older readers. MixerStrip.pan is the
        // canonical audible value in current projects.
        pan: audiblePan,
        clips: store.clips
          .filter((clip) => clip.trackId === track.id)
          .map((clip) => toDocumentClip(clip, store.scoreAnnotations[clip.id])),
      };
      if (track.musicXmlPartId !== undefined) out.musicXmlPartId = track.musicXmlPartId;
      if (track.instrument !== undefined) out.instrument = cloneInstrument(track.instrument);
      if (track.externalMidiMode === 'project' && store.projectExternalMidi !== null) {
        out.externalMidiMode = 'project';
      }
      // The live MIDI-FX transform rides the track; serialize it only when it
      // actually changes notes (an identity transform stays out of the document).
      if (track.midiFx !== undefined) {
        const midiFx = sanitizeMidiFxConfig(track.midiFx);
        if (!isMidiFxNoop(midiFx)) out.midiFx = midiFx;
      }
      if (track.mixer !== undefined || needsVolumeMigration) {
        const baseMixer = track.mixer ?? createDefaultStrip();
        const mixer =
          track.kind === 'group' && baseMixer.pan !== 0
            ? { ...cloneStrip(baseMixer), pan: 0 }
            : cloneStrip(baseMixer);
        if (needsVolumeMigration) mixer.gainDb += linearToDb(legacyVolume);
        // Insert sidechain sources are session track ids; store them as
        // positional indices (dangling references drop out).
        out.mixer = stripWithSidechainSourceIndices(mixer, store.tracks, track.kind !== 'group');
      }
      if (track.groupId !== undefined) {
        const groupIndex = store.tracks.findIndex((entry) => entry.id === track.groupId);
        if (groupIndex >= 0) out.groupIndex = groupIndex;
      }
      if (track.soloSafe === true) out.soloSafe = true;
      // Persist both true and false: false is a meaningful "not percussion"
      // override, distinct from an absent flag (fall back to the heuristic).
      if (track.percussion !== undefined) out.percussion = track.percussion;
      // The generation record says where the track came from, so it survives
      // renames and edits; it is dropped only when there was never one.
      if (track.generated !== undefined) out.generated = { ...track.generated };
      if (track.chordFollow !== undefined) out.chordFollow = track.chordFollow;
      if (track.expressionMap !== undefined) out.expressionMap = track.expressionMap;
      // VCA group ids are app-level strings, stable within a document, so they
      // round-trip directly (dangling ids are dropped on load).
      if (track.vcaId !== undefined) out.vcaId = track.vcaId;
      if (track.frozen !== undefined) out.frozen = { ...track.frozen };
      if (
        track.kind === 'audio' &&
        track.recordInputChannel !== undefined &&
        Number.isInteger(track.recordInputChannel) &&
        track.recordInputChannel >= 0
      ) {
        out.recordInputChannel = track.recordInputChannel;
      }
      if (
        track.kind === 'audio' &&
        typeof track.recordInputDeviceId === 'string' &&
        track.recordInputDeviceId.length > 0
      ) {
        out.recordInputDeviceId = track.recordInputDeviceId;
      }
      // Track automation rides the track entry (track ids are session-scoped,
      // so a document never stores lane targets); omitted when there is none.
      const automation = store.automationLanes.filter(
        (lane) => lane.target === track.id && !(track.kind === 'group' && lane.param === 'pan'),
      );
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
  if (store.pickupLengthPpq > 0) doc.pickupLengthPpq = store.pickupLengthPpq;
  if (store.generationSeed > 0) doc.generationSeed = store.generationSeed;
  if (
    !store.scaleHighlight.enabled ||
    store.scaleHighlight.rootPc !== 0 ||
    store.scaleHighlight.modeMask !== MAJOR_MODE_MASK
  ) {
    doc.scaleHighlight = { ...store.scaleHighlight };
  }
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
  if (!isDefaultMixerState(store.mixer)) {
    const mixer = mixerWithSidechainSourceIndices(store.mixer, store.tracks) as DocumentMixerState;
    if ((mixer.soloMode ?? 'inPlace') === 'inPlace') delete mixer.soloMode;
    // The realtime/export engines have no master-send lane. Drop legacy
    // master sends so silent UI-only routing does not persist.
    mixer.master.sends = [];
    for (const bus of mixer.buses) {
      const target = busAutomationTarget(bus.id);
      const automation = store.automationLanes.filter(
        (lane) => lane.target === target && isBusAutomationTarget(lane.target),
      );
      if (automation.length > 0) bus.automation = automation.map(toDocumentAutomationLane);
    }
    doc.mixer = mixer;
  }
  if (store.projectExternalMidi !== null) {
    doc.externalMidiDefault = cloneInstrument(store.projectExternalMidi) as ExternalMidiInstrument;
  }
  // Score display/layout settings are project state. Keep the document compact
  // by emitting only fields that differ from the defaults.
  const scoreDefaults = createDefaultScoreDisplaySettings();
  const scoreSettings = store.scoreDisplaySettings;
  const scoreDocument: DocumentScoreSettings = {};
  if (store.displayTransposeSemitones !== 0) {
    scoreDocument.displayTransposeSemitones = store.displayTransposeSemitones;
  }
  if (scoreSettings.displayQuantizeKey !== scoreDefaults.displayQuantizeKey) {
    scoreDocument.displayQuantizeKey = scoreSettings.displayQuantizeKey;
  }
  if (scoreSettings.chordsEnabled !== scoreDefaults.chordsEnabled) {
    scoreDocument.chordsEnabled = scoreSettings.chordsEnabled;
  }
  if (scoreSettings.fullScoreEnabled !== scoreDefaults.fullScoreEnabled) {
    scoreDocument.fullScoreEnabled = scoreSettings.fullScoreEnabled;
  }
  if (scoreSettings.estimateFingering !== scoreDefaults.estimateFingering) {
    scoreDocument.estimateFingering = scoreSettings.estimateFingering;
  }
  if (scoreSettings.pageFormat !== scoreDefaults.pageFormat) {
    scoreDocument.pageFormat = scoreSettings.pageFormat;
  }
  if (scoreSettings.landscape !== scoreDefaults.landscape) {
    scoreDocument.landscape = scoreSettings.landscape;
  }
  if (scoreSettings.pageMarginMm !== scoreDefaults.pageMarginMm) {
    scoreDocument.pageMarginMm = scoreSettings.pageMarginMm;
  }
  if (scoreSettings.scalePercent !== scoreDefaults.scalePercent) {
    scoreDocument.scalePercent = scoreSettings.scalePercent;
  }
  if (scoreSettings.spacingStaff !== scoreDefaults.spacingStaff) {
    scoreDocument.spacingStaff = scoreSettings.spacingStaff;
  }
  if (scoreSettings.barsPerSystem !== scoreDefaults.barsPerSystem) {
    scoreDocument.barsPerSystem = scoreSettings.barsPerSystem;
  }
  if (scoreSettings.barsPerPage !== scoreDefaults.barsPerPage) {
    scoreDocument.barsPerPage = scoreSettings.barsPerPage;
  }
  if (scoreSettings.grandStaffSplitPitch !== scoreDefaults.grandStaffSplitPitch) {
    scoreDocument.grandStaffSplitPitch = scoreSettings.grandStaffSplitPitch;
  }
  if (scoreSettings.viewZoom !== scoreDefaults.viewZoom) {
    scoreDocument.viewZoom = scoreSettings.viewZoom;
  }
  if (Object.keys(scoreDocument).length > 0) doc.score = scoreDocument;
  // MIDI-learn CC bindings are app-level metadata; omitted while there are none.
  // Track-scoped targets embed a session track id, so they are stored with the
  // track's positional index (rebound on load); 'master' and other global
  // targets are stable and stored verbatim. Dangling track bindings drop out.
  // Sorted for determinism.
  if (store.midiCcBindings.size > 0) {
    const entries: DocumentMidiCcBinding[] = [];
    for (const [target, binding] of store.midiCcBindings.entries()) {
      const normalizedTarget = normalizeProcessorMidiLearnTarget(store, target);
      if (normalizedTarget === null) continue;
      const scope = midiLearnTargetScope(normalizedTarget);
      if (scope === null) continue;
      const out: DocumentMidiCcBinding = {
        target: normalizedTarget,
        channel: binding.channel,
        controller: binding.controller,
      };
      if (binding.kind && binding.kind !== 'cc') {
        out.kind = binding.kind;
        out.parameter = binding.parameter;
      }
      if (scope !== 'master' && scope !== 'global') {
        const index = store.tracks.findIndex((track) => track.id === scope);
        if (index < 0) continue;
        const portable = withMidiLearnTargetScope(normalizedTarget, index);
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
  // The surface configuration is rig-shaped rather than musical, so an
  // all-default one is omitted to keep untouched documents byte-identical.
  if (!controlSurfaceSettingsAreDefault(store.controlSurface)) {
    doc.controlSurface = { ...store.controlSurface };
  }
  const mixerSnapshots = toDocumentMixerSnapshotSlots(exportMixerSnapshotSlots(), store.tracks);
  if (mixerSnapshots) doc.mixerSnapshots = mixerSnapshots;
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
  if (doc.externalMidiDefault !== undefined) {
    validateTrackInstrument(doc.externalMidiDefault);
    if (doc.externalMidiDefault.kind !== 'external-midi') {
      throw new RangeError('Project externalMidiDefault must be an external-midi instrument');
    }
  }
  // Parse post-load registries before publishing the staged native Project.
  // Positional ids are sufficient for validation; the state is parsed again
  // against the real session ids after the atomic document swap succeeds.
  const validationTracks = doc.tracks.map((track, index) => ({
    id: index + 1,
    kind: track.kind,
  }));
  fromDocumentMixerSnapshotSlots(doc.mixerSnapshots, validationTracks);
  await store.loadDocument(doc);
  resolveMixerSidechainSourceIds(store.mixer, store.tracks);
  clearHistory();
  importMixerSnapshotSlots(fromDocumentMixerSnapshotSlots(doc.mixerSnapshots, store.tracks));
}
