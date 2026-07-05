import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, shallowRef } from 'vue';
import { useAppShortcutsMenu } from '@/composables/useAppShortcutsMenu';
import {
  resetShortcutBlockingOverlaysForTest,
  shortcutBlockingOverlayOpen,
  useShortcutBlockingOverlay,
} from '@/ui/overlay-registry';

describe('useAppShortcutsMenu', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetShortcutBlockingOverlaysForTest();
  });

  function harness(blocked: { value: boolean }) {
    const match = vi.fn(() => 'transport.togglePlayback');
    const togglePlayback = vi.fn();
    const menu = useAppShortcutsMenu({
      deviceRackOpen: ref(false),
      commandPaletteOpen: ref(false),
      editorTool: ref('select'),
      handle: shallowRef(null),
      helpOpen: ref(false),
      isGlobalShortcutBlocked: () => blocked.value || shortcutBlockingOverlayOpen.value,
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
      exportBrowserBackup: vi.fn(),
      exportMidi2: vi.fn(),
      exportMusicXml: vi.fn(),
      exportSmf: vi.fn(),
      exportSzd: vi.fn(),
      importAudio: vi.fn(),
      importBrowserBackup: vi.fn(),
      importDawproject: vi.fn(),
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

  it('does not run global shortcuts while a registered overlay is visible', () => {
    const { match, menu, togglePlayback } = harness({ value: false });
    useShortcutBlockingOverlay(ref(true));
    const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true });

    menu.onGlobalKeyDown(event);

    expect(match).not.toHaveBeenCalled();
    expect(togglePlayback).not.toHaveBeenCalled();
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

  it('opens the command palette through the registered shortcut action', () => {
    const blocked = { value: false };
    const match = vi.fn(() => 'app.commandPalette');
    const commandPaletteOpen = ref(false);
    const menu = useAppShortcutsMenu({
      deviceRackOpen: ref(false),
      commandPaletteOpen,
      editorTool: ref('select'),
      handle: shallowRef(null),
      helpOpen: ref(false),
      isGlobalShortcutBlocked: () => blocked.value || shortcutBlockingOverlayOpen.value,
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
        keysFor: vi.fn(() => ['mod+k']),
      } as never,
      applyNamedLayout: vi.fn(),
      exportDawproject: vi.fn(),
      exportBrowserBackup: vi.fn(),
      exportMidi2: vi.fn(),
      exportMusicXml: vi.fn(),
      exportSmf: vi.fn(),
      exportSzd: vi.fn(),
      importAudio: vi.fn(),
      importBrowserBackup: vi.fn(),
      importDawproject: vi.fn(),
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
      togglePlayback: vi.fn(),
      toggleRecord: vi.fn(),
      toggleScorePanel: vi.fn(),
    });
    const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true });

    menu.onGlobalKeyDown(event);

    expect(commandPaletteOpen.value).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });
});
