import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorNote, EditorTrack } from '@/project/types';

const wasm = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/project/store', () => ({
  getWasmModule: () => {
    if (wasm.current === null) throw new Error('not ready');
    return wasm.current;
  },
}));

import {
  gm2DrumSetName,
  gm2ProgramName,
  gmCatalog,
  gmFamilies,
  gmProgramName,
  trackIsDrums,
} from '@/ui/devices/gm-catalog';

function trackNamed(name: string, extra: Partial<EditorTrack> = {}): EditorTrack {
  return { id: 1, name, kind: 'midi', ...extra } as unknown as EditorTrack;
}

describe('trackIsDrums', () => {
  it('skips gathering notes when a track-level check already decides', () => {
    const notes = vi.fn(() => []);
    expect(trackIsDrums(trackNamed('Drums'), notes)).toBe(true);
    expect(trackIsDrums(trackNamed('Keys', { percussion: true }), notes)).toBe(true);
    expect(notes).not.toHaveBeenCalled();
  });

  it('falls back to the notes for an unnamed track', () => {
    const onKit = [{ channel: 9 }, { channel: 9 }] as unknown as EditorNote[];
    expect(trackIsDrums(trackNamed('Keys'), () => onKit)).toBe(true);
    expect(trackIsDrums(trackNamed('Keys'), () => [])).toBe(false);
    expect(trackIsDrums(null, () => onKit)).toBe(false);
  });
});

describe('gm-catalog', () => {
  beforeEach(() => {
    wasm.current = null;
  });

  it('yields no names before the module is ready', () => {
    expect(gmCatalog()).toBeNull();
    expect(gmProgramName(0)).toBeNull();
    expect(gm2ProgramName(8, 0)).toBeNull();
    expect(gm2DrumSetName(0)).toBeNull();
    expect(gmFamilies()).toEqual([]);
  });

  it('reads names through the module and masks the bank to its LSB', () => {
    const gm2InstrumentName = vi.fn((bank: number, program: number) => `v${bank}:${program}`);
    wasm.current = {
      Project: {
        gmInstrumentName: (program: number) => `gm${program}`,
        gm2InstrumentName,
        gm2DrumSetName: (lsb: number) => `kit${lsb}`,
      },
    };
    expect(gmProgramName(5)).toBe('gm5');
    expect(gm2ProgramName((121 << 7) | 8, 3)).toBe('v8:3');
    expect(gm2DrumSetName(2)).toBe('kit2');
  });

  it('lists 16 families only when the module exposes both family helpers', () => {
    wasm.current = { Project: { gmFamilyName: () => 'Piano' } };
    expect(gmFamilies()).toEqual([]);
    wasm.current = {
      Project: {
        gmFamilyName: (family: number) => (family === 1 ? null : `F${family}`),
        gmFamilyFirstProgram: (family: number) => family * 8,
      },
    };
    const families = gmFamilies();
    expect(families).toHaveLength(16);
    expect(families[0]).toEqual({ index: 0, name: 'F0', firstProgram: 0 });
    expect(families[1].name).toBe('Family 2');
  });
});
