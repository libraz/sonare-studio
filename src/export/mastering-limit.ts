/**
 * Guard for libsonare's whole-buffer mastering entry points.
 *
 * `masterAudioStereo` and `masteringProcessStereo` receive two Float32Array
 * channels in one call. The wasm binding accepts at most 64 Mi elements
 * (Float32 values) for that input, so a stereo call has a 32 Mi-frame limit.
 * Keep this check beside the export seams so callers can fail before they
 * allocate the render buffers or enter wasm.
 */

/** Maximum number of Float32 elements accepted by a whole-buffer mastering call. */
export const MASTERING_FLOAT32_INPUT_ELEMENT_LIMIT = 64 * 1024 * 1024;

/** Maximum stereo frames accepted by a whole-buffer mastering call. */
export const MASTERING_STEREO_FRAME_LIMIT = Math.floor(MASTERING_FLOAT32_INPUT_ELEMENT_LIMIT / 2);

/** Stable code sent across the export worker boundary. */
export const MASTERING_BUFFER_LIMIT_ERROR_CODE = 'mastering-buffer-limit' as const;

export interface MasteringBufferLimitOptions {
  /** Rendered stereo frames, including any release tail. */
  totalFrames: number;
  /** Render sample rate, used only to make the UI error actionable. */
  sampleRate: number;
  /** True when the selected render includes the master chain. */
  includeMasterChain: boolean;
  /** True when an opaque whole-buffer preset call will be made. */
  usesPreset: boolean;
  /** Number of enabled processor stages that use whole-buffer processing. */
  wholeBufferProcessorCount: number;
}

/** Serializable details carried through the export worker error response. */
export interface MasteringBufferLimitDetails {
  totalFrames: number;
  maxFrames: number;
  sampleRate: number;
}

/** Typed export failure raised before a whole-buffer mastering allocation. */
export class MasteringBufferLimitError extends Error {
  readonly code = MASTERING_BUFFER_LIMIT_ERROR_CODE;
  readonly totalFrames: number;
  readonly maxFrames: number;
  readonly sampleRate: number;

  constructor(details: MasteringBufferLimitDetails) {
    const duration =
      Number.isFinite(details.totalFrames) && details.sampleRate > 0
        ? ` (${(details.totalFrames / details.sampleRate).toFixed(1)} s)`
        : '';
    super(
      `The selected mastering chain cannot process ${details.totalFrames} stereo frames${duration}; ` +
        `the whole-buffer limit is ${MASTERING_STEREO_FRAME_LIMIT} frames`,
    );
    this.name = 'MasteringBufferLimitError';
    this.totalFrames = details.totalFrames;
    this.maxFrames = details.maxFrames;
    this.sampleRate = details.sampleRate;
  }
}

/**
 * Fails only when a selected master chain will actually call a whole-buffer
 * mastering seam. Equality at the documented boundary is valid.
 */
export function assertMasteringBufferWithinLimit(options: MasteringBufferLimitOptions): void {
  const wholeBufferMasteringActive =
    options.includeMasterChain && (options.usesPreset || options.wholeBufferProcessorCount > 0);
  if (!wholeBufferMasteringActive || options.totalFrames <= MASTERING_STEREO_FRAME_LIMIT) {
    return;
  }
  throw new MasteringBufferLimitError({
    totalFrames: options.totalFrames,
    maxFrames: MASTERING_STEREO_FRAME_LIMIT,
    sampleRate: options.sampleRate,
  });
}
