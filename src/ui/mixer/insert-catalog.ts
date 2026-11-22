/**
 * Insert-processor catalog helpers for the add-insert popover.
 *
 * Processor names follow the wasm catalog convention 'category.camelName'
 * (e.g. 'dynamics.compressor'). The catalog itself is runtime data; a curated
 * static fallback keeps the offline popover usable when the module is not
 * loaded (tests, early boot).
 *
 * The structured `masteringProcessorCatalog()` supplies metadata when the
 * module is loaded: each entry carries `kind` (realtime/offline/pair),
 * `realtimeInsertable` and `stereoOnly`, so the popover can tag stereo-only
 * processors. Realtime ids are always guarded by the authoritative
 * `masteringInsertNames()` set; the structured catalog cannot widen that set.
 * Two legacy name catalogs are available for their respective scopes (and
 * must not be confused):
 * - `masteringInsertNames()` — processors the realtime engine accepts as strip
 *   inserts. Mixer strips (track/bus/master) are validated against this set, so
 *   their popover MUST use it or the engine throws "Unsupported insert
 *   processor" when the scene syncs. Equal to the catalog's `realtimeInsertable`
 *   set.
 * - `masteringProcessorNames()` — the full processor set (a superset), valid in
 *   the offline mastering chain only.
 */

import { getWasmModule } from '@/project/store';
import type { SoloProcessor } from '@/wasm/index.js';

type CoreCatalog = Pick<
  typeof import('@/wasm/index.js'),
  'masteringProcessorCatalog' | 'masteringProcessorNames' | 'masteringInsertNames'
>;

/** One entry of the structured wasm processor catalog. */
type WasmCatalogEntry = ReturnType<CoreCatalog['masteringProcessorCatalog']>[number];

/** Processor classification from the wasm catalog. */
export type InsertProcessorKind = WasmCatalogEntry['kind'];

/** The wasm functions used by this module; test modules may provide a subset. */
type WasmModule = Partial<CoreCatalog>;

/**
 * Where an insert catalog will be used:
 * - `'realtime'` — a mixer strip insert (engine-validated subset).
 * - `'offline'` — the offline mastering chain (full processor set).
 */
export type InsertCatalogScope = 'realtime' | 'offline';

/** One selectable processor in the add-insert popover. */
export interface InsertProcessorEntry {
  /** Catalog id passed to addInsert (e.g. 'dynamics.compressor'). */
  id: string;
  /** Human-readable name (e.g. 'Compressor'). */
  label: string;
  /**
   * Classification from the wasm catalog, when known. Undefined on the static
   * fallback path (no module loaded).
   */
  kind?: InsertProcessorKind;
  /** True for stereo-only processors (no mono implementation), when known. */
  stereoOnly?: boolean;
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
  ['filter', 'Filter'],
  ['modulation', 'Modulation'],
  ['delay', 'Delay'],
  ['multiband', 'Multiband'],
  ['saturation', 'Saturation'],
  ['spectral', 'Spectral'],
  ['stereo', 'Stereo'],
  ['voice', 'Voice'],
  ['maximizer', 'Maximizer'],
  ['utility', 'Utility'],
  ['repair', 'Repair'],
  ['final', 'Final'],
];

/**
 * Curated processor list used when the wasm catalog is unavailable. All
 * entries are members of the typed SoloProcessor union, so they are valid
 * offline-strip processors.
 */
export const FALLBACK_INSERT_CATALOG: readonly SoloProcessor[] = [
  'dynamics.compressor',
  'dynamics.gate',
  'dynamics.expander',
  'dynamics.deesser',
  'dynamics.parallelComp',
  'dynamics.sidechainRouter',
  'dynamics.transientShaper',
  'dynamics.limiter',
  'dynamics.brickwallLimiter',
  'eq.parametric',
  'eq.shelving',
  'eq.tilt',
  'eq.passiveTube',
  'multiband.compressor',
  'multiband.saturation',
  'saturation.tape',
  'saturation.tube',
  'saturation.softClipper',
  'saturation.ampSim',
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
  const name = id.includes('.') ? id.split('.').slice(1).join(' ') : id;
  return spaceCamelCase(name).split(' ').map(capitalize).join(' ');
}

/** Display label of a category key (capitalized fallback for unknown keys). */
export function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS.find(([key]) => key === category);
  return known ? known[1] : capitalize(category);
}

/**
 * Groups catalog entries (carrying `kind`/`stereoOnly` metadata) by their
 * category prefix, preserving the metadata. Known categories appear in menu
 * order, unknown ones after them alphabetically; processors keep the input
 * order within each group.
 *
 * @param entries Catalog entries (already humanized).
 * @returns Non-empty groups only.
 */
export function groupInsertCatalogEntries(
  entries: readonly InsertProcessorEntry[],
): InsertCatalogGroup[] {
  const byCategory = new Map<string, InsertProcessorEntry[]>();
  for (const entry of entries) {
    const category = entry.id.includes('.') ? entry.id.slice(0, entry.id.indexOf('.')) : 'other';
    const list = byCategory.get(category) ?? [];
    list.push(entry);
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

/** Reads the wasm module, or null when the store/module is unavailable. */
function loadWasmModule(): WasmModule | null {
  try {
    return getWasmModule() as unknown as WasmModule;
  } catch {
    // Module not loaded yet.
  }
  return null;
}

/**
 * Reads the structured `masteringProcessorCatalog()` from a wasm module, or
 * null when the module/function is unavailable.
 */
function loadWasmCatalog(wasm: WasmModule | null): WasmCatalogEntry[] | null {
  try {
    const entries = wasm?.masteringProcessorCatalog?.();
    if (Array.isArray(entries) && entries.length > 0) return entries;
  } catch {
    // Older modules may not expose this catalog yet.
  }
  return null;
}

/**
 * Reads the authoritative realtime insert names. Null means that the API is
 * unavailable; an empty array is a valid authoritative empty set.
 */
function loadRealtimeInsertNames(wasm: WasmModule | null): string[] | null {
  if (!wasm || typeof wasm.masteringInsertNames !== 'function') return null;
  try {
    const names = wasm.masteringInsertNames();
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) return null;
    return names;
  } catch {
    // A partially loaded/older module cannot prove any realtime insert ids.
    return null;
  }
}

/** Reads the offline name catalogs, retaining the legacy fallback order. */
function loadOfflineInsertNames(wasm: WasmModule | null): string[] | null {
  try {
    const names = wasm?.masteringProcessorNames?.() ?? wasm?.masteringInsertNames?.();
    if (names && names.length > 0) return names;
  } catch {
    // Module not loaded yet; use the static offline fallback below.
  }
  return null;
}

/** Keeps the catalog entries a scope offers: realtime-insertable, or non-pair. */
function entryInScope(entry: WasmCatalogEntry, scope: InsertCatalogScope): boolean {
  // Pair (match.*) processors are reference-pair tools, never chain inserts.
  return scope === 'realtime' ? entry.realtimeInsertable : entry.kind !== 'pair';
}

/**
 * Loads the processor catalog as structured entries (with `kind`/`stereoOnly`
 * metadata) for the given scope. Realtime entries are intersected with the
 * authoritative `masteringInsertNames()` set; if that API is unavailable, no
 * realtime entries are offered. Offline prefers `masteringProcessorCatalog()`
 * and falls back to the name catalogs (no metadata), then the curated list.
 *
 * @param scope `'realtime'` keeps the engine's insert-safe subset (mixer
 *   strips); `'offline'` keeps the full set minus pair processors (mastering
 *   chain).
 * @returns Catalog entries in catalog order.
 */
export function loadInsertCatalogEntries(
  scope: InsertCatalogScope = 'realtime',
): InsertProcessorEntry[] {
  const wasm = loadWasmModule();
  const catalog = loadWasmCatalog(wasm);
  if (catalog) {
    const realtimeNames = scope === 'realtime' ? loadRealtimeInsertNames(wasm) : null;
    if (scope === 'realtime' && realtimeNames === null) return [];
    const realtimeSet = realtimeNames ? new Set(realtimeNames) : null;
    return catalog
      .filter(
        (entry) =>
          entryInScope(entry, scope) &&
          (scope === 'offline' || realtimeSet?.has(entry.id) === true),
      )
      .map((entry) => ({
        id: entry.id,
        label: humanizeInsertName(entry.id),
        kind: entry.kind,
        stereoOnly: entry.stereoOnly,
      }));
  }
  return loadInsertCatalog(scope).map((id) => ({ id, label: humanizeInsertName(id) }));
}

/**
 * Loads the processor ids for a scope. Realtime requires the authoritative
 * `masteringInsertNames()` API and returns an empty result when it is
 * unavailable; it never falls back to the broader processor/static catalogs.
 * Offline retains the curated static fallback. Prefer
 * {@link loadInsertCatalogEntries} when the `kind`/`stereoOnly` metadata is
 * useful.
 *
 * @param scope Which catalog to load: `'realtime'` returns the engine's
 *   insert-safe subset (`masteringInsertNames`) for mixer strips; `'offline'`
 *   returns the full processor set (`masteringProcessorNames`) for the
 *   mastering chain. Offline falls back to the insert names and then the
 *   curated static list when needed.
 * @returns Catalog processor ids.
 */
export function loadInsertCatalog(scope: InsertCatalogScope = 'realtime'): string[] {
  const wasm = loadWasmModule();
  const catalog = loadWasmCatalog(wasm);
  if (catalog) {
    if (scope === 'realtime') {
      const realtimeNames = loadRealtimeInsertNames(wasm);
      if (realtimeNames === null) return [];
      const realtimeSet = new Set(realtimeNames);
      return catalog
        .filter((entry) => entryInScope(entry, scope) && realtimeSet.has(entry.id))
        .map((entry) => entry.id);
    }
    return catalog.filter((entry) => entryInScope(entry, scope)).map((entry) => entry.id);
  }

  if (scope === 'realtime') {
    const realtimeNames = loadRealtimeInsertNames(wasm);
    return realtimeNames ?? [];
  }

  const offlineNames = loadOfflineInsertNames(wasm);
  if (offlineNames) return offlineNames;
  return [...FALLBACK_INSERT_CATALOG];
}
