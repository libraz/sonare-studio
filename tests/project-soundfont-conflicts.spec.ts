import { describe, expect, it } from 'vitest';
import {
  collectActiveSoundFontUsage,
  hasSoundFontSlotConflict,
  type SoundFontUsageTrack,
} from '@/project/soundfont-conflicts';

function track(overrides: Partial<SoundFontUsageTrack> = {}): SoundFontUsageTrack {
  return {
    id: 1,
    kind: 'midi',
    instrument: { kind: 'sf2', fontId: 'font-a' },
    ...overrides,
  };
}

describe('soundfont-conflicts', () => {
  it('collects active distinct SF2 fonts and marks the last track as the winner', () => {
    const usage = collectActiveSoundFontUsage([
      track({ id: 1, instrument: { kind: 'sf2', fontId: 'font-a' } }),
      track({ id: 2, instrument: { kind: 'synth-preset', preset: 'e-piano' } }),
      track({ id: 3, instrument: { kind: 'sf2', fontId: 'font-b' } }),
    ]);

    expect(usage).toEqual({ fontIds: ['font-a', 'font-b'], winningFontId: 'font-b' });
    expect(hasSoundFontSlotConflict(usage)).toBe(true);
  });

  it('ignores frozen and non-MIDI tracks when checking the global SF2 slot', () => {
    const usage = collectActiveSoundFontUsage([
      track({ id: 1, instrument: { kind: 'sf2', fontId: 'font-a' } }),
      track({
        id: 2,
        frozen: { assetId: 'frozen-bounce' },
        instrument: { kind: 'sf2', fontId: 'font-b' },
      }),
      track({ id: 3, kind: 'audio', instrument: { kind: 'sf2', fontId: 'font-c' } }),
    ]);

    expect(usage).toEqual({ fontIds: ['font-a'], winningFontId: 'font-a' });
    expect(hasSoundFontSlotConflict(usage)).toBe(false);
  });
});
