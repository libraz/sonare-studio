import { describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { analyzeAudioClipChords, type DetectedAudioChord } from '@/project/audio-chords';
import type { EditorClip } from '@/project/types';

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
});
