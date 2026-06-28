/**
 * Audio-driven section detection: runs libsonare's `analyzeSections` over an
 * audio clip's source window and maps the detected song sections onto the
 * project's section lane.
 *
 * Like {@link analyzeAudioClipChords}, the analyzed buffer is cut with the same
 * fixed-tempo slice as playback and detection times (seconds, relative to the
 * window start) are mapped back to absolute PPQ with that same constant tempo.
 * Each detected section is labeled from its `SectionType` ordinal and colored
 * by type so repeats share a color; names are plain editable strings (sections
 * are app-level metadata, not localized keys). Side-effect-free and
 * dependency-injected for testing; the merge/commit lives in command/timeline.
 */

import type { LoadedAudioAsset } from '@/persistence/assets';
import { mixdownToMono } from './audio-import';
import { sliceAudioClipWindow } from './scheduling';
import { normalizeTempoMap, ppqToSeconds, secondsToPpq } from './tempo-map';
import { type TempoSegment, TRACK_COLOR_PALETTE } from './types';

/**
 * Section labels indexed by libsonare `SectionType` ordinal
 * (Intro=0 .. Unknown=7).
 */
export const SECTION_TYPE_NAMES = [
  'Intro',
  'Verse',
  'Pre-Chorus',
  'Chorus',
  'Bridge',
  'Instrumental',
  'Outro',
  'Section',
] as const;

/** A section returned by the engine detector (the fields we consume). */
export interface DetectedAudioSection {
  /** SectionType ordinal (Intro=0 .. Unknown=7). */
  type: number;
  /** Window-relative start in seconds. */
  start: number;
  /** Window-relative end in seconds. */
  end: number;
}

/** The audio section detector signature (libsonare `analyzeSections`). */
export type AudioSectionAnalyzer = (
  samples: Float32Array,
  sampleRate?: number,
) => ReadonlyArray<DetectedAudioSection>;

/** A detected section ready for `setSections` (id allocated by the command). */
export interface DetectedSectionInput {
  name: string;
  color: string;
  startPpq: number;
  endPpq: number;
}

/** Injectable dependencies for {@link analyzeAudioClipSections}. */
export interface AudioSectionDeps {
  /** Loads an audio asset's PCM (defaults to the OPFS asset store). */
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** The audio section analyzer. */
  analyzeSections: AudioSectionAnalyzer;
}

/** Maps a SectionType ordinal to a stable label and palette color. */
function labelAndColor(type: number): { name: string; color: string } {
  const index = Number.isInteger(type) && type >= 0 ? type : SECTION_TYPE_NAMES.length - 1;
  const name = SECTION_TYPE_NAMES[index] ?? SECTION_TYPE_NAMES[SECTION_TYPE_NAMES.length - 1];
  const color = TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length];
  return { name, color };
}

/**
 * Detects song sections from an audio clip and returns them as section inputs
 * in absolute PPQ, clamped to the clip's region. Returns `[]` when the clip has
 * no asset, the tempo is non-positive, or the source window is empty.
 *
 * @param clip Audio clip to analyze (needs `assetId`).
 * @param tempoBpm Constant tempo (> 0) used for the window slice (the clip
 *   plays at its native sample rate, so the slice is fixed-tempo).
 * @param deps Injected asset loader and section analyzer.
 * @param tempoSegments Project tempo map; detection times are placed on the
 *   timeline through it, so sections land correctly when the tempo varies under
 *   the clip. Empty (the default) reduces to the constant `tempoBpm` mapping.
 * @returns Detected sections (unsorted; `setSections` sorts and assigns ids).
 */
export async function analyzeAudioClipSections(
  clip: { assetId?: string; startPpq: number; lengthPpq: number; sourceOffsetPpq: number },
  tempoBpm: number,
  deps: AudioSectionDeps,
  tempoSegments: ReadonlyArray<TempoSegment> = [],
): Promise<DetectedSectionInput[]> {
  if (clip.assetId === undefined || !(tempoBpm > 0)) return [];
  const asset = await deps.loadAudioAsset(clip.assetId);
  const window = sliceAudioClipWindow(
    asset.channels,
    asset.meta.sampleRate,
    clip.sourceOffsetPpq,
    clip.lengthPpq,
    tempoBpm,
  );
  const mono = mixdownToMono(window);
  if (mono.length === 0) return [];
  const sections = deps.analyzeSections(mono, asset.meta.sampleRate);
  const clipEndPpq = clip.startPpq + clip.lengthPpq;
  // Map window-relative detection seconds onto the timeline through the tempo
  // map (the inverse of how playback positions the clip), so sections stay
  // aligned when the tempo varies under the clip.
  const map = normalizeTempoMap(tempoSegments, tempoBpm);
  const clipStartSeconds = ppqToSeconds(map, clip.startPpq);
  const secondsToTimelinePpq = (seconds: number): number =>
    secondsToPpq(map, clipStartSeconds + Math.max(0, seconds));
  const out: DetectedSectionInput[] = [];
  for (const section of sections ?? []) {
    const startPpq = secondsToTimelinePpq(section.start);
    const endPpq = Math.min(clipEndPpq, secondsToTimelinePpq(section.end));
    if (!(endPpq > startPpq)) continue;
    out.push({ ...labelAndColor(section.type), startPpq, endPpq });
  }
  return out;
}
