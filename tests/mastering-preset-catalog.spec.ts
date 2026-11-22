import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@/project/store';
import {
  filterPresetCatalog,
  humanizePresetName,
  isRestorationPreset,
  loadMasteringPresetCatalog,
  masteringPresetInfo,
  restorationPresets,
} from '@/ui/mastering/preset-catalog';
import { FAKE_MASTERING_PRESETS } from './fake-wasm';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('humanizePresetName', () => {
  it('splits camelCase ids into capitalized words', () => {
    expect(humanizePresetName('pop')).toBe('Pop');
    expect(humanizePresetName('hipHop')).toBe('Hip Hop');
    expect(humanizePresetName('drumAndBass')).toBe('Drum And Bass');
  });

  it('uses curated overrides for ids that read poorly when split', () => {
    expect(humanizePresetName('edm')).toBe('EDM');
    expect(humanizePresetName('aiMusic')).toBe('AI Music');
    expect(humanizePresetName('lofi')).toBe('Lo-Fi');
    expect(humanizePresetName('gameOst')).toBe('Game OST');
    expect(humanizePresetName('rnb')).toBe('R&B');
    expect(humanizePresetName('shellac78')).toBe('Shellac 78');
  });
});

describe('filterPresetCatalog', () => {
  const names = ['pop', 'edm', 'hipHop', 'drumAndBass', 'lofi'];

  it('returns the full list for an empty or whitespace query', () => {
    expect(filterPresetCatalog(names, '')).toEqual(names);
    expect(filterPresetCatalog(names, '   ')).toEqual(names);
  });

  it('matches case-insensitively against the raw id', () => {
    expect(filterPresetCatalog(names, 'HOP')).toEqual(['hipHop']);
    expect(filterPresetCatalog(names, 'drum')).toEqual(['drumAndBass']);
  });

  it('matches against the humanized label', () => {
    // 'lofi' humanizes to 'Lo-Fi'; the hyphen exists only in the label.
    expect(filterPresetCatalog(names, 'lo-f')).toEqual(['lofi']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterPresetCatalog(names, 'zzz')).toEqual([]);
  });
});

describe('loadMasteringPresetCatalog', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('returns the wasm catalog once the store module is initialized', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    expect(loadMasteringPresetCatalog()).toEqual([...FAKE_MASTERING_PRESETS]);
  });

  it('classifies presets and reads their targets from the catalog', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    expect(restorationPresets()).toEqual(['vinyl']);
    expect(isRestorationPreset('vinyl')).toBe(true);
    expect(isRestorationPreset('pop')).toBe(false);
    expect(isRestorationPreset('custom')).toBe(false);
    expect(masteringPresetInfo('pop')?.targetLufs).toBe(-14);
    expect(masteringPresetInfo('vinyl')?.targetLufs).toBeUndefined();
  });
});
