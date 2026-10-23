import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import { clearHistory, setTrackMidiFx, undo } from '@/project/commands';
import { sanitizeMidiFxConfig } from '@/project/midi-fx';
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

describe('ScorePanel live MIDI FX notice', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
  });

  it('clears the active track MIDI FX from the notice as one undoable edit', async () => {
    const store = useProjectStore();
    const trackId = store.activeTrackId;
    setTrackMidiFx(trackId, sanitizeMidiFxConfig({ transposeSemitones: 12 }));
    expect(store.tracks.find((track) => track.id === trackId)?.midiFx).toBeDefined();

    const wrapper = mount(ScorePanel, {
      global: { stubs: { EmptyState: true, ScoreAnnotationPalette: true, ScoreToolbar: true } },
    });
    const clear = wrapper.find('.score-notice-action');
    expect(clear.exists()).toBe(true);

    await clear.trigger('click');
    expect(store.tracks.find((track) => track.id === trackId)?.midiFx).toBeUndefined();
    expect(wrapper.find('.score-notice').exists()).toBe(false);

    expect(undo()).toBe(true);
    expect(store.tracks.find((track) => track.id === trackId)?.midiFx).toBeDefined();
  });
});
