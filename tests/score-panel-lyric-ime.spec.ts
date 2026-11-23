import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import { addNote, clearHistory, setSelection } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { enterKey } from './ime-test-helpers';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/ui/score/use-score-notation', () => ({
  useScoreNotation: () => ({
    loading: ref(false),
    exporting: ref(false),
    error: ref(''),
    svg: ref(''),
    page: ref(1),
    pageCount: ref(1),
    getTimemap: () => [],
    getCurrentXml: () => '',
    getCurrentPartName: () => '',
    bumpGeneration: vi.fn(),
    transcribe: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    applyLayout: vi.fn(async () => undefined),
    gotoPage: vi.fn(),
    setError: vi.fn(),
    onPrint: vi.fn(),
    onExportPdf: vi.fn(),
    onExportMusicXml: vi.fn(),
    onExportPartMusicXml: vi.fn(),
  }),
}));

vi.mock('@/ui/score/use-playhead-sync', () => ({
  usePlayheadSync: () => ({ resetScan: vi.fn() }),
}));

vi.mock('@/notation/verovio', () => ({
  VerovioClient: class {
    failed = false;
    dispose = vi.fn();
  },
}));

describe('ScorePanel lyric field with an IME', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  async function typed() {
    const store = useProjectStore();
    setSelection([addNote({ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1 })]);
    const wrapper = mount(ScorePanel, {
      global: { stubs: { EmptyState: true, ScoreAnnotationPalette: true, ScoreToolbar: true } },
    });
    const input = wrapper.find<HTMLInputElement>('.score-marker-tools input[type="text"]');
    await input.setValue('あ');
    return { store, wrapper, input };
  }

  it('does not add a marker when Enter confirms a composition', async () => {
    const { store, wrapper, input } = await typed();
    const before = store.markers.length;
    input.element.dispatchEvent(enterKey(true));
    await wrapper.vm.$nextTick();
    expect(store.markers).toHaveLength(before);
  });

  it('adds a marker on a plain Enter', async () => {
    const { store, wrapper, input } = await typed();
    const before = store.markers.length;
    input.element.dispatchEvent(enterKey(false));
    await wrapper.vm.$nextTick();
    expect(store.markers).toHaveLength(before + 1);
  });
});
