import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import { addNote, clearHistory, setSelection, setTrackFrozen } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const notationMocks = vi.hoisted(() => ({
  transcribe: vi.fn(async () => undefined),
  setError: vi.fn(),
}));

vi.mock('@/ui/score/use-score-notation', () => ({
  useScoreNotation: () => ({
    loading: ref(false),
    exporting: ref(false),
    error: ref(''),
    svg: ref(''),
    page: ref(1),
    pageCount: ref(1),
    getTimemap: () => [],
    getCurrentXml: () => '<score-partwise />',
    getCurrentPartName: () => 'Track 1',
    bumpGeneration: vi.fn(),
    transcribe: notationMocks.transcribe,
    refresh: vi.fn(async () => undefined),
    applyLayout: vi.fn(async () => undefined),
    gotoPage: vi.fn(),
    setError: notationMocks.setError,
    onPrint: vi.fn(),
    onExportPdf: vi.fn(),
    onExportMusicXml: vi.fn(),
    onExportPartMusicXml: vi.fn(),
  }),
}));

vi.mock('@/ui/score/use-playhead-sync', () => ({
  usePlayheadSync: () => ({
    resetScan: vi.fn(),
  }),
}));

vi.mock('@/notation/verovio', () => ({
  VerovioClient: class {
    failed = false;
    dispose = vi.fn();
  },
}));

describe('ScorePanel note edits on a frozen track', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
  });

  it('reports the refused add-note key in the panel instead of throwing', async () => {
    const store = useProjectStore();
    const id = addNote({ pitch: 60, velocity: 96, channel: 0, startPpq: 0, durationPpq: 1 });
    setSelection([id]);
    setTrackFrozen(store.activeTrackId, { assetId: 'frozen-asset' });
    const errors: unknown[] = [];
    const wrapper = mount(ScorePanel, {
      global: {
        stubs: { EmptyState: true, ScoreAnnotationPalette: true, ScoreToolbar: true },
        config: {
          errorHandler: (error) => {
            errors.push(error);
          },
        },
      },
    });
    notationMocks.setError.mockClear();

    await wrapper.find('.score-body').trigger('keydown', { key: 'n' });

    expect(errors).toEqual([]);
    expect(notationMocks.setError).toHaveBeenCalledWith(expect.stringContaining('frozen'));
    expect(store.notes).toHaveLength(1);
    wrapper.unmount();
  });
});
