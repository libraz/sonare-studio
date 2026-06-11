import { describe, expect, it } from 'vitest';
import {
  clampSectionEdge,
  MIN_SECTION_LENGTH_PPQ,
  newSectionSpan,
  type SectionSpan,
  sectionIndexAt,
} from '@/ui/arrangement/sections';

const span = (startPpq: number, endPpq: number): SectionSpan => ({ startPpq, endPpq });

describe('sectionIndexAt', () => {
  const sections = [span(0, 8), span(16, 24)];

  it('finds the section containing a position', () => {
    expect(sectionIndexAt(sections, 0)).toBe(0);
    expect(sectionIndexAt(sections, 7.9)).toBe(0);
    expect(sectionIndexAt(sections, 20)).toBe(1);
  });

  it('treats the end as exclusive and gaps as misses', () => {
    expect(sectionIndexAt(sections, 8)).toBe(-1);
    expect(sectionIndexAt(sections, 12)).toBe(-1);
    expect(sectionIndexAt([], 0)).toBe(-1);
  });
});

describe('newSectionSpan', () => {
  it('spans from the containing bar to the next section', () => {
    const sections = [span(0, 8), span(16, 24)];
    expect(newSectionSpan(sections, 10, 8, 16)).toEqual({ startPpq: 8, endPpq: 16 });
  });

  it('uses the default length when no section follows', () => {
    const sections = [span(0, 8)];
    expect(newSectionSpan(sections, 13, 12, 16)).toEqual({ startPpq: 12, endPpq: 28 });
  });

  it('returns null inside an existing section', () => {
    const sections = [span(0, 8)];
    expect(newSectionSpan(sections, 4, 4, 16)).toBeNull();
  });

  it('clamps the bar-aligned start so it does not eat the previous section', () => {
    // The previous section ends mid-bar at 10; the bar containing 11 starts at 8.
    const sections = [span(0, 10)];
    expect(newSectionSpan(sections, 11, 8, 16)).toEqual({ startPpq: 10, endPpq: 26 });
  });

  it('creates the first section on an empty timeline', () => {
    expect(newSectionSpan([], 5, 4, 16)).toEqual({ startPpq: 4, endPpq: 20 });
  });

  it('returns null for negative positions and empty derived spans', () => {
    expect(newSectionSpan([], -1, 0, 16)).toBeNull();
    expect(newSectionSpan([span(0, 8)], 8, 8, 0)).toBeNull();
  });
});

describe('clampSectionEdge', () => {
  const sections = [span(0, 8), span(8, 16), span(20, 28)];

  it('clamps the start edge between the previous section and the minimum length', () => {
    expect(clampSectionEdge(sections, 1, 'start', 4)).toBe(8);
    expect(clampSectionEdge(sections, 1, 'start', 10)).toBe(10);
    expect(clampSectionEdge(sections, 1, 'start', 15.9)).toBe(16 - MIN_SECTION_LENGTH_PPQ);
  });

  it('clamps the first section start to PPQ zero', () => {
    expect(clampSectionEdge(sections, 0, 'start', -4)).toBe(0);
  });

  it('clamps the end edge between the minimum length and the next section', () => {
    expect(clampSectionEdge(sections, 1, 'end', 30)).toBe(20);
    expect(clampSectionEdge(sections, 1, 'end', 18)).toBe(18);
    expect(clampSectionEdge(sections, 1, 'end', 8)).toBe(8 + MIN_SECTION_LENGTH_PPQ);
  });

  it('lets the last section end grow freely', () => {
    expect(clampSectionEdge(sections, 2, 'end', 100)).toBe(100);
  });

  it('falls back to a non-negative position for unknown indices', () => {
    expect(clampSectionEdge(sections, 9, 'end', -5)).toBe(0);
    expect(clampSectionEdge(sections, 9, 'end', 5)).toBe(5);
  });
});
