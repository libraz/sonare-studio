import { describe, expect, it } from 'vitest';
import { SMUFL_TEXT_GLYPHS } from '@/notation/smufl-text-glyphs';
import { harvestSmuflTextGlyphs } from '../scripts/smufl-text-glyphs.mjs';

describe('SMuFL text glyph outlines', () => {
  it('match the outlines the installed Verovio draws; rerun scripts/smufl-text-glyphs.mjs when they drift', async () => {
    expect(SMUFL_TEXT_GLYPHS).toEqual(await harvestSmuflTextGlyphs());
  }, 60000);

  it('cover every glyph the engraver writes as text for tempo marks, chord symbols and elisions', () => {
    for (const codePoint of [
      0xeca0, 0xeca2, 0xeca3, 0xeca5, 0xeca7, 0xeca9, 0xecab, 0xecad, 0xecb7, 0xea64, 0xea65,
      0xea66, 0xe551,
    ]) {
      expect(SMUFL_TEXT_GLYPHS.has(codePoint), codePoint.toString(16)).toBe(true);
    }
  });
});
