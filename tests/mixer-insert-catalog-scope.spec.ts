import { afterEach, describe, expect, it, vi } from 'vitest';

const { getWasmModuleMock } = vi.hoisted(() => ({ getWasmModuleMock: vi.fn() }));
vi.mock('@/project/store', () => ({ getWasmModule: getWasmModuleMock }));

import { loadInsertCatalog, loadInsertCatalogEntries } from '@/ui/mixer/insert-catalog';

const REALTIME = ['dynamics.compressor', 'eq.parametric'];
const FULL = ['dynamics.compressor', 'eq.parametric', 'repair.dereverbClassical', 'eq.linearPhase'];

/** Structured catalog covering all three kinds plus a stereo-only entry. */
const CATALOG = [
  { id: 'dynamics.compressor', kind: 'realtime', realtimeInsertable: true, stereoOnly: false },
  { id: 'stereo.imager', kind: 'realtime', realtimeInsertable: true, stereoOnly: true },
  { id: 'repair.dereverbClassical', kind: 'offline', realtimeInsertable: false, stereoOnly: false },
  { id: 'match.applyMatchEq', kind: 'pair', realtimeInsertable: false, stereoOnly: false },
];

afterEach(() => {
  vi.clearAllMocks();
});

describe('loadInsertCatalog scope', () => {
  it('realtime scope returns the engine insert-safe subset', () => {
    getWasmModuleMock.mockReturnValue({
      masteringInsertNames: () => REALTIME,
      masteringProcessorNames: () => FULL,
    });
    expect(loadInsertCatalog('realtime')).toEqual(REALTIME);
  });

  it('defaults to the realtime scope', () => {
    getWasmModuleMock.mockReturnValue({
      masteringInsertNames: () => REALTIME,
      masteringProcessorNames: () => FULL,
    });
    expect(loadInsertCatalog()).toEqual(REALTIME);
  });

  it('offline scope returns the full processor set', () => {
    getWasmModuleMock.mockReturnValue({
      masteringInsertNames: () => REALTIME,
      masteringProcessorNames: () => FULL,
    });
    expect(loadInsertCatalog('offline')).toEqual(FULL);
  });

  it('realtime scope falls back to the full set when the subset fn is missing', () => {
    getWasmModuleMock.mockReturnValue({ masteringProcessorNames: () => FULL });
    expect(loadInsertCatalog('realtime')).toEqual(FULL);
  });

  it('offline scope falls back to the subset when the full fn is missing', () => {
    getWasmModuleMock.mockReturnValue({ masteringInsertNames: () => REALTIME });
    expect(loadInsertCatalog('offline')).toEqual(REALTIME);
  });

  it('prefers the structured catalog over the name catalogs', () => {
    getWasmModuleMock.mockReturnValue({
      masteringProcessorCatalog: () => CATALOG,
      masteringInsertNames: () => REALTIME,
      masteringProcessorNames: () => FULL,
    });
    // realtime keeps only realtimeInsertable ids; offline drops pair, keeps the rest.
    expect(loadInsertCatalog('realtime')).toEqual(['dynamics.compressor', 'stereo.imager']);
    expect(loadInsertCatalog('offline')).toEqual([
      'dynamics.compressor',
      'stereo.imager',
      'repair.dereverbClassical',
    ]);
  });
});

describe('loadInsertCatalogEntries', () => {
  it('carries kind and stereoOnly metadata from the structured catalog', () => {
    getWasmModuleMock.mockReturnValue({ masteringProcessorCatalog: () => CATALOG });
    const entries = loadInsertCatalogEntries('realtime');
    expect(entries).toEqual([
      { id: 'dynamics.compressor', label: 'Compressor', kind: 'realtime', stereoOnly: false },
      { id: 'stereo.imager', label: 'Imager', kind: 'realtime', stereoOnly: true },
    ]);
  });

  it('falls back to humanized name entries without metadata', () => {
    getWasmModuleMock.mockReturnValue({ masteringInsertNames: () => REALTIME });
    expect(loadInsertCatalogEntries('realtime')).toEqual([
      { id: 'dynamics.compressor', label: 'Compressor' },
      { id: 'eq.parametric', label: 'Parametric' },
    ]);
  });
});
