import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PatchEditor from '@/components/devices/PatchEditor.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { resetShortcutBlockingOverlaysForTest } from '@/ui/overlay-registry';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const auditionMock = vi.hoisted(() => ({
  play: vi.fn(async () => {}),
  stop: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('@/ui/devices/audition', () => ({
  createPatchAudition: vi.fn(() => auditionMock),
}));

describe('PatchEditor audition when the host closes the dialog', () => {
  beforeEach(async () => {
    resetShortcutBlockingOverlaysForTest();
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
  });

  it('stops a running audition after Apply closes the dialog', async () => {
    const trackId = useProjectStore().tracks[0].id;
    const wrapper = mount(PatchEditor, { props: { open: true, trackId } });
    const button = (label: string) => wrapper.findAll('button').find((b) => b.text() === label);
    await button('Audition')?.trigger('click');
    await button('Apply')?.trigger('click');
    expect(wrapper.emitted('applied')).toHaveLength(1);

    await wrapper.setProps({ open: false });

    expect(auditionMock.stop).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
