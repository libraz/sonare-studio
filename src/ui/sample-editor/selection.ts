/**
 * Selection model for the sample editor: a frame-based anchor/head pair that
 * supports click-drag selection and shift-click extension, plus the readout
 * formatting (samples + seconds). Pure data module: no DOM, no store access.
 */

import type { SampleRange } from './ops';

/**
 * An in-progress or committed selection. The anchor is where the gesture
 * started; the head follows the pointer (and may sit before the anchor).
 */
export interface SelectionDraft {
  /** Frame where the selection gesture started. */
  anchorFrame: number;
  /** Frame the pointer currently points at. */
  headFrame: number;
}

/** Clamps a (possibly fractional) frame position into [0, totalFrames]. */
export function clampFrameIndex(frame: number, totalFrames: number): number {
  if (!Number.isFinite(frame)) return 0;
  return Math.min(Math.max(0, Math.round(frame)), Math.max(0, totalFrames));
}

/** Starts a new selection at a frame (anchor and head coincide). */
export function beginSelection(frame: number, totalFrames: number): SelectionDraft {
  const clamped = clampFrameIndex(frame, totalFrames);
  return { anchorFrame: clamped, headFrame: clamped };
}

/** Moves the head of a selection (drag update); the anchor stays put. */
export function dragSelection(
  draft: SelectionDraft,
  frame: number,
  totalFrames: number,
): SelectionDraft {
  return { anchorFrame: draft.anchorFrame, headFrame: clampFrameIndex(frame, totalFrames) };
}

/**
 * Shift-click extension: keeps the existing anchor and moves the head to the
 * clicked frame. Without an existing selection this starts a new one.
 */
export function extendSelection(
  draft: SelectionDraft | null,
  frame: number,
  totalFrames: number,
): SelectionDraft {
  if (!draft) return beginSelection(frame, totalFrames);
  return dragSelection(draft, frame, totalFrames);
}

/**
 * Normalizes a draft into an ordered range, or null when there is no draft
 * or the draft is empty (anchor equals head).
 */
export function selectionRange(draft: SelectionDraft | null): SampleRange | null {
  if (!draft) return null;
  const startFrame = Math.min(draft.anchorFrame, draft.headFrame);
  const endFrame = Math.max(draft.anchorFrame, draft.headFrame);
  return startFrame === endFrame ? null : { startFrame, endFrame };
}

/** Formats a frame count with thousands separators (e.g. "44,100"). */
export function formatFrameCount(frames: number): string {
  return Math.round(frames).toLocaleString('en-US');
}

/** Formats a frame count as seconds with millisecond precision. */
export function formatSeconds(frames: number, sampleRate: number): string {
  const seconds = sampleRate > 0 ? frames / sampleRate : 0;
  return `${seconds.toFixed(3)} s`;
}

/**
 * Builds the toolbar readout: the selection bounds and extent when a range
 * is selected, otherwise the total file extent.
 *
 * @param range Normalized selection range (or null for no selection).
 * @param totalFrames Total frames of the loaded audio.
 * @param sampleRate Sample rate of the loaded audio in Hz.
 */
export function selectionReadout(
  range: SampleRange | null,
  totalFrames: number,
  sampleRate: number,
): string {
  if (!range || range.endFrame <= range.startFrame) {
    return `${formatFrameCount(totalFrames)} smp / ${formatSeconds(totalFrames, sampleRate)}`;
  }
  const length = range.endFrame - range.startFrame;
  return (
    `${formatFrameCount(range.startFrame)}-${formatFrameCount(range.endFrame)} smp ` +
    `(${formatFrameCount(length)} smp / ${formatSeconds(length, sampleRate)})`
  );
}
