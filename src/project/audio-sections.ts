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
 * in the UI language current at detection. Side-effect-free and
 * dependency-injected for testing; the merge/commit lives in command/timeline.
 */

import type { ChromaResult, Section, SectionAnalysis, SectionType } from '@libraz/libsonare';
import { type SectionId, sectionKindForNameKey } from '@/compose/section-shaping';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { renderAudibleClipMono } from './audible-clip-window';
import { type DefaultNameKey, defaultName } from './default-names';
import {
  type ChromaFeatures,
  groupSectionRepeats,
  SECTION_CHROMA_FFT,
  SECTION_CHROMA_HOP,
  sectionChromaVector,
} from './section-repeats';
import { ppqToSeconds, secondsToPpq } from './tempo-map';
import { type TempoSegment, TRACK_COLOR_PALETTE } from './types';

export type { ChromaFeatures } from './section-repeats';

/** Section types in the order of the labels below; the position is the fallback color key. */
const SECTION_TYPE_ORDER: readonly SectionType[] = [
  'intro',
  'verse',
  'preChorus',
  'chorus',
  'bridge',
  'instrumental',
  'outro',
  'unknown',
];

/** Name keys of the core's section types, in {@link SECTION_TYPE_ORDER} order. */
export const SECTION_TYPE_NAME_KEYS = [
  'sectionIntro',
  'sectionVerse',
  'sectionPreChorus',
  'sectionChorus',
  'sectionBridge',
  'sectionInstrumental',
  'sectionOutro',
  'sectionSection',
] as const satisfies ReadonlyArray<DefaultNameKey>;

/** The audio section detector signature (libsonare `analyzeSections`). */
export type AudioSectionAnalyzer = (samples: Float32Array, sampleRate: number) => SectionAnalysis;

/** The chroma extractor signature (libsonare `chroma`). */
export type AudioChromaAnalyzer = (
  samples: Float32Array,
  sampleRate: number,
  options: { nFft: number; hopLength: number },
) => ChromaResult;

/** A detected section ready for `setSections` (id allocated by the command). */
export interface DetectedSectionInput {
  name: string;
  kind?: SectionId;
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
  chroma?: AudioChromaAnalyzer;
}

/** Position of a section type in {@link SECTION_TYPE_ORDER}. */
function sectionTypeIndex(type: SectionType): number {
  return SECTION_TYPE_ORDER.indexOf(type);
}

/** Name key of a section type; unknown types fall back to the generic section key. */
function sectionNameKey(type: SectionType): DefaultNameKey {
  return (
    SECTION_TYPE_NAME_KEYS[sectionTypeIndex(type)] ??
    SECTION_TYPE_NAME_KEYS[SECTION_TYPE_NAME_KEYS.length - 1]
  );
}

/** Maps a section type to its stable label. */
function sectionLabel(type: SectionType): string {
  return defaultName(sectionNameKey(type));
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
  const { sections } = deps.analyzeSections(mono, sampleRate);
  const clipEndPpq = clip.startPpq + clip.lengthPpq;
  // Map window-relative detection seconds onto the timeline through the tempo
  // map (the inverse of how playback positions the clip), so sections stay
  // aligned when the tempo varies under the clip.
  const clipStartSeconds = ppqToSeconds(map, clip.startPpq);
  const secondsToTimelinePpq = (seconds: number): number =>
    secondsToPpq(map, clipStartSeconds + Math.max(0, seconds));
  const placed: Array<{ section: Section; startPpq: number; endPpq: number }> = [];
  for (const section of sections) {
    const startPpq = secondsToTimelinePpq(section.startSec);
    const endPpq = Math.min(clipEndPpq, secondsToTimelinePpq(section.endSec));
    if (!(endPpq > startPpq)) continue;
    placed.push({ section, startPpq, endPpq });
  }

  // The detector's type ordinal repeats across genuinely different parts, so
  // coloring by it claims two parts are the same when they are not. Compare the
  // audio instead and color by what actually recurs.
  const chromaResult = deps.chroma?.(mono, sampleRate, {
    nFft: SECTION_CHROMA_FFT,
    hopLength: SECTION_CHROMA_HOP,
  });
  const chroma: ChromaFeatures | undefined = chromaResult && {
    nChroma: chromaResult.features.rows,
    nFrames: chromaResult.features.cols,
    features: chromaResult.features.data,
  };
  const framesPerSecond = chroma ? sampleRate / SECTION_CHROMA_HOP : 0;
  const groups = chroma
    ? groupSectionRepeats(
        placed.map(({ section }) =>
          sectionChromaVector(
            chroma,
            Math.floor(section.startSec * framesPerSecond),
            Math.ceil(section.endSec * framesPerSecond),
          ),
        ),
      )
    : placed.map(({ section }) => sectionTypeIndex(section.type));

  // Number each label's occurrences so repeats read in order; the color says
  // which of them are the same music.
  const seenPerLabel = new Map<string, number>();
  return placed.map(({ section, startPpq, endPpq }, index) => {
    const label = sectionLabel(section.type);
    const occurrence = (seenPerLabel.get(label) ?? 0) + 1;
    seenPerLabel.set(label, occurrence);
    const kind = sectionKindForNameKey(sectionNameKey(section.type));
    return {
      name: chroma ? defaultName('sectionOccurrence', { label, number: occurrence }) : label,
      ...(kind !== null ? { kind } : {}),
      color: groupColor(groups[index] ?? 0),
      startPpq,
      endPpq,
    };
  });
}
