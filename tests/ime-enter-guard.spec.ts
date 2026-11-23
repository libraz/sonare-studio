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

describe('IME-safe Enter handling', () => {
  it('routes every text-entry Enter handler through isImeComposing', () => {
    const files = listSourceFiles(ROOT, ['.vue']);
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
