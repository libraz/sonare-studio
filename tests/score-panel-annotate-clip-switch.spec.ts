import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import { addMidiClip, addNote, addTrack, clearHistory, setActiveClip } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const commandMocks = vi.hoisted(() => ({
  setMarker: vi.fn(),
}));

vi.mock('@/project/commands', async (importActual) => {
  const actual = await importActual<typeof import('@/project/commands')>();
  return {
    ...actual,
    setMarker: commandMocks.setMarker,
  };
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

describe('ScorePanel annotate across clips', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
  });

  it('keeps the palette open when the annotate action switches the active clip', async () => {
    const store = useProjectStore();
    const firstClip = store.clipId;
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const trackId = addTrack({ name: 'Lead', kind: 'midi' });
    const leadClip = addMidiClip({ trackId, startPpq: 0, lengthPpq: 8, name: 'Lead clip' });
    setActiveClip(leadClip);
    addNote({ pitch: 72, startPpq: 0, durationPpq: 1 });
    setActiveClip(firstClip);
    store.scoreDisplaySettings = { ...store.scoreDisplaySettings, fullScoreEnabled: true };

    const wrapper = mount(ScorePanel, {
      global: {
        stubs: { EmptyState: true, ScoreAnnotationPalette: true, ScoreToolbar: true },
      },
    });
    await nextTick();
    const navigator = wrapper.findComponent({ name: 'AccessibleObjectNavigator' });
    const items = navigator.props('items') as Array<{ id: string }>;
    const lead = items.find((item) => item.id.startsWith(`score-${leadClip}-`));
    expect(lead).toBeDefined();

    navigator.vm.$emit('context', lead?.id);
    await nextTick();
    await nextTick();

    expect(store.clipId).toBe(leadClip);
    expect(wrapper.findComponent({ name: 'ScoreAnnotationPalette' }).exists()).toBe(true);
  });
});
