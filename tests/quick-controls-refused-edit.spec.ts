import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuickControls from '@/components/devices/QuickControls.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { clearHistory } from '@/project/commands';
import { InsertConfigurationRefusedError } from '@/project/processor-controls';
import { useProjectStore } from '@/project/store';
import { MESSAGES } from '@/ui/i18n';
import { insertEditErrorMessage } from '@/ui/mixer/insert-edit-error';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/project/quick-controls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/project/quick-controls')>()),
  setQuickControl: () => {
    throw new InsertConfigurationRefusedError(
      'dynamics.compressor',
      'thresholdDb',
      ['autoMakeup'],
      'engine detail',
    );
  },
}));

describe('QuickControls refused edit', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('shows the localized coupled-key message instead of the engine text', async () => {
    const settings = useAppSettings();
    const previous = settings.settings.language;
    settings.set('language', 'ja');
    try {
      const store = useProjectStore();
      const wrapper = mount(QuickControls, {
        props: { target: { type: 'instrument', trackId: store.tracks[0].id } },
      });
      await wrapper.find('.qc-knob').trigger('keydown', { key: 'ArrowUp' });
      const error = wrapper.find('.qc-error');
      const expected = insertEditErrorMessage(
        new InsertConfigurationRefusedError(
          'dynamics.compressor',
          'thresholdDb',
          ['autoMakeup'],
          '',
        ),
        MESSAGES.ja,
      );
      expect(error.text()).toBe(expected);
      expect(error.text()).not.toContain('engine detail');
    } finally {
      settings.set('language', previous);
    }
  });
});
