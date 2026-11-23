import { describe, expect, it } from 'vitest';
import { listSourceFiles, readSource } from './helpers/source-text';

/**
 * Every radio group and tab strip goes through its shared roving directive, so the
 * arrow-key contract (wrap, Home/End, single tab stop) cannot drift per component.
 */
const WIDGETS = [
  { role: 'radiogroup', directive: 'v-radiogroup' },
  { role: 'tablist', directive: 'v-tablist' },
] as const;

/** Opening tags carrying the given role, with the file they live in. */
function tagsWithRole(role: string): { file: string; tag: string }[] {
  const attribute = `role="${role}"`;
  return listSourceFiles('src', ['.vue']).flatMap((file) => {
    const source = readSource(file);
    const tags = [...source.matchAll(/<[a-zA-Z][^<>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes(attribute));
    // A `>` inside an attribute value would cut a tag short and hide the role from the scan.
    expect(tags.length, file).toBe(source.split(attribute).length - 1);
    return tags.map((tag) => ({ file, tag }));
  });
}

describe('roving directive coverage', () => {
  it.each(WIDGETS)('every role="$role" element carries $directive', ({ role, directive }) => {
    const tags = tagsWithRole(role);
    expect(tags.length).toBeGreaterThan(0);
    const missing = tags
      .filter(({ tag }) => !new RegExp(`\\s${directive}(\\s|>|/)`).test(tag))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });
});
