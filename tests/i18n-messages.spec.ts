import { describe, expect, it } from 'vitest';
import { MESSAGES } from '@/ui/i18n';
import { SHORTCUT_ACTIONS } from '@/ui/settings/shortcuts';

type MessageNode = string | { readonly [key: string]: MessageNode };

function isObjectNode(value: MessageNode): value is { readonly [key: string]: MessageNode } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function leafPaths(node: MessageNode, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  return Object.keys(node)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((key) => leafPaths(node[key], prefix === '' ? key : `${prefix}.${key}`));
}

function shapeErrors(
  reference: MessageNode,
  candidate: MessageNode,
  path = '',
  locale = 'candidate',
): string[] {
  if (typeof reference === 'string' || typeof candidate === 'string') {
    return typeof reference === typeof candidate
      ? []
      : [`${locale}:${path || '<root>'} expected ${typeof reference}, got ${typeof candidate}`];
  }
  if (!isObjectNode(reference) || !isObjectNode(candidate)) {
    return [`${locale}:${path || '<root>'} has an unsupported message node shape`];
  }
  const keys = new Set([...Object.keys(reference), ...Object.keys(candidate)]);
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((key) => {
      const nextPath = path === '' ? key : `${path}.${key}`;
      if (!(key in reference)) return [`${locale}:${nextPath} is extra`];
      if (!(key in candidate)) return [`${locale}:${nextPath} is missing`];
      return shapeErrors(reference[key], candidate[key], nextPath, locale);
    });
}

/** Leaf path to message text, for every string in the tree. */
function leafTexts(node: MessageNode, prefix = ''): Map<string, string> {
  if (typeof node === 'string') return new Map([[prefix, node]]);
  return new Map(
    Object.keys(node).flatMap((key) => [
      ...leafTexts(node[key], prefix === '' ? key : `${prefix}.${key}`),
    ]),
  );
}

/** Sorted, de-duplicated `{name}` placeholders formatMessage fills in. */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();
}

describe('i18n messages', () => {
  it('keeps every locale structurally aligned with English', () => {
    const reference = MESSAGES.en as MessageNode;
    const expectedPaths = leafPaths(reference);

    for (const [locale, messages] of Object.entries(MESSAGES)) {
      const node = messages as MessageNode;
      expect(shapeErrors(reference, node, '', locale)).toEqual([]);
      expect(leafPaths(node)).toEqual(expectedPaths);
    }
  });

  it('uses the same placeholders in every locale as in English', () => {
    const reference = leafTexts(MESSAGES.en as MessageNode);
    for (const [locale, messages] of Object.entries(MESSAGES)) {
      const mismatches = [...leafTexts(messages as MessageNode)]
        .filter(([path, text]) => {
          const english = reference.get(path);
          return (
            english !== undefined && placeholders(english).join() !== placeholders(text).join()
          );
        })
        .map(([path]) => `${locale}:${path}`);
      expect(mismatches).toEqual([]);
    }
  });

  it('provides labels for every registered shortcut action and group', () => {
    const groups = new Set(SHORTCUT_ACTIONS.map((action) => action.group));
    for (const messages of Object.values(MESSAGES)) {
      for (const group of groups) {
        expect(
          messages.shortcuts.groups[group as keyof typeof messages.shortcuts.groups],
        ).toBeTruthy();
      }
      for (const action of SHORTCUT_ACTIONS) {
        expect(
          messages.shortcuts.actions[action.id as keyof typeof messages.shortcuts.actions],
        ).toBeTruthy();
      }
    }
  });
});
