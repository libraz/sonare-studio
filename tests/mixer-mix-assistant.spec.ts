import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MixSuggestDialog from '@/components/mixer/MixSuggestDialog.vue';
import type { renderMixdownInWorker } from '@/export/client';
import { insertAutomationParam, instrumentAutomationParam } from '@/project/automation';
import {
  addInsert,
  applyMixerSceneJson,
  clearHistory,
  setStripGain,
  undo,
} from '@/project/commands';
import { createDefaultStrip } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { neutralMixDocument, suggestMixFromStems } from '@/ui/mixer/mix-assistant';

const mixingAssistantSuggest = vi.hoisted(() =>
  vi.fn<typeof import('@libraz/libsonare')['mixingAssistantSuggest']>(),
);

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = { ...createFakeWasmModule(), mixingAssistantSuggest };
  return { ensureWasm: async () => fakeModule };
});

describe('neutralMixDocument', () => {
  it('drops the mix but keeps mutes and instrument lanes', () => {
    const doc = {
      tracks: [
        {
          name: 'Keys',
          mute: true,
          solo: true,
          volume: 0.5,
          pan: -0.3,
          vcaId: 'v',
          mixer: { gainDb: -6, pan: 0.2, inserts: [] },
          automation: [
            { param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -3 }] },
            {
              param: instrumentAutomationParam('cutoffHz'),
              enabled: true,
              points: [{ ppq: 0, value: 800 }],
            },
          ],
        },
      ],
      masterAutomation: [{ param: 'faderDb', enabled: true, points: [] }],
      mixer: { master: { gainDb: -3, pan: 0, inserts: [] }, buses: [{ id: 'b', name: 'B' }] },
    } as unknown as ProjectDocument;
    const neutral = neutralMixDocument(doc);
    const [track] = neutral.tracks;
    expect(track).toMatchObject({ mute: true, solo: false, volume: 1, pan: 0 });
    expect(track.mixer).toBeUndefined();
    expect(track.vcaId).toBeUndefined();
    expect(track.automation?.map((lane) => lane.param)).toEqual([
      instrumentAutomationParam('cutoffHz'),
    ]);
    expect(neutral.masterAutomation).toEqual([]);
    expect(neutral.mixer).toMatchObject({ buses: [] });
    expect(neutral.mixer?.master.gainDb).toBe(0);
  });

  it('keeps a user guitar amp in analysis but drops earlier suggested processors', () => {
    const amp = {
      id: 'amp-1',
      processor: 'saturation.ampSim',
      params: { presetIndex: 5 },
      enabled: true,
    };
    const suggested = {
      id: 'mix-assistant-eq-1',
      processor: 'eq.tilt',
      params: { tiltDb: 2 },
      enabled: true,
    };
    const doc = {
      tracks: [
        {
          name: 'Guitar DI',
          groupIndex: 1,
          mixer: {
            ...createDefaultStrip(),
            gainDb: -18,
            inputTrimDb: -9,
            inserts: [
              suggested,
              amp,
              {
                id: 'group-keyed',
                processor: 'dynamics.compressor',
                params: {},
                enabled: true,
                sidechainSourceGroupTrackIndex: 1,
              },
            ],
          },
          automation: [
            { param: insertAutomationParam(amp.id, 'gainDb'), enabled: true, points: [] },
            { param: insertAutomationParam(1, 'drive'), enabled: true, points: [] },
            { param: insertAutomationParam(suggested.id, 'tiltDb'), enabled: true, points: [] },
          ],
        },
      ],
      mixer: { master: createDefaultStrip(), buses: [] },
    } as unknown as ProjectDocument;
    const [track] = neutralMixDocument(doc).tracks;
    expect(track.mixer?.inserts).toEqual([amp]);
    expect(track.mixer?.gainDb).toBe(0);
    expect(track.mixer?.inputTrimDb).toBeUndefined();
    expect(track.groupIndex).toBeUndefined();
    expect(track.automation?.map((lane) => lane.param)).toEqual([
      insertAutomationParam(amp.id, 'gainDb'),
      insertAutomationParam(0, 'drive'),
    ]);
  });
});

describe('suggestMixFromStems', () => {
  it('names each stem by its track id and passes the song tempo', () => {
    const suggest = vi.fn(() => ({}) as never);
    const left = new Float32Array(4);
    suggestMixFromStems([{ trackId: 3, name: 'Bass', left, right: left }], 48000, 96, suggest);
    expect(suggest).toHaveBeenCalledWith({
      tracks: [{ id: 'track-3', name: 'Bass', channels: [left, left] }],
      sampleRate: 48000,
      tempoBpm: 96,
    });
  });
});

describe('MixSuggestDialog', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('replaces an earlier suggested insert while retaining user inserts on repeated apply', () => {
    const store = useProjectStore();
    const trackId = store.tracks[0].id;
    addInsert(trackId, 'saturation.ampSim', { presetIndex: 0 });
    const ampId = store.tracks[0].mixer?.inserts[0].id;
    const scene = JSON.stringify({
      strips: [
        {
          id: `track-${trackId}`,
          faderDb: -4,
          inserts: [{ processor: 'eq.tilt', params: { tiltDb: 2 } }],
        },
      ],
      buses: [],
      connections: [],
    });
    applyMixerSceneJson(scene, { preserveTrackInserts: true });
    applyMixerSceneJson(scene, { preserveTrackInserts: true });
    expect(store.tracks[0].mixer?.inserts.map((slot) => slot.processor)).toEqual([
      'saturation.ampSim',
      'eq.tilt',
    ]);
    expect(store.tracks[0].mixer?.inserts[0].id).toBe(ampId);
  });

  it('shows what each track was heard as and applies the scene as one undo', async () => {
    const store = useProjectStore();
    const trackId = store.tracks[0].id;
    addInsert('master', 'eq.tilt', { tiltDb: 1 });
    addInsert(trackId, 'saturation.ampSim', { presetIndex: 5 });
    const ampId = store.tracks[0].mixer?.inserts[0].id;
    clearHistory();
    const channel = new Float32Array(8).fill(0.2);
    const render = vi.fn<typeof renderMixdownInWorker>(() => ({
      result: Promise.resolve({
        channels: [channel, channel],
        sampleRate: 48000,
        totalFrames: 8,
        report: { peakDb: -12 },
        stems: [{ source: 'track', trackIndex: 0, name: 'Keys', channels: [channel, channel] }],
      }),
      cancel: vi.fn<() => void>(),
    }));
    mixingAssistantSuggest.mockReturnValue({
      scene: {
        version: 1,
        strips: [
          {
            id: `track-${trackId}`,
            faderDb: -4,
            inserts: [{ processor: 'eq.tilt', params: { tiltDb: 2 } }],
          },
        ],
        buses: [{ id: 'master', role: 'master', inserts: [] }],
        connections: [],
      },
      tracks: [{ stripId: `track-${trackId}`, name: 'Keys', source: 'keys', usable: true }],
      mix: {},
      explanation: [`staged track-${trackId} towards the target`],
    } as never);
    const wrapper = mount(MixSuggestDialog, {
      props: { open: true, loopEnabled: false, loopStartPpq: 0, loopEndPpq: 0, render },
      global: { stubs: { teleport: true } },
    });
    await flushPromises();

    expect(render).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stems: true, includeMasterChain: false }),
    );
    const text = wrapper.text();
    expect(text).toContain('Keys');
    expect(text).toContain(`staged ${store.tracks[0].name} towards the target`);

    const apply = wrapper.findAll('button').find((button) => button.text() === 'Apply suggestion');
    await apply?.trigger('click');
    expect(store.tracks[0].mixer?.gainDb).toBe(-4);
    expect(store.tracks[0].mixer?.inserts.map((slot) => slot.processor)).toEqual([
      'saturation.ampSim',
      'eq.tilt',
    ]);
    expect(store.tracks[0].mixer?.inserts[0]).toMatchObject({
      id: ampId,
      params: { presetIndex: 5 },
    });
    expect(store.mixer.master.inserts.map((slot) => slot.processor)).toEqual(['eq.tilt']);
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(undo()).toBe(true);
    expect(store.tracks[0].mixer?.gainDb ?? 0).toBe(0);
    expect(store.tracks[0].mixer?.inserts.map((slot) => slot.processor)).toEqual([
      'saturation.ampSim',
    ]);
  });

  it('rejects a suggestion when the project changes after measurement', async () => {
    const store = useProjectStore();
    const trackId = store.tracks[0].id;
    const channel = new Float32Array(8).fill(0.2);
    mixingAssistantSuggest.mockReturnValue({
      scene: {
        version: 1,
        strips: [{ id: `track-${trackId}`, faderDb: -4 }],
        buses: [],
        connections: [],
      },
      tracks: [{ stripId: `track-${trackId}`, name: 'Keys', source: 'keys', usable: true }],
      mix: {},
      explanation: [],
    } as never);
    const render = vi.fn<typeof renderMixdownInWorker>(() => ({
      result: Promise.resolve({
        channels: [channel, channel],
        sampleRate: 48000,
        totalFrames: 8,
        report: { peakDb: -12 },
        stems: [{ source: 'track', trackIndex: 0, name: 'Keys', channels: [channel, channel] }],
      }),
      cancel: vi.fn<() => void>(),
    }));
    const wrapper = mount(MixSuggestDialog, {
      props: { open: true, loopEnabled: false, loopStartPpq: 0, loopEndPpq: 0, render },
      global: { stubs: { teleport: true } },
    });
    await flushPromises();
    setStripGain(trackId, -18);
    const apply = wrapper.findAll('button').find((button) => button.text() === 'Apply suggestion');
    await apply?.trigger('click');

    expect(store.tracks[0].mixer?.gainDb).toBe(-18);
    expect(wrapper.text()).toContain('The tracks changed while measuring');
    expect(wrapper.emitted('close')).toBeUndefined();
  });
});
