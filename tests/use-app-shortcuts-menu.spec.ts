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

  function harness(
    blocked: { value: boolean },
    overrides: Partial<Parameters<typeof useAppShortcutsMenu>[0]> = {},
  ) {
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
      recording: { armedTrackId: ref<number | null>(null), isRecording: ref(false) } as never,
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
      ...overrides,
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

  it('exposes the command palette in the Options menu', () => {
    const commandPaletteOpen = ref(false);
    const { menu } = harness(
      { value: false },
      {
        commandPaletteOpen,
        shortcuts: { match: vi.fn(), keysFor: vi.fn(() => ['mod+k']) } as never,
      },
    );
    const optionsMenu = menu.menuBarModel.value.find((entry) => entry.id === 'options');
    const item = optionsMenu?.items.find((entry) => entry.id === 'options.commandPalette');

    expect(item?.hint).toBeTruthy();
    item?.run?.();
    expect(commandPaletteOpen.value).toBe(true);
  });

  it('ignores the record shortcut when no track is armed, but fires it once armed', () => {
    const armedTrackId = ref<number | null>(null);
    const toggleRecord = vi.fn();
    const { menu } = harness(
      { value: false },
      {
        handle: shallowRef({} as never),
        recording: { armedTrackId, isRecording: ref(false) } as never,
        toggleRecord,
        shortcuts: {
          match: vi.fn(() => 'transport.toggleRecord'),
          keysFor: vi.fn(() => ['r']),
        } as never,
      },
    );

    // With an engine present but no armed track, the shortcut must no-op — the
    // menu entry is disabled in this state, so the key path must match it.
    menu.onGlobalKeyDown(new KeyboardEvent('keydown', { key: 'r', cancelable: true }));
    expect(toggleRecord).not.toHaveBeenCalled();

    // Arming a track satisfies the guard; the shortcut now toggles recording.
    armedTrackId.value = 3;
    menu.onGlobalKeyDown(new KeyboardEvent('keydown', { key: 'r', cancelable: true }));
    expect(toggleRecord).toHaveBeenCalledTimes(1);
  });

  it('uses the same unavailable guards for Save and Quantize as their menu items', () => {
    const saveProjectAction = vi.fn();
    const { menu: saveMenu } = harness(
      { value: false },
      {
        opfsAvailable: false,
        saveProjectAction,
        shortcuts: { match: vi.fn(() => 'project.save'), keysFor: vi.fn(() => ['mod+s']) } as never,
      },
    );
    const save = new KeyboardEvent('keydown', { key: 's', cancelable: true });
    saveMenu.onGlobalKeyDown(save);
    expect(saveProjectAction).not.toHaveBeenCalled();
    expect(save.defaultPrevented).toBe(false);

    const { menu: quantizeMenu } = harness(
      { value: false },
      {
        shortcuts: {
          match: vi.fn(() => 'edit.quantizeSelection'),
          keysFor: vi.fn(() => ['q']),
        } as never,
      },
    );
    const quantize = new KeyboardEvent('keydown', { key: 'q', cancelable: true });
    quantizeMenu.onGlobalKeyDown(quantize);
    expect(quantize.defaultPrevented).toBe(false);
  });

  it('lists saved layouts only once, in the dedicated Layout menu', () => {
    const { menu } = harness(
      { value: false },
      {
        layouts: ref([{ name: 'Mixing' }, { name: 'Editing' }]),
        recording: {
          armedTrackId: ref(null),
          isRecording: ref(false),
        } as never,
      },
    );

    // The Window menu must no longer carry layout rows or a save-layout row.
    const windowMenu = menu.menuBarModel.value.find((m) => m.id === 'window');
    const windowIds = (windowMenu?.items ?? []).map((item) => item.id);
    expect(windowIds.some((id) => id.startsWith('window.layout.'))).toBe(false);
    expect(windowIds).not.toContain('window.saveLayout');

    // The dedicated Layout menu is the single home for the saved layouts.
    expect(menu.layoutMenu.value.items.map((item) => item.id)).toContain('layout.Mixing');

    // Flattened into the command palette, each layout appears exactly once.
    const layoutRows = menu.commandPaletteItems.value.filter((row) =>
      row.label.endsWith(': Mixing'),
    );
    expect(layoutRows).toHaveLength(1);
  });
});
