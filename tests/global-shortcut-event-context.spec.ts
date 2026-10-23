import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, shallowRef } from 'vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import { useAppShortcutsMenu } from '@/composables/useAppShortcutsMenu';
import { useShortcuts } from '@/composables/useShortcuts';
import { addNote, clearHistory, setSelection } from '@/project/commands';
import { useProjectStore } from '@/project/store';

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

function harness(actionId: string, overrides: Record<string, unknown> = {}) {
  const match = vi.fn(() => actionId);
  const togglePlayback = vi.fn();
  const nudgeByBar = vi.fn();
  const menu = useAppShortcutsMenu({
    deviceRackOpen: ref(false),
    commandPaletteOpen: ref(false),
    editorTool: ref('select'),
    handle: shallowRef({}) as never,
    helpOpen: ref(false),
    isPlaying: ref(false),
    layouts: ref([]),
    loopEnabled: ref(false),
    opfsAvailable: true,
    pianoRollRef: ref(null),
    recentNames: ref([]),
    midiRecording: { armedTrackId: ref<number | null>(null), arm: vi.fn() } as never,
    recording: {
      armedTrackId: ref<number | null>(null),
      armedTrackIds: ref<number[]>([]),
      isRecording: ref(false),
    } as never,
    scoreVisible: ref(false),
    settingsOpen: ref(false),
    shortcuts: { match, keysFor: vi.fn(() => []) } as never,
    nudgeByBar,
    togglePlayback,
    ...overrides,
  } as never);
  return { menu, match, togglePlayback, nudgeByBar };
}

function keydown(init: KeyboardEventInit, target?: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('global shortcut event context', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('runs a toggle action once per press and swallows its auto-repeats', () => {
    const { menu, togglePlayback } = harness('transport.togglePlayback');

    menu.onGlobalKeyDown(keydown({ key: ' ' }));
    const repeated = keydown({ key: ' ', repeat: true });
    menu.onGlobalKeyDown(repeated);

    expect(togglePlayback).toHaveBeenCalledTimes(1);
    expect(repeated.defaultPrevented).toBe(true);
  });

  it('keeps repeating nudge actions while the key is held', () => {
    const { menu, nudgeByBar } = harness('transport.nudgeForward');

    menu.onGlobalKeyDown(keydown({ key: '.' }));
    menu.onGlobalKeyDown(keydown({ key: '.', repeat: true }));

    expect(nudgeByBar).toHaveBeenCalledTimes(2);
  });

  it('leaves Space on a focused button to the button', () => {
    const { menu, match, togglePlayback } = harness('transport.togglePlayback');
    const button = document.createElement('button');
    document.body.appendChild(button);

    const event = keydown({ key: ' ' }, button);
    menu.onGlobalKeyDown(event);

    expect(match).not.toHaveBeenCalled();
    expect(togglePlayback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    button.remove();
  });

  it('mutes and solos a frozen track from the keyboard like the header buttons', () => {
    const track = store.tracks[0];
    track.frozen = { assetId: 'frozen-asset' };
    store.activeTrackId = track.id;
    const mute = harness('track.toggleMute');
    const solo = harness('track.toggleSolo');

    mute.menu.onGlobalKeyDown(keydown({ key: 'm', altKey: true }));
    solo.menu.onGlobalKeyDown(keydown({ key: 's', altKey: true }));

    expect(store.tracks[0].mute).toBe(true);
    expect(store.tracks[0].solo).toBe(true);
  });

  describe('Edit menu availability', () => {
    function row(menu: ReturnType<typeof harness>['menu'], id: string) {
      return (menu.menuBarModel.value.find((entry) => entry.id === 'edit')?.items ?? []).find(
        (entry) => entry.id === id,
      );
    }

    it('disables split when the playhead is outside the clip and refuses the shortcut', () => {
      const positionPpq = ref(40);
      const { menu } = harness('arrange.splitClipAtPlayhead', { positionPpq });
      const cutAtPlayhead = vi.fn();
      menu.arrangementRef.value = { cutAtPlayhead } as never;

      expect(row(menu, 'arrange.splitClipAtPlayhead')?.disabledReason).toBeTruthy();
      const event = keydown({ key: 'b' });
      menu.onGlobalKeyDown(event);
      expect(cutAtPlayhead).not.toHaveBeenCalled();

      positionPpq.value = 4;
      expect(row(menu, 'arrange.splitClipAtPlayhead')?.disabledReason).toBeNull();
      menu.onGlobalKeyDown(keydown({ key: 'b' }));
      expect(cutAtPlayhead).toHaveBeenCalledTimes(1);
    });

    it('disables note paste and select-all without an active MIDI clip', () => {
      const clip = store.activeClip;
      expect(clip).toBeDefined();
      (clip as { kind?: string }).kind = 'audio';
      const { menu } = harness('edit.selectAllNotes');
      menu.focusZone.value = 'editor';

      expect(row(menu, 'edit.paste')?.disabledReason).toBeTruthy();
      expect(row(menu, 'edit.selectAllNotes')?.disabledReason).toBeTruthy();
    });
  });
});

describe('registry-owned editing keys', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('deletes selected notes on Delete only while the registry binds it', () => {
    const shortcuts = useShortcuts();
    const store = useProjectStore();
    const id = addNote({ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1 });
    setSelection([id]);
    const { menu } = harness('', { shortcuts });

    shortcuts.setKeys('edit.deleteSelectedNotes', []);
    menu.onGlobalKeyDown(keydown({ key: 'Delete' }));
    expect(store.notes.some((note) => note.id === id)).toBe(true);

    shortcuts.resetKeys('edit.deleteSelectedNotes');
    menu.onGlobalKeyDown(keydown({ key: 'Delete' }));
    expect(store.notes.some((note) => note.id === id)).toBe(false);
  });

  it('keeps undo, redo and delete out of the piano roll key handler', () => {
    const source = readFileSync('src/components/piano-roll/PianoRollEditor.vue', 'utf8');
    const handler = source.slice(
      source.indexOf('function onKeyDown'),
      source.indexOf('function handleKeyboardEdit'),
    );
    expect(handler).not.toMatch(/toLowerCase\(\) === 'z'|undo\(|redo\(|Delete|Backspace/);
  });
});

describe('score panel keys', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  function mountWithSelectedNote() {
    const store = useProjectStore();
    const id = addNote({ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1 });
    setSelection([id]);
    const wrapper = mount(ScorePanel, {
      global: { stubs: { EmptyState: true, ScoreAnnotationPalette: true, ScoreToolbar: true } },
    });
    return { store, body: wrapper.find('.score-body') };
  }

  it('adds one note per N press, ignoring auto-repeat', async () => {
    const { store, body } = mountWithSelectedNote();
    expect(body.exists()).toBe(true);
    const before = store.notes.length;

    await body.trigger('keydown', { key: 'n' });
    await body.trigger('keydown', { key: 'n', repeat: true });
    await body.trigger('keydown', { key: 'n', repeat: true });

    expect(store.notes.length).toBe(before + 1);
  });

  it('leaves Delete and the bracket keys to the shortcut registry', async () => {
    const { store, body } = mountWithSelectedNote();
    const before = store.notes.length;
    const durations = store.notes.map((note) => note.durationPpq);

    const del = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    body.element.dispatchEvent(del);
    const bracket = new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true });
    body.element.dispatchEvent(bracket);

    expect(store.notes.length).toBe(before);
    expect(store.notes.map((note) => note.durationPpq)).toEqual(durations);
    expect(del.defaultPrevented).toBe(false);
    expect(bracket.defaultPrevented).toBe(false);
  });
});
