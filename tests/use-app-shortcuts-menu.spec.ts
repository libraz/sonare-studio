import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, shallowRef } from 'vue';
import { useAppShortcutsMenu } from '@/composables/useAppShortcutsMenu';

describe('useAppShortcutsMenu', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function harness(blocked: { value: boolean }) {
    const match = vi.fn(() => 'transport.togglePlayback');
    const togglePlayback = vi.fn();
    const menu = useAppShortcutsMenu({
      deviceRackOpen: ref(false),
      editorTool: ref('select'),
      handle: shallowRef(null),
      helpOpen: ref(false),
      isGlobalShortcutBlocked: () => blocked.value,
      isPlaying: ref(false),
      layouts: ref([]),
      loopEnabled: ref(false),
      opfsAvailable: true,
      recentNames: ref([]),
      recording: {} as never,
      scoreVisible: ref(false),
      settingsOpen: ref(false),
      shortcuts: {
        match,
        keysFor: vi.fn(() => []),
      } as never,
      applyNamedLayout: vi.fn(),
      exportDawproject: vi.fn(),
      exportMidi2: vi.fn(),
      exportSmf: vi.fn(),
      exportSzd: vi.fn(),
      importAudio: vi.fn(),
      importMidi: vi.fn(),
      nudgeByBar: vi.fn(),
      openAbout: vi.fn(),
      openDiagnostics: vi.fn(),
      openExportDialog: vi.fn(),
      openNewDialog: vi.fn(),
      openOpenDialog: vi.fn(),
      openRecentProject: vi.fn(),
      openStartScreen: vi.fn(),
      openDemo: vi.fn(),
      openShortcutsHelp: vi.fn(),
      openWelcomeTour: vi.fn(),
      saveCurrentLayout: vi.fn(),
      saveProjectAction: vi.fn(),
      saveProjectAsAction: vi.fn(),
      seekToEnd: vi.fn(),
      seekToStart: vi.fn(),
      setEditorTool: vi.fn(),
      setLeftLocator: vi.fn(),
      setRightLocator: vi.fn(),
      toggleDeviceRack: vi.fn(),
      toggleLoop: vi.fn(),
      togglePlayback,
      toggleRecord: vi.fn(),
      toggleScorePanel: vi.fn(),
    });
    return { match, menu, togglePlayback };
  }

  it('does not run global shortcuts while a modal or overlay blocks them', () => {
    const blocked = { value: true };
    const { match, menu, togglePlayback } = harness(blocked);
    const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true });

    menu.onGlobalKeyDown(event);

    expect(match).not.toHaveBeenCalled();
    expect(togglePlayback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('runs global shortcuts again after the blocking overlay closes', () => {
    const blocked = { value: false };
    const { match, menu, togglePlayback } = harness(blocked);
    const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true });

    menu.onGlobalKeyDown(event);

    expect(match).toHaveBeenCalledWith(event, 'editor');
    expect(togglePlayback).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
