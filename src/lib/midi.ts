/** Controller value at or above which a MIDI switch (sustain-style on/off CC) reads as on. */
export const MIDI_SWITCH_ON_THRESHOLD = 64;

/** Whether a 7-bit controller value reads as "on" for a switch control. */
export function isSwitchOn(value: number): boolean {
  return value >= MIDI_SWITCH_ON_THRESHOLD;
}
