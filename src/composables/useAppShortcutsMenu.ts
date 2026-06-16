import { type Ref, ref, type ShallowRef } from 'vue';
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
import type { EditorToolId } from '@/ui/editor/tools';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import { detectPlatform, formatKeyCombo } from '@/ui/settings/key-combo';

type Recording = ReturnType<typeof useRecording>;
type Shortcuts = ReturnType<typeof useShortcuts>;
type FocusZone = 'arrange' | 'editor';
type MenuBarId = 'edit' | 'view' | 'transport';

interface ArrangementCommands {
  cutAtPlayhead: () => void;
}

export interface AppShortcutsMenuOptions {
  editorTool: Ref<EditorToolId>;
  handle: ShallowRef<EngineHandle | null>;
  helpOpen: Ref<boolean>;
  isPlaying: Ref<boolean>;
  loopEnabled: Ref<boolean>;
  opfsAvailable: boolean;
  recording: Recording;
  scoreVisible: Ref<boolean>;
  settingsOpen: Ref<boolean>;
  shortcuts: Shortcuts;
  nudgeByBar: (direction: -1 | 1) => void;
  openOpenDialog: () => void;
  saveProjectAction: () => void;
  saveProjectAsAction: () => void;
  seekToEnd: () => void;
  seekToStart: () => void;
  setEditorTool: (tool: EditorToolId) => void;
  setLeftLocator: () => void;
  setRightLocator: () => void;
  toggleLoop: () => void;
  togglePlayback: () => void;
  toggleRecord: () => void;
  toggleScorePanel: () => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useAppShortcutsMenu(options: AppShortcutsMenuOptions) {
  const store = useProjectStore();
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
        if (!options.handle.value) return false;
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
        quantizeSelection();
        return true;
      case 'edit.deleteSelectedNotes':
        if (store.selection.size === 0) return false;
        deleteSelectedNotes();
        return true;
      case 'edit.transposeUp':
        if (store.selection.size === 0) return false;
        transposeSelection(1);
        return true;
      case 'edit.transposeDown':
        if (store.selection.size === 0) return false;
        transposeSelection(-1);
        return true;
      case 'edit.transposeOctaveUp':
        if (store.selection.size === 0) return false;
        transposeSelection(12);
        return true;
      case 'edit.transposeOctaveDown':
        if (store.selection.size === 0) return false;
        transposeSelection(-12);
        return true;
      case 'arrange.duplicateClip': {
        const clip = store.activeClip;
        if (!clip) return false;
        duplicateClip(clip.id, clip.startPpq + clip.lengthPpq);
        return true;
      }
      case 'arrange.splitClipAtPlayhead':
        arrangementRef.value?.cutAtPlayhead();
        return true;
      case 'arrange.deleteClip':
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

  function actionItem(
    actionId: string,
    label: string,
    extra: { disabled?: boolean; checked?: boolean } = {},
  ): ContextMenuItem {
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

  function menuBarItems(menu: MenuBarId): ContextMenuItem[] {
    const noSelection = store.selection.size === 0;
    switch (menu) {
      case 'edit':
        return [
          actionItem('edit.undo', 'Undo', { disabled: !canUndo() }),
          actionItem('edit.redo', 'Redo', { disabled: !canRedo() }),
          { id: 'sep1', separator: true },
          actionItem('edit.selectAllNotes', 'Select all notes'),
          actionItem('edit.quantizeSelection', 'Quantize selection', { disabled: noSelection }),
          { id: 'sep2', separator: true },
          actionItem('edit.deleteSelectedNotes', 'Delete selection', { disabled: noSelection }),
        ];
      case 'view':
        return [
          actionItem('view.toggleSnap', 'Snap to grid', { checked: store.snapEnabled }),
          actionItem('view.toggleScorePanel', 'Score panel', {
            checked: options.scoreVisible.value,
          }),
          { id: 'sep1', separator: true },
          actionItem('tool.select', 'Select tool', {
            checked: options.editorTool.value === 'select',
          }),
          actionItem('tool.draw', 'Draw tool', { checked: options.editorTool.value === 'draw' }),
          actionItem('tool.split', 'Split tool', { checked: options.editorTool.value === 'split' }),
          actionItem('tool.erase', 'Erase tool', { checked: options.editorTool.value === 'erase' }),
        ];
      case 'transport': {
        const engineReady = Boolean(options.handle.value);
        const canRecord = engineReady && options.recording.armedTrackId.value !== null;
        return [
          actionItem('transport.togglePlayback', options.isPlaying.value ? 'Stop' : 'Play'),
          actionItem('transport.toggleLoop', 'Loop', { checked: options.loopEnabled.value }),
          actionItem('transport.toggleRecord', 'Record', {
            disabled: !canRecord,
            checked: options.recording.isRecording.value,
          }),
          { id: 'sep1', separator: true },
          actionItem('transport.toStart', 'Go to start', { disabled: !engineReady }),
          actionItem('transport.toEnd', 'Go to end', { disabled: !engineReady }),
          actionItem('transport.nudgeBack', 'Nudge back one bar', { disabled: !engineReady }),
          actionItem('transport.nudgeForward', 'Nudge forward one bar', { disabled: !engineReady }),
        ];
      }
    }
  }

  function openMenuBar(menu: MenuBarId, event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu(rect.left, rect.bottom + 2, menuBarItems(menu));
  }

  function onGlobalKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || isEditableTarget(event.target)) return;
    const scope = focusZone.value === 'arrange' ? 'arrangement' : 'editor';
    const actionId = options.shortcuts.match(event, scope);
    if (actionId === null) return;
    if (runShortcutAction(actionId)) event.preventDefault();
  }

  return {
    arrangementRef,
    focusZone,
    onGlobalKeyDown,
    openMenuBar,
    shortcutTitle,
  };
}
