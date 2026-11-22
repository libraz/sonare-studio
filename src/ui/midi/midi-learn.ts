/**
 * Pure helpers for app-level MIDI CC "learn": mapping 7-bit controller values
 * to the mixer parameters they drive. The binding shape and target-id grammar
 * live in src/project/midi-learn-targets.ts and are re-exported here.
 * Canvas-free and side-effect-free.
 *
 * MIDI learn is implemented in the app layer, not the engine: the library's
 * `RealtimeEngine.bindMidiCc` binds onto a detached realtime engine that is not
 * in the audible AudioWorklet path (see the note in App.vue), so binding there
 * would move nothing the user hears. Instead, incoming CC is mapped here and
 * applied through the real mixer commands (`setStripGain` / `setStripPan`),
 * which are mirrored to the engine faders in realtime — genuinely audible.
 */

import { clamp, clampInt, isFiniteNumber } from '@/lib/math';
import { MIDI_VALUE_MAX, type MidiCcBinding } from '@/project/midi-learn-targets';

export * from '@/project/midi-learn-targets';

/** A control-change message decoded from a Web MIDI input. */
export interface MidiCcMessage {
  /** MIDI channel (0-15). */
  channel: number;
  /** Controller number (0-127). */
  controller: number;
  /** Controller value (0-127). */
  value: number;
  /** Combined 14-bit controller value (0-16383), when an MSB/LSB pair is available. */
  value14?: number;
  /** Binding family. Omitted means a legacy CC binding. */
  kind?: 'cc' | 'rpn' | 'nrpn';
  /** RPN/NRPN parameter number (0-16383), when `kind` is not `cc`. */
  parameter?: number;
}

const MIDI_VALUE_CENTER = 64;

/**
 * Gain window a full CC sweep spans, in dB. The strip command accepts a much
 * wider range ([-96, +24]); this musical sub-window keeps a fader sweep useful
 * rather than spending most of the travel near silence.
 */
export const MIDI_FADER_MIN_DB = -60;
/** Top of the CC-mapped gain window, in dB. */
export const MIDI_FADER_MAX_DB = 6;

/** Clamps a raw CC value to an integer in [0, 127]. */
export function clampCcValue(value: number): number {
  return clampInt(value, 0, MIDI_VALUE_MAX, 0);
}

/** Maps a 7-bit or optional 14-bit CC message to the legacy 0..127 control range. */
export function midiCcMessageValue(message: Pick<MidiCcMessage, 'value' | 'value14'>): number {
  if (isFiniteNumber(message.value14)) {
    return clampCcValue((message.value14 / 16383) * MIDI_VALUE_MAX);
  }
  return clampCcValue(message.value);
}

/** Maps a CC value (0-127) to gain in dB across the MIDI fader window. */
export function ccToGainDb(value: number): number {
  const t = clampCcValue(value) / MIDI_VALUE_MAX;
  return MIDI_FADER_MIN_DB + t * (MIDI_FADER_MAX_DB - MIDI_FADER_MIN_DB);
}

/**
 * Like {@link ccToGainDb} but without the 7-bit rounding, for a surface whose
 * fader is 14-bit. Integer inputs give exactly the same result, so a learned
 * controller and a native surface land on the same dB for the same step.
 */
export function ccToGainDbFine(value: number): number {
  const t = clamp(Number.isFinite(value) ? value : 0, 0, MIDI_VALUE_MAX) / MIDI_VALUE_MAX;
  return MIDI_FADER_MIN_DB + t * (MIDI_FADER_MAX_DB - MIDI_FADER_MIN_DB);
}

/** Like {@link ccToPan} but without the 7-bit rounding. */
export function ccToPanFine(value: number): number {
  const raw = clamp(Number.isFinite(value) ? value : 0, 0, MIDI_VALUE_MAX);
  return clamp((raw - MIDI_VALUE_CENTER) / (MIDI_VALUE_MAX - MIDI_VALUE_CENTER), -1, 1);
}

/**
 * Maps gain in dB to a normalized 0..1 fader position. Exactly inverts
 * {@link ccToGainDbFine} scaled by 127, so echoing a surface's own fader move
 * back to it lands on the position it already holds instead of nudging the
 * motor by a quantization step.
 */
export function gainDbToFaderPosition(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 0;
  return clamp((gainDb - MIDI_FADER_MIN_DB) / (MIDI_FADER_MAX_DB - MIDI_FADER_MIN_DB), 0, 1);
}

/** Maps a pan position in [-1, 1] to a normalized 0..1 encoder-ring position. */
export function panToRingPosition(pan: number): number {
  if (!Number.isFinite(pan)) return 0.5;
  return (clamp(pan, -1, 1) + 1) / 2;
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

/** Maps a CC value (0-127) linearly into the inclusive range [min, max]. */
export function ccToRange(value: number, min: number, max: number): number {
  const t = clampCcValue(value) / MIDI_VALUE_MAX;
  return min + t * (max - min);
}

/** Maps a CC value logarithmically into a positive range. */
export function ccToLogRange(value: number, min: number, max: number): number {
  if (min <= 0 || max <= 0 || min === max) return ccToRange(value, min, max);
  const t = clampCcValue(value) / MIDI_VALUE_MAX;
  return min * (max / min) ** t;
}

/** Formats a binding for display, e.g. "CC 7 · Ch 1". */
export function formatMidiCcBinding(binding: MidiCcBinding): string {
  if (binding.kind === 'rpn' || binding.kind === 'nrpn') {
    const label = binding.kind.toUpperCase();
    return `${label} ${binding.parameter ?? binding.controller} · Ch ${binding.channel + 1}`;
  }
  return `CC ${binding.controller} · Ch ${binding.channel + 1}`;
}

/** True when an incoming MIDI learn message matches a stored binding. */
export function midiCcBindingMatches(
  binding: MidiCcBinding,
  message: Pick<MidiCcMessage, 'channel' | 'controller' | 'kind' | 'parameter'>,
): boolean {
  const bindingKind = binding.kind ?? 'cc';
  const messageKind = message.kind ?? 'cc';
  if (binding.channel !== message.channel || bindingKind !== messageKind) return false;
  if (bindingKind === 'rpn' || bindingKind === 'nrpn') {
    return binding.parameter === message.parameter;
  }
  return binding.controller === message.controller;
}
