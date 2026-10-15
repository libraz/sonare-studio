import { strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { wavHeaderByteLength, wavTrailingMetadataByteLength } from '@/export/wav';
import { createWavStreamWriter } from '@/export/wav-stream';
import { PayloadMemoryLimitError, PayloadMemoryMeter } from '@/lib/payload-memory';

describe('streaming WAV writer', () => {
  it('writes a valid RIFF header followed by incrementally encoded PCM', async () => {
    const writer = createWavStreamWriter({
      sampleRate: 48_000,
      bitDepth: 16,
      meter: new PayloadMemoryMeter({
        operation: 'audio-export',
        label: 'test',
        budgetBytes: 1024,
      }),
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
      meter: new PayloadMemoryMeter({
        operation: 'audio-export',
        label: 'test',
        budgetBytes: 1024,
      }),
    });
    expect(() => writer.add([new Float32Array(1), new Float32Array(1)], 2)).toThrow(/offset/);
    writer.abort();
  });

  it('charges the full Blob publish copy and releases chunks when publishing is over budget', () => {
    const meter = new PayloadMemoryMeter({
      operation: 'audio-export',
      label: 'test',
      budgetBytes: 56,
    });
    const writer = createWavStreamWriter({
      sampleRate: 48_000,
      bitDepth: 16,
      meter,
    });
    // Two stereo frames retain 8 bytes of encoded PCM. The final WAV is 52
    // bytes, so accounting for its publish copy must exceed this 56-byte
    // budget (8 + 52), while the old header-only reservation did not.
    writer.add([new Float32Array([0, 1]), new Float32Array([0, -1])], 0);

    expect(() => writer.close(2)).toThrow(PayloadMemoryLimitError);
    expect(meter.snapshot().activeBytes).toBe(0);
  });

  it('reserves the header before allocating it as well as the Blob publish copy', () => {
    // Two stereo frames retain 8 bytes. Their 44-byte WAV header plus the
    // 52-byte Blob publish copy peak at 104 bytes. A 103-byte budget used to
    // pass because the header was created outside the meter.
    const meter = new PayloadMemoryMeter({
      operation: 'audio-export',
      label: 'test',
      budgetBytes: 103,
    });
    const writer = createWavStreamWriter({ sampleRate: 48_000, bitDepth: 16, meter });
    writer.add([new Float32Array([0, 1]), new Float32Array([0, -1])], 0);

    expect(() => writer.close(2)).toThrow(PayloadMemoryLimitError);
    expect(meter.snapshot().peakActiveBytes).toBe(52);
    expect(meter.snapshot().activeBytes).toBe(0);
  });

  it('accounts metadata buffers and the final publish at their exact peak', async () => {
    const metadata = {
      title: 'Delivery',
      markers: [{ sampleOffset: 0, name: 'Drop' }],
    };
    const chunkBytes = 4;
    const headerBytes = wavHeaderByteLength(1, 2, 16, metadata);
    const trailingBytes = wavTrailingMetadataByteLength(metadata);
    const fileBytes = headerBytes + chunkBytes + trailingBytes;
    // During close the retained PCM, direct final metadata buffers, and Blob
    // copy coexist. An exact budget must succeed without a hidden metadata
    // generation or PCM copy.
    const meter = new PayloadMemoryMeter({
      operation: 'audio-export',
      label: 'test',
      budgetBytes: chunkBytes + headerBytes + trailingBytes + fileBytes,
    });
    const writer = createWavStreamWriter({
      sampleRate: 48_000,
      bitDepth: 16,
      encodeOptions: { metadata },
      meter,
    });
    writer.add([new Float32Array([0]), new Float32Array([0])], 0);

    const bytes = new Uint8Array(await writer.close(1).arrayBuffer());

    expect(strFromU8(bytes.subarray(36, 40))).toBe('bext');
    expect(strFromU8(bytes.subarray(headerBytes + chunkBytes, headerBytes + chunkBytes + 4))).toBe(
      'cue ',
    );
    expect(meter.snapshot().peakActiveBytes).toBe(
      chunkBytes + headerBytes + trailingBytes + fileBytes,
    );
    expect(meter.snapshot().activeBytes).toBe(0);
  });
});
