import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PianoRollToolbar from '@/components/piano-roll/PianoRollToolbar.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { vTooltip } from '@/ui/tooltip';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('PianoRollToolbar view popover outside-press dismissal', () => {
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
        clipId: store.clipId,
        noteCount: 0,
      },
      global: { directives: { tooltip: vTooltip } },
      attachTo: document.body,
    });
  });

  it('closes on a press outside, but not on the popover or a teleported listbox', async () => {
    await wrapper!.find('.tb-menu').trigger('click');
    const popover = () => wrapper!.find('.view-popover');
    expect(popover().exists()).toBe(true);

    popover().element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wrapper!.vm.$nextTick();
    expect(popover().exists()).toBe(true);

    const listbox = document.createElement('ul');
    listbox.setAttribute('role', 'listbox');
    document.body.appendChild(listbox);
    listbox.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wrapper!.vm.$nextTick();
    expect(popover().exists()).toBe(true);

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wrapper!.vm.$nextTick();
    expect(popover().exists()).toBe(false);
  });
});
