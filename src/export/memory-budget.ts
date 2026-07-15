import { PayloadMemoryLimitError } from '@/lib/payload-memory';

export const MEBIBYTE = 1024 * 1024;
export const DEFAULT_EXPORT_MEMORY_BUDGET_BYTES = 1024 * MEBIBYTE;
export const DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES = 256 * MEBIBYTE;

export interface RenderPayloadMemoryEstimate {
  totalFrames: number;
  stemCount: number;
  fullStereoBuffers: number;
  peakPayloadBytes: number;
}

/** Estimates retained full-length Float32 stereo payloads during an engine render. */
export function estimateRenderPayloadMemory(options: {
  totalFrames: number;
  stemCount: number;
  streamingStems: boolean;
  retainedAuxiliaryStereoBuffers?: number;
}): RenderPayloadMemoryEstimate {
  const { totalFrames, stemCount, streamingStems } = options;
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 0) {
    throw new RangeError(
      `Render frame count must be a non-negative safe integer, got ${totalFrames}`,
    );
  }
  if (!Number.isSafeInteger(stemCount) || stemCount < 0) {
    throw new RangeError(`Stem count must be a non-negative safe integer, got ${stemCount}`);
  }
  const auxiliary = options.retainedAuxiliaryStereoBuffers ?? 0;
  if (!Number.isSafeInteger(auxiliary) || auxiliary < 0) {
    throw new RangeError('Auxiliary stereo buffer count must be a non-negative safe integer');
  }
  // One final mix is always retained. Streaming retains at most the current
  // stem; legacy collection retains every stem. Auxiliary bounces include
  // SoundFont pre-renders that must remain live through later passes.
  const stemBuffers = stemCount === 0 ? 0 : streamingStems ? 1 : stemCount;
  const fullStereoBuffers = 1 + stemBuffers + auxiliary;
  const peakPayloadBytes = totalFrames * Float32Array.BYTES_PER_ELEMENT * 2 * fullStereoBuffers;
  if (!Number.isSafeInteger(peakPayloadBytes)) {
    throw new PayloadMemoryLimitError('Audio export', Number.MAX_SAFE_INTEGER, 1);
  }
  return { totalFrames, stemCount, fullStereoBuffers, peakPayloadBytes };
}

/** Rejects a render before its full-length output arrays are allocated. */
export function assertRenderPayloadMemory(
  estimate: RenderPayloadMemoryEstimate,
  budgetBytes: number,
): void {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    throw new RangeError('Export memory budget must be finite and greater than zero');
  }
  if (estimate.peakPayloadBytes > budgetBytes) {
    throw new PayloadMemoryLimitError('Audio export', estimate.peakPayloadBytes, budgetBytes);
  }
}
