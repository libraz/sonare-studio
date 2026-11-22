import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { nextTick } from 'vue';
import MasteringPanel from '@/components/mastering/MasteringPanel.vue';
import { MIDI_LEARN_KEY, useMidiLearn } from '@/composables/useMidiLearn';
import type { ExportRenderOptions } from '@/export/client';
import type { MixdownProgressFn, MixdownResult } from '@/export/mixdown';
import {
  addMasteringProcessor,
  applyMasteringPresetWithOverrides,
  clearHistory,
  setMasteringEnabled,
  setMasteringPreset,
  undo,
} from '@/project/commands';
import { getWasmModule } from '@/project/runtime';
import type { ProjectDocument } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { DEFAULT_PREVIEW_GAIN } from '@/ui/media/preview';
import { midiLearnMasteringTargetId } from '@/ui/midi/midi-learn';
import type * as WasmModule from '@/wasm/index.js';
import type { MasteringAssistantResult } from '@/wasm/index.js';
import { asAudioContext, createFakeAudioContext } from './fake-audio-context';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const { vi: vitest } = await import('vitest');
  const fakeModule = createFakeWasmModule();
  const suggestion = () => ({
    chainConfig: {},
    explanation: ['base preset: streaming'],
    profile: {
      durationSec: 1,
      bpm: 120,
      bpmConfidence: 0.5,
      integratedLufs: -14,
      loudnessRangeLu: 4,
      truePeakDbtp: -1,
      crestFactorDb: 9,
      spectralCentroidHz: 2000,
      spectralFlatness: 0.1,
      attackPerSecond: 2,
      sustainRatio: 0.5,
    },
  });
  // Distinct entry points remain mockable so tests can tell which one ran.
  Object.assign(fakeModule, {
    masteringAssistantSuggest: vitest.fn(suggestion),
    masteringAssistantSuggestStereo: vitest.fn(suggestion),
  });
  return { ensureWasm: async () => fakeModule };
});

function makeResult(value: number, lufs = -14): MixdownResult {
  return {
    channels: [new Float32Array([value]), new Float32Array([value])],
    sampleRate: 48000,
    totalFrames: 1,
    report: {
      peakDb: -6,
      truePeakDbtp: -0.1,
      lufs,
      momentaryLufs: -12.5,
      shortTermLufs: -13.2,
      loudnessRangeLu: 4.5,
      dynamicRangeDb: 9.1,
    },
  };
}

/** A render whose report carries no loudness, forcing the wasm measurement path. */
function makeResultWithoutLoudness(value: number): MixdownResult {
  const result = makeResult(value);
  return { ...result, report: { peakDb: result.report.peakDb } };
}

/** The wasm double the panel resolves through ensureWasm. */
interface MasteringWasmDouble {
  masteringAssistantSuggest: Mock<typeof WasmModule.masteringAssistantSuggest>;
  masteringAssistantSuggestStereo?: Mock<typeof WasmModule.masteringAssistantSuggestStereo>;
}

async function masteringWasm(): Promise<MasteringWasmDouble> {
  const { ensureWasm } = await import('@/lib/wasm');
  return (await ensureWasm()) as unknown as MasteringWasmDouble;
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
    expect(wrapper.find('.mastering-signal-path').text()).toContain(
      'Playback: realtime processors',
    );
    expect(wrapper.find('.mastering-signal-path').text()).toContain('Preview/export');
    expect(wrapper.findAll('.chain-slot')).toHaveLength(0);
    expect(wrapper.find('.chain-add').exists()).toBe(true);
  });

  it('explains live and render paths and classifies processors from the realtime catalog', async () => {
    setMasteringPreset('streaming');
    addMasteringProcessor('dynamics.compressor');
    // This processor is available to the offline catalog but absent from the
    // fake authoritative realtime insert catalog.
    addMasteringProcessor('repair.dereverbClassical');
    const wasm = getWasmModule() as unknown as {
      masteringProcessorCatalog: () => Array<{
        id: string;
        kind: 'realtime' | 'offline' | 'pair';
        realtimeInsertable: boolean;
        stereoOnly: boolean;
      }>;
    };
    const originalCatalog = wasm.masteringProcessorCatalog;
    wasm.masteringProcessorCatalog = () => [
      ...originalCatalog(),
      {
        id: 'repair.dereverbClassical',
        kind: 'offline',
        realtimeInsertable: false,
        stereoOnly: false,
      },
    ];
    try {
      const wrapper = mount(MasteringPanel);

      expect(wrapper.find('.preset-button').text()).toContain('Streaming');
      expect(wrapper.find('.mastering-signal-path').text()).toContain(
        'Playback: realtime processors (also render/export)',
      );
      expect(wrapper.find('.mastering-signal-path').text()).toContain(
        'Preset → all enabled rack processors',
      );

      const runtimeBadges = wrapper.findAll('.chain-runtime');
      expect(runtimeBadges).toHaveLength(2);
      expect(runtimeBadges[0].classes()).toContain('runtime-live-export');
      expect(runtimeBadges[0].text()).toBe('Live');
      expect(runtimeBadges[0].attributes('aria-label')).toBe('Live + export');
      expect(runtimeBadges[1].classes()).toContain('runtime-preview-export');
      expect(runtimeBadges[1].text()).toBe('Render');
      expect(runtimeBadges[1].attributes('aria-label')).toBe('Preview / export');

      await wrapper.find('.chain-add').trigger('click');
      const catalogItems = wrapper.findAll('.catalog-item');
      expect(catalogItems[0]?.find('.catalog-item-scope').text()).toBe('Live');
      expect(catalogItems[0]?.find('.catalog-item-scope').attributes('aria-label')).toBe(
        'Live + export',
      );
      const offlineItem = catalogItems.find(
        (item) => item.find('.catalog-item-label').text() === 'Dereverb Classical',
      );
      expect(offlineItem?.find('.catalog-item-scope').text()).toBe('Render');
      expect(offlineItem?.find('.catalog-item-scope').attributes('aria-label')).toBe(
        'Preview / export',
      );
      wrapper.unmount();
    } finally {
      wasm.masteringProcessorCatalog = originalCatalog;
    }
  });

  it('keeps a valid empty realtime catalog distinct from an unavailable catalog', () => {
    addMasteringProcessor('dynamics.compressor');
    const wasm = getWasmModule() as unknown as {
      masteringInsertNames: () => string[];
    };
    const originalNames = wasm.masteringInsertNames;
    try {
      wasm.masteringInsertNames = () => [];
      const emptyCatalogWrapper = mount(MasteringPanel);
      expect(emptyCatalogWrapper.find('.chain-runtime').classes()).toContain(
        'runtime-preview-export',
      );
      expect(emptyCatalogWrapper.find('.chain-runtime').text()).toBe('Render');
      emptyCatalogWrapper.unmount();

      wasm.masteringInsertNames = () => [1] as unknown as string[];
      const malformedCatalogWrapper = mount(MasteringPanel);
      expect(malformedCatalogWrapper.find('.chain-runtime').classes()).toContain('runtime-unknown');
      malformedCatalogWrapper.unmount();

      wasm.masteringInsertNames = () => {
        throw new Error('catalog unavailable');
      };
      const unavailableCatalogWrapper = mount(MasteringPanel);
      expect(unavailableCatalogWrapper.find('.chain-runtime').classes()).toContain(
        'runtime-unknown',
      );
      expect(unavailableCatalogWrapper.find('.chain-runtime').text()).toBe('Unknown');
      expect(unavailableCatalogWrapper.find('.mastering-signal-path-warning').exists()).toBe(true);
      unavailableCatalogWrapper.unmount();
    } finally {
      wasm.masteringInsertNames = originalNames;
    }
  });

  it('selects a preset from the searchable dropdown as an undoable edit', async () => {
    const wrapper = mount(MasteringPanel);
    await wrapper.find('.preset-button').trigger('click');
    // The fake wasm catalog feeds the menu.
    const items = wrapper.findAll('.preset-item:not(.none)');
    expect(items.length).toBe(6);
    // Mastering presets show their loudness target; the restoration one does not.
    expect(wrapper.find('.preset-heading').exists()).toBe(true);
    expect(items[items.length - 1].find('.preset-item-target').exists()).toBe(false);

    await wrapper.find('.preset-search input').setValue('hip');
    const filtered = wrapper.findAll('.preset-item:not(.none)');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].find('.preset-item-name').text()).toBe('Hip Hop');
    expect(filtered[0].find('.preset-item-target').text()).toBe('-14 LUFS');

    await filtered[0].trigger('click');
    expect(store.mixer.masteringChain?.preset).toBe('hipHop');
    expect(wrapper.find('.preset-button').text()).toContain('Hip Hop');
    expect(wrapper.find('.preset-menu').exists()).toBe(false);

    undo();
    await nextTick();
    expect(store.mixer.masteringChain?.preset).toBeUndefined();
    expect(wrapper.find('.preset-button').text()).toContain('No preset');
  });

  it('removes preset menu outside-click listeners on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const wrapper = mount(MasteringPanel);

    await wrapper.find('.preset-button').trigger('click');

    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
  });

  it('edits typed mastering preset controls and resets them to the preset', async () => {
    setMasteringPreset('streaming');
    const wrapper = mount(MasteringPanel);

    const target = wrapper.get('[data-preset-control="loudness.targetLufs"] input');
    expect((target.element as HTMLInputElement).value).toBe('-12');
    await target.setValue('-14');

    expect(store.mixer.masteringChain?.presetOverrides).toEqual({
      loudness: { enabled: true, targetLufs: -14 },
    });
    expect(wrapper.get('[data-preset-control="loudness.targetLufs"]').classes()).toContain(
      'overridden',
    );

    await wrapper
      .get('[data-preset-control="loudness.targetLufs"] .preset-control-reset')
      .trigger('click');
    expect(store.mixer.masteringChain?.presetOverrides).toBeUndefined();
    expect(
      (wrapper.get('[data-preset-control="loudness.targetLufs"] input').element as HTMLInputElement)
        .value,
    ).toBe('-12');

    await wrapper.get('[data-preset-control="loudness.truePeakOversample"] select').setValue('8');
    expect(store.mixer.masteringChain?.presetOverrides).toEqual({
      loudness: { enabled: true, truePeakOversample: 8 },
    });
    undo();
    await nextTick();
    expect(store.mixer.masteringChain?.presetOverrides).toBeUndefined();
  });

  it('allows enabling a preset denoise stage whose default is off', async () => {
    setMasteringPreset('streaming');
    const wrapper = mount(MasteringPanel);
    const denoise = wrapper.get('[data-preset-control="repair.denoise.enabled"] input');
    expect((denoise.element as HTMLInputElement).checked).toBe(false);

    await denoise.setValue(true);
    expect(store.mixer.masteringChain?.presetOverrides).toEqual({
      repair: { denoise: { enabled: true } },
    });
    expect((denoise.element as HTMLInputElement).checked).toBe(true);
  });

  it('resets denoise enable without activating a remaining reduction override', async () => {
    setMasteringPreset('streaming');
    const wrapper = mount(MasteringPanel);
    const reduction = wrapper.get('[data-preset-control="repair.denoise.reductionDb"] input');
    const enabled = wrapper.get('[data-preset-control="repair.denoise.enabled"] input');

    // The reduction field is gated on the denoise stage, so it is edited while enabled.
    expect((reduction.element as HTMLInputElement).disabled).toBe(true);
    await enabled.setValue(true);
    expect((reduction.element as HTMLInputElement).disabled).toBe(false);
    await reduction.setValue(80);
    expect(store.mixer.masteringChain?.presetOverrides).toEqual({
      repair: { denoise: { enabled: true, reductionDb: 80 } },
    });
    await wrapper
      .get('[data-preset-control="repair.denoise.enabled"] .preset-control-reset')
      .trigger('click');
    expect((enabled.element as HTMLInputElement).checked).toBe(false);
    expect(store.mixer.masteringChain?.presetOverrides).toEqual({
      repair: { denoise: { enabled: false, reductionDb: 80 } },
    });

    await wrapper
      .get('[data-preset-control="repair.denoise.reductionDb"] .preset-control-reset')
      .trigger('click');
    expect(store.mixer.masteringChain?.presetOverrides).toBeUndefined();
  });

  it('shows the effective denoise state for a parameter-only override', async () => {
    applyMasteringPresetWithOverrides('streaming', { repair: { denoise: { reductionDb: 80 } } });
    const wrapper = mount(MasteringPanel);
    const enabled = wrapper.get('[data-preset-control="repair.denoise.enabled"] input');
    expect((enabled.element as HTMLInputElement).checked).toBe(true);

    await enabled.setValue(false);
    expect(store.mixer.masteringChain?.presetOverrides).toEqual({
      repair: { denoise: { reductionDb: 80, enabled: false } },
    });
    expect((enabled.element as HTMLInputElement).checked).toBe(false);
  });

  it('lists override fields without a typed control in Advanced and allows removing them', async () => {
    applyMasteringPresetWithOverrides('streaming', { eq: { tilt: { tiltDb: 2 } } });
    const wrapper = mount(MasteringPanel);

    const advanced = wrapper.get('.preset-override-advanced');
    expect(advanced.text()).toContain('eq.tilt.tiltDb');
    await advanced.get('.preset-override-remove').trigger('click');
    expect(store.mixer.masteringChain?.presetOverrides).toBeUndefined();
  });

  it('gates loudness parameters on the loudness stage switch', async () => {
    setMasteringPreset('streaming');
    const wrapper = mount(MasteringPanel);
    const enabled = wrapper.get<HTMLInputElement>('[data-preset-control="loudness.enabled"] input');
    const target = wrapper.get<HTMLInputElement>(
      '[data-preset-control="loudness.targetLufs"] input',
    );
    expect(enabled.element.checked).toBe(true);
    expect(target.element.disabled).toBe(false);

    await enabled.setValue(false);
    expect(target.element.disabled).toBe(true);
    expect(
      wrapper.get('[data-preset-control="loudness.ceilingDbtp"] input').element,
    ).toHaveProperty('disabled', true);
    expect(enabled.element.disabled).toBe(false);
  });

  it('keeps preset override controls disabled until a preset is selected', async () => {
    const wrapper = mount(MasteringPanel);

    expect(
      wrapper.findAll('[data-preset-control] input, [data-preset-control] select'),
    ).toHaveLength(8);
    for (const control of wrapper.findAll<HTMLInputElement | HTMLSelectElement>(
      '[data-preset-control] input, [data-preset-control] select',
    )) {
      expect(control.element.disabled).toBe(true);
    }
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
      'Modulation',
      'Saturation',
      'Stereo',
      'Effects',
    ]);

    await wrapper.find('.catalog-item').trigger('click');
    expect(store.mixer.masteringChain?.processors).toMatchObject([
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

  it('commits an active parameter gesture when unmounted', async () => {
    addMasteringProcessor('eq.tilt');
    clearHistory();
    const wrapper = mount(MasteringPanel);
    await wrapper.find('.chain-name').trigger('click');

    wrapper.findComponent({ name: 'MixerKnob' }).vm.$emit('change', 3.5, false);
    expect(store.mixer.masteringChain?.processors[0].params.tiltDb).toBe(3.5);

    wrapper.unmount();
    undo();
    expect(store.mixer.masteringChain?.processors[0].params.tiltDb).toBeUndefined();
  });

  it('arms and clears mastering processor MIDI learn targets', async () => {
    addMasteringProcessor('eq.tilt');
    const learn = useMidiLearn();
    const wrapper = mount(MasteringPanel, {
      global: { provide: { [MIDI_LEARN_KEY as symbol]: learn } },
    });
    await wrapper.find('.chain-name').trigger('click');
    const processorId = store.mixer.masteringChain?.processors[0].id as string;
    const targetId = midiLearnMasteringTargetId(processorId, 'tiltDb');

    const learnButtons = wrapper.findAll('.chain-param-midi-learn');
    expect(learnButtons.length).toBeGreaterThan(0);
    await learnButtons[0].trigger('click');
    expect(learn.isArmedId(targetId)).toBe(true);

    learn.handleCc({ channel: 0, controller: 41, value: 127 });
    await nextTick();
    expect(learn.bindingForId(targetId)).toEqual({ channel: 0, controller: 41 });
    expect(store.mixer.masteringChain?.processors[0].params.tiltDb).toBe(12);

    await wrapper.find('.chain-param-midi-forget').trigger('click');
    expect(learn.bindingForId(targetId)).toBeUndefined();
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

    expect(store.mixer.masteringChain?.processors).toMatchObject([
      { processor: 'saturation.tape', params: {}, enabled: true },
      { processor: 'eq.tilt', params: { tiltDb: 2 }, enabled: false },
    ]);
    const names = wrapper.findAll('.chain-name').map((name) => name.text());
    expect(names).toEqual(['Tape', 'Tilt']);
  });

  it('reorders processors with labelled keyboard-accessible move buttons', async () => {
    addMasteringProcessor('eq.tilt');
    addMasteringProcessor('saturation.tape');
    const wrapper = mount(MasteringPanel);
    const moveButtons = wrapper.findAll<HTMLButtonElement>('.chain-move');

    expect(moveButtons[0].attributes('disabled')).toBeDefined();
    expect(moveButtons[3].attributes('disabled')).toBeDefined();
    await moveButtons[1].trigger('click');

    expect(store.mixer.masteringChain?.processors.map((slot) => slot.processor)).toEqual([
      'saturation.tape',
      'eq.tilt',
    ]);
    expect(wrapper.find('[role="status"]').text()).toBe('Processor moved down');
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
    expect(wrapper.findAll('.loudness-row')).toHaveLength(7);
    const loudnessText = wrapper.find('.loudness-readout').text();
    expect(loudnessText).toContain('-6.0');
    expect(loudnessText).toContain('Momentary');
    expect(loudnessText).toContain('-12.5 LUFS');
    expect(loudnessText).toContain('Short-term');
    expect(loudnessText).toContain('-13.2 LUFS');
    expect(loudnessText).toContain('LRA');
    expect(loudnessText).toContain('4.5 LU');
    expect(loudnessText).toContain('DR');
    expect(loudnessText).toContain('9.1 dB');
    // Positive range metrics use their 0..20 comparison scale, not the -60..0 level scale.
    const loudnessRows = wrapper.findAll('.loudness-row');
    const rangeWidths = loudnessRows.slice(5).map((row) =>
      Number.parseFloat(
        row
          .find('.loudness-fill')
          .attributes('style')
          ?.match(/[\d.]+/)?.[0] ?? 'NaN',
      ),
    );
    expect(rangeWidths[0]).toBeCloseTo(22.5);
    expect(rangeWidths[1]).toBeCloseTo(45.5);
    // truePeakDbtp -0.1 exceeds the -0.3 dBTP warning threshold.
    expect(wrapper.find('.clip-warning').exists()).toBe(true);
    expect(wrapper.find('.mono-compat').text()).toContain('Mono compatibility');
    expect(wrapper.find('.mono-compat').text()).toContain('0.42');
    expect(wrapper.find('.mono-compat').text()).toContain('-3.2 dBFS');
    const abButtons = wrapper.findAll('.ab-button');
    expect(abButtons[0].attributes('disabled')).toBeUndefined();
    expect(abButtons[1].attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.play-button').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.preview-stale').exists()).toBe(false);
  });

  it('level matches the louder A/B render and can be disabled for a raw comparison', async () => {
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });

    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResult(0.5, -10));
    await flush();
    fake.calls[1].resolve(makeResult(0.25, -14));
    await flush();

    const toggle = wrapper.get<HTMLInputElement>('.level-match-toggle input');
    expect(toggle.element.checked).toBe(true);
    expect(wrapper.get('.level-match-status').text()).toBe('A -4.0 dB · B 0.0 dB');

    await toggle.setValue(false);
    expect(wrapper.get('.level-match-status').text()).toBe('Off');
    await toggle.setValue(true);
    expect(wrapper.get('.level-match-status').text()).toBe('A -4.0 dB · B 0.0 dB');
  });

  it('reports level matching as unavailable for invalid or stale measurements', async () => {
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });

    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResultWithoutLoudness(0.5));
    await flush();
    fake.calls[1].resolve(makeResult(0.25, -14));
    await flush();
    expect(wrapper.get('.level-match-status').text()).toBe('Unavailable');

    setMasteringPreset('pop');
    await nextTick();
    expect(wrapper.get('.preview-stale').exists()).toBe(true);
    expect(wrapper.get('.level-match-status').text()).toBe('Unavailable');
  });

  it('returns the active monitor to unity when a playing preview becomes stale', async () => {
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const context = createFakeAudioContext();
    const wrapper = mount(MasteringPanel, {
      props: {
        renderMixdown: fake.render,
        previewContextFactory: () => asAudioContext(context),
      },
    });

    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResult(0.5, -10));
    await flush();
    fake.calls[1].resolve(makeResult(0.25, -14));
    await flush();
    await wrapper.findAll('.ab-button')[0].trigger('click');
    await wrapper.find('.play-button').trigger('click');
    context.currentTime = 0.02;
    const attenuatedProcessedGain = DEFAULT_PREVIEW_GAIN * 10 ** (-4 / 20);
    expect(context.gains[0].gain.value).toBeCloseTo(attenuatedProcessedGain);

    setMasteringPreset('pop');
    await flush();
    expect(wrapper.get('.level-match-status').text()).toBe('Unavailable');
    expect(wrapper.get('.preview-stale').exists()).toBe(true);
    // The monitor follows the same short clickless ramp as an A/B switch.
    context.currentTime = 0.04;
    expect(context.gains[0].gain.value).toBeCloseTo(DEFAULT_PREVIEW_GAIN);
    expect(context.sources).toHaveLength(2);
    expect(context.sources.every((source) => source.started)).toBe(true);
  });

  it('reports how much the previewed chain clipped, not only that it might', async () => {
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });

    await wrapper.find('.preview-button').trigger('click');
    const processed = makeResult(0.5);
    fake.calls[0].resolve({
      ...processed,
      report: {
        ...processed.report,
        clipping: {
          clippedSamples: 2048,
          clippingRatio: 0.02,
          maxClippedPeak: 1.3,
          regionCount: 12,
          firstRegionStartSample: 24000,
        },
      },
    });
    await flush();
    fake.calls[1].resolve(makeResult(0.25));
    await flush();

    const census = wrapper.find('.clip-census');
    expect(census.exists()).toBe(true);
    expect(census.text()).toContain('2,048');
    expect(census.text()).toContain('2.00%');
    expect(census.text()).toContain('12');
    // 24000 frames at the preview's 48 kHz.
    expect(census.text()).toContain('0.50 s');
  });

  it('shows no clipping census when the previewed chain stayed clean', async () => {
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });

    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    fake.calls[1].resolve(makeResult(0.25));
    await flush();

    expect(wrapper.find('.clip-warning').exists()).toBe(true);
    expect(wrapper.find('.clip-census').exists()).toBe(false);
  });

  it('compares a processed preview with a decoded reference track', async () => {
    const fake = makeFakeRender();
    const decodeReference = vi.fn(async () => ({
      name: 'Reference.wav',
      channels: [new Float32Array([0.25]), new Float32Array([0.25])],
      sampleRate: 48000,
    }));
    const wrapper = mount(MasteringPanel, {
      props: { renderMixdown: fake.render, decodeReference },
    });
    const input = wrapper.get<HTMLInputElement>('.mastering-reference-file input');
    Object.defineProperty(input.element, 'files', {
      value: [new File(['x'], 'Reference.wav')],
    });
    await input.trigger('change');
    await flush();

    expect(wrapper.text()).toContain('Reference.wav');
    await wrapper.find('.mastering-reference-compare').trigger('click');
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    await flush();

    expect(wrapper.find('.mastering-reference-results').text()).toContain('-12.0 → -14.0 LUFS');
    expect(wrapper.find('.mastering-reference-results').text()).toContain('100–1000 Hz: +2.0 dB');
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

  it('checks editable streaming targets instead of the wasm default list', async () => {
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    fake.calls[1].resolve(makeResult(0.25));
    await flush();

    const firstTarget = wrapper.find('.targets-editor-row');
    const inputs = firstTarget.findAll('input');
    await inputs[0].setValue('Bandcamp');
    await inputs[1].setValue('-18');
    await inputs[2].setValue('-2');
    await wrapper.find('.targets-button').trigger('click');
    await flush();

    const tableText = wrapper.find('.targets-table').text();
    expect(tableText).toContain('Bandcamp');
    expect(tableText).toContain('-4.0');
  });

  it('keeps invalid streaming target rows visible and reports them before checking', async () => {
    const wrapper = mount(MasteringPanel);
    const firstTarget = wrapper.find('.targets-editor-row');
    await firstTarget.findAll('input')[1].setValue('4');
    await wrapper.find('.targets-button').trigger('click');

    expect(wrapper.find('.mastering-error').text()).toContain('Correct or remove invalid');
    expect(firstTarget.findAll('input')[1].element.value).toBe('4');
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
    expect(wrapper.findAll('.loudness-row')).toHaveLength(7);
  });

  it('does not apply an assistant preset from an old preview after refresh fails', async () => {
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    fake.calls[1].resolve(makeResult(0.25));
    await flush();

    addMasteringProcessor('saturation.tape');
    await flush();
    expect(wrapper.find('.preview-stale').exists()).toBe(true);
    await wrapper.find('.assist-button').trigger('click');
    expect(fake.calls).toHaveLength(3);
    fake.calls[2].reject(new Error('refresh failed'));
    await flush();

    expect(store.mixer.masteringChain?.preset).toBeUndefined();
  });

  it('analyzes a stereo preview through the channel-summing assistant', async () => {
    const wasm = await masteringWasm();
    wasm.masteringAssistantSuggest.mockClear();
    wasm.masteringAssistantSuggestStereo?.mockClear();
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    fake.calls[1].resolve(makeResult(0.25));
    await flush();

    await wrapper.find('.assist-button').trigger('click');
    await flush();

    expect(wasm.masteringAssistantSuggest).not.toHaveBeenCalled();
    const request = wasm.masteringAssistantSuggestStereo?.mock.calls[0][0];
    expect(request?.left).toBeInstanceOf(Float32Array);
    expect(request?.right).toBeInstanceOf(Float32Array);
    expect(request?.sampleRate).toBe(48000);
    expect(request?.preset).toBe('streaming');
    expect(store.mixer.masteringChain?.preset).toBe('streaming');
  });

  it('uses the selected mastering preset as the assistant base', async () => {
    setMasteringPreset('edm');
    const wasm = await masteringWasm();
    wasm.masteringAssistantSuggestStereo?.mockClear();
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    fake.calls[1].resolve(makeResult(0.25));
    await flush();

    await wrapper.find('.assist-button').trigger('click');
    await flush();

    expect(wasm.masteringAssistantSuggestStereo?.mock.calls[0][0]?.preset).toBe('edm');
    expect(store.mixer.masteringChain?.preset).toBe('edm');
  });

  it('applies the suggested preset with the values it tuned, undoable as one edit', async () => {
    const wasm = await masteringWasm();
    const base = wasm.masteringAssistantSuggestStereo?.getMockImplementation()?.(
      {} as never,
    ) as MasteringAssistantResult;
    wasm.masteringAssistantSuggestStereo?.mockReturnValueOnce({
      ...base,
      chainConfig: { loudness: { targetLufs: -14, ceilingDbtp: -1 } },
    });
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    fake.calls[1].resolve(makeResult(0.25));
    await flush();

    await wrapper.find('.assist-button').trigger('click');
    await flush();

    expect(store.mixer.masteringChain?.preset).toBe('streaming');
    expect(store.mixer.masteringChain?.presetOverrides).toEqual({
      loudness: { targetLufs: -14 },
    });
    const adjustments = wrapper.findAll('.assist-adjustments li');
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].text()).toContain('loudness.targetLufs');
    expect(adjustments[0].text()).toContain('-12 → -14');

    undo();
    await nextTick();
    expect(store.mixer.masteringChain?.preset).toBeUndefined();
    expect(store.mixer.masteringChain?.presetOverrides).toBeUndefined();
  });

  it('falls back to the mono assistant when the stereo entry point is absent', async () => {
    const wasm = await masteringWasm();
    wasm.masteringAssistantSuggest.mockClear();
    const stereo = wasm.masteringAssistantSuggestStereo;
    wasm.masteringAssistantSuggestStereo = undefined;
    try {
      addMasteringProcessor('eq.tilt');
      const fake = makeFakeRender();
      const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
      await wrapper.find('.preview-button').trigger('click');
      fake.calls[0].resolve(makeResult(0.5));
      await flush();
      fake.calls[1].resolve(makeResult(0.25));
      await flush();

      await wrapper.find('.assist-button').trigger('click');
      await flush();

      expect(wasm.masteringAssistantSuggest).toHaveBeenCalledTimes(1);
      expect(wasm.masteringAssistantSuggest.mock.calls[0][2]).toEqual({ preset: 'streaming' });
      expect(store.mixer.masteringChain?.preset).toBe('streaming');
    } finally {
      wasm.masteringAssistantSuggestStereo = stereo;
    }
  });

  it('measures streaming targets from both channels when the report has no loudness', async () => {
    addMasteringProcessor('eq.tilt');
    const fake = makeFakeRender();
    const wrapper = mount(MasteringPanel, { props: { renderMixdown: fake.render } });
    await wrapper.find('.preview-button').trigger('click');
    fake.calls[0].resolve(makeResultWithoutLoudness(0.5));
    await flush();
    fake.calls[1].resolve(makeResultWithoutLoudness(0.25));
    await flush();

    const firstTarget = wrapper.find('.targets-editor-row');
    const inputs = firstTarget.findAll('input');
    await inputs[0].setValue('Bandcamp');
    await inputs[1].setValue('-18');
    await inputs[2].setValue('-2');
    await wrapper.find('.targets-button').trigger('click');
    await flush();

    // Channel summing reports FAKE_STEREO_LUFS, so the gain to -18 LUFS is
    // -11 dB; the mono downmix would have understated it as -5 dB.
    const tableText = wrapper.find('.targets-table').text();
    expect(tableText).toContain('Bandcamp');
    expect(tableText).toContain('-11.0');
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
