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

/** Formats a binding for display, e.g. "CC 7 · Ch 1". */
export function formatMidiCcBinding(binding: MidiCcBinding): string {
  return `CC ${binding.controller} · Ch ${binding.channel + 1}`;
}
