import { describe, expect, it } from 'vitest';
import { GM2_DRUM_BANK, isGm2DrumBank } from '@/project/instrument';

describe('isGm2DrumBank', () => {
  it('matches every bank under MSB 120 and nothing else', () => {
    expect(isGm2DrumBank(GM2_DRUM_BANK)).toBe(true);
    expect(isGm2DrumBank(GM2_DRUM_BANK | 0x7f)).toBe(true);
    expect(isGm2DrumBank(GM2_DRUM_BANK - 1)).toBe(false);
    expect(isGm2DrumBank(GM2_DRUM_BANK + 128)).toBe(false);
    expect(isGm2DrumBank(undefined)).toBe(false);
  });
});
