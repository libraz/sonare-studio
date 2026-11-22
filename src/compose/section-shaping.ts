/**
 * Section shaping presets of the drum generator, and the mapping from a saved
 * arrangement section's name onto one of them.
 */

export type SectionId = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'outro';

/** Maps common section names to the generator's section shaping presets. */
export function sectionIdFromName(name: string): SectionId | null {
  const normalized = name.trim().toLocaleLowerCase();
  if (/(pre.?chorus|prechorus|bメロ|サビ前)/u.test(normalized)) return 'prechorus';
  if (/(chorus|hook|サビ)/u.test(normalized)) return 'chorus';
  if (/(intro|イントロ)/u.test(normalized)) return 'intro';
  if (/(verse|aメロ)/u.test(normalized)) return 'verse';
  if (/(bridge|間奏|ブリッジ)/u.test(normalized)) return 'bridge';
  if (/(outro|エンディング|アウトロ)/u.test(normalized)) return 'outro';
  return null;
}
