import type { EditorNote, EditorNoteUpdate } from '@/project/types';

/**
 * Pure value mapping for the multi-parameter note lane below the piano-roll
 * grid. Each lane parameter projects one EditorNote field onto a vertical
 * bar: the spec describes the value range and rendering style (unipolar,
 * bipolar around a center line, stepped), and the conversion helpers turn
 * note fields, normalized bar extents and pointer y coordinates into each
 * other. The ramp helpers back the alt-drag line tool and the sweep-paint
 * bucketing. Everything here is canvas-free and side-effect-free.
 */

/** Identifier of one editable note parameter shown in the lane. */
export type LaneParamId = 'velocity' | 'length' | 'offset' | 'offVelocity' | 'channel';

/** Static description of one lane parameter. */
export interface LaneParamSpec {
  /** Parameter identity. */
  id: LaneParamId;
  /** Short tab label that fits the narrow lane header. */
  label: string;
  /** Full parameter name (tab tooltip). */
  title: string;
  /** Lowest assignable value. */
  min: number;
  /** Highest assignable value. */
  max: number;
  /** Fallback value when a note omits the field or the lane has no height. */
  defaultValue: number;
  /** Bars grow up/down from a center zero line instead of the lane bottom. */
  bipolar: boolean;
  /** Values snap to integer steps. */
  stepped: boolean;
  /** Value-to-bar response: linear or logarithmic across [min, max]. */
  scale: 'linear' | 'log';
  /**
   * Normalization domain start when it differs from `min` (velocity bars use
   * 0..127 so heights keep the historical velocity/127 mapping).
   */
  normMin?: number;
  /** Normalization domain end when it differs from `max`. */
  normMax?: number;
}

/** Note-off velocity assumed when a note omits the optional field. */
export const DEFAULT_OFF_VELOCITY = 64;

/** Shortest length bar: a 1/64 note (PPQ unit = quarter note). */
const MIN_LENGTH_PPQ = 0.0625;
/** Longest length bar: four 4/4 bars. */
const MAX_LENGTH_PPQ = 16;
/** Start-offset range: one eighth note either side of the nearest beat. */
const MAX_OFFSET_PPQ = 0.5;
/** Tolerance below which fractional PPQ values count as unchanged. */
const PPQ_EPSILON = 1e-9;

const SPECS: Readonly<Record<LaneParamId, LaneParamSpec>> = {
  velocity: {
    id: 'velocity',
    label: 'VEL',
    title: 'Velocity',
    min: 1,
    max: 127,
    defaultValue: 96,
    bipolar: false,
    stepped: true,
    scale: 'linear',
    normMin: 0,
    normMax: 127,
  },
  length: {
    id: 'length',
    label: 'LEN',
    title: 'Length',
    min: MIN_LENGTH_PPQ,
    max: MAX_LENGTH_PPQ,
    defaultValue: 1,
    bipolar: false,
    stepped: false,
    scale: 'log',
  },
  offset: {
    id: 'offset',
    label: 'OFS',
    title: 'Start offset',
    min: -MAX_OFFSET_PPQ,
    max: MAX_OFFSET_PPQ,
    defaultValue: 0,
    bipolar: true,
    stepped: false,
    scale: 'linear',
  },
  offVelocity: {
    id: 'offVelocity',
    label: 'REL',
    title: 'Off-velocity',
    min: 1,
    max: 127,
    defaultValue: DEFAULT_OFF_VELOCITY,
    bipolar: false,
    stepped: true,
    scale: 'linear',
    normMin: 0,
    normMax: 127,
  },
  channel: {
    id: 'channel',
    label: 'CH',
    title: 'Channel',
    min: 0,
    max: 15,
    defaultValue: 0,
    bipolar: false,
    stepped: true,
    scale: 'linear',
  },
};

/** Lane parameters in tab order. */
export const LANE_PARAMS: readonly LaneParamSpec[] = [
  SPECS.velocity,
  SPECS.length,
  SPECS.offset,
  SPECS.offVelocity,
  SPECS.channel,
];

/**
 * Returns the static spec of a lane parameter.
 *
 * @param id - Lane parameter identity.
 */
export function laneParamSpec(id: LaneParamId): LaneParamSpec {
  return SPECS[id];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Reads a note's current value for a lane parameter.
 *
 * Offset is the signed deviation of the note start from the nearest beat
 * (quarter note); off-velocity falls back to {@link DEFAULT_OFF_VELOCITY}
 * when the note omits the field.
 *
 * @param id - Lane parameter identity.
 * @param note - Source note.
 */
export function noteLaneValue(id: LaneParamId, note: EditorNote): number {
  switch (id) {
    case 'velocity':
      return note.velocity;
    case 'length':
      return note.durationPpq;
    case 'offset':
      return note.startPpq - Math.round(note.startPpq);
    case 'offVelocity':
      return note.offVelocity ?? DEFAULT_OFF_VELOCITY;
    case 'channel':
      return note.channel;
  }
}

/**
 * Maps a parameter value to a normalized bar extent: 0..1 for unipolar
 * parameters, -1..1 for bipolar ones. Out-of-range values clamp.
 *
 * @param id - Lane parameter identity.
 * @param value - Parameter value.
 */
export function normalizedLaneValue(id: LaneParamId, value: number): number {
  const spec = SPECS[id];
  if (spec.bipolar) return clamp(value / spec.max, -1, 1);
  if (spec.scale === 'log') {
    const clamped = clamp(value, spec.min, spec.max);
    return clamp01(Math.log(clamped / spec.min) / Math.log(spec.max / spec.min));
  }
  const lo = spec.normMin ?? spec.min;
  const hi = spec.normMax ?? spec.max;
  return clamp01((value - lo) / (hi - lo));
}

/**
 * Inverse of {@link normalizedLaneValue}: maps a normalized bar extent back
 * to a parameter value, rounding stepped parameters and clamping to
 * [min, max].
 *
 * @param id - Lane parameter identity.
 * @param normalized - Bar extent (0..1 unipolar, -1..1 bipolar); clamped.
 */
export function laneValueFromNormalized(id: LaneParamId, normalized: number): number {
  const spec = SPECS[id];
  if (spec.bipolar) {
    const value = clamp(normalized, -1, 1) * spec.max;
    return spec.stepped ? clamp(Math.round(value), spec.min, spec.max) : value;
  }
  if (spec.scale === 'log') {
    return spec.min * (spec.max / spec.min) ** clamp01(normalized);
  }
  const lo = spec.normMin ?? spec.min;
  const hi = spec.normMax ?? spec.max;
  const value = lo + normalized * (hi - lo);
  return clamp(spec.stepped ? Math.round(value) : value, spec.min, spec.max);
}

/**
 * Maps a lane-local pointer y coordinate to a parameter value. Top = max,
 * bottom = min; for bipolar parameters the vertical center maps to zero.
 *
 * @param id - Lane parameter identity.
 * @param y - Pointer y in lane-local CSS px.
 * @param heightPx - Lane height in CSS px; non-positive returns the default.
 */
export function laneValueFromY(id: LaneParamId, y: number, heightPx: number): number {
  const spec = SPECS[id];
  if (heightPx <= 0) return spec.defaultValue;
  const normalized = spec.bipolar ? 1 - (2 * y) / heightPx : 1 - y / heightPx;
  return laneValueFromNormalized(id, normalized);
}

/**
 * Clamps a value into a parameter's range, rounding stepped parameters.
 * Applied to ramp-interpolated values so channel sweeps stay on integers.
 *
 * @param id - Lane parameter identity.
 * @param value - Raw value.
 */
export function quantizeLaneValue(id: LaneParamId, value: number): number {
  const spec = SPECS[id];
  return clamp(spec.stepped ? Math.round(value) : value, spec.min, spec.max);
}

/** Vertical extent of one lane bar in CSS px. */
export interface LaneBarRect {
  /** Top edge of the bar. */
  y: number;
  /** Bar height (>= 2 so even minimum values stay grabbable). */
  h: number;
}

/**
 * Computes the vertical bar rectangle for a parameter value. Unipolar bars
 * grow up from the lane bottom (preserving the historical velocity layout);
 * bipolar bars grow from the vertical center line, up for positive values
 * and down for negative ones.
 *
 * @param id - Lane parameter identity.
 * @param value - Parameter value.
 * @param heightPx - Lane height in CSS px.
 */
export function laneBarRect(id: LaneParamId, value: number, heightPx: number): LaneBarRect {
  const spec = SPECS[id];
  const normalized = normalizedLaneValue(id, value);
  if (spec.bipolar) {
    const half = heightPx / 2;
    const extent = Math.min(half, Math.max(2, Math.abs(normalized) * (half - 1)));
    return normalized >= 0 ? { y: half - extent, h: extent } : { y: half, h: extent };
  }
  const h = Math.max(2, normalized * (heightPx - 2));
  return { y: heightPx - h, h };
}

/**
 * Builds the note update that applies a lane value to a note, or null when
 * the note already has that value.
 *
 * Offset rewrites the note start to `round(startPpq) + value` (anchored to
 * the nearest beat of the unedited note, clamped to >= 0); length rewrites
 * the duration; the other parameters map directly to their fields.
 *
 * @param id - Lane parameter identity.
 * @param note - Note as it was before the gesture.
 * @param value - New lane value (quantized internally).
 */
export function laneUpdateForValue(
  id: LaneParamId,
  note: EditorNote,
  value: number,
): EditorNoteUpdate | null {
  const next = quantizeLaneValue(id, value);
  switch (id) {
    case 'velocity':
      return next === note.velocity ? null : { id: note.id, velocity: next };
    case 'length':
      return Math.abs(next - note.durationPpq) <= PPQ_EPSILON
        ? null
        : { id: note.id, durationPpq: next };
    case 'offset': {
      const startPpq = Math.max(0, Math.round(note.startPpq) + next);
      return Math.abs(startPpq - note.startPpq) <= PPQ_EPSILON ? null : { id: note.id, startPpq };
    }
    case 'offVelocity':
      return next === (note.offVelocity ?? DEFAULT_OFF_VELOCITY)
        ? null
        : { id: note.id, offVelocity: next };
    case 'channel':
      return next === note.channel ? null : { id: note.id, channel: next };
  }
}

function formatPpq(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * Formats a lane value for display. Velocities are plain integers, channels
 * read 1-16 (the model stays 0-15), PPQ values are printed in beats with up
 * to three decimals, offsets carry an explicit sign.
 *
 * @param id - Lane parameter identity.
 * @param value - Parameter value.
 */
export function formatLaneValue(id: LaneParamId, value: number): string {
  switch (id) {
    case 'velocity':
    case 'offVelocity':
      return String(Math.round(value));
    case 'channel':
      return String(Math.round(value) + 1);
    case 'length':
      return `${formatPpq(value)} beats`;
    case 'offset':
      return `${value > 0 ? '+' : ''}${formatPpq(value)} beats`;
  }
}

/** Horizontal extent of one note bar in lane-local CSS px. */
export interface LaneBar {
  /** Editor note id the bar belongs to. */
  id: number;
  /** Left edge of the bar column. */
  x: number;
  /** Bar column width. */
  w: number;
}

/**
 * Returns the bars whose columns overlap the horizontal span [x0, x1] in the
 * input order. The endpoints may be passed in either order; bars touching an
 * endpoint count as inside.
 *
 * @param bars - Candidate bars.
 * @param x0 - One end of the swept span.
 * @param x1 - Other end of the swept span.
 */
export function barsInSpan(bars: ReadonlyArray<LaneBar>, x0: number, x1: number): LaneBar[] {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  return bars.filter((bar) => bar.x + bar.w >= lo && bar.x <= hi);
}

/**
 * Linear ramp between two anchor points, clamped to the segment: positions
 * before the start return the start value, positions past the end return the
 * end value. A zero-width segment returns the end value.
 *
 * @param x0 - Ramp start position.
 * @param v0 - Ramp start value.
 * @param x1 - Ramp end position.
 * @param v1 - Ramp end value.
 * @param x - Sample position.
 */
export function rampValueAt(x0: number, v0: number, x1: number, v1: number, x: number): number {
  if (x1 === x0) return v1;
  const t = clamp01((x - x0) / (x1 - x0));
  return v0 + (v1 - v0) * t;
}
