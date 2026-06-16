import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import SettingsDialog from '@/components/settings/SettingsDialog.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useLayouts } from '@/composables/useLayouts';
import { useShortcuts } from '@/composables/useShortcuts';
import type { DockTabId, LayoutBindings } from '@/ui/settings/layouts';
import { selectOption } from './helpers/select-menu';

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

beforeEach(() => {
  window.localStorage.clear();
  useAppSettings().reset();
  useShortcuts().resetAll();
  useLayouts().reload();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.textContent = '';
});

describe('SettingsDialog', () => {
  it('renders nothing while closed', () => {
    wrapper = mount(SettingsDialog, { props: { open: false } });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('shows three tabs with the General panel selected first', () => {
    const w = open();
    const tabs = w.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.text())).toEqual(['General', 'Shortcuts', 'Layouts']);
    expect(tabs[0].attributes('aria-selected')).toBe('true');
    expect(w.find('#settings-panel-general').exists()).toBe(true);
  });

  it('switches tabs by click and by arrow keys', async () => {
    const w = open();
    await w.findAll('[role="tab"]')[1].trigger('click');
    expect(w.find('#settings-panel-shortcuts').exists()).toBe(true);
    await w.find('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' });
    expect(w.find('#settings-panel-layouts').exists()).toBe(true);
    await w.find('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' });
    expect(w.find('#settings-panel-general').exists()).toBe(true);
    await w.find('[role="tablist"]').trigger('keydown', { key: 'ArrowLeft' });
    expect(w.find('#settings-panel-layouts').exists()).toBe(true);
  });

  it('emits close on Escape', async () => {
    const w = open();
    await w.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('writes General changes through the settings store', async () => {
    const w = open();
    const snap = w.findAll('input[type="checkbox"]')[0];
    await snap.setValue(false);
    expect(useAppSettings().settings.snapDefault).toBe(false);
  });

  it('writes language and theme changes through the settings store', async () => {
    const w = open();
    await selectOption(w, '.row:nth-child(2) .row-select', 'Dark');
    await selectOption(w, '.row:nth-child(1) .row-select', 'Japanese');
    expect(useAppSettings().settings.language).toBe('ja');
    expect(useAppSettings().settings.theme).toBe('dark');
  });

  it('rebinds a shortcut by capturing a key press', async () => {
    const w = open();
    await w.findAll('[role="tab"]')[1].trigger('click');
    const row = w.find('[data-action-id="edit.quantizeSelection"]');
    await row.find('button').trigger('click');
    expect(row.text()).toContain('Press keys');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true }));
    expect(useShortcuts().keysFor('edit.quantizeSelection')).toEqual(['mod+j']);
  });

  it('cancels capture with Escape without closing the dialog', async () => {
    const w = open();
    await w.findAll('[role="tab"]')[1].trigger('click');
    const row = w.find('[data-action-id="edit.quantizeSelection"]');
    await row.find('button').trigger('click');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(useShortcuts().keysFor('edit.quantizeSelection')).toEqual(['q']);
    expect(w.emitted('close')).toBeUndefined();
  });

  it('highlights conflicting rows and shows the banner', async () => {
    useShortcuts().setKeys('project.save', ['mod+z']);
    const w = open();
    await w.findAll('[role="tab"]')[1].trigger('click');
    expect(w.find('.conflict-banner').exists()).toBe(true);
    expect(w.find('[data-action-id="project.save"]').classes()).toContain('conflict');
    expect(w.find('[data-action-id="edit.undo"]').classes()).toContain('conflict');
    expect(w.find('[data-action-id="edit.redo"]').classes()).not.toContain('conflict');
  });

  it('resets one shortcut from its row', async () => {
    useShortcuts().setKeys('edit.undo', ['mod+u']);
    const w = open();
    await w.findAll('[role="tab"]')[1].trigger('click');
    const row = w.find('[data-action-id="edit.undo"]');
    const reset = row.findAll('button').find((button) => button.text() === 'Reset');
    expect(reset).toBeDefined();
    await reset!.trigger('click');
    expect(useShortcuts().keysFor('edit.undo')).toEqual(['mod+z']);
  });

  it('filters the shortcut list by search query', async () => {
    const w = open();
    await w.findAll('[role="tab"]')[1].trigger('click');
    await w.find('.shortcut-search').setValue('quantize');
    const ids = w.findAll('tbody [data-action-id]').map((row) => row.attributes('data-action-id'));
    expect(ids).toEqual(['edit.quantizeSelection']);
  });

  it('filters the shortcut list by category', async () => {
    const w = open();
    await w.findAll('[role="tab"]')[1].trigger('click');
    await selectOption(w, '.shortcut-group', 'Tools');
    const ids = w.findAll('tbody [data-action-id]').map((row) => row.attributes('data-action-id'));
    expect(ids).toEqual(['tool.select', 'tool.draw', 'tool.split', 'tool.erase']);
  });

  it('shows an empty state when nothing matches the search', async () => {
    const w = open();
    await w.findAll('[role="tab"]')[1].trigger('click');
    await w.find('.shortcut-search').setValue('zzzznomatch');
    expect(w.findAll('tbody [data-action-id]')).toHaveLength(0);
    expect(w.find('.shortcut-empty').exists()).toBe(true);
  });

  it('offers no edit button for fixed entries', async () => {
    const w = open();
    await w.findAll('[role="tab"]')[1].trigger('click');
    expect(w.find('[data-action-id="typing.notes"]').findAll('button')).toHaveLength(0);
  });

  it('applies a preset layout to the provided bindings', async () => {
    const bindings = makeBindings();
    const w = open(bindings);
    await w.findAll('[role="tab"]')[2].trigger('click');
    const mixRow = w
      .findAll('.layout-item')
      .find((item) => item.find('.layout-name').text() === 'Mix');
    expect(mixRow).toBeDefined();
    await mixRow!.find('button').trigger('click');
    expect(bindings.dockTab.value).toBe('mixer');
    expect(bindings.deviceRackOpen.value).toBe(false);
  });

  it('saves and deletes a user layout', async () => {
    const bindings = makeBindings();
    bindings.dockTab.value = 'steps';
    const w = open(bindings);
    await w.findAll('[role="tab"]')[2].trigger('click');
    await w.find('.layout-save input').setValue('My groove');
    await w.find('.layout-save button').trigger('click');
    expect(useLayouts().userLayouts.value.map((layout) => layout.name)).toEqual(['My groove']);
    const row = w
      .findAll('.layout-item')
      .find((item) => item.find('.layout-name').text() === 'My groove');
    const del = row!.findAll('button').find((button) => button.text() === 'Delete');
    await del!.trigger('click');
    expect(useLayouts().userLayouts.value).toEqual([]);
  });

  it('reports an error when saving under a preset name', async () => {
    const w = open(makeBindings());
    await w.findAll('[role="tab"]')[2].trigger('click');
    await w.find('.layout-save input').setValue('Compose');
    await w.find('.layout-save button').trigger('click');
    expect(w.find('.layout-error').text()).toContain('reserved');
  });

  it('disables layout actions without bindings', async () => {
    const w = open(null);
    await w.findAll('[role="tab"]')[2].trigger('click');
    const apply = w.find('.layout-item button');
    expect(apply.attributes('disabled')).toBeDefined();
  });

  it('traps focus inside the dialog', async () => {
    const w = open();
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    const dialog = w.find('[role="dialog"]').element as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
