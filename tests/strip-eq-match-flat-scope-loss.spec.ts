import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StripEqSection from '@/components/mixer/StripEqSection.vue';
import { dialogQueue, resolveDialog } from '@/composables/useDialogs';
import type { ScopeSource } from '@/engine/scope';
import { clearHistory, setStripEq } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('StripEqSection Match flat when the scope goes away mid-confirmation', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);

  beforeEach(async () => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  afterEach(() => {
    process.off('unhandledRejection', onRejection);
  });

  it('ends quietly and leaves the bands alone', async () => {
    const store = useProjectStore();
    const trackId = store.tracks[0].id;
    const existing = { type: 'peak' as const, frequencyHz: 1000, gainDb: 4, q: 1, enabled: true };
    setStripEq(trackId, { enabled: true, bands: [existing] });
    const spectrum = new Float32Array(64).fill(-56);
    spectrum[2] = -30;
    const scope: ScopeSource = {
      available: true,
      sampleRate: 48000,
      latest: { frame: 1, bands: spectrum, points: new Float32Array() },
      subscribe: () => () => {},
    };
    const wrapper = mount(StripEqSection, {
      props: { target: trackId, scope },
      global: { stubs: { MixerKnob: true }, directives: { tooltip: () => {} } },
    });

    await wrapper.get('.eq-match').trigger('click');
    const request = dialogQueue[0];
    if (!request) throw new Error('expected Match flat confirmation');
    await wrapper.setProps({ scope: null });
    resolveDialog(request.id, true);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(rejections).toEqual([]);
  });
});
