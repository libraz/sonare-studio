import type { Section } from '@libraz/libsonare';
import { describe, expect, it } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  type AudioChromaAnalyzer,
  analyzeAudioClipSections,
  SECTION_TYPE_NAME_KEYS,
} from '@/project/audio-sections';
import { defaultName } from '@/project/default-names';
import { groupSectionRepeats, sectionChromaVector } from '@/project/section-repeats';
import { TRACK_COLOR_PALETTE } from '@/project/types';

/** The current-language display name of the section type at `index`. */
function sectionName(index: number): string {
  return defaultName(SECTION_TYPE_NAME_KEYS[index]);
}

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
function analyzer(sections: Array<Pick<Section, 'type' | 'startSec' | 'endSec'>>): {
  fn: (samples: Float32Array, sampleRate: number) => { sections: Section[]; form: string };
  seen: { length: number; sampleRate?: number }[];
} {
  const seen: { length: number; sampleRate?: number }[] = [];
  return {
    fn: (samples, sampleRate) => {
      seen.push({ length: samples.length, sampleRate });
      return {
        sections: sections.map((section, index) => ({
          energyLevel: 0,
          confidence: 1,
          group: index,
          name: section.type,
          ...section,
        })),
        form: '',
      };
    },
    seen,
  };
}

describe('analyzeAudioClipSections', () => {
  it('maps section seconds to PPQ and labels/colors by type', async () => {
    // 120 BPM => seconds * 2 = PPQ.
    const an = analyzer([
      { type: 'intro', startSec: 0, endSec: 2 }, // Intro -> [8, 12)
      { type: 'chorus', startSec: 2, endSec: 4 }, // Chorus -> [12, 16)
    ]);
    const sections = await analyzeAudioClipSections(clipWindow({ startPpq: 8 }), 120, {
      loadAudioAsset: async () => asset(48000),
      analyzeSections: an.fn,
    });
    expect(sections).toEqual([
      { name: sectionName(0), color: TRACK_COLOR_PALETTE[0], startPpq: 8, endPpq: 12 },
      {
        name: sectionName(3),
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
      { type: 'intro', startSec: 0, endSec: 4 },
      { type: 'chorus', startSec: 4, endSec: 6 },
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
      { name: sectionName(0), color: TRACK_COLOR_PALETTE[0], startPpq: 0, endPpq: 4 },
      {
        name: sectionName(3),
        color: TRACK_COLOR_PALETTE[3 % TRACK_COLOR_PALETTE.length],
        startPpq: 4,
        endPpq: 8,
      },
    ]);
  });

  it('labels an unnamed type as the trailing fallback', async () => {
    const an = analyzer([{ type: 'unknown', startSec: 0, endSec: 1 }]);
    const [section] = await analyzeAudioClipSections(clipWindow(), 120, {
      loadAudioAsset: async () => asset(48000),
      analyzeSections: an.fn,
    });
    expect(section.name).toBe(sectionName(SECTION_TYPE_NAME_KEYS.length - 1));
  });

  it('clamps ends to the clip region and drops empty regions', async () => {
    const an = analyzer([
      { type: 'verse', startSec: 0, endSec: 100 }, // runs past the 16-PPQ clip
      { type: 'preChorus', startSec: 50, endSec: 60 }, // entirely past the window
    ]);
    const sections = await analyzeAudioClipSections(clipWindow({ lengthPpq: 16 }), 120, {
      loadAudioAsset: async () => asset(48000),
      analyzeSections: an.fn,
    });
    expect(sections).toEqual([
      { name: sectionName(1), color: TRACK_COLOR_PALETTE[1], startPpq: 0, endPpq: 16 },
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
    const an = analyzer([{ type: 'intro', startSec: 0, endSec: 1 }]);
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

/**
 * Chroma stub: one 12-bin vector per second of input, taken from `perSecond`.
 * Frames are laid out row-major [bin][frame] like the real extractor's output.
 */
function chromaStub(perSecond: ReadonlyArray<ReadonlyArray<number>>): {
  fn: AudioChromaAnalyzer;
  calls: { nFft?: number; hopLength?: number; sampleRate?: number }[];
} {
  const calls: { nFft?: number; hopLength?: number; sampleRate?: number }[] = [];
  return {
    calls,
    fn: (_samples, sampleRate, { nFft, hopLength }) => {
      calls.push({ sampleRate, nFft, hopLength });
      const framesPerSecond = sampleRate / hopLength;
      const nFrames = Math.max(1, Math.round(perSecond.length * framesPerSecond));
      const features = new Float32Array(12 * nFrames);
      for (let frame = 0; frame < nFrames; frame += 1) {
        const second = Math.min(perSecond.length - 1, Math.floor(frame / framesPerSecond));
        for (let bin = 0; bin < 12; bin += 1) {
          features[bin * nFrames + frame] = perSecond[second][bin] ?? 0;
        }
      }
      return {
        sampleRate,
        hopLength,
        features: { data: features, rows: 12, cols: nFrames },
        meanEnergy: [],
      };
    },
  };
}

/** A one-hot chroma vector, standing in for one distinct part. */
function part(bin: number): number[] {
  return Array.from({ length: 12 }, (_, i) => (i === bin ? 1 : 0));
}

describe('groupSectionRepeats', () => {
  const vec = (...values: number[]) => Float64Array.from(values);

  it('gives matching sections the same group and different ones their own', () => {
    expect(groupSectionRepeats([vec(1, 0), vec(0, 1), vec(1, 0)])).toEqual([0, 1, 0]);
  });

  it('refuses to chain two unrelated parts through a near-miss between them', () => {
    // B sits halfway between A and C and matches each at 0.707. Joining a group
    // requires matching every member, so C stays out of the group B joined;
    // matching any one member would have merged all three.
    const a = vec(1, 0);
    const b = vec(Math.SQRT1_2, Math.SQRT1_2);
    const c = vec(0, 1);
    expect(groupSectionRepeats([a, b, c], 0.7)).toEqual([0, 0, 1]);
  });

  it('gives an incomparable section a group of its own that nothing joins', () => {
    expect(groupSectionRepeats([vec(1, 0), null, vec(1, 0), null])).toEqual([0, 1, 0, 2]);
  });
});

describe('analyzeAudioClipSections repeat coloring', () => {
  it('colors by what recurs, not by the type ordinal the detector reuses', async () => {
    // Four seconds: A, B, A, C. The detector types both B and C as 4, which is
    // exactly the case coloring by type gets wrong.
    const an = analyzer([
      { type: 'chorus', startSec: 0, endSec: 1 },
      { type: 'bridge', startSec: 1, endSec: 2 },
      { type: 'chorus', startSec: 2, endSec: 3 },
      { type: 'bridge', startSec: 3, endSec: 4 },
    ]);
    const chroma = chromaStub([part(0), part(4), part(0), part(7)]);
    const sections = await analyzeAudioClipSections(clipWindow({ lengthPpq: 8 }), 120, {
      loadAudioAsset: async () => asset(48000 * 4),
      analyzeSections: an.fn,
      chroma: chroma.fn,
    });

    const colors = sections.map((section) => section.color);
    expect(colors[0]).toBe(colors[2]);
    expect(new Set(colors).size).toBe(3);
    expect(sections.map((section) => section.name)).toEqual([
      `${sectionName(3)} 1`,
      `${sectionName(4)} 1`,
      `${sectionName(3)} 2`,
      `${sectionName(4)} 2`,
    ]);
    expect(chroma.calls).toEqual([{ sampleRate: 48000, nFft: 4096, hopLength: 2048 }]);
  });

  it('keeps the type coloring and unnumbered labels when no chroma is available', async () => {
    const an = analyzer([
      { type: 'chorus', startSec: 0, endSec: 1 },
      { type: 'bridge', startSec: 1, endSec: 2 },
    ]);
    const sections = await analyzeAudioClipSections(clipWindow({ lengthPpq: 4 }), 120, {
      loadAudioAsset: async () => asset(48000 * 2),
      analyzeSections: an.fn,
    });
    expect(sections.map((section) => section.name)).toEqual([sectionName(3), sectionName(4)]);
    expect(sections[0].color).not.toBe(sections[1].color);
  });

  it('does not group two sections merely because both are silent', async () => {
    const an = analyzer([
      { type: 'verse', startSec: 0, endSec: 1 },
      { type: 'verse', startSec: 1, endSec: 2 },
    ]);
    const chroma = chromaStub([new Array(12).fill(0), new Array(12).fill(0)]);
    const sections = await analyzeAudioClipSections(clipWindow({ lengthPpq: 4 }), 120, {
      loadAudioAsset: async () => asset(48000 * 2),
      analyzeSections: an.fn,
      chroma: chroma.fn,
    });
    expect(sections[0].color).not.toBe(sections[1].color);
  });
});

describe('sectionChromaVector', () => {
  const features = (frames: number[][]) => ({
    nChroma: frames[0].length,
    nFrames: frames.length,
    features: Float32Array.from(
      Array.from({ length: frames[0].length }, (_, bin) => frames.map((f) => f[bin])).flat(),
    ),
  });

  it('averages the span and returns a unit vector', () => {
    const chroma = features([
      [2, 0],
      [0, 2],
      [9, 9],
    ]);
    const vector = sectionChromaVector(chroma, 0, 2);
    // Equal energy in both bins, so the unit vector is 45 degrees.
    expect(vector?.[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(vector?.[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('clamps the span to the available frames', () => {
    const chroma = features([
      [1, 0],
      [1, 0],
    ]);
    expect(sectionChromaVector(chroma, -5, 99)).not.toBeNull();
  });

  it('returns null for an empty or silent span', () => {
    const chroma = features([
      [1, 0],
      [0, 0],
    ]);
    expect(sectionChromaVector(chroma, 1, 1)).toBeNull();
    expect(sectionChromaVector(chroma, 1, 2)).toBeNull();
    expect(
      sectionChromaVector({ nChroma: 0, nFrames: 2, features: new Float32Array() }, 0, 2),
    ).toBeNull();
  });
});
