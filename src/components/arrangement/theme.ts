/**
 * Shared dark-theme color tokens and layout constants for the arrangement
 * components. Canvas helpers (setupCanvas, rounded rects) are reused from the
 * piano-roll theme module until a global theme exists.
 */

/** Color tokens used by the arrangement canvases and lanes. */
export const ARRANGEMENT_COLORS = {
  /** Lane area background. */
  background: '#101216',
  /** Even track lane background. */
  laneEven: '#15171c',
  /** Odd track lane background. */
  laneOdd: '#13151a',
  /** Tint over the active track's lane. */
  laneActive: 'rgba(96, 165, 250, 0.07)',
  /** Horizontal line between track lanes. */
  laneLine: 'rgba(255, 255, 255, 0.05)',
  /** Shade over the area below the last track lane. */
  beyondTracks: 'rgba(0, 0, 0, 0.35)',
  /** Vertical line at each beat. */
  gridBeat: 'rgba(255, 255, 255, 0.05)',
  /** Vertical line at each bar. */
  gridBar: 'rgba(255, 255, 255, 0.12)',
  /** Border of unselected clips. */
  clipBorder: 'rgba(0, 0, 0, 0.55)',
  /** Border of the selected (active) clip. */
  clipSelectedBorder: '#f3f5f9',
  /** Clip name label. */
  clipName: 'rgba(232, 235, 240, 0.92)',
  /** Ruler strip background. */
  rulerBackground: '#14161b',
  /** Line separating the ruler from the lanes. */
  rulerBorder: 'rgba(0, 0, 0, 0.5)',
  /** Bar tick on the ruler. */
  rulerBar: 'rgba(255, 255, 255, 0.45)',
  /** Beat tick on the ruler. */
  rulerBeat: 'rgba(255, 255, 255, 0.16)',
  /** Bar-number label on the ruler. */
  rulerLabel: '#8b93a3',
  /** Loop range band on the ruler. */
  loopOverlay: 'rgba(96, 165, 250, 0.28)',
  /** Shade over the attenuated corner of an audio clip fade. */
  fadeOverlay: 'rgba(0, 0, 0, 0.38)',
  /** Fade ramp line over an audio clip waveform. */
  fadeRamp: 'rgba(243, 245, 249, 0.55)',
  /** Fade handle triangle at an audio clip's top corners. */
  fadeHandle: 'rgba(232, 235, 240, 0.9)',
  /** Marker flag and stem. */
  markerFlag: '#fbbf24',
  /** Marker name label. */
  markerLabel: 'rgba(251, 191, 36, 0.9)',
  /** Playhead line. */
  playhead: '#ff6e6e',
  /** Shade darkening an automation sublane below its track lane. */
  automationLane: 'rgba(0, 0, 0, 0.3)',
  /** Mid-value reference line across an automation sublane. */
  automationMidline: 'rgba(255, 255, 255, 0.07)',
  /** Fill of a hovered automation breakpoint. */
  automationPointHover: '#f3f5f9',
} as const;

/** Height of the bar/beat ruler strip at the top of the arrangement canvas. */
export const RULER_HEIGHT_PX = 28;

/** Height of one track lane. */
export const LANE_HEIGHT_PX = 56;

/** Width of the track header column. */
export const TRACK_HEADER_WIDTH_PX = 192;

/** Height of the section lane above the ruler. */
export const SECTION_LANE_HEIGHT_PX = 22;

/**
 * Converts a `#rrggbb` color to an `rgba()` string with the given alpha.
 * Non-hex inputs are returned unchanged.
 *
 * @param color - CSS color string (expected `#rrggbb`).
 * @param alpha - Alpha in [0, 1].
 */
export function colorWithAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
