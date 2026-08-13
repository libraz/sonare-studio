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

  it('realtime scope does not fall back to the full set when the subset fn is missing', () => {
    getWasmModuleMock.mockReturnValue({ masteringProcessorNames: () => FULL });
    expect(loadInsertCatalog('realtime')).toEqual([]);
  });

  it('realtime scope returns empty when both name catalogs are unavailable', () => {
    getWasmModuleMock.mockReturnValue({});
    expect(loadInsertCatalog('realtime')).toEqual([]);
  });

  it('realtime scope returns empty when the wasm module is unavailable', () => {
    getWasmModuleMock.mockImplementation(() => {
      throw new Error('module unavailable');
    });
    expect(loadInsertCatalog('realtime')).toEqual([]);
  });

  it('realtime scope returns empty when the authoritative names API throws', () => {
    getWasmModuleMock.mockReturnValue({
      masteringInsertNames: () => {
        throw new Error('catalog unavailable');
      },
      masteringProcessorNames: () => FULL,
    });
    expect(loadInsertCatalog('realtime')).toEqual([]);
  });

  it('realtime scope treats an authoritative empty names result as empty', () => {
    getWasmModuleMock.mockReturnValue({
      masteringInsertNames: () => [],
      masteringProcessorNames: () => FULL,
    });
    expect(loadInsertCatalog('realtime')).toEqual([]);
  });

  it('offline scope falls back to the subset when the full fn is missing', () => {
    getWasmModuleMock.mockReturnValue({ masteringInsertNames: () => REALTIME });
    expect(loadInsertCatalog('offline')).toEqual(REALTIME);
  });

  it('offline scope retains the curated fallback when no wasm catalogs are available', () => {
    getWasmModuleMock.mockReturnValue({});
    expect(loadInsertCatalog('offline')).toEqual([...FALLBACK_INSERT_CATALOG]);
  });

  it('prefers the structured catalog over the name catalogs', () => {
    getWasmModuleMock.mockReturnValue({
      masteringProcessorCatalog: () => CATALOG,
      masteringInsertNames: () => STRUCTURED_REALTIME,
      masteringProcessorNames: () => FULL,
    });
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
    getWasmModuleMock.mockReturnValue({
      masteringProcessorCatalog: () => CATALOG,
      masteringInsertNames: () => REALTIME,
      masteringProcessorNames: () => FULL,
    });
    const result = loadInsertCatalog('realtime');
    expect(result).toEqual(['dynamics.compressor']);
    expect(result.every((id) => REALTIME.includes(id))).toBe(true);
  });

  it('offline structured catalogs remain available without realtime names', () => {
    getWasmModuleMock.mockReturnValue({ masteringProcessorCatalog: () => CATALOG });
    expect(loadInsertCatalog('offline')).toEqual([
      'dynamics.compressor',
      'modulation.chorus',
      'modulation.flanger',
      'modulation.rotary',
      'stereo.imager',
      'repair.dereverbClassical',
    ]);
  });

  it('returns no structured realtime entries when authoritative names are unavailable', () => {
    getWasmModuleMock.mockReturnValue({ masteringProcessorCatalog: () => CATALOG });
    expect(loadInsertCatalogEntries('realtime')).toEqual([]);
  });
});

describe('loadInsertCatalogEntries', () => {
  it('carries kind and stereoOnly metadata from the structured catalog', () => {
    getWasmModuleMock.mockReturnValue({
      masteringProcessorCatalog: () => CATALOG,
      masteringInsertNames: () => STRUCTURED_REALTIME,
    });
    const entries = loadInsertCatalogEntries('realtime');
    expect(entries).toEqual([
      { id: 'dynamics.compressor', label: 'Compressor', kind: 'realtime', stereoOnly: false },
      { id: 'modulation.chorus', label: 'Chorus', kind: 'realtime', stereoOnly: false },
      { id: 'modulation.flanger', label: 'Flanger', kind: 'realtime', stereoOnly: false },
      { id: 'modulation.rotary', label: 'Rotary', kind: 'realtime', stereoOnly: true },
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
