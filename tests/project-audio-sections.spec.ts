import { describe, expect, it } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  analyzeAudioClipSections,
  type DetectedAudioSection,
  SECTION_TYPE_NAMES,
} from '@/project/audio-sections';
import { TRACK_COLOR_PALETTE } from '@/project/types';

/** A minimal audio-clip window with neutral defaults. */
function clipWindow(
  overrides: Partial<{
    assetId?: string;
    startPpq: number;
    lengthPpq: number;
    sourceOffsetPpq: number;
  }> = {},
) {
  return { assetId: 'asset-1', startPpq: 0, lengthPpq: 16, sourceOffsetPpq: 0, ...overrides };
}

/** A loaded asset with `frames` mono samples at `sampleRate`. */
function asset(frames: number, sampleRate = 48000): LoadedAudioAsset {
  return {
    meta: { id: 'asset-1', name: 'a', sampleRate, numChannels: 1, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.5)],
  } as LoadedAudioAsset;
}

/** Section analyzer stub capturing the buffers it saw. */
function analyzer(sections: DetectedAudioSection[]): {
  fn: (samples: Float32Array, sampleRate?: number) => DetectedAudioSection[];
  seen: { length: number; sampleRate?: number }[];
} {
  const seen: { length: number; sampleRate?: number }[] = [];
  return {
    fn: (samples, sampleRate) => {
      seen.push({ length: samples.length, sampleRate });
      return sections;
    },
    seen,
  };
}

describe('analyzeAudioClipSections', () => {
  it('maps section seconds to PPQ and labels/colors by type', async () => {
    // 120 BPM => seconds * 2 = PPQ.
    const an = analyzer([
      { type: 0, start: 0, end: 2 }, // Intro -> [8, 12)
      { type: 3, start: 2, end: 4 }, // Chorus -> [12, 16)
    ]);
    const sections = await analyzeAudioClipSections(clipWindow({ startPpq: 8 }), 120, {
      loadAudioAsset: async () => asset(48000),
      analyzeSections: an.fn,
    });
    expect(sections).toEqual([
      { name: SECTION_TYPE_NAMES[0], color: TRACK_COLOR_PALETTE[0], startPpq: 8, endPpq: 12 },
      {
        name: SECTION_TYPE_NAMES[3],
        color: TRACK_COLOR_PALETTE[3 % TRACK_COLOR_PALETTE.length],
        startPpq: 12,
        endPpq: 16,
      },
    ]);
  });

  it('places section seconds through the project tempo map when it varies', async () => {
    // 60 BPM (1 s/quarter) until PPQ 4, then 120 BPM (0.5 s/quarter): window
    // second 4 lands on PPQ 4 and each later second is two quarters, so a
    // section ending at second 6 reaches PPQ 8 — not PPQ 12 at a constant tempo.
    const an = analyzer([
      { type: 0, start: 0, end: 4 },
      { type: 3, start: 4, end: 6 },
    ]);
    const sections = await analyzeAudioClipSections(
      clipWindow({ startPpq: 0, lengthPpq: 16 }),
      60,
      { loadAudioAsset: async () => asset(48000 * 8), analyzeSections: an.fn },
      [
        { startPpq: 0, bpm: 60 },
        { startPpq: 4, bpm: 120 },
      ],
    );
    expect(sections).toEqual([
      { name: SECTION_TYPE_NAMES[0], color: TRACK_COLOR_PALETTE[0], startPpq: 0, endPpq: 4 },
      {
        name: SECTION_TYPE_NAMES[3],
        color: TRACK_COLOR_PALETTE[3 % TRACK_COLOR_PALETTE.length],
        startPpq: 4,
        endPpq: 8,
      },
    ]);
  });

  it('labels an out-of-range type as the trailing fallback', async () => {
    const an = analyzer([{ type: 99, start: 0, end: 1 }]);
    const [section] = await analyzeAudioClipSections(clipWindow(), 120, {
      loadAudioAsset: async () => asset(48000),
      analyzeSections: an.fn,
    });
    expect(section.name).toBe(SECTION_TYPE_NAMES[SECTION_TYPE_NAMES.length - 1]);
  });

  it('clamps ends to the clip region and drops empty regions', async () => {
    const an = analyzer([
      { type: 1, start: 0, end: 100 }, // runs past the 16-PPQ clip
      { type: 2, start: 50, end: 60 }, // entirely past the window
    ]);
    const sections = await analyzeAudioClipSections(clipWindow({ lengthPpq: 16 }), 120, {
      loadAudioAsset: async () => asset(48000),
      analyzeSections: an.fn,
    });
    expect(sections).toEqual([
      { name: SECTION_TYPE_NAMES[1], color: TRACK_COLOR_PALETTE[1], startPpq: 0, endPpq: 16 },
    ]);
  });

  it('analyzes the sliced window at the asset sample rate', async () => {
    const an = analyzer([]);
    await analyzeAudioClipSections(clipWindow({ lengthPpq: 16 }), 120, {
      loadAudioAsset: async () => asset(48000 * 20),
      analyzeSections: an.fn,
    });
    expect(an.seen).toEqual([{ length: 8 * 48000, sampleRate: 48000 }]);
  });

  it('returns nothing without an asset, at non-positive tempo, or on an empty window', async () => {
    const an = analyzer([{ type: 0, start: 0, end: 1 }]);
    const deps = { loadAudioAsset: async () => asset(48000), analyzeSections: an.fn };

    expect(await analyzeAudioClipSections(clipWindow({ assetId: undefined }), 120, deps)).toEqual(
      [],
    );
    expect(await analyzeAudioClipSections(clipWindow(), 0, deps)).toEqual([]);
    expect(
      await analyzeAudioClipSections(clipWindow(), 120, {
        ...deps,
        loadAudioAsset: async () => asset(0),
      }),
    ).toEqual([]);
  });
});
