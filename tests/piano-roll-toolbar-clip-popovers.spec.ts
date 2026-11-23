import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PianoRollToolbar from '@/components/piano-roll/PianoRollToolbar.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Toolbar dialog triggers in template order: View, MIDI FX, decoration, legend. */
const FX = 1;
const ORNAMENT = 2;

let wrapper: VueWrapper | null = null;

beforeEach(async () => {
  setActivePinia(createPinia());
  const store = useProjectStore();
  store.dispose();
  clearHistory();
  await store.init();
  wrapper = mount(PianoRollToolbar, {
    props: {
      overlayEnabled: true,
      fxPanelOpen: false,
      laneVisible: true,
      snapToScale: false,
      ghostMode: 'all',
      ghostHideMuted: true,
      noteColorMode: 'track',
      auditionDrag: true,
      autoReharmonize: false,
      placementGuide: true,
      guidanceTint: true,
      canTransform: true,
      clipId: 1,
      noteCount: 0,
    },
    attachTo: document.body,
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

function expanded(index: number): string | undefined {
  return wrapper!.findAll('button[aria-haspopup="dialog"]')[index].attributes('aria-expanded');
}

async function openPopover(index: number): Promise<void> {
  await wrapper!.findAll('button[aria-haspopup="dialog"]')[index].trigger('click');
  await flushPromises();
  expect(expanded(index)).toBe('true');
}

describe('PianoRollToolbar clip-targeted popovers', () => {
  it.each([
    ['MIDI FX', FX],
    ['decoration', ORNAMENT],
  ])('closes the %s popover when the active clip changes', async (_name, index) => {
    await openPopover(index);
    await wrapper!.setProps({ clipId: 2 });
    await flushPromises();
    expect(expanded(index)).toBe('false');
  });

  it.each([
    ['MIDI FX', FX],
    ['decoration', ORNAMENT],
  ])('closes the %s popover when the track becomes read-only', async (_name, index) => {
    await openPopover(index);
    await wrapper!.setProps({ readOnly: true });
    await flushPromises();
    expect(expanded(index)).toBe('false');
    await wrapper!.setProps({ readOnly: false });
    await flushPromises();
    expect(expanded(index)).toBe('false');
  });
});
