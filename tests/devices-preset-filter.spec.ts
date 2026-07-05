import { describe, expect, it } from 'vitest';
import { filterPresets, groupPresets, presetCategory } from '@/ui/devices/preset-filter';

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

  it('classifies and groups instrument-oriented presets', () => {
    expect(presetCategory('electric-guitar')).toBe('guitars');
    expect(presetCategory('Harpsichord')).toBe('keys');
    expect(presetCategory('bass-picked')).toBe('basses');
    expect(presetCategory('Bassoon')).toBe('winds');
    expect(presetCategory('english-horn')).toBe('winds');
    expect(presetCategory('french-horn')).toBe('orchestral');
    expect(presetCategory('church-organ')).toBe('organs');
    expect(
      groupPresets(
        ['electric-guitar', 'Harpsichord', 'bass-picked', 'Bassoon', 'english-horn', 'saw-lead'],
        '',
      ),
    ).toEqual([
      { category: 'keys', presets: ['Harpsichord'] },
      { category: 'guitars', presets: ['electric-guitar'] },
      { category: 'basses', presets: ['bass-picked'] },
      { category: 'winds', presets: ['Bassoon', 'english-horn'] },
      { category: 'synths', presets: ['saw-lead'] },
    ]);
  });
});
