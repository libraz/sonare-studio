import { describe, expect, it } from 'vitest';
import { filterPresets } from '@/ui/devices/preset-filter';

const CATALOG = ['sine', 'saw-lead', 'square-lead', 'e-piano', 'warm-pad', 'sub-bass', 'pluck'];

describe('filterPresets', () => {
  it('returns every name for a blank query', () => {
    expect(filterPresets(CATALOG, '')).toEqual(CATALOG);
    expect(filterPresets(CATALOG, '   ')).toEqual(CATALOG);
  });

  it('matches case-insensitive substrings', () => {
    expect(filterPresets(CATALOG, 'LEAD')).toEqual(['saw-lead', 'square-lead']);
    expect(filterPresets(CATALOG, 'piano')).toEqual(['e-piano']);
  });

  it('ranks prefix matches before substring matches', () => {
    expect(filterPresets(CATALOG, 'su')).toEqual(['sub-bass']);
    expect(filterPresets(CATALOG, 'p')).toEqual([
      'pluck', // prefix match ranks first despite later catalog position
      'e-piano',
      'warm-pad',
    ]);
  });

  it('keeps catalog order within each rank group', () => {
    expect(filterPresets(CATALOG, 'a')).toEqual([
      'saw-lead',
      'square-lead',
      'e-piano',
      'warm-pad',
      'sub-bass',
    ]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterPresets(CATALOG, 'guitar')).toEqual([]);
  });

  it('trims surrounding whitespace from the query', () => {
    expect(filterPresets(CATALOG, '  pluck  ')).toEqual(['pluck']);
  });
});
