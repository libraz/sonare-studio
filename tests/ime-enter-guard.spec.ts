import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSource } from './helpers/source-text';

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

function vueFiles(dir: string): string[] {
  return readdirSync(join(import.meta.dirname, '..', dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? vueFiles(`${dir}/${e.name}`)
      : e.name.endsWith('.vue')
        ? [`${dir}/${e.name}`]
        : [],
  );
}

describe('IME-safe Enter handling', () => {
  it('routes every text-entry Enter handler through isImeComposing', () => {
    const files = vueFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => {
      if (NOT_TEXT_ENTRY.has(file.slice(ROOT.length + 1))) return false;
      const source = readSource(file);
      const handlesEnter = /@keydown\.enter|['"]Enter['"]/.test(source);
      return handlesEnter && !source.includes('isImeComposing');
    });
    expect(offenders).toEqual([]);
  });
});
