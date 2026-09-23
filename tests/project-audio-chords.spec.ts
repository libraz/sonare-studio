import { describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  analyzeAudioClipChords,
  type DetectedAudioChord,
  detectedChordQuality,
  smoothDetectedChordSymbols,
} from '@/project/audio-chords';
import { chordTonePitchClasses, type EditorChordSymbol, formatChordName } from '@/project/chords';
import type { EditorClip } from '@/project/types';
import { ChordQuality } from '@/wasm/index.js';

/** A minimal audio clip; fields not relevant to detection use neutral values. */
function audioClip(overrides: Partial<EditorClip> = {}): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'audio',
    startPpq: 0,
    lengthPpq: 16,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    kind: 'audio',
    assetId: 'asset-1',
    ...overrides,
  };
}

/** A loaded asset with `frames` mono samples at `sampleRate`. */
function asset(frames: number, sampleRate = 48000): LoadedAudioAsset {
  return {
    meta: { id: 'asset-1', name: 'a', sampleRate, numChannels: 1, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.5)],
  } as LoadedAudioAsset;
}

/** Detector stub returning a fixed progression, capturing the buffer it saw. */
function detector(chords: DetectedAudioChord[]): {
  fn: (samples: Float32Array, sampleRate?: number) => { chords: DetectedAudioChord[] };
  seen: { length: number; sampleRate?: number }[];
} {
  const seen: { length: number; sampleRate?: number }[] = [];
  return {
    fn: (samples, sampleRate) => {
      seen.push({ length: samples.length, sampleRate });
      return { chords };
    },
    seen,
  };
}

describe('analyzeAudioClipChords', () => {
  it('maps detection seconds to absolute PPQ at the clip tempo and offset', async () => {
    // 120 BPM => 0.5 s per quarter (PPQ) => seconds * 2 = PPQ.
    const det = detector([
      { root: 0, bass: 0, quality: 0, start: 0, end: 1 }, // C  -> [0, 2)
      { root: 7, bass: 7, quality: 4, start: 1, end: 2 }, // G7 -> [2, 4)
    ]);
    const symbols = await analyzeAudioClipChords(audioClip({ startPpq: 8 }), 120, {
      loadAudioAsset: async () => asset(48000),
      detectChords: det.fn,
    });
    expect(symbols).toEqual([
      { startPpq: 8, endPpq: 10, rootPc: 0, quality: 0 },
      { startPpq: 10, endPpq: 12, rootPc: 7, quality: 4 },
    ]);
  });

  it('places detection seconds through the project tempo map when it varies', async () => {
    // Tempo map: 60 BPM (1 s/quarter) until PPQ 4, then 120 BPM (0.5 s/quarter).
    // Window second 4 sits exactly on the change (PPQ 4); each later second is
    // worth two quarters, so second 5 -> PPQ 6 and second 6 -> PPQ 8 — not the
    // PPQ 10 / 12 a constant 120 BPM, nor the PPQ 5 / 6 a constant 60 BPM, gives.
    const det = detector([
      { root: 0, bass: 0, quality: 0, start: 0, end: 4 },
      { root: 7, bass: 7, quality: 0, start: 4, end: 5 },
      { root: 5, bass: 5, quality: 0, start: 5, end: 6 },
    ]);
    const symbols = await analyzeAudioClipChords(
      audioClip({ startPpq: 0, lengthPpq: 16 }),
      60,
      { loadAudioAsset: async () => asset(48000 * 8), detectChords: det.fn },
      [
        { startPpq: 0, bpm: 60 },
        { startPpq: 4, bpm: 120 },
      ],
    );
    expect(symbols).toEqual([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 6, rootPc: 7, quality: 0 },
      { startPpq: 6, endPpq: 8, rootPc: 5, quality: 0 },
    ]);
  });

  it('accounts for the clip start offset before mapping detection seconds through tempo changes', async () => {
    // The clip begins at PPQ 2, two seconds into a 60 BPM section. A detection
    // at window second 2 therefore lands on absolute second 4 / PPQ 4, exactly
    // at the tempo change; the next detected second advances two PPQ at 120 BPM.
    const det = detector([{ root: 9, bass: 9, quality: 0, start: 2, end: 3 }]);
    const symbols = await analyzeAudioClipChords(
      audioClip({ startPpq: 2, lengthPpq: 8 }),
      60,
      { loadAudioAsset: async () => asset(48000 * 8), detectChords: det.fn },
      [
        { startPpq: 0, bpm: 60 },
        { startPpq: 4, bpm: 120 },
      ],
    );

    expect(symbols).toEqual([{ startPpq: 4, endPpq: 6, rootPc: 9, quality: 0 }]);
  });

  it('carries a slash bass only when the bass differs from the root', async () => {
    const det = detector([{ root: 7, bass: 0, quality: 4, start: 0, end: 1 }]);
    const [symbol] = await analyzeAudioClipChords(audioClip(), 120, {
      loadAudioAsset: async () => asset(48000),
      detectChords: det.fn,
    });
    expect(symbol.bassPc).toBe(0);
  });

  it('clamps chord ends to the clip region and drops empty regions', async () => {
    const det = detector([
      { root: 0, bass: 0, quality: 0, start: 0, end: 100 }, // runs past the 16-PPQ clip
      { root: 2, bass: 2, quality: 1, start: 50, end: 60 }, // entirely past the window
    ]);
    const symbols = await analyzeAudioClipChords(audioClip({ startPpq: 0, lengthPpq: 16 }), 120, {
      loadAudioAsset: async () => asset(48000),
      detectChords: det.fn,
    });
    expect(symbols).toEqual([{ startPpq: 0, endPpq: 16, rootPc: 0, quality: 0 }]);
  });

  it('analyzes the sliced source window at the asset sample rate', async () => {
    // 120 BPM, 16 PPQ window => 8 s => 8 * 48000 frames sliced from the asset.
    const det = detector([]);
    await analyzeAudioClipChords(audioClip({ lengthPpq: 16 }), 120, {
      loadAudioAsset: async () => asset(48000 * 20),
      detectChords: det.fn,
    });
    expect(det.seen).toEqual([{ length: 8 * 48000, sampleRate: 48000 }]);
  });

  it('returns nothing without an asset, at non-positive tempo, or on an empty window', async () => {
    const det = detector([{ root: 0, bass: 0, quality: 0, start: 0, end: 1 }]);
    const deps = { loadAudioAsset: async () => asset(48000), detectChords: det.fn };

    expect(await analyzeAudioClipChords(audioClip({ assetId: undefined }), 120, deps)).toEqual([]);
    expect(await analyzeAudioClipChords(audioClip(), 0, deps)).toEqual([]);

    const empty = vi.fn(async () => asset(0));
    expect(
      await analyzeAudioClipChords(audioClip(), 120, { ...deps, loadAudioAsset: empty }),
    ).toEqual([]);
  });

  it('absorbs a short single-window outlier between identical neighbours', async () => {
    // C held over four beats, but one short window mis-reads as G in the middle.
    const det = detector([
      { root: 0, bass: 0, quality: 0, start: 0, end: 1 }, // C  -> [0, 2)
      { root: 7, bass: 7, quality: 4, start: 1, end: 1.25 }, // G7 -> [2, 2.5), outlier
      { root: 0, bass: 0, quality: 0, start: 1.25, end: 2 }, // C  -> [2.5, 4)
    ]);
    const symbols = await analyzeAudioClipChords(audioClip({ startPpq: 0 }), 120, {
      loadAudioAsset: async () => asset(48000),
      detectChords: det.fn,
    });
    // The outlier is absorbed and the flanking C regions merge into one span.
    expect(symbols).toEqual([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
  });
});

describe('smoothDetectedChordSymbols', () => {
  function chord(startPpq: number, endPpq: number, rootPc: number, quality = 0): EditorChordSymbol {
    return { startPpq, endPpq, rootPc, quality };
  }

  it('merges adjacent identical contiguous regions', () => {
    const smoothed = smoothDetectedChordSymbols([
      chord(0, 2, 0),
      chord(2, 4, 0),
      chord(4, 6, 7, 4),
    ]);
    expect(smoothed).toEqual([chord(0, 4, 0), chord(4, 6, 7, 4)]);
  });

  it('absorbs a short outlier flanked by identical neighbours', () => {
    const smoothed = smoothDetectedChordSymbols([
      chord(0, 4, 0),
      chord(4, 4.5, 5, 1), // short outlier
      chord(4.5, 8, 0),
    ]);
    expect(smoothed).toEqual([chord(0, 8, 0)]);
  });

  it('keeps a long chord between identical neighbours (not an outlier)', () => {
    const input = [chord(0, 4, 0), chord(4, 8, 7, 4), chord(8, 12, 0)];
    expect(smoothDetectedChordSymbols(input)).toEqual(input);
  });

  it('keeps a short chord whose neighbours differ from each other', () => {
    const input = [chord(0, 4, 0), chord(4, 4.5, 5, 1), chord(4.5, 8, 7, 4)];
    expect(smoothDetectedChordSymbols(input)).toEqual(input);
  });

  it('sorts by onset before smoothing', () => {
    const smoothed = smoothDetectedChordSymbols([chord(2, 4, 0), chord(0, 2, 0)]);
    expect(smoothed).toEqual([chord(0, 4, 0)]);
  });
});

describe('detectedChordQuality', () => {
  /** Root-relative pitch classes each detector template sounds (13 adds its fifth back). */
  const DETECTOR_TONES: Record<number, number[]> = {
    [ChordQuality.Sus2Add4]: [0, 2, 5, 7],
    [ChordQuality.Major6]: [0, 4, 7, 9],
    [ChordQuality.Minor6]: [0, 3, 7, 9],
    [ChordQuality.MinorMajor7]: [0, 3, 7, 11],
    [ChordQuality.Dominant7Sus4]: [0, 5, 7, 10],
    [ChordQuality.Dominant11]: [0, 2, 5, 7, 10],
    [ChordQuality.Dominant13]: [0, 2, 4, 7, 9, 10],
    [ChordQuality.Dominant7Flat9]: [0, 1, 4, 7, 10],
    [ChordQuality.Dominant7Sharp9]: [0, 3, 4, 7, 10],
  };

  it('maps every detector quality the module publishes', () => {
    for (const ordinal of Object.values(ChordQuality)) {
      expect(() => detectedChordQuality(ordinal)).not.toThrow();
    }
  });

  it('keeps the shared ordinals and spells the rest with extensions', () => {
    expect(detectedChordQuality(ChordQuality.Dominant9)).toEqual({ quality: 15 });
    for (const [ordinal, tones] of Object.entries(DETECTOR_TONES)) {
      const symbol = {
        startPpq: 0,
        endPpq: 1,
        rootPc: 0,
        ...detectedChordQuality(Number(ordinal)),
      };
      expect(chordTonePitchClasses(symbol)).toEqual(tones);
    }
  });

  it('names the added qualities conventionally', () => {
    const name = (ordinal: number) =>
      formatChordName({ startPpq: 0, endPpq: 1, rootPc: 0, ...detectedChordQuality(ordinal) });
    expect(
      [
        ChordQuality.Major6,
        ChordQuality.Minor6,
        ChordQuality.MinorMajor7,
        ChordQuality.Dominant7Sus4,
        ChordQuality.Dominant11,
        ChordQuality.Dominant13,
        ChordQuality.Dominant7Flat9,
        ChordQuality.Dominant7Sharp9,
      ].map(name),
    ).toEqual(['C6', 'Cm6', 'Cm(maj7)', 'C7sus4', 'C11', 'C13', 'C7b9', 'C7#9']);
  });

  it('carries the mapped quality into the detected symbols', async () => {
    const det = detector([
      { root: 2, bass: 2, quality: ChordQuality.Dominant7Flat9, start: 0, end: 1 },
    ]);
    const symbols = await analyzeAudioClipChords(audioClip(), 120, {
      loadAudioAsset: async () => asset(48000 * 8),
      detectChords: det.fn,
    });
    expect(symbols[0]).toMatchObject({ rootPc: 2, quality: 4, extensions: [1] });
  });
});
