/**
 * Mastering-preset catalog helpers for the preset selector.
 *
 * Preset names follow the wasm catalog convention (camelCase ids such as
 * 'hipHop' or 'gameOst'). The catalog itself is runtime data
 * (masteringPresetNames); a curated static fallback keeps the selector
 * usable when the module is not loaded (tests, early boot).
 */

import { getWasmModule } from '@/project/store';
import type { MasteringPreset } from '@/wasm/index.js';

/** Whether a built-in preset masters to a loudness target or only repairs. */
type MasteringPresetKind = 'mastering' | 'restoration';

/**
 * Every built-in preset by kind, in catalog order. Restoration presets repair
 * damaged source material and leave its level alone, so the selector lists
 * them apart. Keyed by the typed union so a preset added upstream fails to
 * compile until it is classified here.
 */
const PRESET_KINDS: Readonly<Record<MasteringPreset, MasteringPresetKind>> = {
  pop: 'mastering',
  edm: 'mastering',
  acoustic: 'mastering',
  hipHop: 'mastering',
  aiMusic: 'mastering',
  speech: 'mastering',
  streaming: 'mastering',
  youtube: 'mastering',
  broadcast: 'mastering',
  podcast: 'mastering',
  audiobook: 'mastering',
  cinema: 'mastering',
  jpop: 'mastering',
  ambient: 'mastering',
  lofi: 'mastering',
  classical: 'mastering',
  drumAndBass: 'mastering',
  techno: 'mastering',
  metal: 'mastering',
  trap: 'mastering',
  rnb: 'mastering',
  jazz: 'mastering',
  kpop: 'mastering',
  trance: 'mastering',
  gameOst: 'mastering',
  vinyl: 'restoration',
  tapeHiss: 'restoration',
  fieldRecording: 'restoration',
  voiceMemo: 'restoration',
  shellac78: 'restoration',
};

/** Preset list used when the wasm catalog is unavailable (tests, early boot). */
export const FALLBACK_MASTERING_PRESETS: readonly string[] = Object.keys(PRESET_KINDS);

/** True for a restoration preset (repair only, no loudness target). */
export function isRestorationPreset(id: string): boolean {
  return PRESET_KINDS[id as MasteringPreset] === 'restoration';
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
