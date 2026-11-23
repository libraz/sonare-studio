import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChordListEditor from '@/components/lists/ChordListEditor.vue';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { vTooltip } from '@/ui/tooltip';
import { editorClip } from './fakes/project';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const detect = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@/project/commands', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/project/commands')>();
  return { ...original, detectChordsFromAudioClip: detect.run };
});

function detectButton(wrapper: VueWrapper) {
  const button = wrapper.findAll('button').find((node) => node.text() === 'Detect from clip');
  if (!button) throw new Error('detect button not found');
  return button;
}

function audioClip(id: number) {
  return editorClip({ id, kind: 'audio', assetId: `asset-${id}`, lengthPpq: 8, trackId: 1 });
}

describe('ChordListEditor audio chord detection guard', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
    store.tracks = [{ ...store.tracks[0], id: 1 }];
    store.clips = [audioClip(7), audioClip(8)];
    store.clipId = 7;
  });

  function mountEditor(): VueWrapper {
    return mount(ChordListEditor, { global: { directives: { tooltip: vTooltip } } });
  }

  it('aborts the running detection on unmount', async () => {
    detect.run.mockReturnValueOnce(new Promise(() => {}));
    const wrapper = mountEditor();
    await detectButton(wrapper).trigger('click');
    const signal = detect.run.mock.calls[0][1] as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    wrapper.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('shows no result message when the active clip changes mid-detection', async () => {
    let resolve!: (count: number) => void;
    detect.run.mockReturnValueOnce(
      new Promise<number>((res) => {
        resolve = res;
      }),
    );
    const wrapper = mountEditor();
    await detectButton(wrapper).trigger('click');
    store.clipId = 8;
    resolve(0);
    await flushPromises();
    expect(wrapper.find('.list-error').exists()).toBe(false);
    wrapper.unmount();
  });
});
