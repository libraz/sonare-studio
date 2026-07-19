import { type ComputedRef, computed, type Ref, ref, type ShallowRef } from 'vue';
import type { useRecording } from '@/composables/useRecording';
import type { useShortcuts } from '@/composables/useShortcuts';
import type { EngineHandle } from '@/engine/engine';
import {
  canRedo,
  canUndo,
  deleteClip,
  deleteNotes,
  duplicateClip,
  quantizeSelection,
  redo,
  setSelection,
  transposeSelection,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';
import type { EditorToolId } from '@/ui/editor/tools';
import { useI18n } from '@/ui/i18n';
import { isEditableTarget } from '@/ui/keyboard';
import {
  cleanMenuItems,
  isNavigable,
  type MenuBarItem,
  type MenuBarMenu,
} from '@/ui/menu/menu-bar';
import { detectPlatform, formatKeyCombo } from '@/ui/settings/key-combo';

type Recording = ReturnType<typeof useRecording>;
type Shortcuts = ReturnType<typeof useShortcuts>;
type FocusZone = 'arrange' | 'editor';

interface ArrangementCommands {
  cutAtPlayhead: () => void;
}

export interface AppShortcutsMenuOptions {
  deviceRackOpen: Ref<boolean>;
  commandPaletteOpen: Ref<boolean>;
  editorTool: Ref<EditorToolId>;
  handle: ShallowRef<EngineHandle | null>;
  helpOpen: Ref<boolean>;
  isPlaying: Ref<boolean>;
  isGlobalShortcutBlocked?: () => boolean;
  layouts: Ref<readonly { name: string }[]>;
  loopEnabled: Ref<boolean>;
  opfsAvailable: boolean;
  recentNames: Ref<readonly string[]>;
  recording: Recording;
  scoreVisible: Ref<boolean>;
  settingsOpen: Ref<boolean>;
  shortcuts: Shortcuts;
  applyNamedLayout: (name: string) => void;
  exportDawproject: () => void;
  exportBrowserBackup: () => void;
  exportMidi2: () => void;
  exportMusicXml: () => void;
  exportSmf: () => void;
  exportSzd: () => void;
  importAudio: () => void;
  importBrowserBackup: () => void;
  importDawproject: () => void;
  importMusicXml: () => void;
  importMidi: () => void;
  nudgeByBar: (direction: -1 | 1) => void;
  openAbout: () => void;
  openDiagnostics: () => void;
  openExportDialog: () => void;
  openChordGenerateDialog: () => void;
  openTrackGenerateDialog: () => void;
  openNewDialog: () => void;
  openOpenDialog: () => void;
  openRecentProject: (name: string) => void;
  openStartScreen: () => void;
  openDemo: () => void;
  openShortcutsHelp: () => void;
  openWelcomeTour: () => void;
  saveCurrentLayout: () => void;
  saveProjectAction: () => void;
  saveProjectAsAction: () => void;
  seekToEnd: () => void;
  seekToStart: () => void;
  setEditorTool: (tool: EditorToolId) => void;
  setLeftLocator: () => void;
  setRightLocator: () => void;
  toggleDeviceRack: () => void;
  toggleLoop: () => void;
  togglePlayback: () => void;
  toggleRecord: () => void;
  toggleScorePanel: () => void;
}

export function useAppShortcutsMenu(options: AppShortcutsMenuOptions) {
  const store = useProjectStore();
  const { t } = useI18n();
  const focusZone = ref<FocusZone>('editor');
  const arrangementRef = ref<ArrangementCommands | null>(null);
  const menuPlatform = detectPlatform();

  function selectAllNotes(): void {
    if (!store.initialized) return;
    setSelection(store.notes.map((note) => note.id));
  }

  function deleteSelectedNotes(): void {
    if (store.selection.size === 0) return;
    deleteNotes([...store.selection]);
  }

  function activeContentReadOnly(): boolean {
    return store.activeTrack?.frozen !== undefined;
  }

  function runShortcutAction(actionId: string): boolean {
    switch (actionId) {
      case 'transport.togglePlayback':
        options.togglePlayback();
        return true;
      case 'transport.toggleLoop':
        options.toggleLoop();
        return true;
      case 'transport.toStart':
        options.seekToStart();
        return true;
      case 'transport.toEnd':
        options.seekToEnd();
        return true;
      case 'transport.nudgeBack':
        options.nudgeByBar(-1);
        return true;
      case 'transport.nudgeForward':
        options.nudgeByBar(1);
        return true;
      case 'transport.setLeftLocator':
        options.setLeftLocator();
        return true;
      case 'transport.setRightLocator':
        options.setRightLocator();
        return true;
      case 'transport.toggleRecord':
        // Mirror the menu item's guard: recording needs both an engine and an
        // armed track. Without this the shortcut fired a no-op toggle with no
        // track armed, diverging from the (disabled) menu entry.
        if (!options.handle.value || options.recording.armedTrackId.value === null) return false;
        options.toggleRecord();
        return true;
      case 'project.save':
        options.saveProjectAction();
        return true;
      case 'project.saveAs':
        if (!options.opfsAvailable) return false;
        options.saveProjectAsAction();
        return true;
      case 'project.open':
        if (!options.opfsAvailable) return false;
        options.openOpenDialog();
        return true;
      case 'edit.undo':
        undo();
        return true;
      case 'edit.redo':
        redo();
        return true;
      case 'edit.selectAllNotes':
        selectAllNotes();
        return true;
      case 'edit.quantizeSelection':
        if (activeContentReadOnly()) return false;
        quantizeSelection();
        return true;
      case 'edit.deleteSelectedNotes':
        if (activeContentReadOnly() || store.selection.size === 0) return false;
        deleteSelectedNotes();
        return true;
      case 'edit.transposeUp':
        if (activeContentReadOnly() || store.selection.size === 0) return false;
        transposeSelection(1);
        return true;
      case 'edit.transposeDown':
        if (activeContentReadOnly() || store.selection.size === 0) return false;
        transposeSelection(-1);
        return true;
      case 'edit.transposeOctaveUp':
        if (activeContentReadOnly() || store.selection.size === 0) return false;
        transposeSelection(12);
        return true;
      case 'edit.transposeOctaveDown':
        if (activeContentReadOnly() || store.selection.size === 0) return false;
        transposeSelection(-12);
        return true;
      case 'arrange.duplicateClip': {
        const clip = store.activeClip;
        if (!clip || activeContentReadOnly()) return false;
        duplicateClip(clip.id, clip.startPpq + clip.lengthPpq);
        return true;
      }
      case 'arrange.splitClipAtPlayhead':
        if (activeContentReadOnly()) return false;
        arrangementRef.value?.cutAtPlayhead();
        return true;
      case 'arrange.deleteClip':
        if (activeContentReadOnly()) return false;
        if (store.clipId === -1) {
          if (store.selection.size === 0) return false;
          deleteSelectedNotes();
          return true;
        }
        deleteClip(store.clipId);
        return true;
      case 'view.toggleSnap':
        store.snapEnabled = !store.snapEnabled;
        return true;
      case 'view.toggleScorePanel':
        options.toggleScorePanel();
        return true;
      case 'tool.select':
        options.setEditorTool('select');
        return true;
      case 'tool.draw':
        options.setEditorTool('draw');
        return true;
      case 'tool.split':
        options.setEditorTool('split');
        return true;
      case 'tool.erase':
        options.setEditorTool('erase');
        return true;
      case 'app.settings':
        options.settingsOpen.value = true;
        return true;
      case 'app.commandPalette':
        options.commandPaletteOpen.value = true;
        return true;
      case 'help.shortcuts':
        options.helpOpen.value = true;
        return true;
      default:
        return false;
    }
  }

  function hintFor(actionId: string): string | undefined {
    const combo = options.shortcuts.keysFor(actionId)[0];
    return combo ? formatKeyCombo(combo, menuPlatform) : undefined;
  }

  function shortcutTitle(base: string, actionId: string): string {
    const hint = hintFor(actionId);
    return hint ? `${base} (${hint})` : base;
  }

  /** Menu row that runs a registered shortcut action (and shows its key hint). */
  function actionItem(
    actionId: string,
    label: string,
    extra: { disabled?: boolean; checked?: boolean } = {},
  ): MenuBarItem {
    return {
      id: actionId,
      label,
      hint: hintFor(actionId),
      disabled: extra.disabled,
      checked: extra.checked,
      run: () => {
        runShortcutAction(actionId);
      },
    };
  }

  /** Menu row that runs an arbitrary callback (file / help / layout commands). */
  function commandItem(
    id: string,
    label: string,
    run: () => void,
    extra: { disabled?: boolean; checked?: boolean; hintFor?: string } = {},
  ): MenuBarItem {
    return {
      id,
      label,
      hint: extra.hintFor ? hintFor(extra.hintFor) : undefined,
      disabled: extra.disabled,
      checked: extra.checked,
      run,
    };
  }

  const sep = (id: string): MenuBarItem => ({ id, separator: true });
  const heading = (id: string, text: string): MenuBarItem => ({ id, heading: text });

  function fileItems(): MenuBarItem[] {
    const m = t.value.shell.project;
    const noOpfs = !options.opfsAvailable;
    const noMidiClip = !store.activeClip || clipKind(store.activeClip) !== 'midi';
    const items: MenuBarItem[] = [
      commandItem('file.startScreen', m.startScreen, options.openStartScreen),
      commandItem('file.new', m.new, options.openNewDialog),
      commandItem('file.open', m.open, options.openOpenDialog, {
        disabled: noOpfs,
        hintFor: 'project.open',
      }),
      commandItem('file.openDemo', m.openDemo, options.openDemo),
      sep('file.sep-save'),
      commandItem('file.save', m.save, options.saveProjectAction, {
        disabled: noOpfs,
        hintFor: 'project.save',
      }),
      commandItem('file.saveAs', m.saveAs, options.saveProjectAsAction, {
        disabled: noOpfs,
        hintFor: 'project.saveAs',
      }),
    ];
    const recent = options.recentNames.value;
    if (recent.length > 0) {
      items.push(sep('file.sep-recent'), heading('file.recent', m.recent));
      for (const name of recent) {
        items.push(
          commandItem(`file.recent.${name}`, name, () => options.openRecentProject(name), {
            disabled: noOpfs,
          }),
        );
      }
    }
    items.push(
      sep('file.sep-import'),
      commandItem('file.importMidi', m.importMidi, options.importMidi),
      commandItem('file.importAudio', m.importAudio, options.importAudio),
      commandItem('file.importDawproject', m.importDawproject, options.importDawproject),
      commandItem('file.importMusicXml', m.importMusicXml, options.importMusicXml),
      commandItem('file.importBackup', m.importBackup, options.importBrowserBackup, {
        disabled: noOpfs,
      }),
      sep('file.sep-export'),
      commandItem('file.exportSzd', m.exportSzd, options.exportSzd),
      commandItem('file.exportBackup', m.exportBackup, options.exportBrowserBackup, {
        disabled: noOpfs,
      }),
      commandItem('file.exportSmf', m.exportSmf, options.exportSmf),
      commandItem('file.exportMidi2', m.exportMidi2, options.exportMidi2),
      commandItem('file.exportMusicXml', m.exportMusicXml, options.exportMusicXml, {
        disabled: noMidiClip,
      }),
      commandItem('file.exportAudio', m.exportAudio, options.openExportDialog),
      commandItem('file.exportDawproject', m.exportDawproject, options.exportDawproject),
    );
    return items;
  }

  function editItems(): MenuBarItem[] {
    const a = t.value.shortcuts.actions;
    const noSelection = store.selection.size === 0;
    const noClip = !store.activeClip;
    const readOnly = activeContentReadOnly();
    return [
      actionItem('edit.undo', a['edit.undo'], { disabled: !canUndo() }),
      actionItem('edit.redo', a['edit.redo'], { disabled: !canRedo() }),
      sep('edit.sep-select'),
      actionItem('edit.selectAllNotes', a['edit.selectAllNotes']),
      actionItem('edit.quantizeSelection', a['edit.quantizeSelection'], {
        disabled: readOnly || noSelection,
      }),
      actionItem('edit.deleteSelectedNotes', t.value.shortcuts.menu.deleteSelection, {
        disabled: readOnly || noSelection,
      }),
      heading('edit.transpose', t.value.shortcuts.menu.transpose),
      actionItem('edit.transposeUp', a['edit.transposeUp'], { disabled: readOnly || noSelection }),
      actionItem('edit.transposeDown', a['edit.transposeDown'], {
        disabled: readOnly || noSelection,
      }),
      actionItem('edit.transposeOctaveUp', a['edit.transposeOctaveUp'], {
        disabled: readOnly || noSelection,
      }),
      actionItem('edit.transposeOctaveDown', a['edit.transposeOctaveDown'], {
        disabled: readOnly || noSelection,
      }),
      heading('edit.clip', t.value.shortcuts.menu.clip),
      actionItem('arrange.duplicateClip', a['arrange.duplicateClip'], {
        disabled: readOnly || noClip,
      }),
      actionItem('arrange.splitClipAtPlayhead', a['arrange.splitClipAtPlayhead'], {
        disabled: readOnly || noClip,
      }),
      actionItem('arrange.deleteClip', a['arrange.deleteClip'], { disabled: readOnly || noClip }),
    ];
  }

  function viewItems(): MenuBarItem[] {
    const a = t.value.shortcuts.actions;
    return [
      actionItem('view.toggleSnap', t.value.shortcuts.menu.snapToGrid, {
        checked: store.snapEnabled,
      }),
      heading('view.tools', t.value.shortcuts.menu.tools),
      actionItem('tool.select', a['tool.select'], {
        checked: options.editorTool.value === 'select',
      }),
      actionItem('tool.draw', a['tool.draw'], { checked: options.editorTool.value === 'draw' }),
      actionItem('tool.split', a['tool.split'], { checked: options.editorTool.value === 'split' }),
      actionItem('tool.erase', a['tool.erase'], { checked: options.editorTool.value === 'erase' }),
    ];
  }

  function windowItems(): MenuBarItem[] {
    // Saved layouts and "save current" live only in the dedicated Layout menu
    // (layoutMenu). Listing them here too duplicated every layout across the
    // menu bar and, once flattened, the command palette.
    return [
      commandItem(
        'window.deviceRack',
        t.value.shortcuts.menu.deviceRack,
        options.toggleDeviceRack,
        {
          checked: options.deviceRackOpen.value,
        },
      ),
      actionItem('view.toggleScorePanel', t.value.shortcuts.menu.scorePanel, {
        checked: options.scoreVisible.value,
      }),
    ];
  }

  function transportItems(): MenuBarItem[] {
    const a = t.value.shortcuts.actions;
    const engineReady = Boolean(options.handle.value);
    const canRecord = engineReady && options.recording.armedTrackId.value !== null;
    return [
      actionItem(
        'transport.togglePlayback',
        options.isPlaying.value ? t.value.shortcuts.menu.stop : t.value.shortcuts.menu.play,
      ),
      actionItem('transport.toggleLoop', t.value.shortcuts.menu.loop, {
        checked: options.loopEnabled.value,
      }),
      actionItem('transport.toggleRecord', a['transport.toggleRecord'], {
        disabled: !canRecord,
        checked: options.recording.isRecording.value,
      }),
      sep('transport.sep-nav'),
      actionItem('transport.toStart', a['transport.toStart'], { disabled: !engineReady }),
      actionItem('transport.toEnd', a['transport.toEnd'], { disabled: !engineReady }),
      actionItem('transport.nudgeBack', a['transport.nudgeBack'], { disabled: !engineReady }),
      actionItem('transport.nudgeForward', a['transport.nudgeForward'], { disabled: !engineReady }),
      heading('transport.locators', t.value.shortcuts.menu.locators),
      actionItem('transport.setLeftLocator', a['transport.setLeftLocator']),
      actionItem('transport.setRightLocator', a['transport.setRightLocator']),
    ];
  }

  function optionsItems(): MenuBarItem[] {
    const h = t.value.shell.help;
    return [
      commandItem(
        'options.settings',
        t.value.settings.title,
        () => {
          options.settingsOpen.value = true;
        },
        { hintFor: 'app.settings' },
      ),
      commandItem('options.shortcuts', h.shortcuts, options.openShortcutsHelp, {
        hintFor: 'help.shortcuts',
      }),
    ];
  }

  function helpItems(): MenuBarItem[] {
    const h = t.value.shell.help;
    return [
      commandItem('help.welcomeTour', h.welcomeTour, options.openWelcomeTour),
      commandItem('help.diagnostics', h.diagnostics, options.openDiagnostics),
      sep('help.sep-about'),
      commandItem('help.about', h.about, options.openAbout),
    ];
  }

  function generateItems(): MenuBarItem[] {
    const g = t.value.shell.generate;
    const noProject = !store.initialized;
    return [
      commandItem('generate.progression', g.progression, options.openChordGenerateDialog, {
        disabled: noProject,
      }),
      commandItem('generate.tracks', g.tracks, options.openTrackGenerateDialog, {
        disabled: noProject,
      }),
    ];
  }

  /** The left command bar: File / Edit / View / Transport / Generate / Help. */
  const menuBarModel: ComputedRef<MenuBarMenu[]> = computed(() => {
    const m = t.value.shell.menus;
    return [
      { id: 'file', label: m.file, ariaLabel: t.value.shell.project.menuLabel, items: fileItems() },
      { id: 'edit', label: m.edit, items: editItems() },
      { id: 'view', label: m.view, items: viewItems() },
      { id: 'transport', label: m.transport, items: transportItems() },
      { id: 'generate', label: m.generate, items: generateItems() },
      { id: 'window', label: m.window, items: windowItems() },
      { id: 'options', label: m.options, items: optionsItems() },
      {
        id: 'help',
        label: t.value.shell.help.trigger,
        ariaLabel: t.value.shell.help.menuLabel,
        items: helpItems(),
      },
    ];
  });

  /** The right-aligned Layout picker: saved layouts plus "save current". */
  const layoutMenu: ComputedRef<MenuBarMenu> = computed(() => {
    const l = t.value.shell.layout;
    const items: MenuBarItem[] = options.layouts.value.map((layout) =>
      commandItem(`layout.${layout.name}`, layout.name, () =>
        options.applyNamedLayout(layout.name),
      ),
    );
    items.push(
      sep('layout.sep-save'),
      commandItem('layout.saveCurrent', l.saveCurrent, options.saveCurrentLayout),
    );
    return { id: 'layout', label: l.trigger, ariaLabel: l.menuLabel, items };
  });

  const commandPaletteItems = computed(() => {
    const menus: MenuBarMenu[] = [...menuBarModel.value, layoutMenu.value];
    return menus.flatMap((menu) =>
      cleanMenuItems(menu.items)
        .filter(isNavigable)
        .map((item) => ({
          id: `${menu.id}.${item.id}`,
          label: `${menu.label}: ${item.label}`,
          ...(item.hint ? { hint: item.hint } : {}),
          run: item.run as () => void,
        })),
    );
  });

  function onGlobalKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || isEditableTarget(event.target)) return;
    if (options.isGlobalShortcutBlocked?.() === true) return;
    const scope = focusZone.value === 'arrange' ? 'arrangement' : 'editor';
    const actionId = options.shortcuts.match(event, scope);
    if (actionId === null) return;
    if (runShortcutAction(actionId)) event.preventDefault();
  }

  return {
    arrangementRef,
    focusZone,
    commandPaletteItems,
    layoutMenu,
    menuBarModel,
    onGlobalKeyDown,
    shortcutTitle,
  };
}
