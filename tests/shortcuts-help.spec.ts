import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ShortcutsHelp from '@/components/settings/ShortcutsHelp.vue';
import { useShortcuts } from '@/composables/useShortcuts';
import { SHORTCUT_ACTIONS } from '@/ui/settings/shortcuts';

let wrapper: VueWrapper | null = null;

function open(): VueWrapper {
  wrapper = mount(ShortcutsHelp, { props: { open: true }, attachTo: document.body });
  return wrapper;
}

beforeEach(() => {
  window.localStorage.clear();
  useShortcuts().resetAll();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.textContent = '';
});

describe('ShortcutsHelp', () => {
  it('renders nothing while closed', () => {
    wrapper = mount(ShortcutsHelp, { props: { open: false } });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('shows a section per scope', () => {
    const w = open();
    const titles = w.findAll('.scope-title').map((node) => node.text());
    expect(titles).toEqual(['Everywhere', 'Arrangement', 'Editor']);
  });

  it('lists every registered action', () => {
    const w = open();
    const labels = w.findAll('.shortcut-label').map((node) => node.text());
    expect(labels).toHaveLength(SHORTCUT_ACTIONS.length);
    for (const action of SHORTCUT_ACTIONS) {
      expect(labels).toContain(action.label);
    }
  });

  it('shows fixed key labels for non-customizable entries', () => {
    const w = open();
    expect(w.text()).toContain('A W S E D F T G Y H U J K');
  });

  it('reflects user remapping', async () => {
    useShortcuts().setKeys('edit.quantizeSelection', ['mod+9']);
    const w = open();
    await w.vm.$nextTick();
    const rows = w.findAll('.shortcut-label');
    const index = rows.findIndex((node) => node.text() === 'Quantize selection');
    expect(index).toBeGreaterThanOrEqual(0);
    const keys = w.findAll('.shortcut-keys')[index].text();
    expect(keys === '⌘9' || keys === 'Ctrl+9').toBe(true);
  });

  it('joins multiple bindings with a separator', () => {
    const w = open();
    const rows = w.findAll('.shortcut-label');
    const index = rows.findIndex((node) => node.text() === 'Delete selected notes');
    expect(w.findAll('.shortcut-keys')[index].text()).toContain(' / ');
  });

  it('emits close on Escape and on overlay click', async () => {
    const w = open();
    await w.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    expect(w.emitted('close')).toHaveLength(1);
    await w.find('.dialog-overlay').trigger('click');
    expect(w.emitted('close')).toHaveLength(2);
  });

  it('moves focus into the overlay when opened', async () => {
    const w = open();
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    const dialog = w.find('[role="dialog"]').element as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
