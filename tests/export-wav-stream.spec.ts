import { strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createWavStreamWriter } from '@/export/wav-stream';
import { PayloadMemoryMeter } from '@/lib/payload-memory';

describe('streaming WAV writer', () => {
  it('writes a valid RIFF header followed by incrementally encoded PCM', async () => {
    const writer = createWavStreamWriter({
      sampleRate: 48_000,
      bitDepth: 16,
      meter: new PayloadMemoryMeter({ label: 'test', budgetBytes: 1024 }),
    });
    writer.add([new Float32Array([0, 1]), new Float32Array([0, -1])], 0);
    writer.add([new Float32Array([0.5]), new Float32Array([-0.5])], 2);

    const bytes = new Uint8Array(await writer.close(3).arrayBuffer());
    expect(strFromU8(bytes.subarray(0, 4))).toBe('RIFF');
    expect(strFromU8(bytes.subarray(8, 12))).toBe('WAVE');
    expect(strFromU8(bytes.subarray(36, 40))).toBe('data');
    expect(bytes).toHaveLength(44 + 3 * 2 * 2);
  });

  it('rejects non-contiguous worker chunks', () => {
    const writer = createWavStreamWriter({
      sampleRate: 48_000,
      bitDepth: 16,
      meter: new PayloadMemoryMeter({ label: 'test', budgetBytes: 1024 }),
    });
    expect(() => writer.add([new Float32Array(1), new Float32Array(1)], 2)).toThrow(/offset/);
    writer.abort();
  });
});
