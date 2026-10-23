import { describe, expect, it, vi } from 'vitest';
import { interleaveChannels } from '@/persistence/assets';
import { analyzeAudioTagsInWorker } from '@/project/audio-analysis-client';
import { ingestAudioBuffer } from '@/project/audio-import';
import { type AudioAnalysisFunctions, analyzeAudioTags } from '@/project/audio-tags';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const SAMPLE_RATE = 48000;

/** Returns the tags the import would store, without touching storage. */
async function importedTags(channels: Float32Array[]) {
  const save = vi.fn(async (meta: { tags?: Record<string, number> }) => meta);
  const meta = await ingestAudioBuffer(channels, SAMPLE_RATE, 'Asset', {
    analysis,
    save: save as never,
  });
  return (meta as unknown as { tags?: { lufs?: number } }).tags;
}

function sine(frames = 4800): Float32Array {
  return Float32Array.from({ length: frames }, (_, i) =>
    Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE),
  );
}

/** Unweighted channel-power sum with the BS.1770 offset; enough to show the summing. */
function channelSummedLufs(samples: Float32Array, channels: number): number {
  let power = 0;
  for (let c = 0; c < channels; c += 1) {
    let sum = 0;
    let n = 0;
    for (let i = c; i < samples.length; i += channels) {
      sum += samples[i] * samples[i];
      n += 1;
    }
    power += sum / n;
  }
  return -0.691 + 10 * Math.log10(power);
}

const analysis: AudioAnalysisFunctions = {
  lufs: (samples) => ({ integratedLufs: channelSummedLufs(samples, 1) }),
  lufsInterleaved: (samples, channels) => ({
    integratedLufs: channelSummedLufs(samples, channels),
  }),
};

describe('asset loudness tag', () => {
  it('reads a centred stereo asset 3.01 dB above its mono loudness', async () => {
    const x = sine();
    const monoLufs = channelSummedLufs(x, 1);
    const tags = await importedTags([x, new Float32Array(x)]);
    expect(tags?.lufs).toBeCloseTo(monoLufs + 3.0103, 3);
  });

  it('matches lufsInterleaved on the stored PCM for a wide stereo asset', async () => {
    const left = sine();
    const right = left.map((v) => -v);
    const tags = await importedTags([left, right]);
    expect(tags?.lufs).toBeCloseTo(channelSummedLufs(interleaveChannels([left, right]), 2), 6);
  });

  it('measures a mono asset with the mono function', () => {
    const x = sine();
    const tags = analyzeAudioTags(x, SAMPLE_RATE, analysis, undefined, {
      interleaved: x,
      channels: 1,
    });
    expect(tags.lufs).toBeCloseTo(channelSummedLufs(x, 1), 6);
  });

  it('leaves a multichannel asset untagged rather than reading a downmix', () => {
    const x = sine();
    const tags = analyzeAudioTags(x, SAMPLE_RATE, { lufs: analysis.lufs }, undefined, {
      interleaved: interleaveChannels([x, x]),
      channels: 2,
    });
    expect(tags.lufs).toBeUndefined();
  });
});

describe('worker loudness request', () => {
  it('carries the interleaved channels and transfers them with the mono buffer', async () => {
    const posted: Array<{ message: Record<string, unknown>; transfer: Transferable[] }> = [];
    const listeners: Array<(event: unknown) => void> = [];
    const worker = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === 'message') listeners.push(listener);
      },
      removeEventListener: () => {},
      terminate: () => {},
      postMessage(message: Record<string, unknown>, transfer: Transferable[]) {
        posted.push({ message, transfer });
        queueMicrotask(() => {
          for (const listener of listeners) listener({ data: { type: 'done', tags: {} } });
        });
      },
    };
    const mono = new Float32Array([0.1, 0.2]);
    const interleaved = new Float32Array([0.1, 0.1, 0.2, 0.2]);
    await analyzeAudioTagsInWorker(mono, SAMPLE_RATE, {
      loudness: { interleaved, channels: 2 },
      workerFactory: () => worker as unknown as Worker,
    });
    expect(posted[0].message.loudness).toEqual({ interleaved, channels: 2 });
    expect(posted[0].transfer).toEqual([mono.buffer, interleaved.buffer]);
  });
});
