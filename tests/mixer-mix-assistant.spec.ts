import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MixSuggestDialog from '@/components/mixer/MixSuggestDialog.vue';
import { instrumentAutomationParam } from '@/project/automation';
import { addInsert, clearHistory, undo } from '@/project/commands';
import type { ProjectDocument } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { neutralMixDocument, suggestMixFromStems } from '@/ui/mixer/mix-assistant';

const suggestMixScene = vi.hoisted(() => vi.fn());

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = { ...createFakeWasmModule(), suggestMixScene };
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
});

describe('suggestMixFromStems', () => {
  it('names each stem by its track id and passes the song tempo', () => {
    const suggest = vi.fn(() => ({}) as never);
    const left = new Float32Array(4);
    suggestMixFromStems([{ trackId: 3, name: 'Bass', left, right: left }], 48000, 96, suggest);
    expect(suggest).toHaveBeenCalledWith({
      tracks: [{ id: 'track-3', name: 'Bass', left, right: left }],
      sampleRate: 48000,
      options: { tempoBpm: 96 },
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

  it('shows what each track was heard as and applies the scene as one undo', async () => {
    const store = useProjectStore();
    const trackId = store.tracks[0].id;
    addInsert('master', 'eq.tilt', { tiltDb: 1 });
    clearHistory();
    const channel = new Float32Array(8).fill(0.2);
    const render = vi.fn(() => ({
      result: Promise.resolve({
        channels: [channel, channel],
        sampleRate: 48000,
        totalFrames: 8,
        report: { peakDb: -12 },
        stems: [{ source: 'track', trackIndex: 0, name: 'Keys', channels: [channel, channel] }],
      }),
      cancel: vi.fn(),
    }));
    suggestMixScene.mockReturnValue({
      scene: {
        version: 1,
        strips: [{ id: `track-${trackId}`, faderDb: -4 }],
        buses: [{ id: 'master', role: 'master', inserts: [] }],
        connections: [],
      },
      tracks: [{ stripId: `track-${trackId}`, name: 'Keys', source: 'keys', usable: true }],
      mix: {},
      explanation: [`staged track-${trackId} towards the target`],
    });
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
    expect(store.mixer.master.inserts.map((slot) => slot.processor)).toEqual(['eq.tilt']);
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(undo()).toBe(true);
    expect(store.tracks[0].mixer?.gainDb ?? 0).toBe(0);
  });
});
