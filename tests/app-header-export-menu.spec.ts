import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppHeader from '@/components/shell/AppHeader.vue';
import type { MenuBarMenu } from '@/ui/menu/menu-bar';

let wrapper: VueWrapper | null = null;

const exportSmf = vi.fn();
const exportMidi2 = vi.fn();
const openSettings = vi.fn();

/** A File menu carrying the two distinct export actions under test. */
function fileMenu(): MenuBarMenu {
  return {
    id: 'file',
    label: 'File',
    items: [
      { id: 'file.exportSmf', label: 'Export SMF', run: exportSmf },
      { id: 'file.exportMidi2', label: 'Export MIDI 2.0 clip file', run: exportMidi2 },
    ],
  };
}

function optionsMenu(): MenuBarMenu {
  return {
    id: 'options',
    label: 'Options',
    items: [{ id: 'options.settings', label: 'Settings', run: openSettings }],
  };
}

/** Mounts AppHeader and opens the File menu in the command bar. */
async function openFileMenu(): Promise<VueWrapper> {
  wrapper = mount(AppHeader, {
    attachTo: document.body,
    props: {
      autosaveLastSavedAt: null,
      canRedo: false,
      canUndo: false,
      deviceRackOpen: false,
      dirty: false,
      menus: [fileMenu()],
      projectName: 'Demo',
      resolvedTheme: 'light',
    },
  });
  const trigger = wrapper.findAll('button').find((node) => node.text() === 'File');
  await trigger?.trigger('click');
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  exportSmf.mockReset();
  exportMidi2.mockReset();
  openSettings.mockReset();
  document.body.textContent = '';
});

describe('AppHeader export menu', () => {
  it('offers SMF and MIDI 2.0 clip-file exports as distinct menu items', async () => {
    const w = await openFileMenu();
    const labels = w.findAll('[role="menuitem"]').map((node) => node.text());
    expect(labels).toContain('Export SMF');
    expect(labels).toContain('Export MIDI 2.0 clip file');
  });

  it('runs the MIDI 2.0 action when its item is clicked', async () => {
    const w = await openFileMenu();
    const item = w
      .findAll('[role="menuitem"]')
      .find((node) => node.text() === 'Export MIDI 2.0 clip file');
    expect(item).toBeDefined();
    await item?.trigger('click');
    expect(exportMidi2).toHaveBeenCalledTimes(1);
    // The legacy SMF export stays a separate action.
    expect(exportSmf).not.toHaveBeenCalled();
  });

  it('offers settings from the Options menu', async () => {
    wrapper = mount(AppHeader, {
      attachTo: document.body,
      props: {
        autosaveLastSavedAt: null,
        canRedo: false,
        canUndo: false,
        deviceRackOpen: false,
        dirty: false,
        menus: [optionsMenu()],
        projectName: 'Demo',
        resolvedTheme: 'light',
      },
    });
    const trigger = wrapper.findAll('button').find((node) => node.text() === 'Options');
    await trigger?.trigger('click');
    const item = wrapper.findAll('[role="menuitem"]').find((node) => node.text() === 'Settings');
    await item?.trigger('click');
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('emits one theme toggle action from the right-side button', async () => {
    wrapper = mount(AppHeader, {
      attachTo: document.body,
      props: {
        autosaveLastSavedAt: null,
        canRedo: false,
        canUndo: false,
        deviceRackOpen: false,
        dirty: false,
        menus: [fileMenu()],
        projectName: 'Demo',
        resolvedTheme: 'dark',
      },
    });
    await wrapper.get('.theme-toggle').trigger('click');
    expect(wrapper.emitted('toggleTheme')).toHaveLength(1);
  });

  it('renders permanent undo and redo controls with disabled state', async () => {
    wrapper = mount(AppHeader, {
      attachTo: document.body,
      props: {
        autosaveLastSavedAt: null,
        canRedo: false,
        canUndo: true,
        deviceRackOpen: false,
        dirty: false,
        menus: [fileMenu()],
        projectName: 'Demo',
        resolvedTheme: 'dark',
      },
    });

    expect(wrapper.get('.undo-toggle').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('.redo-toggle').attributes('disabled')).toBeDefined();

    await wrapper.get('.undo-toggle').trigger('click');
    await wrapper.setProps({ canRedo: true, canUndo: false });
    await wrapper.get('.redo-toggle').trigger('click');

    expect(wrapper.emitted('undo')).toHaveLength(1);
    expect(wrapper.emitted('redo')).toHaveLength(1);
    expect(wrapper.get('.undo-toggle').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.redo-toggle').attributes('disabled')).toBeUndefined();
  });
});
