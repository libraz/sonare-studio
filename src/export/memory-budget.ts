import { PayloadMemoryLimitError, type PayloadMemoryOperation } from '@/lib/payload-memory';

export const MEBIBYTE = 1024 * 1024;
export const DEFAULT_EXPORT_MEMORY_BUDGET_BYTES = 1024 * MEBIBYTE;
export const DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES = 256 * MEBIBYTE;
/** Encoder container/header slack added on top of the PCM size. */
const ENCODER_SLACK_BYTES = 64 * 1024;
/** Working buffers the MP3 encoder holds beyond its input and output. */
const MP3_SCRATCH_BYTES = 64 * 1024;

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

function safePayloadBytes(
  value: number,
  label: string,
  operation: PayloadMemoryOperation = 'audio-export',
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PayloadMemoryLimitError(operation, Number.MAX_SAFE_INTEGER, 1, label);
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
    throw new PayloadMemoryLimitError('audio-export', estimate.peakPayloadBytes, budgetBytes);
  }
}

export interface CodecPayloadMemoryEstimate {
  inputBytes: number;
  inputGenerations: number;
  /** Additional caller PCM copy made before transferring to an encode worker. */
  workerInputCopyBytes: number;
  retainedBytes: number;
  outputUpperBoundBytes: number;
  encodedGenerations: number;
  codecScratchBytes: number;
  peakPayloadBytes: number;
}

/** Conservative peak for one-shot worker/main-thread audio codecs. */
export function estimateCodecPayloadMemory(options: {
  encoderId: string;
  inputBytes: number;
  /** True when encodeAudioInWorker clones caller-owned PCM before transfer. */
  workerBacked?: boolean;
  retainedBytes?: number;
}): CodecPayloadMemoryEstimate {
  const inputBytes = safePayloadBytes(options.inputBytes, 'Audio codec input', 'audio-encoding');
  const retainedBytes = safePayloadBytes(
    options.retainedBytes ?? 0,
    'Retained export payload',
    'audio-encoding',
  );
  const workerInputCopyBytes = options.workerBacked === true ? inputBytes : 0;
  const mediaRecorder = new Set(['aac', 'opus-webm', 'opus-ogg']).has(options.encoderId);
  // MediaRecorder first copies the planar Float32 input into an AudioBuffer,
  // then retains Blob chunks while `toBlobBytes()` allocates the final encoded
  // Uint8Array. FLAC likewise keeps frame chunks until its final concatenation.
  // Account for both encoded generations even when the output is smaller in a
  // particular file; incompressible PCM is the safe upper bound.
  const inputGenerations = mediaRecorder ? 2 : 1;
  const encodedGenerations = mediaRecorder || options.encoderId === 'flac' ? 2 : 1;
  const encodedOneGenerationBytes = safePayloadBytes(
    inputBytes + ENCODER_SLACK_BYTES,
    'Encoded audio',
    'audio-encoding',
  );
  const outputUpperBoundBytes = safePayloadBytes(
    encodedOneGenerationBytes * encodedGenerations,
    'Encoded audio',
    'audio-encoding',
  );
  // MP3 converts one 1152-frame block after the bounded-block rewrite. FLAC
  // works on at most one configured frame block at a time; reserve 16 MiB for
  // predictor/residual arrays. MediaRecorder's second PCM generation is its
  // AudioBuffer copy, not scratch.
  const codecScratchBytes =
    (inputGenerations - 1) * inputBytes +
    workerInputCopyBytes +
    (options.encoderId === 'flac'
      ? 16 * MEBIBYTE
      : options.encoderId === 'mp3'
        ? MP3_SCRATCH_BYTES
        : 0);
  const peakPayloadBytes = safePayloadBytes(
    retainedBytes + inputBytes + outputUpperBoundBytes + codecScratchBytes,
    'Audio encoding',
    'audio-encoding',
  );
  return {
    inputBytes,
    inputGenerations,
    workerInputCopyBytes,
    retainedBytes,
    outputUpperBoundBytes,
    encodedGenerations,
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
    throw new PayloadMemoryLimitError('audio-encoding', estimate.peakPayloadBytes, budgetBytes);
  }
}
