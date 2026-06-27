import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import AppHeader from '@/components/shell/AppHeader.vue';

let wrapper: VueWrapper | null = null;

/** Mounts AppHeader with the project menu open and the minimal props. */
function openHeader(): VueWrapper {
  wrapper = mount(AppHeader, {
    attachTo: document.body,
    props: {
      autosaveLastSavedAt: null,
      deviceRackOpen: false,
      dirty: false,
      helpMenuOpen: false,
      layoutMenuOpen: false,
      layouts: [],
      opfsAvailable: true,
      projectMenuOpen: true,
      projectName: 'Demo',
      recentMenuNames: [],
      shortcutTitle: (base: string) => base,
    },
  });
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.textContent = '';
});

describe('AppHeader export menu', () => {
  it('offers SMF and MIDI 2.0 clip-file exports as distinct menu items', () => {
    const w = openHeader();
    const labels = w.findAll('[role="menuitem"]').map((node) => node.text());
    expect(labels).toContain('Export SMF');
    expect(labels).toContain('Export MIDI 2.0 clip file');
  });

  it('emits exportMidi2 when the MIDI 2.0 item is clicked', async () => {
    const w = openHeader();
    const item = w
      .findAll('[role="menuitem"]')
      .find((node) => node.text() === 'Export MIDI 2.0 clip file');
    expect(item).toBeDefined();
    await item?.trigger('click');
    expect(w.emitted('exportMidi2')).toHaveLength(1);
    // The legacy SMF export stays a separate action.
    expect(w.emitted('exportSmf')).toBeUndefined();
  });
});
