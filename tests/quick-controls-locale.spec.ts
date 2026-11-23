import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuickControls from '@/components/devices/QuickControls.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('synth quick-control names by language', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;

  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    settings.set('language', 'ja');
  });
  afterEach(() => settings.set('language', previous));

  it('renders the synth control names in Japanese', () => {
    const store = useProjectStore();
    const wrapper = mount(QuickControls, {
      props: { target: { type: 'instrument', trackId: store.tracks[0].id } },
    });
    const names = wrapper.findAll('.qc-name').map((node) => node.text());
    expect(names).toContain('カットオフ');
    expect(names).toContain('リリース');
    expect(names).not.toContain('Cutoff');
  });
});
