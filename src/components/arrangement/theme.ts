/**
 * Shared dark-theme color tokens and layout constants for the arrangement
 * components. The shared palette is sourced from the global theme (tokens.ts);
 * fine-grained canvas overlays stay as local literals. Canvas helpers
 * (setupCanvas, rounded rects) are reused from the piano-roll theme module.
 */

import { colorWithAlpha, TOKENS } from '@/ui/theme/tokens';

export { colorWithAlpha };

/** Color tokens used by the arrangement canvases and lanes. */
export const ARRANGEMENT_COLORS = {
  /** Lane area background. */
  background: TOKENS.surface1,
  /** Even track lane background. */
  laneEven: '#15171c',
  /** Odd track lane background. */
  laneOdd: '#13151a',
  /** Tint over the active track's lane. */
  laneActive: colorWithAlpha(TOKENS.accent, 0.07),
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
  rulerBackground: TOKENS.surface2,
  /** Line separating the ruler from the lanes. */
  rulerBorder: 'rgba(0, 0, 0, 0.5)',
  /** Bar tick on the ruler. */
  rulerBar: 'rgba(255, 255, 255, 0.45)',
  /** Beat tick on the ruler. */
  rulerBeat: 'rgba(255, 255, 255, 0.16)',
  /** Bar-number label on the ruler. */
  rulerLabel: TOKENS.text3,
  /** Loop range band on the ruler. */
  loopOverlay: colorWithAlpha(TOKENS.accent, 0.28),
  /** Shade over the attenuated corner of an audio clip fade. */
  fadeOverlay: 'rgba(0, 0, 0, 0.38)',
  /** Fade ramp line over an audio clip waveform. */
  fadeRamp: 'rgba(243, 245, 249, 0.55)',
  /** Fade handle triangle at an audio clip's top corners. */
  fadeHandle: 'rgba(232, 235, 240, 0.9)',
  /** Marker flag and stem. */
  markerFlag: TOKENS.warning,
  /** Marker name label. */
  markerLabel: colorWithAlpha(TOKENS.warning, 0.9),
  /** Playhead line. */
  playhead: TOKENS.playhead,
  /** Shade darkening the take sub-rows below their track lane. */
  takeLane: 'rgba(0, 0, 0, 0.25)',
  /** Band over take sub-rows where every take is silent at once (a safe cut). */
  takeSilence: 'rgba(255, 255, 255, 0.09)',
  /** Shade darkening an automation sublane below its track lane. */
  automationLane: 'rgba(0, 0, 0, 0.3)',
  /** Mid-value reference line across an automation sublane. */
  automationMidline: 'rgba(255, 255, 255, 0.07)',
  /** Fill of a hovered automation breakpoint. */
  automationPointHover: '#f3f5f9',
  /** Fill of the draw-tool draft clip outline. */
  draftFill: colorWithAlpha(TOKENS.accent, 0.2),
  /** Stroke of the draw-tool draft clip outline. */
  draftStroke: colorWithAlpha(TOKENS.accent, 0.85),
} as const;

/** Height of the bar/beat ruler strip at the top of the arrangement canvas. */
export const RULER_HEIGHT_PX = 28;

/** Height of one track lane. */
export const LANE_HEIGHT_PX = 56;

/** Width of the track header column. */
export const TRACK_HEADER_WIDTH_PX = 192;

/** Height of the section lane above the ruler. */
export const SECTION_LANE_HEIGHT_PX = 22;

/** Height of the chord lane below the section lane. */
export const CHORD_LANE_HEIGHT_PX = 22;
