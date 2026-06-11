/**
 * Mastering-preset catalog helpers for the preset selector.
 *
 * Preset names follow the wasm catalog convention (camelCase ids such as
 * 'hipHop' or 'gameOst'). The catalog itself is runtime data
 * (masteringPresetNames); a curated static fallback keeps the selector
 * usable when the module is not loaded (tests, early boot).
 */

import { getWasmModule } from '@/project/store';

/**
 * Curated preset list used when the wasm catalog is unavailable. All entries
 * are members of the typed MasteringPreset union.
 */
export const FALLBACK_MASTERING_PRESETS: readonly string[] = [
  'pop',
  'edm',
  'acoustic',
  'hipHop',
  'aiMusic',
  'speech',
  'streaming',
  'youtube',
  'broadcast',
  'podcast',
  'audiobook',
  'cinema',
  'jpop',
  'ambient',
  'lofi',
  'classical',
  'drumAndBass',
  'techno',
  'metal',
  'trap',
  'rnb',
  'jazz',
  'kpop',
  'trance',
  'gameOst',
];

/** Display overrides for ids whose mechanical camelCase split reads poorly. */
const PRESET_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  edm: 'EDM',
  aiMusic: 'AI Music',
  youtube: 'YouTube',
  jpop: 'J-Pop',
  kpop: 'K-Pop',
  lofi: 'Lo-Fi',
  rnb: 'R&B',
  gameOst: 'Game OST',
};

/**
 * Human-readable name of a preset id: known overrides first, then camelCase
 * split into capitalized words ('drumAndBass' -> 'Drum And Bass').
 *
 * @param id Catalog preset id.
 * @returns Display name.
 */
export function humanizePresetName(id: string): string {
  const override = PRESET_LABEL_OVERRIDES[id];
  if (override !== undefined) return override;
  const spaced = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Filters the preset catalog by a search query, matching case-insensitively
 * against both the raw id and the humanized label. An empty or whitespace
 * query returns the full list (order preserved).
 *
 * @param names Catalog preset ids.
 * @param query Search text.
 * @returns Matching ids, in catalog order.
 */
export function filterPresetCatalog(names: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...names];
  return names.filter(
    (id) =>
      id.toLowerCase().includes(needle) || humanizePresetName(id).toLowerCase().includes(needle),
  );
}

/**
 * Loads the preset catalog from the wasm module, falling back to the curated
 * static list when the module (or the function) is unavailable.
 */
export function loadMasteringPresetCatalog(): string[] {
  try {
    const wasm = getWasmModule() as unknown as {
      masteringPresetNames?: () => string[];
    };
    const names = wasm.masteringPresetNames?.();
    if (names && names.length > 0) return names;
  } catch {
    // Module not loaded yet; use the fallback below.
  }
  return [...FALLBACK_MASTERING_PRESETS];
}
