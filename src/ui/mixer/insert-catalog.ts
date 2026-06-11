/**
 * Insert-processor catalog helpers for the add-insert popover.
 *
 * Processor names follow the wasm catalog convention 'category.camelName'
 * (e.g. 'dynamics.compressor'). The catalog itself is runtime data
 * (masteringProcessorNames); a curated static fallback keeps the popover
 * usable when the module is not loaded (tests, early boot).
 */

import { getWasmModule } from '@/project/store';

/** One selectable processor in the add-insert popover. */
export interface InsertProcessorEntry {
  /** Catalog id passed to addInsert (e.g. 'dynamics.compressor'). */
  id: string;
  /** Human-readable name (e.g. 'Compressor'). */
  label: string;
}

/** One category group of the add-insert popover. */
export interface InsertCatalogGroup {
  /** Category key (the part before the dot). */
  category: string;
  /** Human-readable category name. */
  label: string;
  /** Processors of the category, in catalog order. */
  processors: InsertProcessorEntry[];
}

/** Display names of the known catalog categories, in menu order. */
const CATEGORY_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['dynamics', 'Dynamics'],
  ['eq', 'EQ'],
  ['multiband', 'Multiband'],
  ['saturation', 'Saturation'],
  ['spectral', 'Spectral'],
  ['stereo', 'Stereo'],
  ['maximizer', 'Maximizer'],
  ['repair', 'Repair'],
  ['final', 'Final'],
];

/**
 * Curated processor list used when the wasm catalog is unavailable. All
 * entries are members of the typed SoloProcessor union, so they are valid
 * offline-strip processors.
 */
export const FALLBACK_INSERT_CATALOG: readonly string[] = [
  'dynamics.compressor',
  'dynamics.gate',
  'dynamics.expander',
  'dynamics.deesser',
  'dynamics.transientShaper',
  'dynamics.limiter',
  'dynamics.brickwallLimiter',
  'eq.parametric',
  'eq.shelving',
  'eq.tilt',
  'eq.pultec',
  'multiband.compressor',
  'multiband.saturation',
  'saturation.tape',
  'saturation.tube',
  'saturation.softClipper',
  'saturation.exciter',
  'saturation.waveshaper',
  'spectral.airBand',
  'spectral.presenceEnhancer',
  'spectral.lowEndFocus',
  'stereo.imager',
  'stereo.autoPan',
  'stereo.monoMaker',
  'stereo.stereoBalance',
  'maximizer.maximizer',
  'maximizer.truePeakLimiter',
  'repair.denoiseClassical',
  'repair.declick',
  'repair.dehum',
];

/** Capitalizes the first character of a string. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Splits camelCase into spaced words ('brickwallLimiter' -> 'brickwall Limiter'). */
function spaceCamelCase(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * Human-readable name of a processor id: the part after the category dot,
 * camelCase split into capitalized words.
 *
 * @param id Catalog id (e.g. 'dynamics.brickwallLimiter').
 * @returns Display name (e.g. 'Brickwall Limiter').
 */
export function humanizeInsertName(id: string): string {
  const name = id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;
  return spaceCamelCase(name).split(' ').map(capitalize).join(' ');
}

/** Display label of a category key (capitalized fallback for unknown keys). */
export function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS.find(([key]) => key === category);
  return known ? known[1] : capitalize(category);
}

/**
 * Groups catalog processor ids by their category prefix. Known categories
 * appear in menu order, unknown ones after them alphabetically; processors
 * keep the input order within each group.
 *
 * @param names Catalog processor ids.
 * @returns Non-empty groups only.
 */
export function groupInsertCatalog(names: readonly string[]): InsertCatalogGroup[] {
  const byCategory = new Map<string, InsertProcessorEntry[]>();
  for (const id of names) {
    const category = id.includes('.') ? id.slice(0, id.indexOf('.')) : 'other';
    const list = byCategory.get(category) ?? [];
    list.push({ id, label: humanizeInsertName(id) });
    byCategory.set(category, list);
  }
  const knownOrder = CATEGORY_LABELS.map(([key]) => key);
  const categories = [...byCategory.keys()].sort((a, b) => {
    const ia = knownOrder.indexOf(a);
    const ib = knownOrder.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
  return categories.map((category) => ({
    category,
    label: categoryLabel(category),
    processors: byCategory.get(category) ?? [],
  }));
}

/**
 * Loads the processor catalog from the wasm module, falling back to the
 * curated static list when the module (or the function) is unavailable.
 */
export function loadInsertCatalog(): string[] {
  try {
    const wasm = getWasmModule() as unknown as {
      masteringProcessorNames?: () => string[];
      masteringInsertNames?: () => string[];
    };
    const names = wasm.masteringProcessorNames?.() ?? wasm.masteringInsertNames?.();
    if (names && names.length > 0) return names;
  } catch {
    // Module not loaded yet; use the fallback below.
  }
  return [...FALLBACK_INSERT_CATALOG];
}
