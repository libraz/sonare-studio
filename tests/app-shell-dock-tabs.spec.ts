import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appVue = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8');
const appShellCss = readFileSync(resolve(process.cwd(), 'src/ui/shell/app-shell.css'), 'utf8');

describe('editor dock tab strip', () => {
  it('keeps dock tabs in a dedicated scrollable tablist', () => {
    expect(appVue).toContain('<div class="dock-tabs">');
    expect(appVue).toContain(
      '<div v-tablist class="dock-tab-scroll" role="tablist" :aria-label="t.shell.editor.panels">',
    );
  });

  it('allows the tab list to scroll horizontally instead of clipping narrow viewports', () => {
    expect(appShellCss).toMatch(/\.dock-tabs\s*\{[^}]*min-width:\s*0;/s);
    expect(appShellCss).toMatch(/\.dock-tab-scroll\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(appShellCss).toMatch(/\.dock-tab\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(appShellCss).toMatch(/\.dock-tab\s*\{[^}]*white-space:\s*nowrap;/s);
  });

  it('uses a full ARIA tab pattern for editor dock panels', () => {
    const tabs = ['roll', 'mixer', 'mastering', 'steps', 'lists', 'media', 'sample'];
    for (const tab of tabs) {
      expect(appVue).toContain(`:id="dockTabId('${tab}')"`);
      expect(appVue).toContain(`:aria-controls="dockPanelId('${tab}')"`);
      expect(appVue).toContain(`:id="dockPanelId('${tab}')"`);
      expect(appVue).toContain('role="tabpanel"');
      expect(appVue).toContain(`:aria-labelledby="dockTabId('${tab}')"`);
    }
  });

  it('keeps the score visibility toggle outside the tablist', () => {
    const tablistStart = appVue.indexOf('class="dock-tab-scroll"');
    const tablistEnd = appVue.indexOf('</div>', tablistStart);
    const scoreToggle = appVue.indexOf('dock-tab-score');

    expect(tablistStart).toBeGreaterThan(-1);
    expect(tablistEnd).toBeGreaterThan(tablistStart);
    expect(scoreToggle).toBeGreaterThan(tablistEnd);
  });

  it('takes roving keyboard navigation from the shared tablist directive', () => {
    // Arrow/Home/End navigation, the single tab stop and focus movement are the
    // directive's contract (tests/roving-directives.spec.ts). A hand-rolled
    // handler here would be a fourth copy of the same index arithmetic.
    expect(appVue).toContain('v-tablist');
    expect(appVue).not.toContain('onDockTabKeydown');
    expect(appVue).not.toContain('moveDockTab');
  });
});
