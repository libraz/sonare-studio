/**
 * Coordinate mapping core for canvas timeline surfaces (arrangement, piano roll,
 * velocity/automation lanes) plus grid snap math.
 *
 * Time is expressed in PPQ where one quarter note equals 1.0. Pitch follows the
 * MIDI convention (0..127) with row 127 rendered at the top of the surface.
 * Pure logic: no DOM, no framework imports.
 */

/** Rhythmic modifier applied to a grid division. */
export type SnapModifier = 'straight' | 'triplet' | 'dotted';

/** Grid division for snapping, e.g. `{ denominator: 8, modifier: 'triplet' }` = eighth triplet. */
export interface SnapDivision {
  /** Note-value denominator: 1 = whole, 2 = half, 4 = quarter, ... 64 = sixty-fourth. */
  denominator: 1 | 2 | 4 | 8 | 16 | 32 | 64;
  /** Straight, triplet (2/3 of straight) or dotted (1.5x straight). */
  modifier: SnapModifier;
}

/** Lowest valid MIDI pitch. */
export const MIN_PITCH = 0;

/** Highest valid MIDI pitch (rendered as the top row). */
export const MAX_PITCH = 127;

/** Number of pitch rows on a piano roll surface. */
export const PITCH_ROW_COUNT = MAX_PITCH - MIN_PITCH + 1;

/** PPQ length of a whole note (quarter note = 1.0). */
const WHOLE_NOTE_PPQ = 4;

/**
 * Returns the grid step in PPQ for a snap division.
 *
 * @param division - Grid division (note value + modifier).
 * @returns Step length in PPQ (quarter note = 1.0).
 */
export function gridStepPpq(division: SnapDivision): number {
  const straight = WHOLE_NOTE_PPQ / division.denominator;
  switch (division.modifier) {
    case 'triplet':
      return (straight * 2) / 3;
    case 'dotted':
      return straight * 1.5;
    default:
      return straight;
  }
}

/**
 * Snaps a PPQ position to the nearest grid line of the given division.
 * The result is never negative.
 *
 * @param ppq - Position in PPQ.
 * @param division - Grid division to snap to.
 * @returns Snapped position in PPQ, clamped to >= 0.
 */
export function snapPpq(ppq: number, division: SnapDivision): number {
  const step = gridStepPpq(division);
  return snapPpqToStep(ppq, step);
}

/** Snaps a PPQ position to a numeric grid step, clamped to the timeline origin. */
export function snapPpqToStep(ppq: number, step: number): number {
  if (!(step > 0)) return Math.max(0, ppq);
  return Math.max(0, Math.round(ppq / step) * step);
}

/** Construction options for {@link TimelineRange}. */
export interface TimelineRangeOptions {
  /** Viewport width in CSS px. */
  widthPx: number;
  /** Viewport height in CSS px (used to clamp vertical scrolling). */
  heightPx: number;
  /** Horizontal zoom in px per PPQ. Default 100. */
  pxPerPpq?: number;
  /** Height of one pitch row in px. Default 12. */
  rowHeight?: number;
  /** Initial left edge of the visible range in PPQ. Default 0. */
  startPpq?: number;
  /** Initial vertical scroll offset in px. Default 0. */
  scrollY?: number;
  /** Lower zoom bound in px per PPQ. Default 0.01. */
  minPxPerPpq?: number;
  /** Upper zoom bound in px per PPQ. Default 10000. */
  maxPxPerPpq?: number;
}

/**
 * Manages the mapping between musical time/pitch and canvas pixel coordinates
 * for one scrollable, zoomable timeline viewport.
 *
 * Horizontal: visible range is [startPpq, endPpq) at `pxPerPpq` px per quarter
 * note; `startPpq` is clamped to >= 0. Vertical: 128 pitch rows of `rowHeight`
 * px with row 127 at the top, offset by `scrollY`.
 */
export class TimelineRange {
  private _widthPx: number;
  private _heightPx: number;
  private _pxPerPpq: number;
  private _rowHeight: number;
  private _startPpq: number;
  private _scrollY: number;
  private readonly _minPxPerPpq: number;
  private readonly _maxPxPerPpq: number;

  /**
   * Creates a timeline range.
   *
   * @param options - Viewport size and initial zoom/scroll state.
   */
  constructor(options: TimelineRangeOptions) {
    this._widthPx = Math.max(0, options.widthPx);
    this._heightPx = Math.max(0, options.heightPx);
    this._minPxPerPpq = options.minPxPerPpq ?? 0.01;
    this._maxPxPerPpq = options.maxPxPerPpq ?? 10000;
    this._pxPerPpq = this.clampZoom(options.pxPerPpq ?? 100);
    this._rowHeight = Math.max(1, options.rowHeight ?? 12);
    this._startPpq = Math.max(0, options.startPpq ?? 0);
    this._scrollY = 0;
    this._scrollY = this.clampScrollY(options.scrollY ?? 0);
  }

  /** Left edge of the visible range in PPQ (always >= 0). */
  get startPpq(): number {
    return this._startPpq;
  }

  /** Exclusive right edge of the visible range in PPQ. */
  get endPpq(): number {
    return this._startPpq + this._widthPx / this._pxPerPpq;
  }

  /** Current horizontal zoom in px per PPQ. */
  get pxPerPpq(): number {
    return this._pxPerPpq;
  }

  /** Viewport width in px. */
  get widthPx(): number {
    return this._widthPx;
  }

  /** Viewport height in px. */
  get heightPx(): number {
    return this._heightPx;
  }

  /** Height of one pitch row in px. */
  get rowHeight(): number {
    return this._rowHeight;
  }

  /** Current vertical scroll offset in px (0 = row 127 flush with the top). */
  get scrollY(): number {
    return this._scrollY;
  }

  /** Total scrollable content height in px (128 rows). */
  get contentHeightPx(): number {
    return PITCH_ROW_COUNT * this._rowHeight;
  }

  /**
   * Converts a PPQ position to a viewport x coordinate in px.
   *
   * @param ppq - Position in PPQ.
   * @returns X in px relative to the viewport's left edge (may be outside [0, widthPx)).
   */
  ppqToX(ppq: number): number {
    return (ppq - this._startPpq) * this._pxPerPpq;
  }

  /**
   * Converts a viewport x coordinate to a PPQ position.
   *
   * @param x - X in px relative to the viewport's left edge.
   * @returns Position in PPQ.
   */
  xToPpq(x: number): number {
    return this._startPpq + x / this._pxPerPpq;
  }

  /**
   * Zooms horizontally around an anchor x so the PPQ position under the anchor
   * stays fixed (unless the >= 0 clamp on startPpq forces a shift).
   *
   * @param anchorX - Anchor x in viewport px.
   * @param factor - Zoom multiplier (> 1 zooms in, < 1 zooms out).
   */
  zoomAt(anchorX: number, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const anchorPpq = this.xToPpq(anchorX);
    this._pxPerPpq = this.clampZoom(this._pxPerPpq * factor);
    this._startPpq = Math.max(0, anchorPpq - anchorX / this._pxPerPpq);
  }

  /**
   * Scrolls horizontally by a px delta (positive = later in time).
   *
   * @param dx - Delta in px.
   */
  scrollByPx(dx: number): void {
    this.scrollByPpq(dx / this._pxPerPpq);
  }

  /**
   * Scrolls horizontally by a PPQ delta (positive = later in time).
   *
   * @param dppq - Delta in PPQ.
   */
  scrollByPpq(dppq: number): void {
    this._startPpq = Math.max(0, this._startPpq + dppq);
  }

  /**
   * Sets the left edge of the visible range directly.
   *
   * @param ppq - New start position in PPQ; clamped to >= 0.
   */
  setStartPpq(ppq: number): void {
    this._startPpq = Math.max(0, ppq);
  }

  /**
   * Updates the viewport size (e.g. on container resize) and re-clamps scrollY.
   *
   * @param widthPx - New viewport width in px.
   * @param heightPx - New viewport height in px.
   */
  resize(widthPx: number, heightPx: number): void {
    this._widthPx = Math.max(0, widthPx);
    this._heightPx = Math.max(0, heightPx);
    this._scrollY = this.clampScrollY(this._scrollY);
  }

  /**
   * Converts a MIDI pitch to the top y coordinate of its row in viewport px.
   *
   * @param pitch - MIDI pitch (0..127); 127 is the topmost row.
   * @returns Y in px relative to the viewport's top edge.
   */
  pitchToY(pitch: number): number {
    return (MAX_PITCH - pitch) * this._rowHeight - this._scrollY;
  }

  /**
   * Converts a viewport y coordinate to the MIDI pitch of the row it falls in.
   *
   * @param y - Y in px relative to the viewport's top edge.
   * @returns MIDI pitch clamped to 0..127.
   */
  yToPitch(y: number): number {
    const row = Math.floor((y + this._scrollY) / this._rowHeight);
    return Math.min(MAX_PITCH, Math.max(MIN_PITCH, MAX_PITCH - row));
  }

  /**
   * Scrolls vertically by a px delta (positive = towards lower pitches).
   *
   * @param dy - Delta in px.
   */
  scrollByY(dy: number): void {
    this._scrollY = this.clampScrollY(this._scrollY + dy);
  }

  /**
   * Sets the vertical scroll offset directly.
   *
   * @param y - New offset in px; clamped to the scrollable content extent.
   */
  setScrollY(y: number): void {
    this._scrollY = this.clampScrollY(y);
  }

  /**
   * Sets the pitch row height and re-clamps scrollY.
   *
   * @param rowHeight - New row height in px (minimum 1).
   */
  setRowHeight(rowHeight: number): void {
    this._rowHeight = Math.max(1, rowHeight);
    this._scrollY = this.clampScrollY(this._scrollY);
  }

  private clampZoom(pxPerPpq: number): number {
    return Math.min(this._maxPxPerPpq, Math.max(this._minPxPerPpq, pxPerPpq));
  }

  private clampScrollY(y: number): number {
    const maxScroll = Math.max(0, this.contentHeightPx - this._heightPx);
    return Math.min(maxScroll, Math.max(0, y));
  }
}
