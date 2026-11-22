import { BORROWED_DEGREES, chordPitchClasses, type ProgressionPreset } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { editorChordToChord } from '@/compose/chord-io';
import { presetNotation } from '@/compose/preset-notation';
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

  /**
   * A figure is recognized from the notes framing it, so the line is read whole
   * and then cut to the region. The melody here runs on past the chord, as a
   * melody does: E-F-G-A-B, where F and A step through on weak beats between
   * the notes that carry the line.
   */
  it('drops weak passing tones rather than constraining the harmony to them', () => {
    const notes = [note(64, 0, 1), note(65, 1, 1), note(67, 2, 1), note(69, 3, 1), note(71, 4, 4)];
    expect(melodyPitchClassesInRegion(notes, 0, 4)).toEqual([4, 7]);
  });

  // A chord region that holds nothing but ornament still has to constrain
  // something, so the note the ear holds longest stands in.
  it('falls back to the longest note when the region is all ornament', () => {
    const notes = [note(60, 0, 4), note(62, 4, 3), note(63, 7, 1), note(64, 8, 4)];
    expect(melodyPitchClassesInRegion(notes, 4, 8)).toEqual([2]);
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
  it('combines substitutions, modal interchange and negative harmony', () => {
    const g7 = chord({ rootPc: 7, quality: 4 });
    const candidates = reharmCandidatesFor(g7, C_MAJOR);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.kind === 'negative')).toBe(true);
    expect(candidates.some((c) => c.kind === 'borrowed')).toBe(true);
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

  it('filters every palette, including negative harmony, to melody chord tones', () => {
    // G major mirrors to F minor, which does not contain B. The prior
    // implementation leaked that negative candidate despite melodyPcs.
    const g = chord({ rootPc: 7, quality: 0 });
    const candidates = reharmCandidatesFor(g, C_MAJOR, [11]);
    expect(candidates.some((candidate) => candidate.kind === 'negative')).toBe(false);
    for (const candidate of candidates) {
      expect(chordPitchClasses(editorChordToChord(candidate.symbol))).toContain(11);
    }
  });

  it('keeps a usable palette when weak passing tones surround structural chord tones', () => {
    const c = chord({ rootPc: 0, quality: 0 });
    // This is the structural subset of the E–F–G–A phrase above. Passing F/A
    // must not require every substitute to contain four pitch classes.
    expect(reharmCandidatesFor(c, C_MAJOR, [4, 7]).length).toBeGreaterThan(0);
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

describe('presetNotation', () => {
  it('uses the borrowed bIII notation for a custom preset degree', () => {
    const preset: ProgressionPreset = {
      id: 'custom-bIII',
      name: 'Custom bIII',
      degrees: [BORROWED_DEGREES.bIII],
      functional: 'loop',
      styles: ['minimal'],
    };
    expect(presetNotation(preset, 'minimal', C_MAJOR)).toBe('♭III (E♭)');
  });

  it('uses borrowed Roman numerals and flat spellings for Neapolitan presets', () => {
    const preset: ProgressionPreset = {
      id: 'neapolitanPop',
      name: 'Neapolitan Pop',
      // Diatonic degrees are 1-based; 12 and 13 are borrowed-chord codes.
      degrees: [6, 12, 13, 5, 1],
      functional: 'cadenceStrong',
      styles: ['minimal'],
    };
    expect(presetNotation(preset, 'minimal', C_MAJOR)).toBe('vi–iv–♭II–V–I (Am–Fm–D♭–G–C)');
  });

  it('uses the KeyScale signature for preset chord names in E major', () => {
    const preset: ProgressionPreset = {
      id: 'fourChordPop',
      name: 'Four Chord Pop',
      degrees: [1, 5, 6, 4],
      functional: 'loop',
      styles: ['minimal'],
    };
    const eMajor = { rootPc: 4, modeMask12: MAJOR_MODE_MASK };
    expect(presetNotation(preset, 'minimal', eMajor)).toBe('I–V–vi–IV (E–B–C#m–A)');
  });
});
