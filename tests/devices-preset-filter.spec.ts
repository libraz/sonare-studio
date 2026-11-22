import { describe, expect, it } from 'vitest';
import { filterPresets, groupPresets, presetCategory } from '@/ui/devices/preset-filter';

const CATALOG = ['sine', 'sawLead', 'squareLead', 'ePiano', 'warmPad', 'subBass', 'pluck'];

describe('filterPresets', () => {
  it('returns every name for a blank query', () => {
    expect(filterPresets(CATALOG, '')).toEqual(CATALOG);
    expect(filterPresets(CATALOG, '   ')).toEqual(CATALOG);
  });

  it('matches case-insensitive substrings', () => {
    expect(filterPresets(CATALOG, 'LEAD')).toEqual(['sawLead', 'squareLead']);
    expect(filterPresets(CATALOG, 'piano')).toEqual(['ePiano']);
  });

  it('ranks prefix matches before substring matches', () => {
    expect(filterPresets(CATALOG, 'su')).toEqual(['subBass']);
    expect(filterPresets(CATALOG, 'p')).toEqual([
      'pluck', // prefix match ranks first despite later catalog position
      'ePiano',
      'warmPad',
    ]);
  });

  it('keeps catalog order within each rank group', () => {
    expect(filterPresets(CATALOG, 'a')).toEqual([
      'sawLead',
      'squareLead',
      'ePiano',
      'warmPad',
      'subBass',
    ]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterPresets(CATALOG, 'guitar')).toEqual([]);
  });

  it('trims surrounding whitespace from the query', () => {
    expect(filterPresets(CATALOG, '  pluck  ')).toEqual(['pluck']);
  });

  it('classifies and groups instrument-oriented presets', () => {
    expect(presetCategory('electricGuitar')).toBe('guitars');
    expect(presetCategory('Harpsichord')).toBe('keys');
    expect(presetCategory('bassPicked')).toBe('basses');
    expect(presetCategory('Bassoon')).toBe('winds');
    expect(presetCategory('englishHorn')).toBe('winds');
    expect(presetCategory('frenchHorn')).toBe('orchestral');
    expect(presetCategory('churchOrgan')).toBe('organs');
    expect(
      groupPresets(
        ['electricGuitar', 'Harpsichord', 'bassPicked', 'Bassoon', 'englishHorn', 'sawLead'],
        '',
      ),
    ).toEqual([
      { category: 'keys', presets: ['Harpsichord'] },
      { category: 'guitars', presets: ['electricGuitar'] },
      { category: 'basses', presets: ['bassPicked'] },
      { category: 'winds', presets: ['Bassoon', 'englishHorn'] },
      { category: 'synths', presets: ['sawLead'] },
    ]);
  });
});
