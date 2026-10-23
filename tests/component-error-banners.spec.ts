import { readFileSync } from 'node:fs';
import { shallowMount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MixerPanel from '@/components/mixer/MixerPanel.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { PayloadMemoryLimitError } from '@/lib/payload-memory';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { MESSAGES } from '@/ui/i18n';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const thrown = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/project/commands', async (importActual) => {
  const actual = await importActual<typeof import('@/project/commands')>();
  return {
    ...actual,
    addMixerBus: () => {
      throw thrown.value;
    },
  };
});

describe('component error banners', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  afterEach(() => {
    useAppSettings().update({ language: 'en' });
  });

  async function addBusBanner(): Promise<string> {
    const wrapper = shallowMount(MixerPanel, {
      global: {
        directives: { tooltip: {} },
        stubs: { ChannelStrip: true, BusStrip: true, VcaStrip: true, MixerSnapshots: true },
      },
    });
    const button = wrapper
      .findAll('.toolbar-button')
      .find(
        (entry) =>
          entry.text() === MESSAGES[useAppSettings().resolvedLanguage.value].shell.mixer.addBus,
      );
    await button?.trigger('click');
    return wrapper.find('.mixer-error').text();
  }

  for (const language of ['en', 'ja'] as const) {
    it(`renders a thrown engine code in ${language}`, async () => {
      useAppSettings().update({ language });
      thrown.value = 1234;
      const banner = await addBusBanner();
      expect(banner).toBe(
        MESSAGES[language].notices.errors.engineRejected.replace('{code}', '1234'),
      );
    });

    it(`renders a payload memory limit in ${language}`, async () => {
      useAppSettings().update({ language });
      thrown.value = new PayloadMemoryLimitError(
        'audio-export',
        300 * 1024 * 1024,
        200 * 1024 * 1024,
      );
      const banner = await addBusBanner();
      expect(banner).toBe(
        MESSAGES[language].notices.errors.memoryLimit['audio-export']
          .replace('{required}', '300')
          .replace('{budget}', '200'),
      );
    });
  }

  it('routes every banner in every component through describeError', () => {
    for (const path of [
      'src/components/arrangement/TrackHeaderList.vue',
      'src/components/devices/DeviceRack.vue',
      'src/components/mixer/MixerPanel.vue',
      'src/components/step-sequencer/StepSequencer.vue',
      'src/components/arrangement/ArrangementView.vue',
      'src/components/arrangement/TranscribeDialog.vue',
      'src/components/compose/TrackGenerateDialog.vue',
      'src/components/devices/PatchEditor.vue',
      'src/components/mastering/MasteringPanel.vue',
      'src/components/mixer/InsertRack.vue',
      'src/components/mixer/MixSuggestDialog.vue',
      'src/components/piano-roll/use-piano-roll-viewport.ts',
      'src/components/sample-editor/SampleEditor.vue',
      'src/components/score/ScorePanel.vue',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/\berrorMessage\(/);
    }
  });
});
