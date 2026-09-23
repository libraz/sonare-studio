import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { alignClipWarp, thinAnchors } from '@/project/take-alignment';
import { normalizeTempoMap } from '@/project/tempo-map';
import { warpSourceSecondsAt } from '@/project/warp';
import * as wasm from '@/wasm/index.js';

// The alignment itself runs in the real engine; a stub could not match chroma.
beforeAll(async () => {
  const wasmBinary = readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`);
  await wasm.init({ wasmBinary } as Parameters<typeof wasm.init>[0]);
});

const SAMPLE_RATE = 22050;
const NOTES = [60, 64, 67, 72, 71, 67, 64, 62];

/** The same melody with each note lasting `stepSeconds`. */
function melody(stepSeconds: number): Float32Array {
  const stepFrames = Math.round(stepSeconds * SAMPLE_RATE);
  const out = new Float32Array(stepFrames * NOTES.length);
  NOTES.forEach((note, index) => {
    const hz = 440 * 2 ** ((note - 69) / 12);
    for (let i = 0; i < stepFrames; i++) {
      out[index * stepFrames + i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
    }
  });
  return out;
}

function asset(id: string, samples: Float32Array): LoadedAudioAsset {
  return {
    meta: { id, name: id, sampleRate: SAMPLE_RATE, numChannels: 1, numFrames: samples.length },
    channels: [samples],
  };
}

describe('thinAnchors', () => {
  it('keeps the bends and drops anchors a straight line reproduces', () => {
    const anchors = [
      { warpSample: 0, sourceSample: 0 },
      { warpSample: 100, sourceSample: 100 },
      { warpSample: 200, sourceSample: 200 },
      { warpSample: 300, sourceSample: 400 },
      { warpSample: 400, sourceSample: 600 },
    ];
    expect(thinAnchors(anchors, 5)).toEqual([anchors[0], anchors[2], anchors[4]]);
  });
});

describe('alignClipWarp', () => {
  it('warps a slower take so its notes land under the reference', async () => {
    const assets = new Map([
      ['reference', asset('reference', melody(0.5))],
      ['take', asset('take', melody(0.55))],
    ]);
    const tempo = normalizeTempoMap([{ startPpq: 0, bpm: 120 }], 120);
    // 4 s of reference at 120 BPM is 8 PPQ.
    const clip = { startPpq: 0, lengthPpq: 8, sourceOffsetPpq: 0, assetId: 'take' };
    const reference = { startPpq: 0, lengthPpq: 8, sourceOffsetPpq: 0, assetId: 'reference' };
    const result = await alignClipWarp(clip, reference, tempo, {
      loadAudioAsset: async (id) => assets.get(id) as LoadedAudioAsset,
      align: (request) => wasm.alignTakeToReference(request),
    });
    if (typeof result === 'string') throw new Error(result);

    // Reference 2 s (4 PPQ) is where the take reaches 2.2 s.
    const warped = { ...clip, warp: result.warp };
    expect(warpSourceSecondsAt(warped, 4)).toBeCloseTo(2.2, 1);
    expect(result.warp.anchors?.length ?? 0).toBeLessThan(40);
  });

  it('refuses a reference that does not cover the clip window', async () => {
    const assets = new Map([
      ['reference', asset('reference', melody(0.25))],
      ['take', asset('take', melody(0.5))],
    ]);
    const tempo = normalizeTempoMap([{ startPpq: 0, bpm: 120 }], 120);
    const result = await alignClipWarp(
      { startPpq: 0, lengthPpq: 8, sourceOffsetPpq: 0, assetId: 'take' },
      { startPpq: 0, lengthPpq: 4, sourceOffsetPpq: 0, assetId: 'reference' },
      tempo,
      {
        loadAudioAsset: async (id) => assets.get(id) as LoadedAudioAsset,
        align: (request) => wasm.alignTakeToReference(request),
      },
    );
    expect(result).toBe('reference-short');
  });
});
