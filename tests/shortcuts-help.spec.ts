import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ShortcutsHelp from '@/components/settings/ShortcutsHelp.vue';
import { useShortcuts } from '@/composables/useShortcuts';
import {
  resetShortcutBlockingOverlaysForTest,
  shortcutBlockingOverlayOpen,
} from '@/ui/overlay-registry';
import { SHORTCUT_ACTIONS } from '@/ui/settings/shortcuts';

let wrapper: VueWrapper | null = null;

function open(): VueWrapper {
  wrapper = mount(ShortcutsHelp, { props: { open: true }, attachTo: document.body });
  return wrapper;
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

function qa<T extends Element = HTMLElement>(selector: string): T[] {
  return [...document.body.querySelectorAll<T>(selector)];
}

beforeEach(() => {
  resetShortcutBlockingOverlaysForTest();
  window.localStorage.clear();
  useShortcuts().resetAll();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.textContent = '';
  resetShortcutBlockingOverlaysForTest();
});

describe('ShortcutsHelp', () => {
  it('renders nothing while closed', () => {
    wrapper = mount(ShortcutsHelp, { props: { open: false } });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('shows a section per scope', () => {
    open();
    const titles = qa('.scope-title').map((node) => node.textContent);
    expect(titles).toEqual(['Everywhere', 'Arrangement', 'Editor']);
  });

  it('lists every registered action', () => {
    open();
    const labels = qa('.shortcut-label').map((node) => node.textContent);
    expect(labels).toHaveLength(SHORTCUT_ACTIONS.length);
    for (const action of SHORTCUT_ACTIONS) {
      expect(labels).toContain(action.label);
    }
  });

  it('shows fixed key labels for non-customizable entries', () => {
    open();
    expect(document.body.textContent).toContain('A W S E D F T G Y H U J K');
  });

  it('reflects user remapping', async () => {
    useShortcuts().setKeys('edit.quantizeSelection', ['mod+9']);
    open();
    await nextTick();
    const rows = qa('.shortcut-label');
    const index = rows.findIndex((node) => node.textContent === 'Quantize selection');
    expect(index).toBeGreaterThanOrEqual(0);
    const keys = qa('.shortcut-keys')[index].textContent ?? '';
    expect(keys === '⌘9' || keys === 'Ctrl+9').toBe(true);
  });

  it('joins multiple bindings with a separator', () => {
    open();
    const rows = qa('.shortcut-label');
    const index = rows.findIndex((node) => node.textContent === 'Delete selected notes');
    expect(qa('.shortcut-keys')[index].textContent).toContain(' / ');
  });

  it('emits close on Escape and on overlay click', async () => {
    const w = open();
    q('[role="dialog"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(w.emitted('close')).toHaveLength(1);
    q('.modal-scrim')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(w.emitted('close')).toHaveLength(2);
  });

  it('moves focus into the overlay when opened', async () => {
    open();
    await nextTick();
    await nextTick();
    const dialog = q<HTMLElement>('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('registers the Help modal as a background-shortcut blocker', () => {
    open();
    expect(shortcutBlockingOverlayOpen.value).toBe(true);
  });
});
