/**
 * Contract between the studio and the vendored libsonare surface in `src/wasm/`.
 *
 * Type-checks every tracked `src/` and `tests/` file (Vue files through their
 * `<script>` blocks) against the vendored declarations and fails on each
 * diagnostic the core surface causes: an import the core no longer exports, a
 * member missing on a core type, an object key a core request type does not
 * declare, or a call that no longer matches a core signature. `tests/` sits
 * outside `vue-tsc`, so this is also what keeps the core fakes honest.
 * Diagnostics unrelated to the core are left to `vue-tsc`.
 *
 * It also fails when the core starts exporting something the studio mirrors
 * by hand, so each mirror is replaced by the core's own export.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_CURVES } from '@/project/automation';
import { PAN_LAW_IDS } from '@/project/mixer';
import * as core from '@/wasm/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WASM_DIR = path.join(ROOT, 'src', 'wasm');

/** Unknown member, unknown object key, unknown export, call and assignment mismatches. */
const MEMBER_CODES = new Set([2339, 2551]);
const OBJECT_KEY_CODES = new Set([2353, 2561]);
const EXPORT_CODES = new Set([2305, 2724, 2614]);
const CALL_CODES = new Set([2345, 2554, 2555, 2556, 2769]);
const ASSIGN_CODES = new Set([2322, 2559, 2739, 2740, 2741]);

function trackedSources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', 'src/*.ts', 'src/*.vue', 'tests/*.ts'],
    { cwd: ROOT },
  );
  return out
    .toString()
    .trim()
    .split('\n')
    .filter((f) => !f.startsWith('src/wasm/'))
    .map((f) => path.join(ROOT, f));
}

function vueScript(source: string): string {
  let body = '';
  for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) body += `${m[1]}\n`;
  return body;
}

function createProgram(files: string[]): ts.Program {
  const virtual = new Map<string, string>();
  const roots = files.map((f) => {
    if (!f.endsWith('.vue')) return f;
    virtual.set(`${f}.ts`, vueScript(readFileSync(f, 'utf8')));
    return `${f}.ts`;
  });
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    baseUrl: ROOT,
    paths: { '@/*': ['./src/*'] },
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (name, lang, onError, create) => {
    const text = virtual.get(name);
    return text === undefined
      ? getSourceFile(name, lang, onError, create)
      : ts.createSourceFile(name, text, lang, true);
  };
  host.fileExists = (name) => virtual.has(name) || fileExists(name);
  host.readFile = (name) => virtual.get(name) ?? readFile(name);
  return ts.createProgram(roots, options, host);
}

function declaredInCore(declarations: readonly ts.Declaration[] | undefined): boolean {
  return (declarations ?? []).some((d) =>
    path.resolve(d.getSourceFile().fileName).startsWith(WASM_DIR + path.sep),
  );
}

function typeFromCore(type: ts.Type | undefined): boolean {
  if (!type) return false;
  const parts = type.isUnionOrIntersection() ? type.types : [type];
  return parts.some((t) => declaredInCore((t.aliasSymbol ?? t.getSymbol())?.declarations));
}

function nodeAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  const find = (n: ts.Node): ts.Node | undefined =>
    pos >= n.getStart(sf) && pos < n.getEnd() ? (ts.forEachChild(n, find) ?? n) : undefined;
  return find(sf);
}

function enclosing<T extends ts.Node>(
  n: ts.Node | undefined,
  is: (x: ts.Node) => x is T,
): T | undefined {
  for (let cur = n; cur; cur = cur.parent) if (is(cur)) return cur;
  return undefined;
}

function coreCaused(checker: ts.TypeChecker, sf: ts.SourceFile, d: ts.Diagnostic): boolean {
  const node = d.start === undefined ? undefined : nodeAt(sf, d.start);
  if (!node) return false;
  if (EXPORT_CODES.has(d.code)) {
    const decl = enclosing(node, ts.isImportDeclaration) ?? enclosing(node, ts.isExportDeclaration);
    const spec = decl?.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec)) return false;
    return declaredInCore(checker.getSymbolAtLocation(spec)?.declarations);
  }
  if (MEMBER_CODES.has(d.code)) {
    const access = enclosing(node, ts.isPropertyAccessExpression);
    return access !== undefined && typeFromCore(checker.getTypeAtLocation(access.expression));
  }
  if (OBJECT_KEY_CODES.has(d.code)) {
    const literal = enclosing(node, ts.isObjectLiteralExpression);
    return literal !== undefined && typeFromCore(checker.getContextualType(literal));
  }
  if (CALL_CODES.has(d.code)) {
    const call = enclosing(node, ts.isCallOrNewExpression);
    if (!call) return false;
    const target = checker.getResolvedSignature(call)?.getDeclaration();
    return target !== undefined && declaredInCore([target]);
  }
  if (ASSIGN_CODES.has(d.code)) {
    const declared = enclosing(node, ts.isVariableDeclaration)?.type;
    if (declared && typeFromCore(checker.getTypeFromTypeNode(declared))) return true;
    const expr = enclosing(
      node,
      (n): n is ts.Expression => ts.isExpression(n) && !ts.isIdentifier(n),
    );
    return expr !== undefined && typeFromCore(checker.getContextualType(expr));
  }
  return false;
}

let studioProgram: ts.Program | undefined;

/** One program over every tracked studio and test source, shared by the checks below. */
function studio(): ts.Program {
  studioProgram ??= createProgram(trackedSources());
  return studioProgram;
}

/** True when any type reference inside `node` names a core type. */
function mentionsCore(checker: ts.TypeChecker, node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n) || ts.isTypeQueryNode(n)) {
      const name = ts.isTypeReferenceNode(n)
        ? n.typeName
        : ts.isTypeQueryNode(n)
          ? n.exprName
          : n.expression;
      let symbol = checker.getSymbolAtLocation(name);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      if (declaredInCore(symbol?.declarations)) found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** True when an interface extends a core type (`Pick<RealtimeEngine, ...>` and the like). */
function extendsCore(checker: ts.TypeChecker, node: ts.InterfaceDeclaration): boolean {
  return (node.heritageClauses ?? []).some((clause) => mentionsCore(checker, clause));
}

/**
 * Local object types a core class instance would satisfy: every member is one
 * the class has, at least one is a method, and the type is not built from the
 * core type itself (an interface extending `Pick<...>` of it). Interfaces and
 * type literals are both checked, inline ones included. Such a type is a hand-declared seam the import check
 * cannot see through, so a core rename or removal behind it goes unnoticed.
 */
function handDeclaredCoreMirrors(): string[] {
  const program = studio();
  const checker = program.getTypeChecker();
  const index = program.getSourceFile(path.join(WASM_DIR, 'index.d.ts'));
  const moduleSymbol = index && checker.getSymbolAtLocation(index);
  if (!moduleSymbol) throw new Error('vendored index.d.ts is not in the program');
  const classes = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) =>
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
    )
    .filter((symbol) => symbol.flags & ts.SymbolFlags.Class)
    .map((symbol) => ({ name: symbol.name, type: checker.getDeclaredTypeOfSymbol(symbol) }));
  const found: string[] = [];
  for (const sf of program.getSourceFiles()) {
    const file = path.relative(ROOT, sf.fileName).replace(/\.vue\.ts$/, '.vue');
    if (!file.startsWith('src/') || file.startsWith('src/wasm/')) continue;
    const visit = (node: ts.Node): void => {
      const candidate = ts.isInterfaceDeclaration(node)
        ? !extendsCore(checker, node)
        : ts.isTypeLiteralNode(node);
      if (candidate) {
        const local = checker.getTypeAtLocation(ts.isInterfaceDeclaration(node) ? node.name : node);
        const members = checker.getPropertiesOfType(local);
        // A member typed through the core (`Parameters<RealtimeEngine['process']>`)
        // is derived; only members written out by hand count against the type.
        const hasMethod = members.some((member) =>
          (member.declarations ?? []).some(
            (d) =>
              !declaredInCore([d]) &&
              !mentionsCore(checker, d) &&
              (ts.isMethodSignature(d) ||
                (ts.isPropertySignature(d) &&
                  d.type !== undefined &&
                  ts.isFunctionTypeNode(d.type))),
          ),
        );
        if (hasMethod) {
          for (const core of classes) {
            const names = new Set(checker.getPropertiesOfType(core.type).map((m) => m.name));
            if (!members.every((member) => names.has(member.name))) continue;
            if (!checker.isTypeAssignableTo(core.type, local)) continue;
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const label = ts.isInterfaceDeclaration(node)
              ? node.name.text
              : ts.isTypeAliasDeclaration(node.parent)
                ? node.parent.name.text
                : '(inline type)';
            found.push(`${file}:${line + 1} ${label} mirrors ${core.name}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe('vendored libsonare surface', () => {
  it('every studio and test use of the core matches the vendored declarations', {
    timeout: 180_000,
  }, () => {
    const program = studio();
    const checker = program.getTypeChecker();
    const roots = new Set(program.getRootFileNames());
    const failures: string[] = [];
    for (const sf of program.getSourceFiles()) {
      if (!roots.has(sf.fileName)) continue;
      for (const d of program.getSemanticDiagnostics(sf)) {
        if (!coreCaused(checker, sf, d)) continue;
        const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
        const file = path.relative(ROOT, sf.fileName).replace(/\.vue\.ts$/, '.vue');
        failures.push(
          `${file}:${line + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('no studio type re-declares the members of a core class by hand', {
    timeout: 180_000,
  }, () => {
    expect(handDeclaredCoreMirrors()).toEqual([]);
  });
});

/** Names the core would export for the document `Project.toJson()` writes. */
const DOCUMENT_TYPE_NAMES = ['ProjectDocument', 'ProjectJson', 'ProjectJsonDocument'];

describe('hand-written mirrors of core vocabulary', () => {
  const runtimeLists = Object.entries<unknown>(core).filter(
    (entry): entry is [string, readonly string[]] =>
      Array.isArray(entry[1]) && entry[1].every((value) => typeof value === 'string'),
  );

  it.each([
    ['PAN_LAW_IDS', PAN_LAW_IDS],
    ['AUTOMATION_CURVES', [...AUTOMATION_CURVES]],
  ])('%s has no core runtime list to take its place', (_name, mirror) => {
    const covering = runtimeLists.filter(([, values]) => {
      const listed = new Set<string>(values);
      return mirror.every((value) => listed.has(value));
    });
    expect(covering.map(([name]) => name)).toEqual([]);
  });

  it("the Project.toJson() document has no core type to take the mirror's place", () => {
    const exported = coreExports().map((symbol) => symbol.name);
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.filter((name) => DOCUMENT_TYPE_NAMES.includes(name))).toEqual([]);
  });
});

/** The exports of the vendored `index.d.ts`. */
function coreExports(): ts.Symbol[] {
  const index = path.join(WASM_DIR, 'index.d.ts');
  const program = ts.createProgram([index], { noEmit: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(index)!);
  return checker.getExportsOfModule(moduleSymbol!);
}
