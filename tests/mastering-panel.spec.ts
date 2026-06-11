import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import MasteringPanel from '@/components/mastering/MasteringPanel.vue';
import type { ExportRenderOptions } from '@/export/client';
import type { MixdownProgressFn, MixdownResult } from '@/export/mixdown';
import { addMasteringProcessor, clearHistory, setMasteringEnabled, undo } from '@/project/commands';
import type { ProjectDocument } from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

function makeResult(value: number): MixdownResult {
  return {
    channels: [new Float32Array([value]), new Float32Array([value])],
    sampleRate: 48000,
    totalFrames: 1,
    report: { peakDb: -6, truePeakDb: -0.1, lufs: -14 },
  };
}

interface FakeRenderCall {
  doc: ProjectDocument;
  options: ExportRenderOptions;
  onProgress?: MixdownProgressFn;
  cancel: ReturnType<typeof vi.fn>;
  resolve: (result: MixdownResult) => void;
  reject: (error: Error) => void;
}

/** Render-function double exposing each call's settle hooks. */
function makeFakeRender() {
  const calls: FakeRenderCall[] = [];
  const render = (
    doc: ProjectDocument,
    options: ExportRenderOptions,
    onProgress?: MixdownProgressFn,
  ) => {
    let resolve!: (result: MixdownResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<MixdownResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const call: FakeRenderCall = { doc, options, cancel: vi.fn(), resolve, reject };
    if (onProgress) call.onProgress = onProgress;
    calls.push(call);
    return { result, cancel: call.cancel };
  };
  return { calls, render };
}

/** Lets queued promise continuations and re-renders run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

describe('MasteringPanel.vue', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('shows the empty chain with no preset selected', () => {
    const wrapper = mount(MasteringPanel);
    expect(wrapper.find('.preset-button').text()).toContain('No preset');
    expect(wrapper.findAll('.chain-slot')).toHaveLength(0);
    expect(wrapper.find('.chain-add').exists()).toBe(true);
  });

  it('selects a preset from the searchable dropdown as an undoable edit', async () => {
    const wrapper = mount(MasteringPanel);
    await wrapper.find('.preset-button').trigger('click');
    // The fake wasm catalog feeds the menu.
    const items = wrapper.findAll('.preset-item:not(.none)');
    expect(items.length).toBe(5);

    await wrapper.find('.preset-search').setValue('hip');
    const filtered = wrapper.findAll('.preset-item:not(.none)');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].text()).toBe('Hip Hop');

    await filtered[0].trigger('click');
    expect(store.mixer.masteringChain?.preset).toBe('hipHop');
    expect(wrapper.find('.preset-button').text()).toContain('Hip Hop');
    expect(wrapper.find('.preset-menu').exists()).toBe(false);

    undo();
    await nextTick();
    expect(store.mixer.masteringChain?.preset).toBeUndefined();
    expect(wrapper.find('.preset-button').text()).toContain('No preset');
  });

  it('clears the preset via the "No preset" item', async () => {
    const wrapper = mount(MasteringPanel);
    await wrapper.find('.preset-button').trigger('click');
    await wrapper.findAll('.preset-item:not(.none)')[0].trigger('click');
    expect(store.mixer.masteringChain?.preset).toBe('pop');

    await wrapper.find('.preset-button').trigger('click');
    await wrapper.find('.preset-item.none').trigger('click');
    expect(store.mixer.masteringChain?.preset).toBeUndefined();
  });

  it('adds a processor from the category-grouped catalog and expands its knobs', async () => {
    const wrapper = mount(MasteringPanel);
    await wrapper.find('.chain-add').trigger('click');
    expect(wrapper.findAll('.catalog-category').map((c) => c.text())).toEqual([
      'Dynamics',
      'EQ',
      'Saturation',
      'Stereo',
    ]);

    await wrapper.find('.catalog-item').trigger('click');
    expect(store.mixer.masteringChain?.processors).toEqual([
      { processor: 'dynamics.compressor', params: {}, enabled: true },
    ]);
    const slot = wrapper.find('.chain-slot');
    expect(slot.find('.chain-name').text()).toBe('Compressor');
    expect(slot.find('.chain-badge').text()).toBe('Dynamics');
    // The new slot opens expanded with one knob per catalog parameter.
    expect(wrapper.findAll('.chain-params .knob').length).toBe(6);
  });

  it('edits a parameter through gesture-coalescing knob changes', async () => {
    addMasteringProcessor('eq.tilt');
    const wrapper = mount(MasteringPanel);
    await wrapper.find('.chain-name').trigger('click');
    const knobs = wrapper.findAll('.chain-params .knob');
    expect(knobs.length).toBe(2);

    const vm = wrapper.findComponent({ name: 'MixerKnob' });
    // Simulate a drag: two intermediate values then a committing release.
    vm.vm.$emit('change', 2, false);
    vm.vm.$emit('change', 3.5, false);
    vm.vm.$emit('change', 3.5, true);
    expect(store.mixer.masteringChain?.processors[0].params.tiltDb).toBe(3.5);

    // The whole drag coalesced into one history entry.
    undo();
    expect(store.mixer.masteringChain?.processors[0]?.params.tiltDb).toBeUndefined();
  });

  it('bypasses and removes processors', async () => {
    addMasteringProcessor('eq.tilt');
    const wrapper = mount(MasteringPanel);

    await wrapper.find('.chain-power').trigger('click');
    expect(store.mixer.masteringChain?.processors[0].enabled).toBe(false);
    expect(wrapper.find('.chain-slot').classes()).toContain('bypassed');

    await wrapper.find('.chain-remove').trigger('click');
    expect(store.mixer.masteringChain).toBeUndefined();
    expect(wrapper.findAll('.chain-slot')).toHaveLength(0);
  });

  it('reorders processors by drag and drop, preserving bypass state', async () => {
    addMasteringProcessor('eq.tilt', { tiltDb: 2 });
    addMasteringProcessor('saturation.tape');
    setMasteringEnabled(0, false);
    const wrapper = mount(MasteringPanel);

    const rows = wrapper.findAll('.chain-slot');
    await rows[0].trigger('dragstart');
    await rows[1].trigger('drop');

    expect(store.mixer.masteringChain?.processors).toEqual([
      { processor: 'saturation.tape', params: {}, enabled: true },
      { processor: 'eq.tilt', params: { tiltDb: 2 }, enabled: false },
    ]);
    const names = wrapper.findAll('.chain-name').map((name) => name.text());
    expect(names).toEqual(['Tape', 'Tilt']);
  });

  it('renders a preview over the first 8 bars and shows the loudness readout', async () => {
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });

    await wrapper.find('.preview-button').trigger('click');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].options.range).toEqual({ startPpq: 0, endPpq: 32 });
    expect(fake.calls[0].doc.mixer?.masteringChain).toBeDefined();
    expect(wrapper.find('.preview-progress').exists()).toBe(true);
    expect(wrapper.find('.preview-button').attributes('disabled')).toBeDefined();

    fake.calls[0].onProgress?.(0.5, 'eq.tilt');
    await nextTick();
    expect(wrapper.find('.progress-stage').text()).toBe('eq.tilt');

    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    // Second render is the chain-bypassed A/B baseline.
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].doc.mixer?.masteringChain).toBeUndefined();
    fake.calls[1].resolve(makeResult(0.25));
    await flush();

    expect(wrapper.find('.preview-progress').exists()).toBe(false);
    expect(wrapper.findAll('.loudness-row')).toHaveLength(3);
    expect(wrapper.find('.loudness-value').text()).toContain('-6.0');
    // truePeakDb -0.1 exceeds the -0.3 dBTP warning threshold.
    expect(wrapper.find('.clip-warning').exists()).toBe(true);
    const abButtons = wrapper.findAll('.ab-button');
    expect(abButtons[0].attributes('disabled')).toBeUndefined();
    expect(abButtons[1].attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.play-button').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.preview-stale').exists()).toBe(false);
  });

  it('uses the loop window as the preview range when a loop is active', async () => {
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, {
      props: {
        renderMixdown: fake.render,
        loopEnabled: true,
        loopStartPpq: 8,
        loopEndPpq: 24,
      },
    });
    await wrapper.find('.preview-button').trigger('click');
    expect(fake.calls[0].options.range).toEqual({ startPpq: 8, endPpq: 24 });
  });

  it('marks the preview stale after a project edit', async () => {
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    expect(wrapper.find('.preview-stale').exists()).toBe(false);

    addMasteringProcessor('eq.tilt');
    await flush();
    expect(wrapper.find('.preview-stale').exists()).toBe(true);
  });

  it('surfaces render failures and recovers on the next preview', async () => {
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].reject(new Error('render exploded'));
    await flush();
    expect(wrapper.find('.preview-pane .mastering-error').text()).toBe('render exploded');

    await wrapper.find('.preview-button').trigger('click');
    expect(fake.calls).toHaveLength(2);
    fake.calls[1].resolve(makeResult(0.5));
    await flush();
    expect(wrapper.find('.preview-pane .mastering-error').exists()).toBe(false);
    expect(wrapper.findAll('.loudness-row')).toHaveLength(3);
  });

  it('cancels an in-flight preview render', async () => {
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
    await wrapper.find('.preview-button').trigger('click');
    await wrapper.find('.preview-cancel').trigger('click');
    expect(fake.calls[0].cancel).toHaveBeenCalled();
    expect(wrapper.find('.preview-progress').exists()).toBe(false);
    expect(wrapper.find('.preview-button').attributes('disabled')).toBeUndefined();
  });
});
