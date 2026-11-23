import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import SettingsDialog from '@/components/settings/SettingsDialog.vue';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

/** Tabs whose aria-controls names an element missing from the document. */
function danglingControls(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="tab"][aria-controls]')]
    .map((tab) => tab.getAttribute('aria-controls') ?? '')
    .filter((id) => document.getElementById(id) === null);
}

describe('SettingsDialog tab controls', () => {
  it('points aria-controls only at the rendered panel, on every tab', async () => {
    wrapper = mount(SettingsDialog, {
      props: { open: true, layoutBindings: null },
      attachTo: document.body,
    });
    await flushPromises();
    const tabs = [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.length).toBeGreaterThan(1);
    for (const tab of tabs) {
      tab.click();
      await flushPromises();
      expect(danglingControls()).toEqual([]);
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
    }
  });
});
