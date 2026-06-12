/**
 * Row geometry for arrangement tracks with optional take and automation
 * sublanes. A row is one track lane plus, when the track's take lanes are
 * expanded, one take sub-row per take below it, plus, when the track's
 * automation is expanded, an automation sublane at the bottom. Heights become
 * non-uniform, so the canvas and the header column share these prefix-sum
 * helpers instead of the old `index * laneHeight` math. Pure geometry: no
 * DOM, no framework imports.
 *
 * Vertical positions are in content px: y = 0 is the top of the first row,
 * before any ruler offset or scroll is applied by the caller.
 */

import type { AutomationParam } from '@/project/automation';

/** Height of one expanded automation sublane in px. */
export const AUTOMATION_LANE_HEIGHT_PX = 56;

/** Vertical inset keeping breakpoints inside the sublane, in px. */
export const AUTOMATION_LANE_PAD_PX = 5;

/** Height of one expanded take sub-row in px. */
export const TAKE_LANE_HEIGHT_PX = 40;

/** Region of a row a content y coordinate falls in. */
export type ArrangementRowZone = 'track' | 'take' | 'automation';

/** Result of a successful row hit-test. */
export interface ArrangementRowHit {
  /** Row (track) index, 0 = top row. */
  index: number;
  /** Whether the point is in the track lane, a take sub-row or the automation sublane. */
  zone: ArrangementRowZone;
  /** Index of the hit take sub-row; present only when `zone` is 'take'. */
  takeIndex?: number;
}

/** Prefix-sum row layout for one expansion state. */
export interface ArrangementRowLayout {
  /** Content y of a row's top edge; `rowTop(rowCount)` is the total height. */
  rowTop(index: number): number;
  /** Full height of a row (lane plus take and automation sublanes when expanded). */
  rowHeight(index: number): number;
  /** Content y of the top edge of take sub-row `takeIndex` inside a row. */
  takeTop(index: number, takeIndex: number): number;
  /** Content y of a row's automation sublane top (its bottom edge when collapsed). */
  automationTop(index: number): number;
  /** Total content height of all rows in px. */
  readonly totalHeight: number;
  /** Resolves a content y to a row and zone; null outside the rows. */
  hitTest(y: number): ArrangementRowHit | null;
}

/** The clip fields {@link trackTakeRowCount} reads. */
export interface TakeRowClip {
  /** Id of the owning track. */
  trackId: number;
  /** Alternative recordings of the clip; absent or empty = no take rows. */
  takes?: ReadonlyArray<unknown>;
}

/**
 * Returns the number of take sub-rows a takes-expanded track shows: the
 * maximum take count among the track's comped clips (each clip draws its
 * takes within its own horizontal span).
 *
 * @param clips All arrangement clips.
 * @param trackId Id of the track.
 */
export function trackTakeRowCount(clips: ReadonlyArray<TakeRowClip>, trackId: number): number {
  let count = 0;
  for (const clip of clips) {
    if (clip.trackId === trackId) count = Math.max(count, clip.takes?.length ?? 0);
  }
  return count;
}

/**
 * Builds the row layout for one expansion state.
 *
 * @param expanded Per-row flags: true = the row shows an automation sublane.
 * @param laneHeight Height of one track lane in px.
 * @param automationHeight Height of an expanded sublane in px.
 * @param takeCounts Per-row number of visible take sub-rows (absent/0 = none).
 * @param takeHeight Height of one take sub-row in px.
 * @returns Prefix-sum lookup helpers for the given state.
 */
export function buildRowLayout(
  expanded: readonly boolean[],
  laneHeight: number,
  automationHeight: number = AUTOMATION_LANE_HEIGHT_PX,
  takeCounts: readonly number[] = [],
  takeHeight: number = TAKE_LANE_HEIGHT_PX,
): ArrangementRowLayout {
  const takeRowsHeight = (index: number): number => (takeCounts[index] ?? 0) * takeHeight;
  const tops = new Array<number>(expanded.length + 1);
  tops[0] = 0;
  for (let i = 0; i < expanded.length; i++) {
    tops[i + 1] = tops[i] + laneHeight + takeRowsHeight(i) + (expanded[i] ? automationHeight : 0);
  }
  const totalHeight = tops[expanded.length];
  return {
    rowTop: (index) => tops[Math.min(expanded.length, Math.max(0, index))],
    rowHeight: (index) =>
      laneHeight + takeRowsHeight(index) + (expanded[index] ? automationHeight : 0),
    takeTop: (index, takeIndex) => tops[index] + laneHeight + takeIndex * takeHeight,
    automationTop: (index) => tops[index] + laneHeight + takeRowsHeight(index),
    totalHeight,
    hitTest: (y) => {
      if (y < 0 || y >= totalHeight) return null;
      let index = 0;
      while (index + 1 < tops.length && tops[index + 1] <= y) index++;
      const offset = y - tops[index];
      if (offset < laneHeight) return { index, zone: 'track' };
      if (offset < laneHeight + takeRowsHeight(index)) {
        return { index, zone: 'take', takeIndex: Math.floor((offset - laneHeight) / takeHeight) };
      }
      return { index, zone: 'automation' };
    },
  };
}

/** Drawing/editing value domain of an automated parameter. */
export interface AutomationValueDomain {
  /** Value mapped to the sublane bottom. */
  min: number;
  /** Value mapped to the sublane top. */
  max: number;
}

/**
 * Returns the value domain a sublane displays. Fader automation draws the
 * musically useful [-60, +12] dB window (narrower than the model's clamp
 * range); pan draws its full [-1, 1] range.
 *
 * @param param Automated parameter.
 * @returns The min/max values mapped onto the sublane height.
 */
export function automationValueDomain(param: AutomationParam): AutomationValueDomain {
  return param === 'faderDb' ? { min: -60, max: 12 } : { min: -1, max: 1 };
}

/** Clamps a number into [0, 1]. */
function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/**
 * Maps an automation value to a viewport y inside a sublane. Values outside
 * the parameter's display domain clamp to the padded sublane edges.
 *
 * @param param Automated parameter (selects the display domain).
 * @param value Automation value.
 * @param top Sublane top edge in viewport px.
 * @param height Sublane height in px.
 * @returns Y in viewport px (max value at the top).
 */
export function automationValueToY(
  param: AutomationParam,
  value: number,
  top: number,
  height: number,
): number {
  const domain = automationValueDomain(param);
  const t = clamp01((value - domain.min) / (domain.max - domain.min));
  const innerTop = top + AUTOMATION_LANE_PAD_PX;
  const innerHeight = Math.max(1, height - 2 * AUTOMATION_LANE_PAD_PX);
  return innerTop + (1 - t) * innerHeight;
}

/**
 * Maps a viewport y inside a sublane back to an automation value, clamped to
 * the parameter's display domain (the inverse of {@link automationValueToY}).
 *
 * @param param Automated parameter (selects the display domain).
 * @param y Y in viewport px.
 * @param top Sublane top edge in viewport px.
 * @param height Sublane height in px.
 * @returns The automation value at y.
 */
export function automationYToValue(
  param: AutomationParam,
  y: number,
  top: number,
  height: number,
): number {
  const domain = automationValueDomain(param);
  const innerTop = top + AUTOMATION_LANE_PAD_PX;
  const innerHeight = Math.max(1, height - 2 * AUTOMATION_LANE_PAD_PX);
  const t = clamp01((y - innerTop) / innerHeight);
  return domain.min + (1 - t) * (domain.max - domain.min);
}
