import { PayloadMemoryLimitError } from '@/lib/payload-memory';

export const MEBIBYTE = 1024 * 1024;
export const DEFAULT_EXPORT_MEMORY_BUDGET_BYTES = 1024 * MEBIBYTE;
export const DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES = 256 * MEBIBYTE;

export interface RenderPayloadMemoryEstimate {
  totalFrames: number;
  stemCount: number;
  retainedStereoBuffers: number;
  transientStereoBuffers: number;
  fullStereoBuffers: number;
  sourceAudioBytes: number;
  preparedClipBytes: number;
  soundFontBytes: number;
  peakPayloadBytes: number;
}

function safePayloadBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PayloadMemoryLimitError(label, Number.MAX_SAFE_INTEGER, 1);
  }
  return value;
}

/**
 * Estimates all long-lived and full-window payloads during an engine render.
 * Source PCM, transformed clip schedules and SoundFonts stay live alongside
 * the final/stem buffers; metering/mastering also needs a transient stereo
 * scratch buffer while the input mix remains retained.
 */
export function estimateRenderPayloadMemory(options: {
  totalFrames: number;
  stemCount: number;
  streamingStems: boolean;
  /** The final master is delivered incrementally instead of retained. */
  streamingMixdown?: boolean;
  retainedAuxiliaryStereoBuffers?: number;
  transientStereoBuffers?: number;
  sourceAudioBytes?: number;
  preparedClipBytes?: number;
  soundFontBytes?: number;
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
  const transientStereoBuffers = options.transientStereoBuffers ?? 1;
  if (!Number.isSafeInteger(transientStereoBuffers) || transientStereoBuffers < 0) {
    throw new RangeError('Transient stereo buffer count must be a non-negative safe integer');
  }
  const sourceAudioBytes = safePayloadBytes(options.sourceAudioBytes ?? 0, 'Audio source PCM');
  const preparedClipBytes = safePayloadBytes(
    options.preparedClipBytes ?? 0,
    'Prepared audio clips',
  );
  const soundFontBytes = safePayloadBytes(options.soundFontBytes ?? 0, 'SoundFont payload');
  // A streamed master retains no full final mix. Streaming stems retain at
  // most the current stem; legacy collection retains every stem. Auxiliary bounces include
  // SoundFont pre-renders that must remain live through later passes.
  const stemBuffers = stemCount === 0 ? 0 : streamingStems ? 1 : stemCount;
  const retainedStereoBuffers =
    (options.streamingMixdown === true ? 0 : 1) + stemBuffers + auxiliary;
  const fullStereoBuffers = retainedStereoBuffers + transientStereoBuffers;
  const fullWindowBytes = safePayloadBytes(
    totalFrames * Float32Array.BYTES_PER_ELEMENT * 2 * fullStereoBuffers,
    'Audio export',
  );
  const peakPayloadBytes = safePayloadBytes(
    fullWindowBytes + sourceAudioBytes + preparedClipBytes + soundFontBytes,
    'Audio export',
  );
  return {
    totalFrames,
    stemCount,
    retainedStereoBuffers,
    transientStereoBuffers,
    fullStereoBuffers,
    sourceAudioBytes,
    preparedClipBytes,
    soundFontBytes,
    peakPayloadBytes,
  };
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

export interface CodecPayloadMemoryEstimate {
  inputBytes: number;
  retainedBytes: number;
  outputUpperBoundBytes: number;
  codecScratchBytes: number;
  peakPayloadBytes: number;
}

/** Conservative peak for one-shot worker/main-thread audio codecs. */
export function estimateCodecPayloadMemory(options: {
  encoderId: string;
  inputBytes: number;
  retainedBytes?: number;
}): CodecPayloadMemoryEstimate {
  const inputBytes = safePayloadBytes(options.inputBytes, 'Audio codec input');
  const retainedBytes = safePayloadBytes(options.retainedBytes ?? 0, 'Retained export payload');
  // WAV is never larger than Float32 input plus headers; FLAC can expand
  // incompressible integer PCM slightly; MP3 is much smaller. One raw-sized
  // output plus a bounded header allowance safely covers all three.
  const outputUpperBoundBytes = safePayloadBytes(inputBytes + 64 * 1024, 'Encoded audio');
  // MP3 converts one 1152-frame block after the bounded-block rewrite. FLAC
  // works on at most one configured frame block at a time; reserve 16 MiB for
  // predictor/residual arrays. WAV writes directly into its final output.
  const codecScratchBytes =
    options.encoderId === 'flac' ? 16 * MEBIBYTE : options.encoderId === 'mp3' ? 64 * 1024 : 0;
  const peakPayloadBytes = safePayloadBytes(
    retainedBytes + inputBytes + outputUpperBoundBytes + codecScratchBytes,
    'Audio encoding',
  );
  return {
    inputBytes,
    retainedBytes,
    outputUpperBoundBytes,
    codecScratchBytes,
    peakPayloadBytes,
  };
}

/** Rejects before worker transfer or codec output allocation. */
export function assertCodecPayloadMemory(
  estimate: CodecPayloadMemoryEstimate,
  budgetBytes: number,
): void {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    throw new RangeError('Codec memory budget must be finite and greater than zero');
  }
  if (estimate.peakPayloadBytes > budgetBytes) {
    throw new PayloadMemoryLimitError('Audio encoding', estimate.peakPayloadBytes, budgetBytes);
  }
}
