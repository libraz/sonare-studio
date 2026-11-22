/**
 * Fails when `src/` re-implements a shared helper or spells out a value a
 * shared constant names. Each rule names its home; a hit elsewhere either
 * moves onto that home or is listed in the rule's `allowed` with the reason
 * the site cannot use it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

interface Rule {
  name: string;
  pattern: RegExp;
  home: string;
  allowed?: Record<string, string>;
}

const RULES: Rule[] = [
  {
    name: 'binary byte unit spelled out',
    pattern: /\b1024\s*\*\s*1024\b|\b1024\s*\*\*\s*[23]\b/,
    home: 'src/lib/bytes.ts',
    allowed: { 'src/export/mastering-limit.ts': 'a Float32 element count, not bytes' },
  },
  {
    name: 'FNV-1a constant spelled out',
    pattern: /0x811c9dc5|0x01000193/i,
    home: 'src/lib/fnv1a.ts',
  },
  {
    name: 'JSON round-trip deep copy',
    pattern: /JSON\.parse\(\s*JSON\.stringify\(/,
    home: 'src/project/clone-json.ts',
  },
  {
    name: 'pitch-class modulus spelled out',
    pattern: /%\s*12\)\s*\+\s*12\)\s*%\s*12/,
    home: 'src/lib/pitch.ts',
  },
  {
    name: 'local copy of a shared helper',
    pattern:
      /\bfunction\s+(clamp|clamp01|clampInt|isFiniteNumber|isAbortError|tryEval|fnv1a32|fnv1a32Bytes|cloneJson|pitchClassOf)\s*[<(]/,
    home: 'src/lib/math.ts, src/lib/errors.ts, src/lib/fnv1a.ts, src/lib/pitch.ts, src/project/clone-json.ts',
    allowed: {
      'src/lib/math.ts': 'home',
      'src/lib/errors.ts': 'home',
      'src/lib/fnv1a.ts': 'home',
      'src/lib/pitch.ts': 'home',
      'src/project/clone-json.ts': 'home',
      'src/components/onboarding/tour-placement.ts':
        'the lower bound wins when the viewport is smaller than the tooltip',
    },
  },
];

function sourceFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', 'src/**/*.ts', 'src/**/*.vue'],
    {
      cwd: ROOT,
    },
  )
    .toString()
    .trim()
    .split('\n')
    .filter((file) => file !== '');
}

describe('shared helpers and constants are used, not re-spelled', () => {
  const files = sourceFiles().map((file) => ({
    file,
    lines: readFileSync(path.join(ROOT, file), 'utf8').split('\n'),
  }));

  for (const rule of RULES) {
    it(`${rule.name} only in ${rule.home}`, () => {
      const homes = new Set(rule.home.split(', '));
      const hits: string[] = [];
      for (const { file, lines } of files) {
        if (homes.has(file) || rule.allowed?.[file] !== undefined) continue;
        lines.forEach((line, index) => {
          if (rule.pattern.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }

  it('lists no allowance for a file that no longer needs it', () => {
    const stale: string[] = [];
    for (const rule of RULES) {
      for (const file of Object.keys(rule.allowed ?? {})) {
        if (rule.allowed?.[file] === 'home') continue;
        const entry = files.find((candidate) => candidate.file === file);
        if (!entry?.lines.some((line) => rule.pattern.test(line)))
          stale.push(`${rule.name}: ${file}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
