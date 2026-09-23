/**
 * Mastering-preset catalog helpers for the preset selector.
 *
 * Preset names follow the wasm catalog convention (camelCase ids such as
 * 'hipHop' or 'gameOst'). Every preset's kind and loudness targets come from
 * the runtime catalog (capabilityCatalog().masteringPresets); before the
 * module is loaded the catalog is empty.
 */

import { getWasmModule } from '@/project/store';
import type { capabilityCatalog, MasteringPreset } from '@/wasm/index.js';

/** One built-in preset: its kind and, for a mastering preset, its targets. */
export type MasteringPresetInfo = ReturnType<typeof capabilityCatalog>['masteringPresets'][number];

/** Preset catalogs per loaded module; a build's catalog never changes. */
const presetCache = new WeakMap<object, readonly MasteringPresetInfo[]>();

/** The loaded module's built-in presets in catalog order, or [] before init. */
function presetInfos(): readonly MasteringPresetInfo[] {
  let wasm: ReturnType<typeof getWasmModule>;
  try {
    wasm = getWasmModule();
  } catch {
    return [];
  }
  let presets = presetCache.get(wasm);
  if (!presets) {
    presets = wasm.capabilityCatalog().masteringPresets;
    presetCache.set(wasm, presets);
  }
  return presets;
}

/** Catalog entry of a built-in preset, or undefined for an unknown id. */
export function masteringPresetInfo(id: string): MasteringPresetInfo | undefined {
  return presetInfos().find((preset) => preset.name === id);
}

/** True for a restoration preset (repair only, no loudness target). */
export function isRestorationPreset(id: string): boolean {
  return masteringPresetInfo(id)?.kind === 'restoration';
}

/** The restoration presets, in catalog order. */
export function restorationPresets(): MasteringPreset[] {
  return presetInfos()
    .filter((preset) => preset.kind === 'restoration')
    .map((preset) => preset.name as MasteringPreset);
}

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
  shellac78: 'Shellac 78',
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

/** Loads the preset ids from the wasm catalog, in catalog order ([] before init). */
export function loadMasteringPresetCatalog(): string[] {
  return presetInfos().map((preset) => preset.name);
}
