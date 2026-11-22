/**
 * Fails on a type-checker escape where a core reshape could hide.
 *
 * In `src/` every `as unknown as`, `as any` and `@ts-expect-error` /
 * `@ts-ignore` is counted per file against {@link SRC_ALLOWED}, which says why
 * each remaining one cannot be typed through. In `tests/` only a cast
 * whose target names a type imported from the core is counted, against
 * {@link TEST_ALLOWED}: fakes are typed from the core, so a cast to a core type
 * is either a deliberately invalid input or a fake that drifted.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Remaining `src/` escapes: file → count and why. */
const SRC_ALLOWED: Record<string, { count: number; reason: string }> = {
  'src/workers/verovio.worker.ts': {
    count: 2,
    reason: "verovio's declared loadData and timemap differ from its runtime; worker global scope",
  },
  'src/workers/musicxml-import.worker.ts': { count: 1, reason: 'worker global scope' },
  'src/workers/audio-encode.worker.ts': { count: 1, reason: 'worker global scope' },
  'src/workers/export.worker.ts': { count: 1, reason: 'worker global scope' },
  'src/lib/web-midi.ts': { count: 1, reason: 'Web MIDI is missing from the DOM lib' },
  'src/project/document-schema.ts': {
    count: 2,
    reason: 'persisted JSON boundary, validated field by field before the cast',
  },
  'src/project/command/tracks.ts': { count: 1, reason: 'generic keyed write to a studio track' },
  'src/project/command/utils.ts': {
    count: 2,
    reason: 'lane-kind callbacks erased to the point type',
  },
  'src/project/midi-lane-kinds.ts': { count: 1, reason: 'lane-kind registry type erasure' },
  'src/project/processor-controls.ts': {
    count: 1,
    reason: 'studio controls stored before the kind discriminant existed',
  },
  'src/export/engine-render.ts': { count: 1, reason: 'cropped planes returned as the caller T' },
  'src/ui/devices/synth-enums.ts': { count: 1, reason: 'Object.fromEntries over fallback tables' },
};

/** Test casts to a core type: file → count and why. */
const TEST_ALLOWED: Record<string, { count: number; reason: string }> = {};

/** App-side engine types a fake must be built for through `tests/fakes/engine.ts`. */
const ENGINE_TYPES = new Set(['EngineHandle', 'OfflineRenderEngine', 'SidechainCheckEngine']);

function listed(patterns: string[]): string[] {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', ...patterns], {
    cwd: ROOT,
  })
    .toString()
    .trim()
    .split('\n')
    .filter((file) => file !== '');
  expect(files.length, `no files matched ${patterns.join(' ')}`).toBeGreaterThan(0);
  return files;
}

function scriptText(file: string): string {
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  if (!file.endsWith('.vue')) return source;
  let body = '';
  for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) body += `${m[1]}\n`;
  return body;
}

function isCoreModule(specifier: string): boolean {
  return /(^|\/)wasm(\/|$)/.test(specifier.replace(/\/index\.js$/, ''));
}

function isDoubleCast(node: ts.AsExpression): boolean {
  const inner = ts.isParenthesizedExpression(node.expression)
    ? node.expression.expression
    : node.expression;
  return ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword;
}

function isEscape(node: ts.Node): node is ts.AsExpression {
  return (
    ts.isAsExpression(node) && (node.type.kind === ts.SyntaxKind.AnyKeyword || isDoubleCast(node))
  );
}

/** Local names a file imports from the core, namespace imports included. */
function coreNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isCoreModule(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.add(element.name.text);
    }
  }
  return names;
}

function mentions(type: ts.Node, names: Set<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(type);
  return found;
}

function countsBy(files: string[], count: (sf: ts.SourceFile, text: string) => number) {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const text = scriptText(file);
    const n = count(ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true), text);
    if (n > 0) counts[file] = n;
  }
  return counts;
}

function allowedCounts(allowed: Record<string, { count: number }>): Record<string, number> {
  return Object.fromEntries(Object.entries(allowed).map(([file, { count }]) => [file, count]));
}

describe('core cast guard', () => {
  it('src keeps only the listed type-checker escapes', () => {
    const counts = countsBy(listed(['src/*.ts', 'src/*.vue']), (sf, text) => {
      let n = text.match(/\/\/\s*@ts-(expect-error|ignore)\b/g)?.length ?? 0;
      const visit = (node: ts.Node): void => {
        if (isEscape(node)) n += 1;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return n;
    });
    expect(counts).toEqual(allowedCounts(SRC_ALLOWED));
  });

  it('tests cast to a core type only where listed', () => {
    const counts = countsBy(listed(['tests/*.ts']), (sf) => {
      const names = coreNames(sf);
      if (names.size === 0) return 0;
      let n = 0;
      const visit = (node: ts.Node): void => {
        if (isEscape(node) && mentions(node.type, names)) n += 1;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return n;
    });
    expect(counts).toEqual(allowedCounts(TEST_ALLOWED));
  });

  it('tests build engine fakes from the shared typed fakes, never by a cast', () => {
    const counts = countsBy(listed(['tests/*.ts']), (sf) => {
      let n = 0;
      const visit = (node: ts.Node): void => {
        if (isEscape(node) && mentions(node.type, ENGINE_TYPES)) n += 1;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return n;
    });
    expect(counts).toEqual({});
  });
});
