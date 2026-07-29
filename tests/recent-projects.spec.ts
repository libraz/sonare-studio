import { afterEach, describe, expect, it } from 'vitest';
import {
  loadRecentProjects,
  MAX_RECENT_PROJECTS,
  parseRecent,
  RECENT_PROJECTS_STORAGE_KEY,
  saveRecentProjects,
  withoutRecent,
  withRecent,
} from '@/ui/shell/recent-projects';

describe('withRecent', () => {
  it('moves a name to the front and de-duplicates', () => {
    expect(withRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(withRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('ignores blank names and trims', () => {
    expect(withRecent(['a'], '   ')).toEqual(['a']);
    expect(withRecent(['a'], '  b  ')).toEqual(['b', 'a']);
  });

  it('caps the list at the maximum', () => {
    const many = Array.from({ length: MAX_RECENT_PROJECTS + 3 }, (_, i) => `p${i}`);
    const result = withRecent(many, 'fresh');
    expect(result).toHaveLength(MAX_RECENT_PROJECTS);
    expect(result[0]).toBe('fresh');
  });
});

describe('withoutRecent', () => {
  it('drops the named entry', () => {
    expect(withoutRecent(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(withoutRecent(['a'], 'missing')).toEqual(['a']);
  });
});

describe('parseRecent', () => {
  it('keeps only non-empty unique strings, capped', () => {
    expect(parseRecent(['a', ' a ', '', ' ', '.', '..', 2, 'b', null])).toEqual(['a', 'b']);
    expect(parseRecent('nope')).toEqual([]);
    expect(parseRecent(Array.from({ length: 20 }, (_, i) => `p${i}`))).toHaveLength(
      MAX_RECENT_PROJECTS,
    );
  });
});

describe('load/save round-trip', () => {
  afterEach(() => {
    window.localStorage.removeItem(RECENT_PROJECTS_STORAGE_KEY);
  });

  it('persists and reloads the list', () => {
    saveRecentProjects(['x', 'y']);
    expect(loadRecentProjects()).toEqual(['x', 'y']);
  });

  it('returns an empty list when nothing is stored', () => {
    expect(loadRecentProjects()).toEqual([]);
  });

  it('recovers from malformed storage', () => {
    window.localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, '{not json');
    expect(loadRecentProjects()).toEqual([]);
  });
});
