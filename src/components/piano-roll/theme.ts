/**
 * Shared dark-theme color tokens and canvas helpers for the piano-roll
 * components. Kept local to the piano roll until a global theme exists.
 */

import type { EditorNote } from '@/project/types';

/** Color tokens used by the piano-roll canvases. */
export const PIANO_ROLL_COLORS = {
  /** Note grid background. */
  background: '#15171c',
  /** Row shading for black-key pitches. */
  rowBlackKey: 'rgba(0, 0, 0, 0.28)',
  /** Row tint for pitches inside the highlighted scale. */
  rowScale: 'rgba(94, 234, 212, 0.05)',
  /** Horizontal line between pitch rows. */
  rowLine: 'rgba(255, 255, 255, 0.04)',
  /** Vertical line at the snap grid step. */
  gridFine: 'rgba(255, 255, 255, 0.045)',
  /** Vertical line at each beat (quarter note). */
  gridBeat: 'rgba(255, 255, 255, 0.09)',
  /** Vertical line at each bar. */
  gridBar: 'rgba(255, 255, 255, 0.18)',
  /** Shade over the region past the clip end. */
  beyondClip: 'rgba(0, 0, 0, 0.35)',
  /** Border of unselected notes. */
  noteBorder: 'rgba(0, 0, 0, 0.55)',
  /** Border of selected notes. */
  noteSelectedBorder: '#f3f5f9',
  /** Playhead line. */
  playhead: '#ff6e6e',
  /** Marquee fill. */
  marqueeFill: 'rgba(96, 165, 250, 0.14)',
  /** Marquee outline. */
  marqueeStroke: 'rgba(96, 165, 250, 0.85)',
  /** White piano keys. */
  keyWhite: '#cdd2da',
  /** Black piano keys. */
  keyBlack: '#23262d',
  /** Key separator lines. */
  keyLine: 'rgba(0, 0, 0, 0.35)',
  /** Octave labels on C keys. */
  keyLabel: '#3a3f48',
  /** Velocity lane background. */
  laneBackground: '#181a20',
  /** Velocity lane reference lines (25/50/75%). */
  laneRule: 'rgba(255, 255, 255, 0.06)',
  /** Zero line of bipolar parameter lanes. */
  laneCenter: 'rgba(255, 255, 255, 0.18)',
  /** In-flight value readout while a lane drag runs. */
  laneValueText: '#9aa1ad',
} as const;

/** Default track color applied to notes until per-track colors exist. */
export const DEFAULT_NOTE_COLOR = '#4fa8e8';

/** Per-note color resolver; single-track for now, multi-track overlays later. */
export type NoteColorFn = (note: EditorNote) => string;

/** Pitch classes rendered as black keys (C#, D#, F#, G#, A#). */
const BLACK_KEY_PCS = new Set([1, 3, 6, 8, 10]);

/**
 * Returns true when a MIDI pitch is a black key.
 *
 * @param pitch - MIDI pitch (0..127).
 */
export function isBlackKey(pitch: number): boolean {
  return BLACK_KEY_PCS.has(((pitch % 12) + 12) % 12);
}

/**
 * Resizes a canvas backing store to CSS px dimensions times devicePixelRatio
 * and returns a 2d context with the DPR transform applied, so all subsequent
 * drawing uses CSS px coordinates.
 *
 * @param canvas - Target canvas element.
 * @param widthPx - CSS pixel width.
 * @param heightPx - CSS pixel height.
 * @returns The configured 2d context, or null when unavailable.
 */
export function setupCanvas(
  canvas: HTMLCanvasElement,
  widthPx: number,
  heightPx: number,
): CanvasRenderingContext2D | null {
  const dpr = globalThis.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(widthPx * dpr));
  canvas.height = Math.max(1, Math.round(heightPx * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * Returns a 2d context with the devicePixelRatio transform applied, so draw
 * code can work in CSS px after the backing store was sized by
 * {@link setupCanvas}.
 *
 * @param canvas - Source canvas element.
 * @returns The configured 2d context, or null when unavailable.
 */
export function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = globalThis.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * Fills a rounded rectangle, falling back to a plain rect when the canvas
 * implementation lacks roundRect.
 *
 * @param ctx - Target 2d context (path is begun and filled here).
 * @param x - Left edge in px.
 * @param y - Top edge in px.
 * @param width - Width in px.
 * @param height - Height in px.
 * @param radius - Corner radius in px (clamped to half the extent).
 */
export function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    ctx.fill();
    return;
  }
  ctx.fillRect(x, y, width, height);
}

/**
 * Strokes a rounded rectangle, falling back to a plain rect when the canvas
 * implementation lacks roundRect.
 *
 * @param ctx - Target 2d context (path is begun and stroked here).
 * @param x - Left edge in px.
 * @param y - Top edge in px.
 * @param width - Width in px.
 * @param height - Height in px.
 * @param radius - Corner radius in px (clamped to half the extent).
 */
export function strokeRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    ctx.stroke();
    return;
  }
  ctx.strokeRect(x, y, width, height);
}
