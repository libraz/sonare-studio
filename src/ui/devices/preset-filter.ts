/**
 * Search filtering for the instrument preset picker.
 */

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
