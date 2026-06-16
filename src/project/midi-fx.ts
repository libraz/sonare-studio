/**
 * MIDI-FX transform helpers shared by the bake command and the piano-roll
 * transform panel. A MIDI-FX transform is a destructive, undoable pass the
 * engine applies to a clip's stored notes via `Project.bakeMidiFx`: transpose,
 * grid quantize, velocity scale/offset/curve, timing/velocity humanize and
 * chord harmonize. Canvas-free and side-effect-free.
 *
 * The engine accepts a flat JSON object (verified against the realtime ABI):
 * `transpose_semitones`, `quantize_ppq` + `quantize_strength`, `velocity_scale`,
 * `velocity_offset`, `velocity_gamma`, `humanize_ppq`, `humanize_velocity` and
 * `chord_intervals`. Absent or identity-valued keys are no-ops, so the
 * serializer only emits keys that actually change the notes.
 *
 * All PPQ values are in the editor convention where 1.0 = one quarter note.
 */

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamps to a finite number in [min, max] (non-finite returns `fallback`). */
function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

/** Clamps to an integer in [min, max] (non-finite returns `fallback`). */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), min, max);
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
  };
}

/** The flat object shape the engine's `bakeMidiFx` accepts. */
interface MidiFxEngineConfig {
  transpose_semitones?: number;
  quantize_ppq?: number;
  quantize_strength?: number;
  velocity_scale?: number;
  velocity_offset?: number;
  velocity_gamma?: number;
  humanize_ppq?: number;
  humanize_velocity?: number;
  chord_intervals?: number[];
}

/**
 * Builds the engine config object from a sanitized transform, emitting only the
 * keys that actually change the notes (identity-valued fields are omitted so an
 * untouched control never perturbs the clip).
 *
 * @param config A sanitized {@link MidiFxConfig}.
 * @returns The engine config, possibly empty when nothing is effective.
 */
function toEngineConfig(config: MidiFxConfig): MidiFxEngineConfig {
  const out: MidiFxEngineConfig = {};
  if (config.transposeSemitones !== 0) out.transpose_semitones = config.transposeSemitones;
  if (config.quantizeStrength > 0 && config.quantizeGrid > 0) {
    out.quantize_ppq = config.quantizeGrid;
    out.quantize_strength = config.quantizeStrength;
  }
  if (config.velocityScale !== 1) out.velocity_scale = config.velocityScale;
  if (config.velocityOffset !== 0) out.velocity_offset = config.velocityOffset;
  if (config.velocityGamma !== 1) out.velocity_gamma = config.velocityGamma;
  if (config.humanizeTimingPpq > 0) out.humanize_ppq = config.humanizeTimingPpq;
  if (config.humanizeVelocity > 0) out.humanize_velocity = config.humanizeVelocity;
  if (config.chordIntervals.length > 0 && config.chordIntervals.some((i) => i !== 0)) {
    out.chord_intervals = [...config.chordIntervals];
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
 * Serializes a transform to the JSON string `Project.bakeMidiFx` accepts, or
 * null when the transform is a no-op (nothing to bake).
 *
 * @param config A {@link MidiFxConfig} (sanitized internally).
 * @returns A JSON string, or null when no field is effective.
 */
export function midiFxConfigJson(config: MidiFxConfig): string | null {
  const engine = toEngineConfig(sanitizeMidiFxConfig(config));
  if (Object.keys(engine).length === 0) return null;
  return JSON.stringify(engine);
}
