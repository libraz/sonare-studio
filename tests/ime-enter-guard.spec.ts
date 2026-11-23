import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listSourceFiles, readSource } from './helpers/source-text';

const ROOT = 'src/components';

/** Enter handlers that are not text entry: menus, lists, tour steps and the modal dispatcher. */
const NOT_TEXT_ENTRY = new Set([
  'accessibility/AccessibleObjectNavigator.vue',
  'onboarding/WelcomeTour.vue',
  'project/NewProjectDialog.vue',
  'project/OpenProjectDialog.vue',
  'shell/AppModal.vue',
  'shell/ContextMenu.vue',
  'shell/MenuBar.vue',
  'shell/SelectMenu.vue',
  'step-sequencer/StepGrid.vue',
]);

/**
 * True when every Enter binding of a component without its own guard is a bare handler
 * name defined in one of its `@/ui` modules, with isImeComposing inside that definition.
 */
function enterHandledByGuardedModules(source: string): boolean {
  if (/['"]Enter['"]/.test(source)) return false;
  const bindings = [...source.matchAll(/@keydown\.enter[\w.]*="([^"]*)"/g)].map((m) => m[1]);
  if (bindings.length === 0 || !bindings.every((b) => /^\w+$/.test(b))) return false;
  const modules = [...source.matchAll(/from '@\/(ui\/[^']+)'/g)]
    .map((m) => `src/${m[1]}.ts`)
    .filter((path) => existsSync(path))
    .map(readSource);
  return bindings.every((name) =>
    modules.some((module) => {
      const from = module.indexOf(`function ${name}(`);
      if (from < 0) return false;
      const to = module.indexOf('\n  }\n', from);
      return module.slice(from, to < 0 ? undefined : to).includes('isImeComposing');
    }),
  );
}

describe('IME-safe Enter handling', () => {
  it('routes every text-entry Enter handler through isImeComposing', () => {
    const files = listSourceFiles(ROOT, ['.vue']);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => {
      if (NOT_TEXT_ENTRY.has(file.slice(ROOT.length + 1))) return false;
      const source = readSource(file);
      const handlesEnter = /@keydown\.enter|['"]Enter['"]/.test(source);
      return (
        handlesEnter && !source.includes('isImeComposing') && !enterHandledByGuardedModules(source)
      );
    });
    expect(offenders).toEqual([]);
  });
});
