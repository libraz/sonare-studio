import { describe, expect, it } from 'vitest';
import { isSwitchOn, MIDI_SWITCH_ON_THRESHOLD } from '@/lib/midi';

describe('isSwitchOn', () => {
  it('reads values at or above the threshold as on', () => {
    expect(isSwitchOn(MIDI_SWITCH_ON_THRESHOLD - 1)).toBe(false);
    expect(isSwitchOn(MIDI_SWITCH_ON_THRESHOLD)).toBe(true);
    expect(isSwitchOn(127)).toBe(true);
    expect(isSwitchOn(0)).toBe(false);
  });
});
