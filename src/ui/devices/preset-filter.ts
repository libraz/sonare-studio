/**
 * Search filtering and grouping for the instrument preset picker.
 */

/** Preset category used by the device rack. */
export type PresetCategory =
  | 'keys'
  | 'guitars'
  | 'basses'
  | 'orchestral'
  | 'winds'
  | 'organs'
  | 'synths'
  | 'drums'
  | 'other';

/** One grouped preset section. */
export interface PresetGroup {
  category: PresetCategory;
  presets: string[];
}

const CATEGORY_ORDER: PresetCategory[] = [
  'keys',
  'guitars',
  'basses',
  'orchestral',
  'winds',
  'organs',
  'synths',
  'drums',
  'other',
];

/** Returns the picker category of one NativeSynth preset name. */
export function presetCategory(name: string): PresetCategory {
  const lower = name.toLowerCase();
  if (lower.includes('harpsichord')) return 'keys';
  if (lower.includes('bassoon')) return 'winds';
  if (lower.includes('guitar') || lower.includes('harp') || lower.includes('pluck')) {
    return 'guitars';
  }
  if (lower.includes('bass') || lower.includes('contrabass')) return 'basses';
  if (
    lower.includes('piano') ||
    lower.includes('clav') ||
    lower.includes('harpsichord') ||
    lower.includes('bell')
  ) {
    return 'keys';
  }
  if (lower.includes('organ')) return 'organs';
  if (
    lower.includes('flute') ||
    lower.includes('reed') ||
    lower.includes('bassoon') ||
    lower.includes('sax') ||
    lower.includes('clarinet') ||
    lower.includes('oboe')
  ) {
    return 'winds';
  }
  if (
    lower.includes('brass') ||
    lower.includes('violin') ||
    lower.includes('string') ||
    lower.includes('cello')
  ) {
    return 'orchestral';
  }
  if (lower.includes('drum') || lower.includes('kit') || lower.includes('perc')) return 'drums';
  if (
    lower.includes('synth') ||
    lower.includes('lead') ||
    lower.includes('pad') ||
    lower.includes('saw') ||
    lower.includes('square') ||
    lower.includes('sine')
  ) {
    return 'synths';
  }
  return 'other';
}

/**
 * Filters preset names by a case-insensitive query. Prefix matches rank
 * before substring matches; within each group the catalog order is kept.
 * A blank query returns every name.
 *
 * @param names Catalog preset names.
 * @param query Raw search input (whitespace trimmed).
 * @returns Matching names, prefix matches first.
 */
export function filterPresets(names: ReadonlyArray<string>, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...names];
  const prefixMatches: string[] = [];
  const substringMatches: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(q)) prefixMatches.push(name);
    else if (lower.includes(q)) substringMatches.push(name);
  }
  return [...prefixMatches, ...substringMatches];
}

/**
 * Groups filtered preset names into stable category sections while preserving
 * the ranked order inside each category.
 */
export function groupPresets(names: ReadonlyArray<string>, query: string): PresetGroup[] {
  const filtered = filterPresets(names, query);
  const byCategory = new Map<PresetCategory, string[]>();
  for (const preset of filtered) {
    const category = presetCategory(preset);
    const bucket = byCategory.get(category) ?? [];
    bucket.push(preset);
    byCategory.set(category, bucket);
  }
  return CATEGORY_ORDER.flatMap((category) => {
    const presets = byCategory.get(category);
    return presets && presets.length > 0 ? [{ category, presets }] : [];
  });
}
