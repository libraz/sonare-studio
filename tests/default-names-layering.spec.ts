import { describe, expect, it } from 'vitest';
import { listSourceFiles, readSource } from './helpers/source-text';

/** Layers that must not read the UI language or settings. */
const LOCALE_FREE_DIRS = [
  'src/project',
  'src/export',
  'src/notation',
  'src/compose',
  'src/workers',
] as const;

const FORBIDDEN_IMPORTS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '@/ui/i18n (index)', pattern: /from\s+['"]@\/ui\/i18n['"]/ },
  { label: 'useI18n', pattern: /\buseI18n\b/ },
  { label: '@/composables/useAppSettings', pattern: /@\/composables\/useAppSettings/ },
];

describe('default-name layering', () => {
  it('keeps the language and settings out of the locale-free layers', () => {
    const files = LOCALE_FREE_DIRS.flatMap((dir) => listSourceFiles(dir, ['.ts', '.vue']));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) => {
      const source = readSource(file);
      return FORBIDDEN_IMPORTS.filter(({ pattern }) => pattern.test(source)).map(
        ({ label }) => `${file}: ${label}`,
      );
    });
    expect(offenders).toEqual([]);
  });
});
