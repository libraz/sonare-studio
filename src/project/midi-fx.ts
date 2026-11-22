/**
 * MIDI-FX transform helpers shared by the bake command and the piano-roll
 * transform panel. A MIDI-FX transform is a destructive, undoable pass the
 * engine applies to a clip's stored notes via `Project.bakeMidiFx`: transpose,
 * grid quantize, velocity scale/offset/curve, timing/velocity humanize and
 * chord harmonize. Canvas-free and side-effect-free.
 *
 * The engine takes the core's `MidiFxConfig`: `transposeSemitones`,
 * `quantizePpq` + `quantizeStrength`, `velocityScale`, `velocityOffset`,
 * `velocityGamma`, `humanizePpq`, `humanizeVelocity`, `chordIntervals` and
 * `arpeggiatorIntervals` + `arpeggiatorStepPpq` (+ optional
 * `arpeggiatorGatePpq`). Absent or identity-valued fields are no-ops, so
 * {@link midiFxConfig} only emits fields that actually change the notes.
 *
 * All PPQ values are in the editor convention where 1.0 = one quarter note.
 */

import { clamp, clampInt } from '@/lib/math';
import type { MidiFxConfig as EngineMidiFxConfig } from '@/wasm/index.js';

/** A complete MIDI-FX transform configuration (UI-facing, pre-serialization). */
export interface MidiFxConfig {
  /** Pitch shift in semitones (0 = off). */
  transposeSemitones: number;
  /** Quantize strength 0..1 (0 = off); the grid is {@link MidiFxConfig.quantizeGrid}. */
  quantizeStrength: number;
  /** Quantize grid in quarter-note PPQ (e.g. 0.25 = a 1/16 grid). */
  quantizeGrid: number;
  /** Velocity multiplier (1 = off). */
  velocityScale: number;
  /** Velocity offset added after scaling (0 = off). */
  velocityOffset: number;
  /** Velocity curve gamma; >1 softens, <1 hardens (1 = off). */
  velocityGamma: number;
  /** Maximum random timing jitter in quarter-note PPQ (0 = off). */
  humanizeTimingPpq: number;
  /** Maximum random velocity jitter (0 = off). */
  humanizeVelocity: number;
  /** Harmonize intervals in semitones (empty or root-only = off). */
  chordIntervals: number[];
  /** Arpeggio step intervals in semitones, in playback order (empty = off). */
  arpeggiatorIntervals: number[];
  /** Arpeggio step spacing in quarter-note PPQ (e.g. 0.25 = a 1/16 step). */
  arpeggiatorRate: number;
  /** Arpeggio gate as a fraction of the step (1 = legato, <1 = staccato). */
  arpeggiatorGate: number;
}

/** Identity transform: every field a no-op. */
export const DEFAULT_MIDI_FX_CONFIG: MidiFxConfig = {
  transposeSemitones: 0,
  quantizeStrength: 0,
  quantizeGrid: 0.25,
  velocityScale: 1,
  velocityOffset: 0,
  velocityGamma: 1,
  humanizeTimingPpq: 0,
  humanizeVelocity: 0,
  chordIntervals: [],
  arpeggiatorIntervals: [],
  arpeggiatorRate: 0.25,
  arpeggiatorGate: 1,
};

/** One harmonize preset offered by the transform panel. */
export interface ChordPreset {
  /** Stable identifier. */
  id: string;
  /** Short menu label. */
  label: string;
  /** Semitone offsets applied per note (0 keeps the original note). */
  intervals: number[];
}

/** Harmonize presets, in menu order. "Off" is the empty-interval entry. */
export const MIDI_FX_CHORD_PRESETS: readonly ChordPreset[] = [
  { id: 'off', label: 'Off', intervals: [] },
  { id: 'octave', label: 'Octave', intervals: [0, 12] },
  { id: 'fifth', label: '5th', intervals: [0, 7] },
  { id: 'major', label: 'Major', intervals: [0, 4, 7] },
  { id: 'minor', label: 'Minor', intervals: [0, 3, 7] },
  { id: 'sus4', label: 'Sus4', intervals: [0, 5, 7] },
  { id: 'major7', label: 'Maj7', intervals: [0, 4, 7, 11] },
  { id: 'minor7', label: 'Min7', intervals: [0, 3, 7, 10] },
  { id: 'dom7', label: 'Dom7', intervals: [0, 4, 7, 10] },
  { id: 'spread', label: 'Spread', intervals: [-12, 0, 12] },
];

/** One arpeggio pattern offered by the transform panel. */
export interface ArpPreset {
  /** Stable identifier. */
  id: string;
  /** Short menu label. */
  label: string;
  /** Semitone offsets played one per step, in order (0 keeps the original note). */
  intervals: number[];
}

/**
 * Arpeggio patterns, in menu order. "Off" is the empty-interval entry. Unlike
 * harmonize, order and repeats matter (a step list is played sequentially), so
 * up/down patterns list the same interval more than once.
 */
export const MIDI_FX_ARP_PRESETS: readonly ArpPreset[] = [
  { id: 'off', label: 'Off', intervals: [] },
  { id: 'octave', label: 'Octave', intervals: [0, 12] },
  { id: 'up', label: 'Up', intervals: [0, 4, 7] },
  { id: 'upOctave', label: 'Up+8ve', intervals: [0, 4, 7, 12] },
  { id: 'minor', label: 'Minor', intervals: [0, 3, 7] },
  { id: 'octaves', label: 'Octaves', intervals: [0, 12, 24] },
  { id: 'updown', label: 'Up/Down', intervals: [0, 4, 7, 12, 7, 4] },
];

/** One quantize grid offered by the transform panel. */
export interface MidiFxGrid {
  /** Stable identifier. */
  id: string;
  /** Short menu label. */
  label: string;
  /** Grid spacing in quarter-note PPQ. */
  ppq: number;
}

/** Quantize grids, in menu order (1/4 down to 1/32, with triplets). */
export const MIDI_FX_QUANTIZE_GRIDS: readonly MidiFxGrid[] = [
  { id: '1/4', label: '1/4', ppq: 1 },
  { id: '1/4T', label: '1/4T', ppq: 2 / 3 },
  { id: '1/8', label: '1/8', ppq: 0.5 },
  { id: '1/8T', label: '1/8T', ppq: 1 / 3 },
  { id: '1/16', label: '1/16', ppq: 0.25 },
  { id: '1/16T', label: '1/16T', ppq: 1 / 6 },
  { id: '1/32', label: '1/32', ppq: 0.125 },
];

/** Lowest / highest harmonize interval (semitones). */
const CHORD_INTERVAL_MIN = -48;
const CHORD_INTERVAL_MAX = 48;
/** Maximum harmonize voices the engine accepts. */
const CHORD_INTERVAL_MAX_COUNT = 8;

/** Lowest / highest arpeggio step interval (semitones). */
const ARP_INTERVAL_MIN = -48;
const ARP_INTERVAL_MAX = 48;
/** Maximum arpeggio steps the engine accepts (ArpeggiatorConfig::kMaxArpSteps). */
const ARP_INTERVAL_MAX_COUNT = 16;

/** Clamps to a finite number in [min, max] (non-finite returns `fallback`). */
function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

/**
 * Normalizes harmonize intervals: drops non-finite entries, clamps each to the
 * supported range, de-duplicates (preserving order) and caps the voice count.
 *
 * @param intervals Raw semitone offsets.
 * @returns A fresh, clamped, de-duplicated interval list.
 */
export function sanitizeChordIntervals(intervals: ReadonlyArray<number>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of intervals) {
    if (!Number.isFinite(raw)) continue;
    const value = clamp(Math.round(raw), CHORD_INTERVAL_MIN, CHORD_INTERVAL_MAX);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= CHORD_INTERVAL_MAX_COUNT) break;
  }
  return out;
}

/**
 * Normalizes arpeggio step intervals: drops non-finite entries, clamps each to
 * the supported range and caps the step count. Order and repeats are preserved
 * (a step list is played sequentially, so they are musically meaningful).
 *
 * @param intervals Raw semitone offsets, in playback order.
 * @returns A fresh, clamped interval list (at most {@link ARP_INTERVAL_MAX_COUNT}).
 */
export function sanitizeArpIntervals(intervals: ReadonlyArray<number>): number[] {
  const out: number[] = [];
  for (const raw of intervals) {
    if (!Number.isFinite(raw)) continue;
    out.push(clamp(Math.round(raw), ARP_INTERVAL_MIN, ARP_INTERVAL_MAX));
    if (out.length >= ARP_INTERVAL_MAX_COUNT) break;
  }
  return out;
}

/**
 * Clamps every field of a transform config into its supported range, returning
 * a fresh object safe to serialize or store.
 *
 * @param input Partial or fully-populated config.
 * @returns A complete, clamped {@link MidiFxConfig}.
 */
export function sanitizeMidiFxConfig(input: Partial<MidiFxConfig>): MidiFxConfig {
  const grid = clampFinite(
    input.quantizeGrid ?? DEFAULT_MIDI_FX_CONFIG.quantizeGrid,
    1 / 8,
    4,
    DEFAULT_MIDI_FX_CONFIG.quantizeGrid,
  );
  return {
    transposeSemitones: clampInt(input.transposeSemitones ?? 0, -48, 48, 0),
    quantizeStrength: clampFinite(input.quantizeStrength ?? 0, 0, 1, 0),
    quantizeGrid: grid,
    velocityScale: clampFinite(input.velocityScale ?? 1, 0, 4, 1),
    velocityOffset: clampInt(input.velocityOffset ?? 0, -127, 127, 0),
    velocityGamma: clampFinite(input.velocityGamma ?? 1, 0.1, 4, 1),
    humanizeTimingPpq: clampFinite(input.humanizeTimingPpq ?? 0, 0, 1, 0),
    humanizeVelocity: clampInt(input.humanizeVelocity ?? 0, 0, 64, 0),
    chordIntervals: sanitizeChordIntervals(input.chordIntervals ?? []),
    arpeggiatorIntervals: sanitizeArpIntervals(input.arpeggiatorIntervals ?? []),
    arpeggiatorRate: clampFinite(
      input.arpeggiatorRate ?? DEFAULT_MIDI_FX_CONFIG.arpeggiatorRate,
      1 / 32,
      4,
      DEFAULT_MIDI_FX_CONFIG.arpeggiatorRate,
    ),
    arpeggiatorGate: clampFinite(input.arpeggiatorGate ?? 1, 0.05, 1, 1),
  };
}

/**
 * Builds the engine config from a sanitized transform, emitting only the
 * fields that actually change the notes (identity-valued fields are omitted so
 * an untouched control never perturbs the clip).
 *
 * @param config A sanitized {@link MidiFxConfig}.
 * @returns The engine config, possibly empty when nothing is effective.
 */
function toEngineConfig(config: MidiFxConfig): EngineMidiFxConfig {
  const out: EngineMidiFxConfig = {};
  if (config.transposeSemitones !== 0) out.transposeSemitones = config.transposeSemitones;
  if (config.quantizeStrength > 0 && config.quantizeGrid > 0) {
    out.quantizePpq = config.quantizeGrid;
    out.quantizeStrength = config.quantizeStrength;
  }
  if (config.velocityScale !== 1) out.velocityScale = config.velocityScale;
  if (config.velocityOffset !== 0) out.velocityOffset = config.velocityOffset;
  if (config.velocityGamma !== 1) out.velocityGamma = config.velocityGamma;
  if (config.humanizeTimingPpq > 0) out.humanizePpq = config.humanizeTimingPpq;
  if (config.humanizeVelocity > 0) out.humanizeVelocity = config.humanizeVelocity;
  if (config.chordIntervals.length > 0 && config.chordIntervals.some((i) => i !== 0)) {
    out.chordIntervals = [...config.chordIntervals];
  }
  // An arpeggio re-triggers a held note into a sequence, so any non-empty step
  // list is effective (even a single [0] step, which repeats the note). The gate
  // is emitted only when it shortens the step; a full gate is the legato
  // default the engine assumes when the field is absent.
  if (config.arpeggiatorIntervals.length > 0 && config.arpeggiatorRate > 0) {
    out.arpeggiatorIntervals = [...config.arpeggiatorIntervals];
    out.arpeggiatorStepPpq = config.arpeggiatorRate;
    if (config.arpeggiatorGate < 1) {
      out.arpeggiatorGatePpq = config.arpeggiatorRate * config.arpeggiatorGate;
    }
  }
  return out;
}

/**
 * True when a sanitized transform would leave every note unchanged (no
 * effective keys), so callers can skip a pointless undoable bake.
 *
 * @param config A sanitized {@link MidiFxConfig}.
 */
export function isMidiFxNoop(config: MidiFxConfig): boolean {
  return Object.keys(toEngineConfig(config)).length === 0;
}

/**
 * Converts a transform to the core's MIDI-FX config, or null when the
 * transform is a no-op (nothing to apply or bake).
 *
 * @param config A {@link MidiFxConfig} (sanitized internally).
 * @returns The core config, or null when no field is effective.
 */
export function midiFxConfig(config: MidiFxConfig): EngineMidiFxConfig | null {
  const engine = toEngineConfig(sanitizeMidiFxConfig(config));
  return Object.keys(engine).length === 0 ? null : engine;
}
