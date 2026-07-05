/**
 * Loop-recording split helpers. The libsonare Project API can create internal
 * takes, but studio recordings must ingest every pass into OPFS assets first,
 * so the asset slicing stays in JS.
 */

export interface LoopRecordingSplit {
  /** Zero-based take/pass index. */
  index: number;
  /** Inclusive frame offset in the captured buffer. */
  startFrame: number;
  /** Exclusive frame offset in the captured buffer. */
  endFrame: number;
}

export interface LoopRecordingTakeSlice {
  /** Zero-based take/pass index. */
  index: number;
  /** Planar channel slices for this pass. */
  channels: Float32Array[];
}

export interface NativeLoopRecordingDesc {
  trackId: number;
  startPpq: number;
  loopLengthPpq: number;
  audio: Float32Array;
  audioChannels: number;
  audioSampleRate: number;
}

/**
 * Splits a linear capture into completed loop passes.
 *
 * At least two complete passes are required before cycle recording becomes a
 * take stack; otherwise the caller should keep the original linear capture.
 * Boundaries are anchored from zero and rounded independently, avoiding the
 * cumulative drift that comes from repeatedly adding a rounded loop length.
 */
export function loopRecordingSplits(
  captureFrames: number,
  framesPerCycle: number,
): LoopRecordingSplit[] {
  if (
    !Number.isFinite(captureFrames) ||
    !Number.isFinite(framesPerCycle) ||
    captureFrames <= 0 ||
    framesPerCycle <= 0
  ) {
    return [];
  }
  const cycles = Math.floor(captureFrames / framesPerCycle + Number.EPSILON);
  if (cycles < 2) return [];
  const splits: LoopRecordingSplit[] = [];
  for (let index = 0; index < cycles; index++) {
    const startFrame = Math.round(index * framesPerCycle);
    const endFrame = Math.round((index + 1) * framesPerCycle);
    if (endFrame > startFrame && endFrame <= captureFrames) {
      splits.push({ index, startFrame, endFrame });
    }
  }
  return splits.length >= 2 ? splits : [];
}

/**
 * Materializes planar audio slices for completed loop passes.
 *
 * This keeps cycle-recording's frame-boundary contract next to
 * {@link loopRecordingSplits}; callers can ingest each returned pass into
 * their own asset store or compare it against native loop-recording results.
 */
export function loopRecordingTakeSlices(
  channels: ReadonlyArray<Float32Array>,
  splits: ReadonlyArray<LoopRecordingSplit>,
): LoopRecordingTakeSlice[] {
  if (channels.length === 0 || splits.length === 0) return [];
  const usableChannels = channels.filter((channel) => channel.length > 0);
  if (usableChannels.length === 0) return [];
  const takeSlices: LoopRecordingTakeSlice[] = [];
  for (const split of splits) {
    if (
      !Number.isInteger(split.index) ||
      !Number.isInteger(split.startFrame) ||
      !Number.isInteger(split.endFrame) ||
      split.startFrame < 0 ||
      split.endFrame <= split.startFrame
    ) {
      continue;
    }
    const endFrame = Math.min(split.endFrame, ...usableChannels.map((channel) => channel.length));
    if (endFrame <= split.startFrame) continue;
    takeSlices.push({
      index: split.index,
      channels: usableChannels.map((channel) => channel.slice(split.startFrame, endFrame)),
    });
  }
  return takeSlices;
}

/**
 * Builds the PCM descriptor accepted by libsonare's Project.addLoopRecordingTakes.
 *
 * Studio's live recording path still ingests every take into OPFS assets before
 * creating app clips, so this is an adapter/contract helper rather than the
 * default recording path. It keeps the native ABI shape explicit and testable
 * while the app-level asset boundary remains in JS.
 */
export function nativeLoopRecordingDesc(
  trackId: number,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  startPpq: number,
  loopLengthPpq: number,
): NativeLoopRecordingDesc | null {
  if (
    !Number.isInteger(trackId) ||
    trackId < 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(startPpq) ||
    startPpq < 0 ||
    !Number.isFinite(loopLengthPpq) ||
    loopLengthPpq <= 0 ||
    channels.length === 0
  ) {
    return null;
  }
  const frameCount = Math.min(...channels.map((channel) => channel.length));
  if (frameCount <= 0) return null;
  const validChannels = channels.filter((channel) => channel.length >= frameCount);
  if (validChannels.length === 0) return null;
  const audio = new Float32Array(frameCount * validChannels.length);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < validChannels.length; channel++) {
      audio[frame * validChannels.length + channel] = validChannels[channel][frame];
    }
  }
  return {
    trackId,
    startPpq,
    loopLengthPpq,
    audio,
    audioChannels: validChannels.length,
    audioSampleRate: sampleRate,
  };
}
