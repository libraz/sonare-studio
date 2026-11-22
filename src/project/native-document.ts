/**
 * Mirror of the document `Project.toJson()` writes. The core declares no type
 * for it, so this module is the only reader; its closed sets are the core's
 * token unions. It goes away when the core exports a document type.
 */

import type {
  Project,
  ProjectChordQuality,
  ProjectLoopMode,
  ProjectMidiEvent,
  ProjectTempoSegment,
  ProjectTimeSignatureSegment,
  ProjectTrackKind,
  ProjectWarpMode,
} from '@libraz/libsonare';

/** One track entry. */
export interface NativeTrack {
  id: number;
  kind: ProjectTrackKind;
  name: string;
}

/** One clip fade entry. */
export interface NativeClipFade {
  lengthPpq?: number;
}

/** One clip entry. */
export interface NativeClip {
  id: number;
  trackId: number;
  startPpq: number;
  lengthPpq: number;
  sourceOffsetPpq?: number;
  gain?: number;
  loopMode?: ProjectLoopMode;
  loopLengthPpq?: number;
  fadeIn?: NativeClipFade;
  fadeOut?: NativeClipFade;
  warpRefId?: number;
  warpMode?: ProjectWarpMode;
}

/** One warp map entry. */
export interface NativeWarpMap {
  id?: number;
}

/** One chord in the annotation stream. */
export interface NativeAnnotationChord {
  startPpq: number;
  endPpq: number;
  /** Root pitch class; 255 when unknown. */
  rootPc: number;
  quality: ProjectChordQuality;
  /** Slash-bass pitch class; 255 when there is none. */
  slashBassPc: number;
  romanNumeral: string;
  extensions?: number[];
}

/** The slice of the document the studio reads. */
export interface NativeProjectDocument {
  sampleRate?: number;
  midiContent?: Record<string, ProjectMidiEvent[]>;
  tempoSegments?: ProjectTempoSegment[];
  timeSignatures?: ProjectTimeSignatureSegment[];
  tracks?: NativeTrack[];
  clips?: NativeClip[];
  warpMaps?: NativeWarpMap[];
  annotation?: { chords?: NativeAnnotationChord[] };
}

/** Parses the document the Project currently serializes. */
export function readNativeDocument(project: Pick<Project, 'toJson'>): NativeProjectDocument {
  return JSON.parse(project.toJson()) as NativeProjectDocument;
}

/** True when the clip loops. */
export function nativeClipLoops(clip: Pick<NativeClip, 'loopMode'>): boolean {
  return clip.loopMode === 'loop';
}

/** True when the clip's warp mode is anything but `off`. */
export function nativeClipWarps(clip: Pick<NativeClip, 'warpMode'> | undefined): boolean {
  return (clip?.warpMode ?? 'off') !== 'off';
}
