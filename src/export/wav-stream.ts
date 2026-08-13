/** Incremental WAV payload writer for long mixdowns. */

import type { PayloadMemoryMeter } from '@/lib/payload-memory';
import {
  type EncodeWavOptions,
  encodeWavChunk,
  type WavBitDepth,
  wavChunkByteLength,
  wavHeader,
  wavHeaderByteLength,
  wavTrailingMetadata,
  wavTrailingMetadataByteLength,
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
      const byteLength = wavChunkByteLength(channels[0].length, channels.length, options.bitDepth);
      // Reserve before encoding so a chunk allocation can never outrun the
      // meter. Keep the encoder's result directly; copying it would create an
      // unmetered second full generation of PCM.
      const release = options.meter.retain(byteLength, `WAV chunk ${chunks.length + 1}`);
      try {
        // `encodeWavChunk` allocates a fresh ordinary ArrayBuffer. Its public
        // typed-array signature permits ArrayBufferLike for callers, so narrow
        // that known allocation here without copying it for Blob publication.
        const encoded = encodeWavChunk(
          channels,
          options.bitDepth,
          options.encodeOptions,
        ) as Uint8Array<ArrayBuffer>;
        if (encoded.byteLength !== byteLength) {
          throw new Error('WAV chunk size changed while encoding');
        }
        chunks.push(encoded);
        releases.push(release);
      } catch (error) {
        release();
        throw error;
      }
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
      let releaseMetadata: (() => void) | undefined;
      let releasePublish: (() => void) | undefined;
      try {
        const metadata = options.encodeOptions?.metadata;
        const headerBytes = wavHeaderByteLength(totalFrames, 2, options.bitDepth, metadata);
        const trailingBytes = wavTrailingMetadataByteLength(metadata);
        // Both parts allocate their own backing buffers. Reserve before
        // constructing either one so the meter remains an upper bound during
        // the final publish, not merely after it has already peaked.
        releaseMetadata = options.meter.retain(
          headerBytes + trailingBytes,
          'WAV header and trailing metadata',
        );
        const header = wavHeader(
          totalFrames,
          2,
          options.sampleRate,
          options.bitDepth,
          options.encodeOptions,
        );
        const trailing = wavTrailingMetadata(metadata);
        if (header.byteLength !== headerBytes || trailing.byteLength !== trailingBytes) {
          throw new Error('WAV metadata size changed while publishing');
        }
        // Blob construction retains a complete copy of the published parts while
        // the incrementally encoded chunks are still held by this writer. Do not
        // create an additional per-chunk copy; charge the full publish peak once.
        const encodedBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        releasePublish = options.meter.retain(
          headerBytes + encodedBytes + trailingBytes,
          'WAV file publish',
        );
        // wavHeader/wavTrailingMetadata always allocate ordinary ArrayBuffers;
        // narrow their generic ArrayBufferLike type without copying the parts.
        return new Blob(
          [
            header.buffer as ArrayBuffer,
            ...chunks.map((chunk) => chunk.buffer),
            trailing.buffer as ArrayBuffer,
          ],
          { type: 'audio/wav' },
        );
      } finally {
        releasePublish?.();
        releaseMetadata?.();
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
