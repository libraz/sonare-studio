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

function asset(id: string, samples: Float32Array, sampleRate = SAMPLE_RATE): LoadedAudioAsset {
  return {
    meta: { id, name: id, sampleRate, numChannels: 1, numFrames: samples.length },
    channels: [samples],
  };
}

/** The same melody with each note lasting `stepSeconds`, at `sampleRate`. */
function melodyAt(stepSeconds: number, sampleRate: number): Float32Array {
  const stepFrames = Math.round(stepSeconds * sampleRate);
  const out = new Float32Array(stepFrames * NOTES.length);
  NOTES.forEach((note, index) => {
    const hz = 440 * 2 ** ((note - 69) / 12);
    for (let i = 0; i < stepFrames; i++) {
      out[index * stepFrames + i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
    }
  });
  return out;
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
      ['reference', asset('reference', melodyAt(0.5, SAMPLE_RATE))],
      ['take', asset('take', melodyAt(0.55, SAMPLE_RATE))],
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

  it('reads the reference and the take at their own rates', async () => {
    const assets = new Map([
      ['reference', asset('reference', melodyAt(0.5, 48000), 48000)],
      ['take', asset('take', melodyAt(0.55, 44100), 44100)],
    ]);
    const tempo = normalizeTempoMap([{ startPpq: 0, bpm: 120 }], 120);
    const clip = { startPpq: 0, lengthPpq: 8, sourceOffsetPpq: 0, assetId: 'take' };
    const reference = { startPpq: 0, lengthPpq: 8, sourceOffsetPpq: 0, assetId: 'reference' };
    const requests: Array<{ sampleRate?: number; takeSampleRate?: number; reference: number }> = [];
    const result = await alignClipWarp(clip, reference, tempo, {
      loadAudioAsset: async (id) => assets.get(id) as LoadedAudioAsset,
      align: (request) => {
        requests.push({
          sampleRate: request.sampleRate,
          takeSampleRate: request.takeSampleRate,
          reference: request.reference.length,
        });
        return wasm.alignTakeToReference(request);
      },
    });
    if (typeof result === 'string') throw new Error(result);

    expect(requests).toEqual([{ sampleRate: 48000, takeSampleRate: 44100, reference: 4 * 48000 }]);
    // Reference 2 s (4 PPQ) is where the take reaches 2.2 s.
    const warped = { ...clip, warp: result.warp };
    expect(warpSourceSecondsAt(warped, 4)).toBeCloseTo(2.2, 1);
    expect(result.warp.sourceStartSeconds).toBeCloseTo(0, 1);
  });

  it('refuses a reference that does not cover the clip window', async () => {
    const assets = new Map([
      ['reference', asset('reference', melodyAt(0.25, SAMPLE_RATE))],
      ['take', asset('take', melodyAt(0.5, SAMPLE_RATE))],
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
