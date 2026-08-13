/**
 * Loop-recording split helpers. The libsonare Project API can create internal
 * takes, but studio recordings must ingest every pass into OPFS assets first,
 * so the asset slicing stays in JS.
 */

import { countInStartPpq } from './time-signature';
import type { TimeSignatureSegment } from './types';

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

/** The caller that is allowed to mutate transport state for a recording take. */
export type RecordingTransportOwner = 'audio' | 'midi' | 'shared';

/** How a recording start request should interpret an optional requested PPQ. */
export type RecordingStartMode = 'normal' | 'auto-punch' | 'explicit-start';

/** Count-in behavior captured by a resolved recording start plan. */
export type RecordingCountInMode = 'none' | 'bars';

/** Immutable transport decisions shared by audio and MIDI recording. */
export interface RecordingStartPlan {
  /** Resolved timeline PPQ at which the recorder accepts captured material. */
  punchInPpq: number;
  /** Alias retained for callers that describe the value as the recording start. */
  startPpq: number;
  /** Explicit alias for the resolved punch-in used by coordination callers. */
  resolvedStartPpq: number;
  /** True when the transport was stopped when this plan was resolved. */
  startedFromRest: boolean;
  /** PPQ at which transport pre-roll begins; equals punchInPpq without count-in. */
  countInStartPpq: number;
  /** PPQ at which transport pre-roll ends and capture begins. */
  countInEndPpq: number;
  /** Count-in span in PPQ, always non-negative. */
  countInPpq: number;
  /** Whether the plan owns a bar count-in or no pre-roll. */
  countInMode: RecordingCountInMode;
  /** Optional count-in span, convenient for consumers that pass ranges around. */
  countInSpan: { startPpq: number; endPpq: number } | null;
  /** Short alias for the resolved count-in span. */
  countIn: { startPpq: number; endPpq: number } | null;
  /** Active cycle window, if this plan starts cycle recording at its boundary. */
  cycle: { startPpq: number; endPpq: number } | null;
  /** Explicit name for the resolved cycle bounds. */
  cycleBounds: { startPpq: number; endPpq: number } | null;
  /** Cycle start bound, duplicated as scalar fields for lightweight consumers. */
  cycleStartPpq: number | null;
  /** Cycle end bound, duplicated as scalar fields for lightweight consumers. */
  cycleEndPpq: number | null;
  /** Whether this request is normal, explicitly placed, or auto-punch. */
  mode: RecordingStartMode;
  /** The single recorder/coordination owner allowed to seek and play. */
  transportOwner: RecordingTransportOwner;
  /** Origin PPQ used for timestamp alignment when the request is explicit. */
  originPpq: number;
}

/** Inputs needed to resolve one shared recording start plan. */
export interface ResolveRecordingStartPlanOptions {
  /** Timeline playhead captured before either recorder mutates transport. */
  positionPpq: number;
  /** Audible playhead captured before either recorder mutates transport. */
  audiblePositionPpq?: number;
  /** Snapshot of whether transport was stopped at resolution time. */
  startedFromRest: boolean;
  /** Optional requested punch-in; omitted uses the captured playhead. */
  requestedStartPpq?: number;
  /** Normal starts may snap/cycle; auto-punch preserves the legacy explicit path. */
  mode?: RecordingStartMode;
  /** Whether an active loop should be used for snap/cycle behavior. */
  loopEnabled: boolean;
  loopStartPpq: number;
  loopEndPpq: number;
  /** Number of count-in bars requested when starting from rest. */
  countInBars: number;
  /** Meter map used to resolve the count-in boundary. */
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>;
  /** Who owns transport mutation for this take. */
  transportOwner?: RecordingTransportOwner;
}

/** Ruler seeks may land fractionally near a cycle boundary. */
export const LOOP_RECORDING_START_SNAP_TOLERANCE_PPQ = 0.5;

/**
 * Aligns a non-explicit, stopped recording start to the active cycle boundary.
 * Audio and MIDI recording must share this rule or their takes begin on
 * different PPQ positions after the same ruler seek.
 */
export function snapLoopRecordingStartPpq(
  startPpq: number,
  options: {
    explicit: boolean;
    wasRolling: boolean;
    loopEnabled: boolean;
    loopStartPpq: number;
    loopEndPpq: number;
  },
): number {
  if (
    options.explicit ||
    options.wasRolling ||
    !options.loopEnabled ||
    options.loopEndPpq <= options.loopStartPpq ||
    Math.abs(startPpq - options.loopStartPpq) >= LOOP_RECORDING_START_SNAP_TOLERANCE_PPQ
  ) {
    return startPpq;
  }
  return options.loopStartPpq;
}

/**
 * Resolves transport decisions once, before either recorder starts mutating
 * the transport. Audio and MIDI can then consume the same punch-in, count-in,
 * and cycle boundaries even when opening a microphone changes live transport
 * state in between their calls.
 */
export function resolveRecordingStartPlan(
  options: ResolveRecordingStartPlanOptions,
): RecordingStartPlan {
  const mode = options.mode ?? 'normal';
  const positionPpq = Number.isFinite(options.positionPpq) ? Math.max(0, options.positionPpq) : 0;
  const audiblePositionPpq = Number.isFinite(options.audiblePositionPpq)
    ? Math.max(0, options.audiblePositionPpq as number)
    : positionPpq;
  const originPpq = options.startedFromRest ? positionPpq : audiblePositionPpq;
  const requestedStartPpq =
    options.requestedStartPpq !== undefined &&
    Number.isFinite(options.requestedStartPpq) &&
    options.requestedStartPpq >= 0
      ? options.requestedStartPpq
      : undefined;
  let punchInPpq = requestedStartPpq ?? originPpq;
  const validLoop =
    options.loopEnabled &&
    Number.isFinite(options.loopStartPpq) &&
    Number.isFinite(options.loopEndPpq) &&
    options.loopEndPpq > options.loopStartPpq;
  if (requestedStartPpq === undefined || mode === 'explicit-start') {
    punchInPpq = snapLoopRecordingStartPpq(punchInPpq, {
      explicit: mode === 'auto-punch',
      wasRolling: !options.startedFromRest,
      loopEnabled: validLoop,
      loopStartPpq: options.loopStartPpq,
      loopEndPpq: options.loopEndPpq,
    });
  }

  const countInEnabled =
    mode !== 'auto-punch' &&
    options.startedFromRest &&
    Number.isFinite(options.countInBars) &&
    options.countInBars > 0;
  const countInStart = countInEnabled
    ? Math.max(
        0,
        countInStartPpq(options.timeSignatures ?? [], punchInPpq, Math.max(0, options.countInBars)),
      )
    : punchInPpq;
  const countInPpq = Math.max(0, punchInPpq - countInStart);
  const cycle =
    mode !== 'auto-punch' && validLoop && Math.abs(punchInPpq - options.loopStartPpq) < 1e-6
      ? { startPpq: options.loopStartPpq, endPpq: options.loopEndPpq }
      : null;
  const countInMode: RecordingCountInMode = countInPpq > 0 ? 'bars' : 'none';
  const countInSpan =
    countInMode === 'bars' ? { startPpq: countInStart, endPpq: punchInPpq } : null;
  return {
    punchInPpq,
    startPpq: punchInPpq,
    resolvedStartPpq: punchInPpq,
    startedFromRest: options.startedFromRest,
    countInStartPpq: countInStart,
    countInEndPpq: punchInPpq,
    countInPpq,
    countInMode,
    countInSpan,
    countIn: countInSpan,
    cycle,
    cycleBounds: cycle,
    cycleStartPpq: cycle?.startPpq ?? null,
    cycleEndPpq: cycle?.endPpq ?? null,
    mode,
    transportOwner: options.transportOwner ?? 'audio',
    originPpq,
  };
}

/** Legacy explicit-start resolver: keeps auto-punch semantics named. */
export function resolveAutoPunchRecordingStartPlan(
  options: Omit<ResolveRecordingStartPlanOptions, 'mode'>,
): RecordingStartPlan {
  return resolveRecordingStartPlan({ ...options, mode: 'auto-punch' });
}

/** Explicit placement that still allows cycle behavior at a cycle boundary. */
export function resolveExplicitRecordingStartPlan(
  options: Omit<ResolveRecordingStartPlanOptions, 'mode'>,
): RecordingStartPlan {
  return resolveRecordingStartPlan({ ...options, mode: 'explicit-start' });
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
