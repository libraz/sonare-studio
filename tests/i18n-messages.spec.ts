import { describe, expect, it } from 'vitest';
import { MESSAGES } from '@/ui/i18n';

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
});
