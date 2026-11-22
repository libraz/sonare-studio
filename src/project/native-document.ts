/**
 * Mirror of the document `Project.toJson()` writes. The core declares no type
 * for it and stores some closed sets as ordinals, so this module is the only
 * reader and owns every ordinal-to-token mapping. It goes away when the core
 * exports a document type.
 */

import type {
  Project,
  ProjectChordQuality,
  ProjectMidiEvent,
  ProjectTempoSegment,
  ProjectTimeSignatureSegment,
} from '@/wasm/index.js';
import type { TrackKind } from './types';

/** `ProjectChordQuality` tokens in the ordinal order the document stores them. */
export const PROJECT_CHORD_QUALITY_BY_ORDINAL: ReadonlyArray<ProjectChordQuality> = [
  'unknown',
  'major',
  'minor',
  'diminished',
  'augmented',
  'dominant',
  'halfDiminished',
  'suspended',
];

/** One track entry. `kind` is an ordinal: 0=audio, 1=midi, 2=aux. */
export interface NativeTrack {
  id: number;
  kind: number;
  name: string;
}

/** One clip fade entry. */
export interface NativeClipFade {
  lengthPpq?: number;
}

/** One clip entry. `loopMode`: 0=off, 1=loop. `warpMode`: 0=off, else warping. */
export interface NativeClip {
  id: number;
  trackId: number;
  startPpq: number;
  lengthPpq: number;
  sourceOffsetPpq?: number;
  gain?: number;
  loopMode?: number;
  loopLengthPpq?: number;
  fadeIn?: NativeClipFade;
  fadeOut?: NativeClipFade;
  warpRefId?: number;
  warpMode?: number;
}

/** One warp map entry. */
export interface NativeWarpMap {
  id?: number;
}

/** One chord in the annotation stream. `quality` indexes {@link PROJECT_CHORD_QUALITY_BY_ORDINAL}. */
export interface NativeAnnotationChord {
  startPpq: number;
  endPpq: number;
  /** Root pitch class; 255 when unknown. */
  rootPc: number;
  quality: number;
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

/** Maps a track-kind ordinal to the editor kind (unknown ordinals read as midi). */
export function nativeTrackKind(ordinal: number): TrackKind {
  if (ordinal === 0) return 'audio';
  if (ordinal === 2) return 'aux';
  return 'midi';
}

/** True when the clip's loop-mode ordinal is `loop`. */
export function nativeClipLoops(clip: Pick<NativeClip, 'loopMode'>): boolean {
  return clip.loopMode === 1;
}

/** True when the clip's warp-mode ordinal is anything but `off`. */
export function nativeClipWarps(clip: Pick<NativeClip, 'warpMode'> | undefined): boolean {
  return (clip?.warpMode ?? 0) !== 0;
}
