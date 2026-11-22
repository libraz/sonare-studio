import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SampleEditor from '@/components/sample-editor/SampleEditor.vue';
import { ensureWasm } from '@/lib/wasm';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import { useProjectStore } from '@/project/store';
import type { MasteringRepairAnalysis } from '@/wasm/index.js';

const assetStore = vi.hoisted(() => {
  const deleteAsset = vi.fn(async () => undefined);
  return {
    deleteAsset,
    deleteAssetUnlocked: deleteAsset,
    listAssets: vi.fn<() => Promise<AudioAssetMeta[]>>(),
    loadAsset: vi.fn<(id: string) => Promise<LoadedAudioAsset>>(),
    saveAsset: vi.fn(),
    saveAssetWithStatus: vi.fn(async (...args: Parameters<typeof assetStore.saveAsset>) => ({
      meta: await assetStore.saveAsset(...args),
      created: true,
    })),
  };
});
vi.mock('@/persistence/assets', () => assetStore);

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: vi.fn(async () => fakeModule) };
});

type MutableModule = Record<string, unknown>;

function stereoAsset(id: string): LoadedAudioAsset {
  return {
    meta: { id, name: 'Vocal', sampleRate: 48000, numChannels: 2, numFrames: 8 },
    channels: [new Float32Array(8).fill(0.1), new Float32Array(8).fill(0.2)],
  };
}

function mountEditor() {
  return mount(SampleEditor, {
    props: { assetId: 'asset-a' },
    global: { directives: { tooltip: () => {} }, stubs: { SelectMenu: true, ToggleButton: true } },
  });
}

function button(wrapper: ReturnType<typeof mountEditor>, text: string) {
  const found = wrapper.findAll('button').find((candidate) => candidate.text() === text);
  if (!found) throw new Error(`No button labelled ${text}`);
  return found;
}

describe('SampleEditor auto-tune, repair session and formant mode', () => {
  let module: MutableModule;

  beforeEach(async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
    vi.clearAllMocks();
    module = (await ensureWasm()) as unknown as MutableModule;
    assetStore.listAssets.mockResolvedValue([]);
    assetStore.loadAsset.mockImplementation(async (id) => stereoAsset(id));
    assetStore.saveAsset.mockImplementation(async () => ({ id: 'saved', name: 'Vocal (edit)' }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports the detected key after auto-tuning and names it in the history', async () => {
    module.autoTune = vi.fn((request: { samples: Float32Array }) => ({
      samples: request.samples.map((v) => v * 2),
      key: { root: 9, mode: 'minor', confidence: 0.55 },
    }));
    const wrapper = mountEditor();
    await flushPromises();

    await button(wrapper, 'Auto-tune').trigger('click');
    await flushPromises();

    expect(wrapper.find('.result-status').text()).toBe('Tuned to A Minor (detected key)');
    expect(wrapper.find('.history-entry.current').text()).toBe('Auto-tune to A Minor');
  });

  it('lists the recommended stages and applies them in one call', async () => {
    const analysis: MasteringRepairAnalysis = {
      defects: { clip: { flatRunCount: 0 } } as MasteringRepairAnalysis['defects'],
      channels: [
        {
          click: { count: 4 },
          clip: { runCount: 0 },
          crackle: { sampleCount: 0 },
          hum: { fundamentalHz: 0 },
          noise: { floorDbfs: -70 },
        },
        {
          click: { count: 0 },
          clip: { runCount: 0 },
          crackle: { sampleCount: 0 },
          hum: { fundamentalHz: 0 },
          noise: { floorDbfs: -71 },
        },
      ] as MasteringRepairAnalysis['channels'],
      declipThresholdSafe: true,
      integratedLufs: -20.04,
      recommended: [{ stage: 'declick' }, { stage: 'dehum', fundamentalHz: 50 }],
      explanation: [],
    };
    module.masteringRepairAnalyze = vi.fn(() => analysis);
    const apply = vi.fn((request: { channels: Float32Array[] }) => ({
      channels: request.channels,
      reports: [],
    }));
    module.masteringRepairApply = apply;
    const wrapper = mountEditor();
    await flushPromises();

    await button(wrapper, 'Analyze & repair').trigger('click');
    await flushPromises();

    const panel = wrapper.find('.repair-analysis');
    expect(panel.find('.match-eq-loudness').text()).toBe('-20.0 LUFS');
    expect(panel.findAll('dt').map((dt) => dt.text())).toEqual(['L', 'R']);
    expect(panel.find('dd').text()).toContain('Clicks 4');
    expect(panel.findAll('toggle-button-stub')).toHaveLength(2);

    // Scoped to the panel: the Repair tab carries the same label.
    const applyRepair = panel.findAll('button').find((candidate) => candidate.text() === 'Repair');
    await applyRepair?.trigger('click');
    await flushPromises();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ stages: analysis.recommended });
    expect(wrapper.find('.history-entry.current').text()).toBe('Repair (Declick, Dehum)');
    // The new version voids the analysis it was based on.
    expect(wrapper.find('.repair-analysis').exists()).toBe(false);
  });

  it("surfaces libsonare's refusal of an unreachable absolute formant request", async () => {
    module.voiceChange = vi.fn(() => {
      throw new RangeError('formantFactor must be in [0.69, 2.08] for pitchSemitones 4');
    });
    const wrapper = mountEditor();
    await flushPromises();

    await button(wrapper, 'Voice').trigger('click');
    await flushPromises();

    expect(wrapper.find('.error').text()).toBe(
      'formantFactor must be in [0.69, 2.08] for pitchSemitones 4',
    );
  });
});
