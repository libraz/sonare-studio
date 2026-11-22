import { describe, expect, it, vi } from 'vitest';
import { renderWarpedClipSource } from '@/project/warp';
import { coreWasmBinary } from './core-package';

// Rendered through the real engine: its time-stretch mode is what playback uses.
vi.mock('@/lib/wasm', async () => {
  const wasm = await import('@libraz/libsonare');
  let module: typeof wasm | null = null;
  return {
    ensureWasm: async () => {
      if (!module) {
        const wasmBinary = coreWasmBinary();
        await wasm.init({ wasmBinary } as Parameters<typeof wasm.init>[0]);
        module = wasm;
      }
      return module;
    },
  };
});

const SAMPLE_RATE = 44100;

function tone(frames: number, hz: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = 0.25 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  return out;
}

/** Zero crossings per second over the middle half: twice the frequency. */
function crossingHz(samples: Float32Array): number {
  const start = Math.floor(samples.length / 4);
  const end = Math.floor((samples.length * 3) / 4);
  let crossings = 0;
  for (let i = start + 1; i < end; i++) {
    if (samples[i - 1] < 0 !== samples[i] < 0) crossings++;
  }
  return crossings / 2 / ((end - start) / SAMPLE_RATE);
}

describe('renderWarpedClipSource', () => {
  it('stretches to the window length and keeps the pitch', async () => {
    const source = tone(SAMPLE_RATE, 440);
    const lengthFrames = Math.round(SAMPLE_RATE * 1.25);
    const [out] = await renderWarpedClipSource(
      {
        channels: [source],
        lengthFrames,
        anchors: [
          { warpSample: 0, sourceSample: 0 },
          { warpSample: lengthFrames, sourceSample: source.length },
        ],
      },
      SAMPLE_RATE,
    );
    expect(out.length).toBe(lengthFrames);
    expect(Math.abs(crossingHz(out) - 440)).toBeLessThan(5);
  });

  it('keeps the source channel count, rendering beyond two channels in pairs', async () => {
    const channels = [tone(4410, 220), tone(4410, 330), tone(4410, 440)];
    const rendered = await renderWarpedClipSource(
      {
        channels,
        lengthFrames: 8820,
        anchors: [
          { warpSample: 0, sourceSample: 0 },
          { warpSample: 8820, sourceSample: 4410 },
        ],
      },
      SAMPLE_RATE,
    );
    expect(rendered.map((channel) => channel.length)).toEqual([8820, 8820, 8820]);
  });
});
