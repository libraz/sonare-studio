import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import SettingsDialog from '@/components/settings/SettingsDialog.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { dialogQueue, resolveDialog } from '@/composables/useDialogs';
import { useLayouts } from '@/composables/useLayouts';
import { useShortcuts } from '@/composables/useShortcuts';
import type { DockTabId, LayoutBindings } from '@/ui/settings/layouts';
import { chooseOption } from './helpers/select-menu';

// AppModal teleports its content (and SelectMenu its dropdown) to <body>, so the
// dialog is queried through the document rather than the wrapper, and events are
// dispatched natively. The mounts use attachTo: document.body so the teleported
// trees live in the real document where the SelectMenu helper looks for options.

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

function qa<T extends Element = HTMLElement>(selector: string): T[] {
  return Array.from(document.body.querySelectorAll<T>(selector));
}

/** Opens the SelectMenu matched by `selector` and picks the option `label`. */
async function selectOption(selector: string, label: string): Promise<void> {
  q(`${selector} .select-trigger`)?.click();
  await flushPromises();
  await chooseOption(label);
}

/**
 * Opens the SelectMenu whose trigger carries `aria-label` and picks `label`.
 * The grouped settings list no longer exposes a stable positional selector, so
 * rows are addressed by their accessible label instead of DOM order.
 */
async function selectByAria(ariaLabel: string, label: string): Promise<void> {
  q(`.select-trigger[aria-label="${ariaLabel}"]`)?.click();
  await flushPromises();
  await chooseOption(label);
}

/** Dispatches a bubbling keydown on the given element. */
async function keydownOn(
  el: Element | null,
  key: string,
  init: KeyboardEventInit = {},
): Promise<void> {
  el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  await nextTick();
}

function makeBindings(): LayoutBindings {
  return {
    arrangeHeightPx: ref(260),
    dockTab: ref<DockTabId>('roll'),
    deviceRackOpen: ref(true),
    scoreOpen: ref(false),
    dockCollapsed: ref(false),
  };
}

let wrapper: VueWrapper | null = null;

function open(layoutBindings: LayoutBindings | null = null): VueWrapper {
  wrapper = mount(SettingsDialog, {
    props: { open: true, layoutBindings },
    attachTo: document.body,
  });
  return wrapper;
}

/** Clicks the tab at `index` and waits for the panel swap. */
async function clickTab(index: number): Promise<void> {
  qa('[role="tab"]')[index].click();
  await nextTick();
}

beforeEach(() => {
  window.localStorage.clear();
  useAppSettings().reset();
  useShortcuts().resetAll();
  useLayouts().reload();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('SettingsDialog', () => {
  it('renders nothing while closed', () => {
    wrapper = mount(SettingsDialog, { props: { open: false }, attachTo: document.body });
    expect(q('[role="dialog"]')).toBeNull();
  });

  it('shows three tabs with the General panel selected first', () => {
    open();
    const tabs = qa('[role="tab"]');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['General', 'Shortcuts', 'Layouts']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(q('#settings-panel-general')).not.toBeNull();
  });

  it('switches tabs by click and by arrow keys', async () => {
    open();
    await clickTab(1);
    expect(q('#settings-panel-shortcuts')).not.toBeNull();
    await keydownOn(q('[role="tablist"]'), 'ArrowRight');
    expect(q('#settings-panel-layouts')).not.toBeNull();
    await keydownOn(q('[role="tablist"]'), 'ArrowRight');
    expect(q('#settings-panel-general')).not.toBeNull();
    await keydownOn(q('[role="tablist"]'), 'ArrowLeft');
    expect(q('#settings-panel-layouts')).not.toBeNull();
  });

  it('emits close on Escape', async () => {
    const w = open();
    await keydownOn(q('[role="dialog"]'), 'Escape');
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('writes General changes through the settings store', async () => {
    open();
    const snap = q<HTMLButtonElement>('button[aria-label="Snap to grid by default"]');
    expect(snap?.getAttribute('aria-pressed')).toBe('true');
    expect(snap?.textContent?.trim()).toBe('On');
    snap?.click();
    await nextTick();
    expect(useAppSettings().settings.snapDefault).toBe(false);
    expect(snap?.getAttribute('aria-pressed')).toBe('false');
    expect(snap?.textContent?.trim()).toBe('Off');
  });

  it('writes language and theme changes through the settings store', async () => {
    open();
    await selectByAria('Theme', 'Dark');
    await selectByAria('Language', 'Japanese');
    expect(useAppSettings().settings.language).toBe('ja');
    expect(useAppSettings().settings.theme).toBe('dark');
  });

  it('writes the default recording source through the settings store', async () => {
    open();
    await selectByAria('Recording source', 'Master output');
    expect(useAppSettings().settings.recordingCaptureSource).toBe('output');
  });

  it('adds a captured shortcut without discarding existing bindings', async () => {
    open();
    await clickTab(1);
    const row = q('[data-action-id="edit.quantizeSelection"]');
    row?.querySelector('button')?.click();
    await nextTick();
    expect(row?.textContent).toContain('Press keys');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
    expect(useShortcuts().keysFor('edit.quantizeSelection')).toEqual(['q', 'mod+j']);
  });

  it('can clear a shortcut binding entirely', async () => {
    open();
    await clickTab(1);
    const row = q('[data-action-id="edit.quantizeSelection"]');
    const clear = Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Clear',
    );
    clear?.click();
    await nextTick();
    expect(useShortcuts().keysFor('edit.quantizeSelection')).toEqual([]);
  });

  it('cancels capture with Escape without closing the dialog', async () => {
    const w = open();
    await clickTab(1);
    const row = q('[data-action-id="edit.quantizeSelection"]');
    row?.querySelector('button')?.click();
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(useShortcuts().keysFor('edit.quantizeSelection')).toEqual(['q']);
    expect(w.emitted('close')).toBeUndefined();
  });

  it('removes the shortcut capture keydown listener when unmounted mid-capture', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const w = open();
    await clickTab(1);
    const row = q('[data-action-id="edit.quantizeSelection"]');
    row?.querySelector('button')?.click();
    await nextTick();

    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    w.unmount();
    wrapper = null;
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true);
  });

  it('highlights conflicting rows and shows the banner', async () => {
    useShortcuts().setKeys('project.save', ['mod+z']);
    open();
    await clickTab(1);
    expect(q('.conflict-banner')).not.toBeNull();
    expect(q('[data-action-id="project.save"]')?.classList.contains('conflict')).toBe(true);
    expect(q('[data-action-id="edit.undo"]')?.classList.contains('conflict')).toBe(true);
    expect(q('[data-action-id="edit.redo"]')?.classList.contains('conflict')).toBe(false);
  });

  it('resets one shortcut from its row', async () => {
    useShortcuts().setKeys('edit.undo', ['mod+u']);
    open();
    await clickTab(1);
    const row = q('[data-action-id="edit.undo"]');
    const reset = Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Reset',
    );
    expect(reset).toBeDefined();
    reset?.click();
    await nextTick();
    expect(useShortcuts().keysFor('edit.undo')).toEqual(['mod+z']);
  });

  it('filters the shortcut list by search query', async () => {
    open();
    await clickTab(1);
    const search = q<HTMLInputElement>('input[aria-label="Search shortcuts"]');
    if (!search) throw new Error('search input not found');
    search.value = 'quantize';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const ids = qa('tbody [data-action-id]').map((row) => row.getAttribute('data-action-id'));
    expect(ids).toEqual(['edit.quantizeSelection']);
  });

  it('filters the shortcut list by category', async () => {
    open();
    await clickTab(1);
    await selectOption('.shortcut-group', 'Tools');
    const ids = qa('tbody [data-action-id]').map((row) => row.getAttribute('data-action-id'));
    expect(ids).toEqual(['tool.select', 'tool.draw', 'tool.split', 'tool.erase']);
  });

  it('shows an empty state when nothing matches the search', async () => {
    open();
    await clickTab(1);
    const search = q<HTMLInputElement>('input[aria-label="Search shortcuts"]');
    if (!search) throw new Error('search input not found');
    search.value = 'zzzznomatch';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(qa('tbody [data-action-id]')).toHaveLength(0);
    expect(q('.shortcut-empty')).not.toBeNull();
  });

  it('offers no edit button for fixed entries', async () => {
    open();
    await clickTab(1);
    expect(q('[data-action-id="typing.notes"]')?.querySelectorAll('button')).toHaveLength(0);
  });

  it('applies a preset layout to the provided bindings', async () => {
    const bindings = makeBindings();
    open(bindings);
    await clickTab(2);
    const mixRow = qa('.settings-row').find(
      (item) => item.querySelector('.layout-name')?.textContent?.trim() === 'Mix',
    );
    expect(mixRow).toBeDefined();
    mixRow?.querySelector('button')?.click();
    await nextTick();
    expect(bindings.dockTab.value).toBe('mixer');
    expect(bindings.deviceRackOpen.value).toBe(false);
  });

  it('saves and deletes a user layout', async () => {
    const bindings = makeBindings();
    bindings.dockTab.value = 'steps';
    open(bindings);
    await clickTab(2);
    const nameInput = q<HTMLInputElement>('.layout-save input');
    if (!nameInput) throw new Error('layout name input not found');
    nameInput.value = 'My groove';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    q('.layout-save button')?.click();
    await nextTick();
    expect(useLayouts().userLayouts.value.map((layout) => layout.name)).toEqual(['My groove']);
    const row = qa('.settings-row').find(
      (item) => item.querySelector('.layout-name')?.textContent?.trim() === 'My groove',
    );
    const del = Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Delete',
    );
    useAppSettings().set('confirmDestructive', false);
    del?.click();
    await nextTick();
    expect(useLayouts().userLayouts.value).toEqual([]);
  });

  it('keeps a saved layout when destructive-confirmation is cancelled', async () => {
    const bindings = makeBindings();
    open(bindings);
    await clickTab(2);
    const nameInput = q<HTMLInputElement>('.layout-save input');
    if (!nameInput) throw new Error('layout name input not found');
    nameInput.value = 'Keep me';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    q('.layout-save button')?.click();
    await nextTick();

    const row = qa('.settings-row').find(
      (item) => item.querySelector('.layout-name')?.textContent?.trim() === 'Keep me',
    );
    Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent?.trim() === 'Delete')
      ?.click();
    await nextTick();
    const request = dialogQueue[0];
    if (!request) throw new Error('expected destructive confirmation');
    resolveDialog(request.id, false);
    await flushPromises();

    expect(useLayouts().userLayouts.value.map((layout) => layout.name)).toEqual(['Keep me']);
  });

  it('reports an error when saving under a preset name', async () => {
    open(makeBindings());
    await clickTab(2);
    const nameInput = q<HTMLInputElement>('.layout-save input');
    if (!nameInput) throw new Error('layout name input not found');
    nameInput.value = 'Compose';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    q('.layout-save button')?.click();
    await nextTick();
    expect(q('.layout-error')?.textContent).toContain('reserved');
  });

  it('disables layout actions without bindings', async () => {
    open(null);
    await clickTab(2);
    const apply = q('.settings-row button');
    expect(apply?.getAttribute('disabled')).not.toBeNull();
  });

  it('moves focus into the dialog when it opens', async () => {
    // AppModal focuses the dialog card on the closed -> open transition, so the
    // focus trap starts inside the modal. Mount closed first to drive that edge.
    const w = mount(SettingsDialog, { props: { open: false }, attachTo: document.body });
    wrapper = w;
    await w.setProps({ open: true });
    await nextTick();
    await nextTick();
    const dialog = q('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);
  });
});
