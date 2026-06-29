import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppHeader from '@/components/shell/AppHeader.vue';
import type { MenuBarMenu } from '@/ui/menu/menu-bar';

let wrapper: VueWrapper | null = null;

const exportSmf = vi.fn();
const exportMidi2 = vi.fn();

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

const emptyLayoutMenu: MenuBarMenu = { id: 'layout', label: 'Layout', items: [] };

/** Mounts AppHeader and opens the File menu in the command bar. */
async function openFileMenu(): Promise<VueWrapper> {
  wrapper = mount(AppHeader, {
    attachTo: document.body,
    props: {
      autosaveLastSavedAt: null,
      deviceRackOpen: false,
      dirty: false,
      layoutMenu: emptyLayoutMenu,
      menus: [fileMenu()],
      projectName: 'Demo',
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
});
