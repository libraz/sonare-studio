/**
 * Plain-JSON project document types and schema version: the contract between
 * the editor state and the persistence layer (which zips it into a project
 * file). See serialization.ts for the converters.
 */

import type { DocumentNoteAnnotation, DocumentScoreSettings } from './annotations';
import type { AutomationParam, AutomationPoint } from './automation';
import type { EditorChordSymbol } from './chords';
import type {
  MixerSnapshot,
  MixerSnapshotSlot,
  MixerSnapshotTrack,
} from './command/mixer-snapshots';
import type { ControlSurfaceSettings } from './control-surface';
import type { TrackExpressionMap } from './expression-map';
import type { ExternalStemRole } from './external-stems';
import type { TrackProvenance } from './generation';
import type { ExternalMidiInstrument, TrackInstrument } from './instrument';
import type { MidiFxConfig } from './midi-fx';
import type { MixerBus, MixerStrip, ProjectMixerState } from './mixer';
import type {
  ClipExpressionCurve,
  ClipKind,
  EditorNote,
  MidiClipTake,
  SmfSysExPacket,
  TrackKind,
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
 *   Additionally (still version 3, additive): tracks may carry an optional
 *   `pitchRange` (inclusive MIDI pitch, see src/project/pitch-range.ts for the
 *   standard SATB/instrument presets) and an optional `leadFollow`
 *   accompaniment-follow relationship, addressing the followed track by
 *   positional index (see `groupIndex`) and carrying its stashed notes. Both
 *   are omitted when absent, so documents written before them load unchanged.
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
  /** Compatibility mirror of mixer.pan for older document readers. */
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
  /** Playable pitch range (inclusive MIDI pitch); absent = unbounded. */
  pitchRange?: { low: number; high: number };
  /** Accompaniment follow relationship; absent = the track follows nothing. */
  leadFollow?: DocumentLeadFollow;
}

/**
 * Accompaniment follow relationship persisted in a document (see
 * `EditorTrack.leadFollow` in src/project/types.ts). The followed track is
 * addressed by positional index, like {@link DocumentTrack.groupIndex}, since
 * track ids are session-scoped; a stashed note's origin clip has no id of its
 * own in the document either, so it is addressed by its index within this
 * track's `clips` array.
 */
export interface DocumentLeadFollow {
  /** Positional index of the melody track this accompaniment track follows. */
  leadTrackIndex: number;
  /** Notes parked outside their clip by thinning, in source-relative PPQ. */
  stash: Array<{ clipIndex: number; note: DocumentNote }>;
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
