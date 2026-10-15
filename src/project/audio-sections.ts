/**
 * Audio-driven section detection: runs libsonare's `analyzeSections` over an
 * audio clip's source window and maps the detected song sections onto the
 * project's section lane.
 *
 * Like {@link analyzeAudioClipChords}, the analyzed buffer is cut with the same
 * fixed-tempo slice as playback and detection times (seconds, relative to the
 * window start) are mapped back to absolute PPQ with that same constant tempo.
 * Each detected section is labeled from its `SectionType` ordinal and numbered
 * by occurrence. Color comes from a chroma comparison of the sections
 * themselves rather than from the type ordinal, which the detector reuses
 * across parts that share nothing musically. Names are plain editable strings
 * (sections are app-level metadata, not localized keys). Side-effect-free and
 * dependency-injected for testing; the merge/commit lives in command/timeline.
 */

import type { LoadedAudioAsset } from '@/persistence/assets';
import { renderAudibleClipMono } from './audible-clip-window';
import {
  type ChromaAnalyzer,
  groupSectionRepeats,
  SECTION_CHROMA_FFT,
  SECTION_CHROMA_HOP,
  sectionChromaVector,
} from './section-repeats';
import { ppqToSeconds, secondsToPpq } from './tempo-map';
import { type TempoSegment, TRACK_COLOR_PALETTE } from './types';

export type { ChromaAnalyzer, ChromaFeatures } from './section-repeats';

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
  /**
   * Chroma extractor used to tell repeats apart. Omit to color by detected
   * type, which cannot distinguish two different parts the detector gave the
   * same type ordinal.
   */
  chroma?: ChromaAnalyzer;
}

/** Maps a SectionType ordinal to its stable label. */
function sectionLabel(type: number): string {
  const index = Number.isInteger(type) && type >= 0 ? type : SECTION_TYPE_NAMES.length - 1;
  return SECTION_TYPE_NAMES[index] ?? SECTION_TYPE_NAMES[SECTION_TYPE_NAMES.length - 1];
}

/** Palette entry for a repeat group (or, without chroma, for a type). */
function groupColor(group: number): string {
  return TRACK_COLOR_PALETTE[Math.max(0, group) % TRACK_COLOR_PALETTE.length];
}

/**
 * Detects song sections from an audio clip and returns them as section inputs
 * in absolute PPQ, clamped to the clip's region. Returns `[]` when the clip has
 * no asset, the tempo is non-positive, or the source window is empty.
 *
 * @param clip Audio clip to analyze (needs `assetId`).
 * @param tempoBpm Fallback tempo (> 0) when `tempoSegments` is empty.
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
  const audible = await renderAudibleClipMono(clip, tempoBpm, tempoSegments, deps.loadAudioAsset);
  if (!audible) return [];
  const { mono, sampleRate, map } = audible;
  const sections = deps.analyzeSections(mono, sampleRate);
  const clipEndPpq = clip.startPpq + clip.lengthPpq;
  // Map window-relative detection seconds onto the timeline through the tempo
  // map (the inverse of how playback positions the clip), so sections stay
  // aligned when the tempo varies under the clip.
  const clipStartSeconds = ppqToSeconds(map, clip.startPpq);
  const secondsToTimelinePpq = (seconds: number): number =>
    secondsToPpq(map, clipStartSeconds + Math.max(0, seconds));
  const placed: Array<{ section: DetectedAudioSection; startPpq: number; endPpq: number }> = [];
  for (const section of sections ?? []) {
    const startPpq = secondsToTimelinePpq(section.start);
    const endPpq = Math.min(clipEndPpq, secondsToTimelinePpq(section.end));
    if (!(endPpq > startPpq)) continue;
    placed.push({ section, startPpq, endPpq });
  }

  // The detector's type ordinal repeats across genuinely different parts, so
  // coloring by it claims two parts are the same when they are not. Compare the
  // audio instead and color by what actually recurs.
  const chroma = deps.chroma?.(mono, sampleRate, SECTION_CHROMA_FFT, SECTION_CHROMA_HOP);
  const framesPerSecond = chroma ? sampleRate / SECTION_CHROMA_HOP : 0;
  const groups = chroma
    ? groupSectionRepeats(
        placed.map(({ section }) =>
          sectionChromaVector(
            chroma,
            Math.floor(section.start * framesPerSecond),
            Math.ceil(section.end * framesPerSecond),
          ),
        ),
      )
    : placed.map(({ section }) => (Number.isInteger(section.type) ? section.type : 0));

  // Number each label's occurrences so repeats read in order; the color says
  // which of them are the same music.
  const seenPerLabel = new Map<string, number>();
  return placed.map(({ section, startPpq, endPpq }, index) => {
    const label = sectionLabel(section.type);
    const occurrence = (seenPerLabel.get(label) ?? 0) + 1;
    seenPerLabel.set(label, occurrence);
    return {
      name: chroma ? `${label} ${occurrence}` : label,
      color: groupColor(groups[index] ?? 0),
      startPpq,
      endPpq,
    };
  });
}
