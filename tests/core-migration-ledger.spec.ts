/**
 * Checks studio and test sources against libsonare's WASM migration ledger,
 * as the installed package ships it.
 *
 * Every name the ledger lists as removed or renamed from 1.x, and that no 2.0
 * declaration still spells, must not appear as an import from the core or as
 * a member access anywhere in `src/` or `tests/`. Unlike the type-based
 * contract check this needs no type to flow from the core, so it also catches
 * a call routed through a hand-declared seam (`unknown`, a local interface) to
 * a member the core no longer has.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CORE_DIST_DIR, coreMigrationLedger, type LedgerEntry } from './core-package';
import { readSource } from './helpers/source-text';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Ledger kinds whose old name is a top-level export (reached by import). */
const EXPORT_KINDS = new Set(['function', 'class', 'type', 'export']);
/** Ledger kinds whose old name is `Owner.member` (reached by member access). */
const MEMBER_KINDS = new Set(['method', 'field']);

/**
 * Studio-owned names that happen to match a retired core name. Each is keyed by
 * file so the same name reaching the core from anywhere else still fails.
 */
const STUDIO_OWNED: ReadonlyArray<{ name: string; files: string[]; reason: string }> = [
  {
    name: 'currentTime',
    reason: 'DOM AudioContext / HTMLMediaElement clock',
    files: [
      'src/engine/web-midi-output.ts',
      'src/export/browser-media.ts',
      'src/ui/media/preview.ts',
      'tests/fake-audio-context.ts',
      'tests/mastering-panel.spec.ts',
      'tests/media-preview.spec.ts',
    ],
  },
  {
    name: 'aliases',
    reason: 'asset and font sidecar alias lists',
    files: ['src/persistence/assets.ts', 'src/project/fonts.ts'],
  },
  {
    name: 'durationSeconds',
    reason: 'E2E debug-surface readouts',
    files: [
      'scripts/e2e/scenarios/audio-edit-to-master.mjs',
      'scripts/e2e/scenarios/audio-to-midi-production.mjs',
    ],
  },
  { name: 'startSeconds', reason: 'tempo-map segment field', files: ['src/project/tempo-map.ts'] },
  {
    name: 'setStripGain',
    reason: 'studio mixer command',
    files: ['src/ui/mixer/strip-gestures.ts', 'tests/mixer-strip-gestures.spec.ts'],
  },
  {
    name: 'loudnessRangeDb',
    reason: 'persisted audio tag key',
    files: ['src/project/audio-tags.ts'],
  },
  ...[
    'clickCount',
    'clipRunCount',
    'clipFlatRunCount',
    'crackleSampleCount',
    'cracklePerSecond',
  ].map((name) => ({
    name,
    reason: 'spec-local defect overrides',
    files: ['tests/sample-editor-repair-analysis.spec.ts'],
  })),
  {
    name: 'humFundamentalHz',
    reason: 'spec-local defect overrides',
    files: ['tests/sample-editor-repair-analysis.spec.ts'],
  },
  {
    name: 'setCaptureSource',
    reason: 'studio recording composable',
    files: [
      'src/composables/useRecordingControls.ts',
      'tests/recording-cycle.spec.ts',
      'tests/use-recording-controls.spec.ts',
      'tests/use-recording.spec.ts',
    ],
  },
  {
    name: 'setInputMonitor',
    reason: 'E2E debug surface',
    files: ['scripts/e2e/scenarios/input-monitor.mjs'],
  },
  ...['beatTimes', 'beatStrengths'].map((name) => ({
    name,
    reason: 'studio analysis-worker protocol',
    files: ['src/project/audio-analysis-client.ts'],
  })),
  {
    name: 'keyConfidence',
    reason: 'persisted audio tag key',
    files: ['src/project/audio-tags.ts'],
  },
  ...['sidechainHpfHz', 'sidechainHpfEnabled', 'retuneGrainSize', 'elevation'].map((name) => ({
    name,
    reason: 'reads 1.x keys out of a v5 document to migrate them',
    files: ['src/project/document-schema-v5.ts'],
  })),
];

/**
 * Common studio vocabulary allowed in any file. Typed access to a core value is
 * guarded by the compiler and by core-cast-guard; this check covers the
 * untyped remainder, where words this generic would only be noise.
 */
const STUDIO_VOCABULARY: ReadonlyArray<{ name: string; reason: string }> = [
  { name: 'end', reason: 'ranges, streams and gestures' },
  { name: 'time', reason: 'DAWproject points and studio events' },
  { name: 'duration', reason: 'DOM media, containers and note fields' },
  { name: 'distance', reason: 'pointer hit-testing' },
  { name: 'frequency', reason: 'Web Audio oscillators and E2E readouts' },
  { name: 'masteringChain', reason: 'studio mixer state' },
  { name: 'messages', reason: 'worker-client spec fakes' },
  { name: 'timestamps', reason: 'Web MIDI output spec fakes' },
  { name: 'roman', reason: 'theory-engine reharmonization results' },
];

/** `file name` pairs, and bare vocabulary names, suppressed during the last scan. */
const suppressed = new Set<string>();

function studioOwned(file: string, name: string): boolean {
  if (STUDIO_VOCABULARY.some((entry) => entry.name === name)) {
    suppressed.add(name);
    return true;
  }
  const owned = STUDIO_OWNED.some((entry) => entry.name === name && entry.files.includes(file));
  if (owned) suppressed.add(`${file} ${name}`);
  return owned;
}

/** Old names gone from 2.0: renamed, removed, or renamed while reshaped. */
function retiredNames(entries: LedgerEntry[]): { exports: Set<string>; members: Set<string> } {
  const exports = new Set<string>();
  const members = new Set<string>();
  for (const entry of entries) {
    const gone = entry.new !== undefined || entry.removed !== undefined || entry.to !== undefined;
    if (!gone) continue;
    if (EXPORT_KINDS.has(entry.kind)) exports.add(entry.old);
    else if (MEMBER_KINDS.has(entry.kind))
      members.add(entry.old.slice(entry.old.lastIndexOf('.') + 1));
  }
  return { exports, members };
}

/**
 * The internal embind module description: it keeps raw binding names the
 * public wrappers renamed, so a name declared only there is not reachable.
 */
const RAW_MODULE_DECLS = 'sonare.d.ts';

/** Every identifier the installed 2.0 public declarations spell outside comments. */
function declaredNames(): Set<string> {
  const names = new Set<string>();
  const scanner = ts.createScanner(ts.ScriptTarget.ESNext, true);
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.d.ts') && item.name !== RAW_MODULE_DECLS) {
        scanner.setText(readFileSync(full, 'utf8'));
        for (
          let token = scanner.scan();
          token !== ts.SyntaxKind.EndOfFileToken;
          token = scanner.scan()
        ) {
          if (token === ts.SyntaxKind.Identifier || token >= ts.SyntaxKind.FirstKeyword) {
            names.add(scanner.getTokenText());
          } else if (token === ts.SyntaxKind.StringLiteral) {
            names.add(scanner.getTokenValue());
          }
        }
      }
    }
  };
  walk(CORE_DIST_DIR);
  return names;
}

function trackedSources(): string[] {
  const out = execFileSync(
    'git',
    [
      'ls-files',
      '-co',
      '--exclude-standard',
      'src/*.ts',
      'src/*.vue',
      'tests/*.ts',
      'scripts/*.mjs',
    ],
    { cwd: ROOT },
  );
  return out
    .toString()
    .trim()
    .split('\n')
    .filter((f) => f !== '');
}

function scriptText(file: string): string {
  const source = readSource(file);
  if (!file.endsWith('.vue')) return source;
  let body = '';
  for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) body += `${m[1]}\n`;
  return body;
}

function isCoreModule(specifier: string): boolean {
  return /(^|\/)wasm(\/|$)/.test(specifier.replace(/\/index\.js$/, ''));
}

/** Uses of retired names: `file:line kind name`. */
function retiredUses(exports: Set<string>, members: Set<string>): string[] {
  const hits: string[] = [];
  for (const file of trackedSources()) {
    const sf = ts.createSourceFile(file, scriptText(file), ts.ScriptTarget.ESNext, true);
    const report = (node: ts.Node, kind: string, name: string): void => {
      if (studioOwned(file, name)) return;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push(`${file}:${line + 1} ${kind} ${name}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && members.has(node.name.text)) {
        report(node.name, 'member', node.name.text);
      }
      if (ts.isPropertyAccessExpression(node) && exports.has(node.name.text)) {
        report(node.name, 'export', node.name.text);
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isCoreModule(node.moduleSpecifier.text)
      ) {
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : node.exportClause;
        if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (exports.has(imported)) report(element, 'import', imported);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

describe('libsonare migration ledger', () => {
  const entries = coreMigrationLedger().entry;

  it('lists the retired surface', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('no studio or test source reaches a name the 2.0 core retired', () => {
    const live = declaredNames();
    const { exports, members } = retiredNames(entries);
    for (const name of live) {
      exports.delete(name);
      members.delete(name);
    }
    // The miss that motivated this check must stay detectable.
    expect(members.has('createClipPageProvider')).toBe(true);
    expect(retiredUses(exports, members)).toEqual([]);
    // An allowance that no longer matches anything is stale and must go.
    const stale = [
      ...STUDIO_OWNED.flatMap(({ name, files }) => files.map((file) => `${file} ${name}`)),
      ...STUDIO_VOCABULARY.map(({ name }) => name),
    ].filter((key) => !suppressed.has(key));
    expect(stale).toEqual([]);
  });
});
