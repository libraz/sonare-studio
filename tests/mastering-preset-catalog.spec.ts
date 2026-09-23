import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@/project/store';
import {
  FALLBACK_MASTERING_PRESETS,
  filterPresetCatalog,
  humanizePresetName,
  isRestorationPreset,
  loadMasteringPresetCatalog,
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

describe('isRestorationPreset', () => {
  it('separates the repair-only presets from the loudness-targeted ones', () => {
    const restoration = FALLBACK_MASTERING_PRESETS.filter(isRestorationPreset);
    expect(restoration).toEqual(['vinyl', 'tapeHiss', 'fieldRecording', 'voiceMemo', 'shellac78']);
    expect(isRestorationPreset('pop')).toBe(false);
    expect(isRestorationPreset('custom')).toBe(false);
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

  it('exposes a non-empty curated fallback', () => {
    expect(FALLBACK_MASTERING_PRESETS.length).toBeGreaterThan(0);
    expect(FALLBACK_MASTERING_PRESETS).toContain('pop');
    expect(FALLBACK_MASTERING_PRESETS).toContain('streaming');
  });
});
