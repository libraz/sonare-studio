/**
 * Pure helpers for app-level MIDI CC "learn": mapping 7-bit controller values
 * to the mixer parameters they drive, and encoding/decoding the target ids a
 * binding points at. Canvas-free and side-effect-free.
 *
 * MIDI learn is implemented in the app layer, not the engine: the library's
 * `RealtimeEngine.bindMidiCc` binds onto a detached realtime engine that is not
 * in the audible AudioWorklet path (see the note in App.vue), so binding there
 * would move nothing the user hears. Instead, incoming CC is mapped here and
 * applied through the real mixer commands (`setStripGain` / `setStripPan`),
 * which are mirrored to the engine faders in realtime — genuinely audible.
 */

/** The mixer parameter a CC binding drives. */
export type MidiLearnParam = 'gain' | 'pan';

/** A mixer strip a binding targets: a track id, or the master strip. */
export type MidiLearnScope = number | 'master';

/** A decoded learn target: which parameter on which strip. */
export interface MidiLearnTarget {
  /** Driven parameter. */
  param: MidiLearnParam;
  /** Driven strip (track id or 'master'). */
  scope: MidiLearnScope;
}

/** A control-change message decoded from a Web MIDI input. */
export interface MidiCcMessage {
  /** MIDI channel (0-15). */
  channel: number;
  /** Controller number (0-127). */
  controller: number;
  /** Controller value (0-127). */
  value: number;
}

/** A stored binding: the channel + controller a target listens to. */
export interface MidiCcBinding {
  /** MIDI channel (0-15). */
  channel: number;
  /** Controller number (0-127). */
  controller: number;
}

/** Lowest / highest 7-bit MIDI value. */
export const MIDI_VALUE_MAX = 127;
const MIDI_VALUE_CENTER = 64;

/**
 * Gain window a full CC sweep spans, in dB. The strip command accepts a much
 * wider range ([-96, +24]); this musical sub-window keeps a fader sweep useful
 * rather than spending most of the travel near silence.
 */
export const MIDI_FADER_MIN_DB = -60;
/** Top of the CC-mapped gain window, in dB. */
export const MIDI_FADER_MAX_DB = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamps a raw CC value to an integer in [0, 127]. */
export function clampCcValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.round(value), 0, MIDI_VALUE_MAX);
}

/** Maps a CC value (0-127) to gain in dB across the MIDI fader window. */
export function ccToGainDb(value: number): number {
  const t = clampCcValue(value) / MIDI_VALUE_MAX;
  return MIDI_FADER_MIN_DB + t * (MIDI_FADER_MAX_DB - MIDI_FADER_MIN_DB);
}

/** Maps gain in dB back to the nearest CC value (for display / round-trip). */
export function gainDbToCc(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 0;
  const t = (gainDb - MIDI_FADER_MIN_DB) / (MIDI_FADER_MAX_DB - MIDI_FADER_MIN_DB);
  return clampCcValue(t * MIDI_VALUE_MAX);
}

/** Maps a CC value (0-127) to a pan position in [-1, 1] (64 = center). */
export function ccToPan(value: number): number {
  return clamp(
    (clampCcValue(value) - MIDI_VALUE_CENTER) / (MIDI_VALUE_MAX - MIDI_VALUE_CENTER),
    -1,
    1,
  );
}

/** Maps a pan position in [-1, 1] back to the nearest CC value. */
export function panToCc(pan: number): number {
  if (!Number.isFinite(pan)) return MIDI_VALUE_CENTER;
  return clampCcValue(MIDI_VALUE_CENTER + pan * (MIDI_VALUE_MAX - MIDI_VALUE_CENTER));
}

/** Encodes a learn target into a stable string id (e.g. `gain:master`, `pan:7`). */
export function midiLearnTargetId(param: MidiLearnParam, scope: MidiLearnScope): string {
  return `${param}:${scope}`;
}

/** Decodes a target id, or null when it is malformed. */
export function parseMidiLearnTargetId(id: string): MidiLearnTarget | null {
  const sep = id.indexOf(':');
  if (sep < 0) return null;
  const param = id.slice(0, sep);
  if (param !== 'gain' && param !== 'pan') return null;
  const rest = id.slice(sep + 1);
  if (rest === 'master') return { param, scope: 'master' };
  const trackId = Number(rest);
  if (!Number.isInteger(trackId)) return null;
  return { param, scope: trackId };
}

/** Prefix marking an insert-parameter learn target id. */
const INSERT_TARGET_PREFIX = 'insert:';

/** A decoded insert-parameter learn target. */
export interface MidiLearnInsertTarget {
  /** Strip the insert lives on (track id or 'master'). */
  scope: MidiLearnScope;
  /** Insert slot index on the strip. */
  index: number;
  /** Processor parameter name (a quick-control id). */
  paramId: string;
}

/**
 * Encodes an insert-parameter learn target, e.g. `insert:7:2:thresholdDb`
 * (track 7, slot 2) or `insert:master:0:gainDb`. The param id is the last
 * segment, so it may itself contain colons without ambiguity.
 *
 * @param scope Strip the insert lives on (track id or 'master').
 * @param index Insert slot index.
 * @param paramId Processor parameter name.
 * @returns The encoded target id.
 */
export function midiLearnInsertTargetId(
  scope: MidiLearnScope,
  index: number,
  paramId: string,
): string {
  return `${INSERT_TARGET_PREFIX}${scope}:${index}:${paramId}`;
}

/** Decodes an insert-parameter target id, or null when it is malformed. */
export function parseMidiLearnInsertTargetId(id: string): MidiLearnInsertTarget | null {
  if (!id.startsWith(INSERT_TARGET_PREFIX)) return null;
  const rest = id.slice(INSERT_TARGET_PREFIX.length);
  const firstSep = rest.indexOf(':');
  if (firstSep <= 0) return null;
  const scopeText = rest.slice(0, firstSep);
  const afterScope = rest.slice(firstSep + 1);
  const secondSep = afterScope.indexOf(':');
  if (secondSep < 0) return null;
  const indexText = afterScope.slice(0, secondSep);
  const paramId = afterScope.slice(secondSep + 1);
  if (paramId.length === 0) return null;
  const index = Number(indexText);
  if (!Number.isInteger(index) || index < 0) return null;
  if (scopeText === 'master') return { scope: 'master', index, paramId };
  const trackId = Number(scopeText);
  if (!Number.isInteger(trackId)) return null;
  return { scope: trackId, index, paramId };
}

/** Prefix marking an instrument-parameter learn target id. */
const INSTRUMENT_TARGET_PREFIX = 'instrument:';

/** A decoded instrument-parameter learn target. */
export interface MidiLearnInstrumentTarget {
  /** Track whose instrument is driven. */
  trackId: number;
  /** Instrument parameter name (a quick-control id). */
  paramId: string;
}

/**
 * Encodes an instrument-parameter learn target, e.g. `instrument:7:cutoffHz`.
 * The param id is the last segment, so it may itself contain colons.
 *
 * @param trackId Track whose instrument is driven.
 * @param paramId Instrument parameter name.
 * @returns The encoded target id.
 */
export function midiLearnInstrumentTargetId(trackId: number, paramId: string): string {
  return `${INSTRUMENT_TARGET_PREFIX}${trackId}:${paramId}`;
}

/** Decodes an instrument-parameter target id, or null when it is malformed. */
export function parseMidiLearnInstrumentTargetId(id: string): MidiLearnInstrumentTarget | null {
  if (!id.startsWith(INSTRUMENT_TARGET_PREFIX)) return null;
  const rest = id.slice(INSTRUMENT_TARGET_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const paramId = rest.slice(sep + 1);
  if (paramId.length === 0) return null;
  const trackId = Number(rest.slice(0, sep));
  if (!Number.isInteger(trackId)) return null;
  return { trackId, paramId };
}

/** Maps a CC value (0-127) linearly into the inclusive range [min, max]. */
export function ccToRange(value: number, min: number, max: number): number {
  const t = clampCcValue(value) / MIDI_VALUE_MAX;
  return min + t * (max - min);
}

/** Maps a value in [min, max] back to the nearest CC value (for round-trips). */
export function rangeToCc(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max === min) return 0;
  return clampCcValue(((value - min) / (max - min)) * MIDI_VALUE_MAX);
}

/** Formats a binding for display, e.g. "CC 7 · Ch 1". */
export function formatMidiCcBinding(binding: MidiCcBinding): string {
  return `CC ${binding.controller} · Ch ${binding.channel + 1}`;
}

/** True when an id decodes to any known learn target (strip / insert / instrument). */
export function isMidiLearnTargetId(id: string): boolean {
  return (
    parseMidiLearnTargetId(id) !== null ||
    parseMidiLearnInsertTargetId(id) !== null ||
    parseMidiLearnInstrumentTargetId(id) !== null
  );
}

/**
 * Extracts the track scope a target id is bound to: a track id, 'master', or
 * null when the id does not decode. Track-scoped ids embed a session track id
 * (gain/pan/insert/instrument); 'master' ids are stable across reloads.
 */
export function midiLearnTargetScope(id: string): MidiLearnScope | null {
  const strip = parseMidiLearnTargetId(id);
  if (strip) return strip.scope;
  const insert = parseMidiLearnInsertTargetId(id);
  if (insert) return insert.scope;
  const instrument = parseMidiLearnInstrumentTargetId(id);
  if (instrument) return instrument.trackId;
  return null;
}

/**
 * Rewrites a target id's track scope to a new value, keeping the rest of the
 * target intact. Returns null when the id does not decode, or when a numeric
 * scope is replaced by 'master' on an instrument target (which is track-only).
 *
 * This makes a binding portable across a document load: serialize replaces the
 * session track id with the track's positional index, and load replaces that
 * index with the freshly assigned track id.
 */
export function withMidiLearnTargetScope(id: string, scope: MidiLearnScope): string | null {
  const strip = parseMidiLearnTargetId(id);
  if (strip) return midiLearnTargetId(strip.param, scope);
  const insert = parseMidiLearnInsertTargetId(id);
  if (insert) return midiLearnInsertTargetId(scope, insert.index, insert.paramId);
  const instrument = parseMidiLearnInstrumentTargetId(id);
  if (instrument) {
    if (scope === 'master') return null;
    return midiLearnInstrumentTargetId(scope, instrument.paramId);
  }
  return null;
}

/** One persisted CC binding: the target id it drives plus the channel + controller. */
export interface PersistedMidiCcBinding {
  /**
   * Target id (see {@link midiLearnTargetId} and the insert/instrument
   * encoders). When {@link trackScoped} is true, the id's scope segment holds a
   * positional track index rather than a session track id.
   */
  target: string;
  /** MIDI channel (0-15). */
  channel: number;
  /** Controller number (0-127). */
  controller: number;
  /** True when `target`'s scope is a track index awaiting load-time rebinding. */
  trackScoped?: boolean;
}

/**
 * Sanitizes an untrusted persisted binding list (a document's `midiCcBindings`)
 * into well-formed entries. Drops entries whose target id does not decode to a
 * known target, whose channel/controller is out of range, or that repeat a
 * target already seen (first occurrence wins).
 *
 * @param value Candidate entry list; non-arrays yield [].
 * @returns A new array of well-formed bindings.
 */
export function sanitizeMidiCcBindings(value: unknown): PersistedMidiCcBinding[] {
  if (!Array.isArray(value)) return [];
  const out: PersistedMidiCcBinding[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as {
      target?: unknown;
      channel?: unknown;
      controller?: unknown;
      trackScoped?: unknown;
    };
    if (typeof candidate.target !== 'string' || !isMidiLearnTargetId(candidate.target)) continue;
    if (seen.has(candidate.target)) continue;
    const channel = Number(candidate.channel);
    const controller = Number(candidate.controller);
    if (!Number.isInteger(channel) || channel < 0 || channel > 15) continue;
    if (!Number.isInteger(controller) || controller < 0 || controller > MIDI_VALUE_MAX) continue;
    seen.add(candidate.target);
    const binding: PersistedMidiCcBinding = { target: candidate.target, channel, controller };
    if (candidate.trackScoped === true) binding.trackScoped = true;
    out.push(binding);
  }
  return out;
}
