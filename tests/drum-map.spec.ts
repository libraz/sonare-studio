import { DRUM_NOTES, type DrumsOptions, generateDrums } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import {
  drumNoteName,
  GM2_DRUM_BANK_MSB,
  gm2DrumBank,
  gm2DrumKitName,
  gmDrumName,
} from '@/ui/step-sequencer/drum-map';

describe('gm2DrumBank', () => {
  it('encodes bank MSB 120 with the kit in the LSB', () => {
    expect(gm2DrumBank(0)).toBe(GM2_DRUM_BANK_MSB << 7);
    expect(gm2DrumBank(1)).toBe((GM2_DRUM_BANK_MSB << 7) | 1);
    expect(gm2DrumBank(8)).toBe((GM2_DRUM_BANK_MSB << 7) | 8);
  });

  it('masks the kit index to 7 bits', () => {
    expect(gm2DrumBank(200)).toBe((GM2_DRUM_BANK_MSB << 7) | (200 & 0x7f));
  });
});

describe('gm2DrumKitName', () => {
  const source = {
    gm2DrumSetName: (lsb: number) => (lsb === 8 ? 'Room' : lsb === 0 ? 'Standard' : null),
  };

  it('returns the wasm kit name when available', () => {
    expect(gm2DrumKitName(0, source)).toBe('Standard');
    expect(gm2DrumKitName(8, source)).toBe('Room');
  });

  it('returns null for an unnamed kit or a missing source', () => {
    expect(gm2DrumKitName(3, source)).toBeNull();
    expect(gm2DrumKitName(0, undefined)).toBeNull();
    expect(gm2DrumKitName(0, {})).toBeNull();
  });
});

describe('drumNoteName', () => {
  const source = {
    gm2DrumName: (lsb: number, note: number) => (lsb === 8 && note === 38 ? 'Room Snare' : null),
  };

  it('prefers the kit-specific name when the kit provides one', () => {
    expect(drumNoteName(38, 8, source)).toBe('Room Snare');
  });

  it('falls back to the GM1 name when the kit has no override', () => {
    // Kit 8 has no override for pitch 36, so the GM1 name is used.
    expect(drumNoteName(36, 8, source)).toBe(gmDrumName(36));
  });

  it('uses the GM1 map when no kit or source is given', () => {
    expect(drumNoteName(38)).toBe(gmDrumName(38));
    expect(drumNoteName(38, 8)).toBe(gmDrumName(38));
  });

  it('returns null outside the GM percussion range with no kit name', () => {
    expect(drumNoteName(20, 8, source)).toBeNull();
  });
});

describe('coverage of the drum generator', () => {
  const STYLES: ReadonlyArray<DrumsOptions['style']> = [
    'standard',
    'funk',
    'shuffle',
    'bossa',
    'trap',
    'halftime',
    'breakbeat',
    'house',
    'synthpop',
  ];
  const SECTIONS: ReadonlyArray<DrumsOptions['section']> = [
    'intro',
    'verse',
    'prechorus',
    'chorus',
    'bridge',
    'outro',
  ];
  const ROLES: ReadonlyArray<DrumsOptions['role']> = ['full', 'ambient', 'minimal', 'fxOnly'];

  it('names every voice libcantus can emit', () => {
    for (const [voice, pitch] of Object.entries(DRUM_NOTES)) {
      expect(gmDrumName(pitch), `${voice} (${pitch})`).not.toBeNull();
    }
  });

  it('names every pitch a generation sweep produces', () => {
    const pitches = new Set<number>();
    for (const style of STYLES) {
      for (const section of SECTIONS) {
        for (const role of ROLES) {
          const hits = generateDrums({
            bars: 4,
            style,
            section,
            role,
            fills: true,
            ctx: { seed: 0, bpm: 120, complexity: { rhythmic: 0.6 } },
          });
          for (const hit of hits) pitches.add(hit.pitch);
        }
      }
    }
    // The sweep must reach the shaker, the one voice above the GM1 key range.
    expect(pitches.has(DRUM_NOTES.shaker)).toBe(true);
    const unnamed = [...pitches]
      .filter((pitch) => gmDrumName(pitch) === null)
      .sort((a, b) => a - b);
    expect(unnamed).toEqual([]);
  });
});
