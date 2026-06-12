import type { MidiNote } from '@/engine/instruments';
import type { TrackInstrument } from './instrument';
import type { MixerStrip } from './mixer';

/**
 * One note in the piano-roll editor mirror.
 *
 * The underlying libsonare Project stores anonymous note-on/note-off event
 * pairs only; `id` is an editor-side identity assigned by the project store
 * so the UI can track notes across edits (selection, drag handles, undo).
 */
export interface EditorNote {
  /** Stable editor-assigned identity (monotonic, never reused in a session). */
  id: number;
  /** MIDI note number (integer, 0-127). */
  pitch: number;
  /** Note-on velocity (integer, 1-127). */
  velocity: number;
  /** Note start within the clip, in quarter-note PPQ (fractional allowed, >= 0). */
  startPpq: number;
  /** Note length in PPQ (> 0). */
  durationPpq: number;
  /** MIDI channel (integer, 0-15). */
  channel: number;
  /** Optional note-off (release) velocity (integer, 1-127); omitted = default release. */
  offVelocity?: number;
}

/** Payload for creating a note; velocity and channel fall back to defaults. */
export interface NewEditorNote {
  /** MIDI note number (integer, 0-127). */
  pitch: number;
  /** Note start within the clip, in PPQ (>= 0). */
  startPpq: number;
  /** Note length in PPQ (> 0). */
  durationPpq: number;
  /** Note-on velocity (integer, 1-127). Defaults to 96. */
  velocity?: number;
  /** MIDI channel (integer, 0-15). Defaults to 0. */
  channel?: number;
  /** Optional note-off velocity (integer, 1-127). */
  offVelocity?: number;
}

/** Partial note edit addressed by editor note id (move / resize / velocity). */
export interface EditorNoteUpdate {
  /** Id of the note to edit. */
  id: number;
  /** New MIDI note number (integer, 0-127). */
  pitch?: number;
  /** New note-on velocity (integer, 1-127). */
  velocity?: number;
  /** New start position in PPQ (>= 0). */
  startPpq?: number;
  /** New length in PPQ (> 0). */
  durationPpq?: number;
  /** New MIDI channel (integer, 0-15). */
  channel?: number;
  /** New note-off velocity (integer, 1-127). */
  offVelocity?: number;
}

/**
 * Track content kind. 'audio'/'midi'/'aux' mirror the wasm ProjectTrackKind
 * string forms; 'group' is an app-level folder/submix track (stored as 'aux'
 * in the wasm Project) whose member tracks route through a dedicated engine
 * bus.
 */
export type TrackKind = 'audio' | 'midi' | 'aux' | 'group';

/** Clip content kind: MIDI clips carry notes, audio clips reference an asset. */
export type ClipKind = 'midi' | 'audio';

/**
 * Returns the effective content kind of a clip mirror entry; clips created
 * before audio support (or by plain MIDI commands) have no `kind` field and
 * default to 'midi'.
 */
export function clipKind(clip: Pick<EditorClip, 'kind'>): ClipKind {
  return clip.kind ?? 'midi';
}

/** True when a clip mirror entry is an audio clip. */
export function isAudioClip(clip: Pick<EditorClip, 'kind'>): boolean {
  return clipKind(clip) === 'audio';
}

/**
 * One track in the arrangement mirror.
 *
 * `id`, `name` and `kind` are owned by the wasm Project (write through the
 * commands layer); `color`, `mute`, `solo`, `volume`, `pan`, `order`,
 * `instrument` and `mixer` are app-level metadata the Project has no API for.
 */
export interface EditorTrack {
  /** Stable track id allocated by the wasm Project. */
  id: number;
  /** Track display name (stored in the Project, renameTrack). */
  name: string;
  /** Display color as a CSS color string (app-level metadata). */
  color: string;
  /** Track content kind; only 'midi' tracks carry editable clips today. */
  kind: TrackKind;
  /** Playback mute flag (mirrored to the engine mixer lane in realtime). */
  mute: boolean;
  /** Playback solo flag (mirrored to the engine mixer lane in realtime). */
  solo: boolean;
  /** Linear track volume (>= 0, 1 = unity; mirrored to the engine lane fader). */
  volume: number;
  /** Stereo pan in [-1, 1] (app-level legacy field; the mixer strip pan is the audible pan). */
  pan: number;
  /** Display order index; always equals the track's index in the mirror. */
  order: number;
  /**
   * Id of the group track this track is a member of (app-level metadata);
   * absent = the track outputs to the master mix. Group tracks themselves
   * never carry a groupId (no nesting).
   */
  groupId?: number;
  /**
   * Instrument rendering the track's MIDI clips (app-level metadata); absent
   * = the default synth preset (see src/project/instrument.ts).
   */
  instrument?: TrackInstrument;
  /**
   * Mixer channel strip (app-level metadata); absent = a neutral strip. The
   * strip is audible in realtime through the engine (see src/project/mixer.ts).
   */
  mixer?: MixerStrip;
}

/** One alternative recording of an audio clip (cycle-recording take). */
export interface ClipTake {
  /** Audio asset id (src/persistence/assets.ts) holding this take's PCM. */
  assetId: string;
  /** Take display name (e.g. "Take 2"). */
  name: string;
}

/**
 * One comp selection segment of an audio clip with takes. Segments are
 * sorted by start, the first starts at 0, and each one selects which take
 * plays from its start (clip-window-relative PPQ) up to the next segment's
 * start (the last runs to the clip end).
 */
export interface ClipCompSegment {
  /** Segment start, relative to the clip window, in PPQ (>= 0). */
  startPpq: number;
  /** Index into the clip's takes list. */
  takeIndex: number;
}

/**
 * One clip in the arrangement mirror.
 *
 * All timing/gain/loop fields mirror the wasm Project clip; `name` is
 * app-level metadata. Note PPQ values inside `notes` are source-relative:
 * the audible window is [sourceOffsetPpq, sourceOffsetPpq + lengthPpq),
 * mapped to the timeline at startPpq.
 */
export interface EditorClip {
  /** Stable clip id allocated by the wasm Project. */
  id: number;
  /** Id of the owning track. */
  trackId: number;
  /** Clip display name (app-level metadata). */
  name: string;
  /** Timeline start of the clip, in PPQ. */
  startPpq: number;
  /** Clip length in PPQ. */
  lengthPpq: number;
  /** Offset of the clip window into its source, in PPQ (split/trim adjust it). */
  sourceOffsetPpq: number;
  /** Linear playback gain (>= 0). */
  gain: number;
  /** True when the clip loops its window. */
  loopEnabled: boolean;
  /** Loop length in PPQ (0 = full clip window). */
  loopLengthPpq: number;
  /** Note content recovered from the Project, with editor-assigned ids. */
  notes: EditorNote[];
  /** Clip content kind; absent = 'midi' (see {@link clipKind}). */
  kind?: ClipKind;
  /** Audio asset id (src/persistence/assets.ts); audio clips only. */
  assetId?: string;
  /** Fade-in length in PPQ (> 0 when present); audio clips only. */
  fadeInPpq?: number;
  /** Fade-out length in PPQ (> 0 when present); audio clips only. */
  fadeOutPpq?: number;
  /**
   * Alternative recordings of this clip (cycle-recording takes); audio clips
   * only. When present, playback follows {@link compSegments} and `assetId`
   * mirrors the take selected at the clip start.
   */
  takes?: ClipTake[];
  /** Comp selection over {@link takes}; absent with takes = take 0 throughout. */
  compSegments?: ClipCompSegment[];
}

/** One timeline marker (app-level; the Project has no marker removal API). */
export interface EditorMarker {
  /** Stable editor-assigned marker id. */
  id: number;
  /** Marker position in PPQ (>= 0). */
  ppq: number;
  /** Marker display name. */
  name: string;
}

/** One arrangement section (app-level metadata; the Project has no section API). */
export interface EditorSection {
  /** Stable editor-assigned section id. */
  id: number;
  /** Section display name. */
  name: string;
  /** Display color as a CSS color string. */
  color: string;
  /** Section start in PPQ (>= 0). */
  startPpq: number;
  /** Section end in PPQ (> startPpq). */
  endPpq: number;
}

/** One tempo segment, mirroring the wasm ProjectTempoSegment input shape. */
export interface TempoSegment {
  /** Segment start in PPQ. */
  startPpq: number;
  /** Tempo in BPM at the segment start (> 0). */
  bpm: number;
  /** Optional ramp end tempo in BPM (omitted/0 = constant tempo). */
  endBpm?: number;
}

/** One time-signature segment, mirroring ProjectTimeSignatureSegment. */
export interface TimeSignatureSegment {
  /** Segment start in PPQ. */
  startPpq: number;
  /** Beats per bar (positive integer). */
  numerator: number;
  /** Beat unit (positive integer, e.g. 4 or 8). */
  denominator: number;
}

/** Default colors cycled through when tracks are created without one. */
export const TRACK_COLOR_PALETTE: readonly string[] = [
  '#60a5fa', // blue
  '#f87171', // red
  '#34d399', // green
  '#fbbf24', // amber
  '#a78bfa', // violet
  '#f472b6', // pink
  '#2dd4bf', // teal
  '#fb923c', // orange
];

/** Default color for sections created without one. */
export const DEFAULT_SECTION_COLOR = '#64748b';

/** Scale highlight configuration for the piano roll key lane. */
export interface ScaleHighlightConfig {
  /** Whether scale highlighting is active; when false no pitch class is highlighted. */
  enabled: boolean;
  /** Root pitch class (0-11, C = 0). */
  rootPc: number;
  /** 12-bit interval mask relative to the root (bit n = interval n enabled). */
  modeMask: number;
}

/** 12-bit interval mask of the natural major scale (C major when rootPc = 0). */
export const MAJOR_MODE_MASK = 0b101010110101;

/**
 * Converts an editor note to the engine {@link MidiNote} shape
 * (e.g., for prerenderMidiClip).
 *
 * @param note Editor note to convert.
 * @returns Engine-facing note (drops the editor id and off velocity).
 */
export function editorNoteToMidiNote(note: EditorNote): MidiNote {
  return {
    note: note.pitch,
    velocity: note.velocity,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel,
  };
}

/**
 * Converts a list of editor notes to engine {@link MidiNote}s.
 *
 * @param notes Editor notes to convert.
 * @returns Engine-facing notes in the same order.
 */
export function editorNotesToMidiNotes(notes: ReadonlyArray<EditorNote>): MidiNote[] {
  return notes.map(editorNoteToMidiNote);
}

/**
 * Converts an engine {@link MidiNote} to a {@link NewEditorNote} payload
 * (e.g., to import a generated phrase into the editor).
 *
 * @param note Engine note to convert.
 * @returns Creation payload accepted by the addNote command.
 */
export function midiNoteToNewEditorNote(note: MidiNote): NewEditorNote {
  return {
    pitch: note.note,
    velocity: note.velocity,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel ?? 0,
  };
}
