import { afterEach, describe, expect, it, vi } from 'vitest';

const { getWasmModuleMock } = vi.hoisted(() => ({ getWasmModuleMock: vi.fn() }));
vi.mock('@/project/store', () => ({ getWasmModule: getWasmModuleMock }));

import {
  FALLBACK_INSERT_CATALOG,
  loadInsertCatalog,
  loadInsertCatalogEntries,
} from '@/ui/mixer/insert-catalog';

const REALTIME = ['dynamics.compressor', 'eq.parametric'];
const FULL = ['dynamics.compressor', 'eq.parametric', 'repair.dereverbClassical', 'eq.linearPhase'];
const STRUCTURED_REALTIME = [
  'dynamics.compressor',
  'modulation.chorus',
  'modulation.flanger',
  'modulation.rotary',
  'stereo.imager',
];

/** Structured catalog covering all three kinds plus a stereo-only entry. */
const CATALOG = [
  { id: 'dynamics.compressor', kind: 'realtime', realtimeInsertable: true, stereoOnly: false },
  { id: 'modulation.chorus', kind: 'realtime', realtimeInsertable: true, stereoOnly: false },
  { id: 'modulation.flanger', kind: 'realtime', realtimeInsertable: true, stereoOnly: false },
  { id: 'modulation.rotary', kind: 'realtime', realtimeInsertable: true, stereoOnly: true },
  { id: 'stereo.imager', kind: 'realtime', realtimeInsertable: true, stereoOnly: true },
  { id: 'repair.dereverbClassical', kind: 'offline', realtimeInsertable: false, stereoOnly: false },
  { id: 'match.applyMatchEq', kind: 'pair', realtimeInsertable: false, stereoOnly: false },
];

/** A core exposing the three catalog functions; an empty catalog selects the name catalogs. */
function core(lists: { catalog?: unknown[]; insert?: string[]; full?: string[] }) {
  return {
    masteringProcessorCatalog: () => lists.catalog ?? [],
    masteringInsertNames: () => lists.insert ?? [],
    masteringProcessorNames: () => lists.full ?? [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('loadInsertCatalog scope', () => {
  it('realtime scope returns the engine insert-safe subset', () => {
    getWasmModuleMock.mockReturnValue(core({ insert: REALTIME, full: FULL }));
    expect(loadInsertCatalog('realtime')).toEqual(REALTIME);
  });

  it('defaults to the realtime scope', () => {
    getWasmModuleMock.mockReturnValue(core({ insert: REALTIME, full: FULL }));
    expect(loadInsertCatalog()).toEqual(REALTIME);
  });

  it('offline scope returns the full processor set', () => {
    getWasmModuleMock.mockReturnValue(core({ insert: REALTIME, full: FULL }));
    expect(loadInsertCatalog('offline')).toEqual(FULL);
  });

  it('realtime scope returns empty when the wasm module is unavailable', () => {
    getWasmModuleMock.mockImplementation(() => {
      throw new Error('module unavailable');
    });
    expect(loadInsertCatalog('realtime')).toEqual([]);
  });

  it('realtime scope treats an authoritative empty names result as empty', () => {
    getWasmModuleMock.mockReturnValue(core({ insert: [], full: FULL }));
    expect(loadInsertCatalog('realtime')).toEqual([]);
  });

  it('offline scope retains the curated fallback when no wasm catalogs are available', () => {
    getWasmModuleMock.mockReturnValue(core({ insert: [], full: [] }));
    expect(loadInsertCatalog('offline')).toEqual([...FALLBACK_INSERT_CATALOG]);
  });

  it('prefers the structured catalog over the name catalogs', () => {
    getWasmModuleMock.mockReturnValue(
      core({ catalog: CATALOG, insert: STRUCTURED_REALTIME, full: FULL }),
    );
    // realtime keeps only realtimeInsertable ids; offline drops pair, keeps the rest.
    expect(loadInsertCatalog('realtime')).toEqual([
      'dynamics.compressor',
      'modulation.chorus',
      'modulation.flanger',
      'modulation.rotary',
      'stereo.imager',
    ]);
    expect(loadInsertCatalog('offline')).toEqual([
      'dynamics.compressor',
      'modulation.chorus',
      'modulation.flanger',
      'modulation.rotary',
      'stereo.imager',
      'repair.dereverbClassical',
    ]);
  });

  it('never lets structured realtime metadata widen the authoritative names set', () => {
    getWasmModuleMock.mockReturnValue(core({ catalog: CATALOG, insert: REALTIME, full: FULL }));
    const result = loadInsertCatalog('realtime');
    expect(result).toEqual(['dynamics.compressor']);
    expect(result.every((id) => REALTIME.includes(id))).toBe(true);
  });
});

describe('loadInsertCatalogEntries', () => {
  it('carries kind and stereoOnly metadata from the structured catalog', () => {
    getWasmModuleMock.mockReturnValue(core({ catalog: CATALOG, insert: STRUCTURED_REALTIME }));
    const entries = loadInsertCatalogEntries('realtime');
    expect(entries).toEqual([
      { id: 'dynamics.compressor', label: 'Compressor', kind: 'realtime', stereoOnly: false },
      { id: 'modulation.chorus', label: 'Chorus', kind: 'realtime', stereoOnly: false },
      { id: 'modulation.flanger', label: 'Flanger', kind: 'realtime', stereoOnly: false },
      { id: 'modulation.rotary', label: 'Rotary', kind: 'realtime', stereoOnly: true },
      { id: 'stereo.imager', label: 'Imager', kind: 'realtime', stereoOnly: true },
    ]);
  });

  it('falls back to humanized name entries when the catalog is empty', () => {
    getWasmModuleMock.mockReturnValue(core({ insert: REALTIME }));
    expect(loadInsertCatalogEntries('realtime')).toEqual([
      { id: 'dynamics.compressor', label: 'Compressor' },
      { id: 'eq.parametric', label: 'Parametric' },
    ]);
  });
});
