import { describe, expect, it } from 'vitest';
import {
  categoryLabel,
  FALLBACK_INSERT_CATALOG,
  groupInsertCatalog,
  humanizeInsertName,
  loadInsertCatalog,
} from '@/ui/mixer/insert-catalog';

describe('humanizeInsertName', () => {
  it('drops the category and splits camelCase', () => {
    expect(humanizeInsertName('dynamics.brickwallLimiter')).toBe('Brickwall Limiter');
    expect(humanizeInsertName('dynamics.compressor')).toBe('Compressor');
    expect(humanizeInsertName('maximizer.truePeakLimiter')).toBe('True Peak Limiter');
    expect(humanizeInsertName('effects.reverb.plate')).toBe('Reverb Plate');
  });

  it('handles ids without a category prefix', () => {
    expect(humanizeInsertName('softClipper')).toBe('Soft Clipper');
  });
});

describe('categoryLabel', () => {
  it('labels known categories', () => {
    expect(categoryLabel('dynamics')).toBe('Dynamics');
    expect(categoryLabel('eq')).toBe('EQ');
  });

  it('capitalizes unknown categories', () => {
    expect(categoryLabel('custom')).toBe('Custom');
  });
});

describe('groupInsertCatalog', () => {
  it('groups by category prefix in menu order', () => {
    const groups = groupInsertCatalog([
      'stereo.imager',
      'dynamics.compressor',
      'eq.parametric',
      'dynamics.gate',
    ]);
    expect(groups.map((group) => group.category)).toEqual(['dynamics', 'eq', 'stereo']);
    expect(groups[0].processors.map((p) => p.id)).toEqual(['dynamics.compressor', 'dynamics.gate']);
  });

  it('keeps a real multi-segment processor id under its top-level category', () => {
    const groups = groupInsertCatalog(['effects.reverb.plate']);
    expect(groups).toEqual([
      {
        category: 'effects',
        label: 'Effects',
        processors: [{ id: 'effects.reverb.plate', label: 'Reverb Plate' }],
      },
    ]);
  });

  it('keeps processor input order within a group', () => {
    const groups = groupInsertCatalog(['saturation.tube', 'saturation.tape']);
    expect(groups[0].processors.map((p) => p.id)).toEqual(['saturation.tube', 'saturation.tape']);
  });

  it('sorts unknown categories after known ones, alphabetically', () => {
    const groups = groupInsertCatalog(['zeta.thing', 'alpha.thing', 'dynamics.compressor']);
    expect(groups.map((group) => group.category)).toEqual(['dynamics', 'alpha', 'zeta']);
  });

  it('labels groups and processors', () => {
    const groups = groupInsertCatalog(['dynamics.transientShaper']);
    expect(groups[0].label).toBe('Dynamics');
    expect(groups[0].processors[0].label).toBe('Transient Shaper');
  });

  it('puts prefix-free ids into an "other" group', () => {
    const groups = groupInsertCatalog(['mystery']);
    expect(groups[0].category).toBe('other');
    expect(groups[0].processors[0].label).toBe('Mystery');
  });

  it('returns no groups for an empty catalog', () => {
    expect(groupInsertCatalog([])).toEqual([]);
  });
});

describe('loadInsertCatalog', () => {
  it('returns an empty realtime catalog when the wasm module is unavailable', () => {
    // The project store is not initialized in this spec, so getWasmModule throws.
    expect(loadInsertCatalog()).toEqual([]);
  });

  it('retains the curated fallback for offline catalogs when the wasm module is unavailable', () => {
    expect(loadInsertCatalog('offline')).toEqual([...FALLBACK_INSERT_CATALOG]);
  });

  it('curated fallback entries are well-formed category.name ids', () => {
    expect(FALLBACK_INSERT_CATALOG.length).toBeGreaterThan(0);
    for (const id of FALLBACK_INSERT_CATALOG) {
      expect(id).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    }
  });
});
