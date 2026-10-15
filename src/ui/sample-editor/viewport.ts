import { clamp } from '@/lib/math';
/**
 * Horizontal viewport over a sample buffer: maps canvas x pixels to frame
 * positions with zoom (frames per pixel) and scroll (start frame) state.
 * Pure math module: no canvas, no DOM access.
 */

/** Hard zoom-in limit: at most 20 px per frame. */
export const MIN_FRAMES_PER_PX = 0.05;

/** Viewport state with clamped zoom and scroll. */
export class SampleViewport {
  private totalFramesValue: number;
  private widthPxValue: number;
  private startFrameValue = 0;
  private framesPerPxValue: number;

  /**
   * @param totalFrames Total frames of the audio (>= 0; fractions floored).
   * @param widthPx Viewport width in CSS pixels (>= 1).
   */
  constructor(totalFrames: number, widthPx: number) {
    this.totalFramesValue = Math.max(0, Math.floor(totalFrames));
    this.widthPxValue = Math.max(1, widthPx);
    this.framesPerPxValue = this.fitFramesPerPx();
  }

  /** Total frames of the audio. */
  get totalFrames(): number {
    return this.totalFramesValue;
  }

  /** Viewport width in CSS pixels. */
  get widthPx(): number {
    return this.widthPxValue;
  }

  /** First (possibly fractional) visible frame. */
  get startFrame(): number {
    return this.startFrameValue;
  }

  /** One past the last visible frame (clamped to the total). */
  get endFrame(): number {
    return Math.min(
      this.totalFramesValue,
      this.startFrameValue + this.widthPxValue * this.framesPerPxValue,
    );
  }

  /** Current zoom level as frames per CSS pixel. */
  get framesPerPx(): number {
    return this.framesPerPxValue;
  }

  /** Zoom level at which the whole file fits the viewport width. */
  private fitFramesPerPx(): number {
    return Math.max(MIN_FRAMES_PER_PX, this.totalFramesValue / this.widthPxValue);
  }

  /** Clamps a zoom level between the zoom-in limit and whole-file fit. */
  private clampZoom(framesPerPx: number): number {
    return clamp(framesPerPx, MIN_FRAMES_PER_PX, this.fitFramesPerPx());
  }

  /** Keeps the scroll position inside the scrollable extent. */
  private clampScroll(): void {
    const maxStart = Math.max(0, this.totalFramesValue - this.widthPxValue * this.framesPerPxValue);
    this.startFrameValue = clamp(this.startFrameValue, 0, maxStart);
  }

  /** Updates the viewport width, preserving zoom and scroll where possible. */
  resize(widthPx: number): void {
    this.widthPxValue = Math.max(1, widthPx);
    this.framesPerPxValue = this.clampZoom(this.framesPerPxValue);
    this.clampScroll();
  }

  /** Replaces the audio length (after an edit), preserving zoom if valid. */
  setTotalFrames(totalFrames: number): void {
    this.totalFramesValue = Math.max(0, Math.floor(totalFrames));
    this.framesPerPxValue = this.clampZoom(this.framesPerPxValue);
    this.clampScroll();
  }

  /** Zooms out (and scrolls back) so the whole file is visible. */
  zoomToFit(): void {
    this.framesPerPxValue = this.fitFramesPerPx();
    this.startFrameValue = 0;
  }

  /** Converts a viewport x position to a (fractional) frame position. */
  xToFrame(x: number): number {
    return this.startFrameValue + x * this.framesPerPxValue;
  }

  /** Converts a frame position to a viewport x position. */
  frameToX(frame: number): number {
    return (frame - this.startFrameValue) / this.framesPerPxValue;
  }

  /**
   * Multiplies the zoom level by a factor (< 1 zooms in), keeping the frame
   * under the anchor x position fixed on screen.
   */
  zoomAt(anchorX: number, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const anchorFrame = this.xToFrame(anchorX);
    this.framesPerPxValue = this.clampZoom(this.framesPerPxValue * factor);
    this.startFrameValue = anchorFrame - anchorX * this.framesPerPxValue;
    this.clampScroll();
  }

  /** Scrolls the viewport by a pixel delta (positive moves forward). */
  scrollByPx(deltaPx: number): void {
    this.startFrameValue += deltaPx * this.framesPerPxValue;
    this.clampScroll();
  }
}
