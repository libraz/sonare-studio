import { describe, expect, it } from 'vitest';
import {
  melodyPitchClassesInRegion,
  modalInterchangeFor,
  negativeHarmonyFor,
  reharmCandidatesFor,
  substitutionsFor,
} from '@/compose/reharm';
import type { EditorChordSymbol } from '@/project/chords';
import { MAJOR_MODE_MASK } from '@/project/types';

const C_MAJOR = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

function chord(partial: Partial<EditorChordSymbol>): EditorChordSymbol {
  return { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, ...partial };
}

describe('substitutionsFor', () => {
  it('offers the tritone substitution for a dominant chord', () => {
    // G7 in C major -> includes the tritone sub Db7 (rootPc 1, dom7 = ordinal 4).
    const g7 = chord({ rootPc: 7, quality: 4 });
    const candidates = substitutionsFor(g7, C_MAJOR);
    expect(candidates.length).toBeGreaterThan(0);
    const tritone = candidates.find((c) => c.kind === 'tritone');
    expect(tritone).toBeDefined();
    expect(tritone?.symbol.rootPc).toBe(1);
    expect(tritone?.symbol.quality).toBe(4);
    // Candidates keep the source region.
    for (const candidate of candidates) {
      expect(candidate.symbol.startPpq).toBe(0);
      expect(candidate.symbol.endPpq).toBe(4);
      expect(candidate.roman.length).toBeGreaterThan(0);
    }
  });

  it('narrows candidates to those preserving the melody pitch classes', () => {
    const g7 = chord({ rootPc: 7, quality: 4 });
    const all = substitutionsFor(g7, C_MAJOR);
    // Constrain to candidates that keep B (pc 11), the third of G7.
    const constrained = substitutionsFor(g7, C_MAJOR, [11]);
    expect(constrained.length).toBeLessThanOrEqual(all.length);
  });
});

describe('melodyPitchClassesInRegion', () => {
  const note = (pitch: number, startPpq: number, durationPpq: number) => ({
    pitch,
    startPpq,
    durationPpq,
  });

  it('takes the top voice at each onset within the region', () => {
    // Two onsets: at 0 (C3 48 vs E4 64 -> top E) and at 2 (G4 67).
    const notes = [note(48, 0, 2), note(64, 0, 2), note(67, 2, 2)];
    expect(melodyPitchClassesInRegion(notes, 0, 4)).toEqual([4, 7]);
  });

  it('includes a note sustained from before the region', () => {
    // A melody note beginning before the chord but still sounding into it.
    expect(melodyPitchClassesInRegion([note(60, -2, 4)], 0, 4)).toEqual([0]);
  });

  it('excludes notes that end at or before the region and start at or after it', () => {
    const notes = [note(62, -4, 4), note(65, 4, 2)];
    expect(melodyPitchClassesInRegion(notes, 0, 4)).toEqual([]);
  });

  it('folds octaves into distinct pitch classes', () => {
    const notes = [note(60, 0, 1), note(72, 1, 1)];
    expect(melodyPitchClassesInRegion(notes, 0, 4)).toEqual([0]);
  });
});

describe('modalInterchangeFor', () => {
  it('lists borrowed chords over the given region', () => {
    const palette = modalInterchangeFor(C_MAJOR, { startPpq: 8, endPpq: 12 });
    expect(palette.length).toBeGreaterThan(0);
    for (const candidate of palette) {
      expect(candidate.kind).toBe('borrowed');
      expect(candidate.symbol.startPpq).toBe(8);
      expect(candidate.symbol.endPpq).toBe(12);
      expect(candidate.symbol.rootPc).toBeGreaterThanOrEqual(0);
      expect(candidate.symbol.rootPc).toBeLessThanOrEqual(11);
    }
  });
});

describe('reharmCandidatesFor', () => {
  it('combines substitutions with the negative-harmony reflection', () => {
    const g7 = chord({ rootPc: 7, quality: 4 });
    const candidates = reharmCandidatesFor(g7, C_MAJOR);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.kind === 'negative')).toBe(true);
    // Every candidate keeps the source region and differs from the source chord.
    for (const candidate of candidates) {
      expect(candidate.symbol.startPpq).toBe(0);
      expect(candidate.symbol.endPpq).toBe(4);
      const sameAsSource =
        candidate.symbol.rootPc === g7.rootPc && candidate.symbol.quality === g7.quality;
      expect(sameAsSource).toBe(false);
    }
  });

  it('drops duplicate chords produced by different relationships', () => {
    const g7 = chord({ rootPc: 7, quality: 4 });
    const candidates = reharmCandidatesFor(g7, C_MAJOR);
    const keys = candidates.map(
      (c) => `${c.symbol.rootPc}:${c.symbol.quality}:${c.symbol.bassPc ?? -1}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('negativeHarmonyFor', () => {
  it('reflects a chord across the key axis', () => {
    // G major reflected across C's axis => F minor (rootPc 5, min = ordinal 1).
    const g = chord({ rootPc: 7, quality: 0 });
    const mirror = negativeHarmonyFor(g, C_MAJOR);
    expect(mirror.kind).toBe('negative');
    expect(mirror.symbol.rootPc).toBe(5);
    expect(mirror.symbol.quality).toBe(1);
  });
});
