import { type ComputedRef, computed, type Ref, ref, type ShallowRef } from 'vue';
import type { useMidiRecording } from '@/composables/useMidiRecording';
import type { useRecording } from '@/composables/useRecording';
import type { useShortcuts } from '@/composables/useShortcuts';
import type { EngineHandle } from '@/engine/engine';
import { describeError } from '@/lib/errors';
import {
  canPasteClipAt,
  clipClipboardVersion,
  hasCopiedClip,
} from '@/project/command/clips-clipboard';
import {
  canRedo,
  canUndo,
  copyActiveClip,
  copySelectedNotes,
  cutActiveClip,
  cutSelectedNotes,
  deleteClip,
  deleteNotes,
  duplicateClip,
  pasteClipAt,
  pasteNotesAt,
  quantizeSelection,
  redo,
  setActiveClip,
  setSelection,
  setTrackMute,
  setTrackSolo,
  transposeSelection,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
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
import { localizedLayoutName } from '@/ui/settings/layouts';

type Recording = ReturnType<typeof useRecording>;
type MidiRecording = ReturnType<typeof useMidiRecording>;
type Shortcuts = ReturnType<typeof useShortcuts>;
type FocusZone = 'arrange' | 'editor';

interface ArrangementCommands {
  cutAtPlayhead: () => void;
  zoomHorizontal: (factor: number) => void;
  zoomToFit: () => void;
}

interface PianoRollCommands {
  fitSelection: () => void;
  zoomHorizontal: (factor: number) => void;
}

export interface AppShortcutsMenuOptions {
  /** Unified session state from useRecordingControls. */
  canRecord?: Ref<boolean>;
  deviceRackOpen: Ref<boolean>;
  commandPaletteOpen: Ref<boolean>;
  editorTool: Ref<EditorToolId>;
  handle: ShallowRef<EngineHandle | null>;
  helpOpen: Ref<boolean>;
  isPlaying: Ref<boolean>;
  /** Unified session state from useRecordingControls. */
  isRecording?: Ref<boolean>;
  isGlobalShortcutBlocked?: () => boolean;
  layouts: Ref<readonly { name: string }[]>;
  loopEnabled: Ref<boolean>;
  pianoRollRef: Ref<PianoRollCommands | null>;
  opfsAvailable: boolean;
  /** Current transport playhead, used to place pasted note selections. */
  positionPpq?: Ref<number>;
  recentNames: Ref<readonly string[]>;
  midiRecording: MidiRecording;
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
  importStems: () => void;
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
  openKeyChangeDialog: () => void;
  openNewDialog: () => void;
  openOpenDialog: () => void;
  openRevisionsDialog: () => void;
  openRecentProject: (name: string) => void;
  openStartScreen: () => void;
  openDemo: () => void;
  openShortcutsHelp: () => void;
  openWelcomeTour: () => void;
  /** Publishes a user-visible failure from a menu or global shortcut command. */
  onError?: (message: string) => void;
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

  function reportActionError(error: unknown): void {
    options.onError?.(describeError(error));
  }

  /** Ensures menu and palette command failures use the shell error surface. */
  function runMenuAction(action: () => unknown): void {
    try {
      void Promise.resolve(action()).catch(reportActionError);
    } catch (error) {
      reportActionError(error);
    }
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
        if (
          !options.handle.value ||
          !(
            options.canRecord?.value ??
            (options.recording.armedTrackId.value !== null ||
              options.midiRecording.armedTrackId.value !== null)
          )
        ) {
          return false;
        }
        options.toggleRecord();
        return true;
      case 'project.save':
        if (!options.opfsAvailable) return false;
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
      case 'edit.copy':
        return focusZone.value === 'arrange' ? copyActiveClip() : copySelectedNotes();
      case 'edit.cut':
        if (activeContentReadOnly()) return false;
        return focusZone.value === 'arrange' ? cutActiveClip() : cutSelectedNotes();
      case 'edit.paste':
        if (activeContentReadOnly()) return false;
        if (focusZone.value === 'arrange') {
          const startPpq = Math.max(0, options.positionPpq?.value ?? 0);
          if (!hasCopiedClip() || !canPasteClipAt(store.activeTrackId, startPpq)) return false;
          return pasteClipAt(store.activeTrackId, startPpq) !== null;
        }
        return pasteNotesAt(Math.max(0, options.positionPpq?.value ?? 0)).length > 0;
      case 'edit.selectAllNotes':
        selectAllNotes();
        return true;
      case 'edit.quantizeSelection':
        if (activeContentReadOnly() || store.selection.size === 0) return false;
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
        setActiveClip(duplicateClip(clip.id, clip.startPpq + clip.lengthPpq));
        return true;
      }
      case 'arrange.splitClipAtPlayhead':
        if (activeContentReadOnly()) return false;
        arrangementRef.value?.cutAtPlayhead();
        return true;
      case 'arrange.deleteClip':
        if (activeContentReadOnly()) return false;
        if (store.clipId === -1) {
          if (focusZone.value === 'arrange') return false;
          if (store.selection.size === 0) return false;
          deleteSelectedNotes();
          return true;
        }
        deleteClip(store.clipId);
        return true;
      case 'track.toggleMute': {
        const track = store.activeTrack;
        if (!track || track.frozen !== undefined) return false;
        setTrackMute(track.id, !track.mute);
        return true;
      }
      case 'track.toggleSolo': {
        const track = store.activeTrack;
        if (!track || track.frozen !== undefined) return false;
        setTrackSolo(track.id, !track.solo);
        return true;
      }
      case 'track.toggleArm': {
        const track = store.activeTrack;
        if (
          !track ||
          track.frozen !== undefined ||
          (track.kind !== 'audio' && track.kind !== 'midi')
        ) {
          return false;
        }
        const recorder = track.kind === 'audio' ? options.recording : options.midiRecording;
        recorder.arm(recorder.armedTrackId.value === track.id ? null : track.id);
        return true;
      }
      case 'view.toggleSnap':
        store.snapEnabled = !store.snapEnabled;
        return true;
      case 'view.toggleScorePanel':
        options.toggleScorePanel();
        return true;
      case 'view.zoomIn':
        if (focusZone.value === 'arrange') arrangementRef.value?.zoomHorizontal(1.2);
        else options.pianoRollRef.value?.zoomHorizontal(1.2);
        return true;
      case 'view.zoomOut':
        if (focusZone.value === 'arrange') arrangementRef.value?.zoomHorizontal(1 / 1.2);
        else options.pianoRollRef.value?.zoomHorizontal(1 / 1.2);
        return true;
      case 'view.zoomToFit':
        if (focusZone.value === 'arrange') arrangementRef.value?.zoomToFit();
        else options.pianoRollRef.value?.fitSelection();
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

  /** Menu row that runs a registered shortcut action (and shows its key hint). */
  function actionItem(
    actionId: string,
    label: string,
    extra: { reason?: string | null; checked?: boolean } = {},
  ): MenuBarItem {
    return {
      id: actionId,
      label,
      hint: hintFor(actionId),
      disabledReason: extra.reason,
      checked: extra.checked,
      run: () => {
        runMenuAction(() => runShortcutAction(actionId));
      },
    };
  }

  /** Menu row that runs an arbitrary callback (file / help / layout commands). */
  function commandItem(
    id: string,
    label: string,
    run: () => void,
    extra: { reason?: string | null; checked?: boolean; hintFor?: string } = {},
  ): MenuBarItem {
    return {
      id,
      label,
      hint: extra.hintFor ? hintFor(extra.hintFor) : undefined,
      disabledReason: extra.reason,
      checked: extra.checked,
      run: () => runMenuAction(run),
    };
  }

  const sep = (id: string): MenuBarItem => ({ id, separator: true });
  const heading = (id: string, text: string): MenuBarItem => ({ id, heading: text });

  function fileItems(): MenuBarItem[] {
    const m = t.value.shell.project;
    const r = t.value.reasons;
    const noOpfs = options.opfsAvailable ? null : r.noStorage;
    const noMidiClip = store.clips.some((clip) => clipKind(clip) === 'midi')
      ? null
      : r.noMidiClipInProject;
    const items: MenuBarItem[] = [
      commandItem('file.startScreen', m.startScreen, options.openStartScreen),
      commandItem('file.new', m.new, options.openNewDialog),
      commandItem('file.open', m.open, options.openOpenDialog, {
        reason: noOpfs,
        hintFor: 'project.open',
      }),
      commandItem('file.openDemo', m.openDemo, options.openDemo),
      sep('file.sep-save'),
      commandItem('file.save', m.save, options.saveProjectAction, {
        reason: noOpfs,
        hintFor: 'project.save',
      }),
      commandItem('file.saveAs', m.saveAs, options.saveProjectAsAction, {
        reason: noOpfs,
        hintFor: 'project.saveAs',
      }),
      commandItem('file.revisions', m.revisions, options.openRevisionsDialog, {
        reason: noOpfs,
      }),
    ];
    const recent = options.recentNames.value;
    if (recent.length > 0) {
      items.push(sep('file.sep-recent'), heading('file.recent', m.recent));
      for (const name of recent) {
        items.push(
          commandItem(`file.recent.${name}`, name, () => options.openRecentProject(name), {
            reason: noOpfs,
          }),
        );
      }
    }
    items.push(
      sep('file.sep-import'),
      commandItem('file.importMidi', m.importMidi, options.importMidi),
      commandItem('file.importAudio', m.importAudio, options.importAudio),
      commandItem('file.importStems', m.importStems, options.importStems),
      commandItem('file.importDawproject', m.importDawproject, options.importDawproject),
      commandItem('file.importMusicXml', m.importMusicXml, options.importMusicXml),
      commandItem('file.importBackup', m.importBackup, options.importBrowserBackup, {
        reason: noOpfs,
      }),
      sep('file.sep-export'),
      commandItem('file.exportSzd', m.exportSzd, options.exportSzd),
      commandItem('file.exportBackup', m.exportBackup, options.exportBrowserBackup, {
        reason: noOpfs,
      }),
      commandItem('file.exportSmf', m.exportSmf, options.exportSmf),
      commandItem('file.exportMidi2', m.exportMidi2, options.exportMidi2),
      commandItem('file.exportMusicXml', m.exportMusicXml, options.exportMusicXml, {
        reason: noMidiClip,
      }),
      commandItem('file.exportAudio', m.exportAudio, options.openExportDialog),
      commandItem('file.exportDawproject', m.exportDawproject, options.exportDawproject),
    );
    return items;
  }

  function editItems(): MenuBarItem[] {
    const a = t.value.shortcuts.actions;
    // The clipboard is process-local, so read its revision to keep the menu
    // reactive after a copy made by a keyboard shortcut or another surface.
    void clipClipboardVersion.value;
    const arrangementFocus = focusZone.value === 'arrange';
    const r = t.value.reasons;
    const noSelection = arrangementFocus
      ? firstBlock([!store.activeClip, r.noClipSelection])
      : firstBlock([store.selection.size === 0, r.noNoteSelection]);
    const noClip = firstBlock([!store.activeClip, r.noClipSelection]);
    const readOnly = firstBlock([activeContentReadOnly(), r.trackFrozen]);
    const pasteUnavailable = arrangementFocus
      ? firstBlock(
          [!hasCopiedClip(), r.nothingToPaste],
          [
            !canPasteClipAt(store.activeTrackId, Math.max(0, options.positionPpq?.value ?? 0)),
            r.noRoomToPaste,
          ],
        )
      : noClip;
    const editSelection = firstBlock(readOnly, noSelection);
    const editClip = firstBlock(readOnly, noClip);
    return [
      actionItem('edit.undo', a['edit.undo'], { reason: canUndo() ? null : r.nothingToUndo }),
      actionItem('edit.redo', a['edit.redo'], { reason: canRedo() ? null : r.nothingToRedo }),
      actionItem('edit.copy', a['edit.copy'], { reason: noSelection }),
      actionItem('edit.cut', a['edit.cut'], { reason: editSelection }),
      actionItem('edit.paste', a['edit.paste'], { reason: firstBlock(readOnly, pasteUnavailable) }),
      sep('edit.sep-select'),
      actionItem('edit.selectAllNotes', a['edit.selectAllNotes']),
      actionItem('edit.quantizeSelection', a['edit.quantizeSelection'], {
        reason: editSelection,
      }),
      actionItem('edit.deleteSelectedNotes', t.value.shortcuts.menu.deleteSelection, {
        reason: editSelection,
      }),
      heading('edit.transpose', t.value.shortcuts.menu.transpose),
      actionItem('edit.transposeUp', a['edit.transposeUp'], { reason: editSelection }),
      actionItem('edit.transposeDown', a['edit.transposeDown'], {
        reason: editSelection,
      }),
      actionItem('edit.transposeOctaveUp', a['edit.transposeOctaveUp'], {
        reason: editSelection,
      }),
      actionItem('edit.transposeOctaveDown', a['edit.transposeOctaveDown'], {
        reason: editSelection,
      }),
      heading('edit.clip', t.value.shortcuts.menu.clip),
      actionItem('arrange.duplicateClip', a['arrange.duplicateClip'], {
        reason: editClip,
      }),
      actionItem('arrange.splitClipAtPlayhead', a['arrange.splitClipAtPlayhead'], {
        reason: editClip,
      }),
      actionItem('arrange.deleteClip', a['arrange.deleteClip'], { reason: editClip }),
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
    const r = t.value.reasons;
    const engineOff = options.handle.value ? null : r.engineOff;
    const recordBlocked = firstBlock(engineOff, [
      !(
        options.canRecord?.value ??
        (options.recording.armedTrackId.value !== null ||
          options.midiRecording.armedTrackId.value !== null)
      ),
      r.noArmedTrack,
    ]);
    return [
      actionItem(
        'transport.togglePlayback',
        options.isPlaying.value ? t.value.shortcuts.menu.stop : t.value.shortcuts.menu.play,
      ),
      actionItem('transport.toggleLoop', t.value.shortcuts.menu.loop, {
        checked: options.loopEnabled.value,
      }),
      actionItem('transport.toggleRecord', a['transport.toggleRecord'], {
        reason: recordBlocked,
        checked:
          options.isRecording?.value ??
          (options.recording.isRecording.value ||
            options.midiRecording.isRecording?.value === true),
      }),
      sep('transport.sep-nav'),
      actionItem('transport.toStart', a['transport.toStart'], { reason: engineOff }),
      actionItem('transport.toEnd', a['transport.toEnd'], { reason: engineOff }),
      actionItem('transport.nudgeBack', a['transport.nudgeBack'], { reason: engineOff }),
      actionItem('transport.nudgeForward', a['transport.nudgeForward'], { reason: engineOff }),
      heading('transport.locators', t.value.shortcuts.menu.locators),
      actionItem('transport.setLeftLocator', a['transport.setLeftLocator']),
      actionItem('transport.setRightLocator', a['transport.setRightLocator']),
    ];
  }

  function optionsItems(): MenuBarItem[] {
    const h = t.value.shell.help;
    return [
      commandItem(
        'options.commandPalette',
        t.value.shell.commandPalette.title,
        () => {
          options.commandPaletteOpen.value = true;
        },
        { hintFor: 'app.commandPalette' },
      ),
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
    const noProject = store.initialized ? null : t.value.reasons.projectLoading;
    return [
      commandItem('generate.progression', g.progression, options.openChordGenerateDialog, {
        reason: noProject,
      }),
      commandItem('generate.tracks', g.tracks, options.openTrackGenerateDialog, {
        reason: noProject,
      }),
      commandItem('generate.keyChanges', g.keyChanges, options.openKeyChangeDialog, {
        reason: noProject,
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
      commandItem(
        `layout.${layout.name}`,
        localizedLayoutName(layout.name, t.value.settings.layouts.presetNames),
        () => options.applyNamedLayout(layout.name),
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
    try {
      if (runShortcutAction(actionId)) event.preventDefault();
    } catch (error) {
      // A matched shortcut has claimed the browser event even if its command
      // failed. Surface that failure instead of letting a raw WASM throw end
      // the key handler without feedback.
      event.preventDefault();
      reportActionError(error);
    }
  }

  return {
    arrangementRef,
    focusZone,
    commandPaletteItems,
    layoutMenu,
    menuBarModel,
    onGlobalKeyDown,
  };
}
