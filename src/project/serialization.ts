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

import { clearHistory } from './commands';
import { getProject, useProjectStore } from './store';
import type { EditorNote, TrackKind } from './types';

/** Current schema version written by {@link serializeProject}. */
export const PROJECT_DOCUMENT_SCHEMA_VERSION = 1;

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
  /** Note content in source-relative PPQ. */
  notes: DocumentNote[];
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
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: store.projectName,
    sampleRate: project.getSampleRate(),
    tempoSegments: store.tempoSegments.map((segment) => ({ ...segment })),
    timeSignatures: store.timeSignatures.map((segment) => ({ ...segment })),
    tracks: store.tracks.map((track) => ({
      name: track.name,
      color: track.color,
      kind: track.kind,
      mute: track.mute,
      solo: track.solo,
      volume: track.volume,
      pan: track.pan,
      clips: store.clips
        .filter((clip) => clip.trackId === track.id)
        .map((clip) => ({
          name: clip.name,
          startPpq: clip.startPpq,
          lengthPpq: clip.lengthPpq,
          sourceOffsetPpq: clip.sourceOffsetPpq,
          gain: clip.gain,
          loopEnabled: clip.loopEnabled,
          loopLengthPpq: clip.loopLengthPpq,
          notes: clip.notes.map(toDocumentNote),
        })),
    })),
    markers: store.markers.map((marker) => ({ ppq: marker.ppq, name: marker.name })),
    sections: store.sections.map((section) => ({
      name: section.name,
      color: section.color,
      startPpq: section.startPpq,
      endPpq: section.endPpq,
    })),
  };
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
