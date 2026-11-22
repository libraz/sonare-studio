/**
 * The few pieces the SMF reader and writer share: the document defaults both
 * sides fall back to, the SysEx sidecar bounds, and the MThd header parser the
 * reader scans with and the writer appends a SysEx track through.
 */

import { MEBIBYTE } from '@/lib/bytes';

export const DEFAULT_SAMPLE_RATE = 48000;
export const DEFAULT_CLIP_LENGTH_PPQ = 1;
/** Bound opaque sidecar data so an imported SMF cannot bloat a project document. */
export const MAX_SMF_SYSEX_PACKETS = 4096;
export const MAX_SMF_SYSEX_BYTES = MEBIBYTE;

function smfU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function smfU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] * 0x1000000 +
      ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>>
    0
  );
}

interface SmfHeader {
  headerLength: number;
  format: number;
  tracks: number;
  ticksPerQuarter: number;
  dataOffset: number;
}

export function parseSmfHeader(bytes: Uint8Array): SmfHeader | null {
  if (bytes.length < 14 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'MThd') {
    return null;
  }
  const headerLength = smfU32(bytes, 4);
  const dataOffset = 8 + headerLength;
  if (headerLength < 6 || dataOffset > bytes.length) return null;
  const ticksPerQuarter = smfU16(bytes, 12);
  // SMPTE division has no fixed PPQ mapping; libsonare rejects it too.
  if ((ticksPerQuarter & 0x8000) !== 0 || ticksPerQuarter === 0) return null;
  return {
    headerLength,
    format: smfU16(bytes, 8),
    tracks: smfU16(bytes, 10),
    ticksPerQuarter,
    dataOffset,
  };
}
