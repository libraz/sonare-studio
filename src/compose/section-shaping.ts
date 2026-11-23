/**
 * Section shaping presets of the drum generator, and the mapping from a saved
 * arrangement section's name onto one of them.
 */

import type { DefaultNameKey } from '@/project/default-names';
import { MESSAGES } from '@/ui/i18n/messages';

export type SectionId = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'outro';

/**
 * Section kinds in matching order (a pre-chorus name also contains "chorus"),
 * each with the default section names that denote it.
 */
const SECTION_NAME_KEYS: ReadonlyArray<readonly [SectionId, ReadonlyArray<DefaultNameKey>]> = [
  ['prechorus', ['sectionPreChorus']],
  ['chorus', ['sectionChorus', 'sectionFinalChorus']],
  ['intro', ['sectionIntro']],
  ['verse', ['sectionVerse']],
  ['bridge', ['sectionBridge', 'sectionInstrumental']],
  ['outro', ['sectionOutro']],
];

function normalizeSectionName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** Every spelling of each section kind across all languages, normalized. */
const SECTION_SPELLINGS: ReadonlyArray<readonly [SectionId, ReadonlyArray<string>]> =
  SECTION_NAME_KEYS.map(([id, keys]) => {
    const spellings = Object.values(MESSAGES).flatMap(({ common }) => [
      ...keys.map((key) => common.defaultNames[key]),
      ...common.sectionAliases[id].split('|'),
    ]);
    return [id, spellings.map(normalizeSectionName).filter((spelling) => spelling !== '')];
  });

/** Maps common section names, in any message language, to the generator's section shaping presets. */
export function sectionIdFromName(name: string): SectionId | null {
  const normalized = normalizeSectionName(name);
  for (const [id, spellings] of SECTION_SPELLINGS) {
    if (spellings.some((spelling) => normalized.includes(spelling))) return id;
  }
  return null;
}
