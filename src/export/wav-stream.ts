/** Incremental WAV payload writer for long mixdowns. */

import type { PayloadMemoryMeter } from '@/lib/payload-memory';
import {
  type EncodeWavOptions,
  encodeWavChunk,
  type WavBitDepth,
  wavHeader,
  wavTrailingMetadata,
} from './wav';

export interface WavStreamWriter {
  add(channels: readonly [Float32Array, Float32Array], offsetFrames: number): void;
  close(totalFrames: number): Blob;
  abort(): void;
}

/**
 * Encodes one PCM block at a time and retains only the already-encoded file
 * chunks. The RIFF header is written once the worker reports its final frame
 * count, so raw full-length PCM never crosses the worker boundary.
 */
export function createWavStreamWriter(options: {
  sampleRate: number;
  bitDepth: WavBitDepth;
  encodeOptions?: EncodeWavOptions;
  meter: PayloadMemoryMeter;
}): WavStreamWriter {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const releases: Array<() => void> = [];
  let expectedOffset = 0;
  let closed = false;
  const releaseChunks = (): void => {
    chunks.length = 0;
    while (releases.length > 0) releases.pop()?.();
  };
  return {
    add(channels, offsetFrames): void {
      if (closed) throw new Error('WAV stream writer is closed');
      if (offsetFrames !== expectedOffset) {
        throw new RangeError(
          `WAV stream chunk offset ${offsetFrames} does not follow ${expectedOffset}`,
        );
      }
      const encoded = encodeWavChunk(channels, options.bitDepth, options.encodeOptions);
      const copy = new Uint8Array(encoded.byteLength);
      copy.set(encoded);
      releases.push(options.meter.retain(copy.byteLength, `WAV chunk ${chunks.length + 1}`));
      chunks.push(copy);
      expectedOffset += channels[0].length;
    },
    close(totalFrames): Blob {
      if (closed) throw new Error('WAV stream writer is closed');
      if (totalFrames !== expectedOffset) {
        throw new RangeError(
          `WAV stream received ${expectedOffset} frames, expected ${totalFrames}`,
        );
      }
      closed = true;
      const header = wavHeader(
        totalFrames,
        2,
        options.sampleRate,
        options.bitDepth,
        options.encodeOptions,
      );
      const trailing = wavTrailingMetadata(options.encodeOptions?.metadata);
      const releasePublish = options.meter.retain(
        header.byteLength + trailing.byteLength,
        'WAV header and metadata',
      );
      try {
        const publishHeader = new Uint8Array(header.byteLength);
        publishHeader.set(header);
        const publishTrailing = new Uint8Array(trailing.byteLength);
        publishTrailing.set(trailing);
        return new Blob(
          [
            publishHeader.buffer,
            ...chunks.map((chunk) => new Uint8Array(chunk).buffer),
            publishTrailing.buffer,
          ],
          {
            type: 'audio/wav',
          },
        );
      } finally {
        releasePublish();
        releaseChunks();
      }
    },
    abort(): void {
      if (closed) return;
      closed = true;
      releaseChunks();
    },
  };
}
