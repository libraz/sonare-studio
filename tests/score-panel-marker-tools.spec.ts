import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import { addNote, clearHistory } from '@/project/commands';
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

function field(wrapper: ReturnType<typeof mount>, label: string) {
  const input = wrapper.find(`[aria-label="${label}"]`);
  expect(input.exists()).toBe(true);
  return input;
}

describe('ScorePanel marker tools', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds structured lyric markers at the current score edit position', async () => {
    addNote({ pitch: 60, velocity: 96, startPpq: 5.5, durationPpq: 1 });
    const wrapper = mount(ScorePanel, {
      props: {
        positionPpq: () => 5.25,
      },
      global: {
        stubs: {
          EmptyState: true,
          ScoreAnnotationPalette: true,
          ScoreToolbar: true,
        },
      },
    });

    await field(wrapper, 'Lyric').setValue('glo');
    await field(wrapper, 'Verse').setValue('2');
    await field(wrapper, 'Syllabic').setValue('begin');
    await wrapper.find('label.inline-check input').setValue(true);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Add lyric')
      ?.trigger('click');
    await nextTick();

    expect(commandMocks.setMarker).toHaveBeenCalledWith(null, 5.5, 'Lyric 2: begin: glo~');
    expect(notationMocks.setError).toHaveBeenCalledWith('');
    expect(notationMocks.transcribe).toHaveBeenCalled();
    expect((field(wrapper, 'Lyric').element as HTMLInputElement).value).toBe('');
  });

  it('rejects lyric placement when the score has no note attack', async () => {
    const wrapper = mount(ScorePanel, {
      props: { positionPpq: () => 5.25 },
      global: {
        stubs: {
          EmptyState: true,
          ScoreAnnotationPalette: true,
          ScoreToolbar: true,
        },
      },
    });

    await field(wrapper, 'Lyric').setValue('missing');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Add lyric')
      ?.trigger('click');

    expect(commandMocks.setMarker).not.toHaveBeenCalled();
    expect(notationMocks.setError).toHaveBeenCalledWith('Add a note before placing a lyric.');
  });

  it('exposes score notes for keyboard selection, seeking, and annotation', async () => {
    const noteId = addNote({ pitch: 60, velocity: 96, startPpq: 1, durationPpq: 1 });
    const wrapper = mount(ScorePanel, {
      global: {
        stubs: {
          EmptyState: true,
          ScoreAnnotationPalette: true,
          ScoreToolbar: true,
        },
      },
    });
    await nextTick();

    const navigator = wrapper.get('[role="listbox"]');
    expect(navigator.attributes('aria-label')).toBe('Score note navigator');
    expect(wrapper.get('[role="option"]').text()).toContain('C4');

    await navigator.trigger('keydown', { key: ' ' });
    expect(store.selection.has(noteId)).toBe(true);
    expect(wrapper.emitted('seek')).toEqual([[1]]);

    await navigator.trigger('keydown', { key: 'F10', shiftKey: true });
    expect(wrapper.find('score-annotation-palette-stub').exists()).toBe(true);
  });

  it('adds key markers snapped to the containing score measure', async () => {
    const wrapper = mount(ScorePanel, {
      props: {
        positionPpq: () => 6.75,
      },
      global: {
        stubs: {
          EmptyState: true,
          ScoreAnnotationPalette: true,
          ScoreToolbar: true,
        },
      },
    });

    await field(wrapper, 'Key').setValue('Bb');
    await field(wrapper, 'Mode').setValue('minor');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Add key')
      ?.trigger('click');
    await nextTick();

    expect(commandMocks.setMarker).toHaveBeenCalledWith(null, 4, 'Key: Bb minor');
    expect(notationMocks.setError).toHaveBeenCalledWith('');
    expect(notationMocks.transcribe).toHaveBeenCalled();
  });

  /** Mounts the panel at an edit position, adds a key marker, and returns the written ppq. */
  async function addKeyAt(positionPpq: number): Promise<number> {
    commandMocks.setMarker.mockClear();
    const wrapper = mount(ScorePanel, {
      props: { positionPpq: () => positionPpq },
      global: {
        stubs: { EmptyState: true, ScoreAnnotationPalette: true, ScoreToolbar: true },
      },
    });
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Add key')
      ?.trigger('click');
    await nextTick();
    return commandMocks.setMarker.mock.calls[0][1] as number;
  }

  it('snaps the key marker to the containing measure across a meter change', async () => {
    store.timeSignatures = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 4, numerator: 3, denominator: 4 },
    ];
    expect(await addKeyAt(8.5)).toBe(7);
  });

  it('snaps the key marker to the containing measure after an opening pickup', async () => {
    store.pickupLengthPpq = 1;
    expect(await addKeyAt(3)).toBe(1);
    expect(await addKeyAt(5.5)).toBe(5);
    expect(await addKeyAt(0.5)).toBe(0);
  });

  it('clears a pending retranscribe timer on unmount', async () => {
    vi.useFakeTimers();
    const wrapper = mount(ScorePanel, {
      global: {
        stubs: {
          EmptyState: true,
          ScoreAnnotationPalette: true,
          ScoreToolbar: true,
        },
      },
    });
    await nextTick();
    notationMocks.transcribe.mockClear();

    store.notes = [
      {
        id: 1,
        pitch: 60,
        velocity: 100,
        startPpq: 0,
        durationPpq: 1,
        channel: 0,
      },
    ];
    await nextTick();

    wrapper.unmount();
    vi.runOnlyPendingTimers();

    expect(notationMocks.transcribe).not.toHaveBeenCalled();
  });

  it('retranscribes after marker, tempo, meter and track revisions', async () => {
    vi.useFakeTimers();
    const wrapper = mount(ScorePanel, {
      global: {
        stubs: {
          EmptyState: true,
          ScoreAnnotationPalette: true,
          ScoreToolbar: true,
        },
      },
    });
    await nextTick();
    notationMocks.transcribe.mockClear();

    store.markers = [{ id: 1, ppq: 0, name: 'Intro' }];
    await nextTick();
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(notationMocks.transcribe).toHaveBeenCalledTimes(1);

    store.tempoSegments = [{ startPpq: 0, bpm: 96 }];
    await nextTick();
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(notationMocks.transcribe).toHaveBeenCalledTimes(2);

    store.timeSignatures = [{ startPpq: 0, numerator: 3, denominator: 4 }];
    await nextTick();
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(notationMocks.transcribe).toHaveBeenCalledTimes(3);

    store.tracks = store.tracks.map((track) => ({ ...track, name: `${track.name} renamed` }));
    await nextTick();
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(notationMocks.transcribe).toHaveBeenCalledTimes(4);

    wrapper.unmount();
  });
});
