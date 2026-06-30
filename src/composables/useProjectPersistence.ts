import { computed, nextTick, type Ref, ref, watch } from 'vue';
import type { useAutosave } from '@/composables/useAutosave';
import { promptDialog } from '@/composables/useDialogs';
import { describeError } from '@/lib/errors';
import { gatherProjectBundle, restoreProjectBundle } from '@/persistence/bundle';
import { garbageCollectMedia } from '@/persistence/gc';
import { downloadSzd, pickAndReadSzd } from '@/persistence/local-file';
import {
  deleteProject,
  isOpfsAvailable,
  listProjects,
  loadProject,
  type StoredProjectInfo,
  saveProject,
} from '@/persistence/opfs';
import { decodeSzd, decodeSzdBundle, encodeSzd } from '@/persistence/szd';
import { makeBwv565Document } from '@/project/demo/bwv565';
import { exportProjectClipFile, exportProjectSmf } from '@/project/export';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { smfToProjectDocument } from '@/project/smf';
import { useProjectStore } from '@/project/store';
import { createTemplate, type TemplateName } from '@/project/templates';
import { formatMessage, useI18n } from '@/ui/i18n';
import { midiCcBindingsKey } from '@/ui/midi/midi-learn';
import {
  loadRecentProjects,
  saveRecentProjects,
  withoutRecent,
  withRecent,
} from '@/ui/shell/recent-projects';

const AUTOSAVE_SLOT = 'autosave';

type Autosave = ReturnType<typeof useAutosave>;
type ConfirmAction = (
  message: string,
  opts?: { danger?: boolean; confirmLabel?: string; title?: string },
) => Promise<boolean>;
type RunAction = (action: () => Promise<void>) => Promise<void>;
type DownloadBlobFile = (blob: Blob, filename: string) => void;

export interface ProjectPersistenceOptions {
  autosave: Autosave;
  confirmAction: ConfirmAction;
  downloadBlobFile: DownloadBlobFile;
  errorMessage: Ref<string>;
  runAction: RunAction;
}

export function useProjectPersistence(options: ProjectPersistenceOptions) {
  const { autosave, confirmAction, downloadBlobFile, errorMessage, runAction } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  const dirty = ref(false);
  const opfsAvailable = isOpfsAvailable();
  const projectMenuOpen = ref(false);
  const projectMenuRoot = ref<HTMLElement | null>(null);
  const midiImportInput = ref<HTMLInputElement | null>(null);
  const newDialogOpen = ref(false);
  const openDialogOpen = ref(false);
  const startScreenOpen = ref(false);
  const hasAutosave = ref(false);
  const storedProjects = ref<StoredProjectInfo[]>([]);
  const recentProjects = ref<string[]>(loadRecentProjects());

  watch(
    () =>
      [
        store.projectName,
        store.tracks,
        store.clips,
        store.markers,
        store.sections,
        store.tempoSegments,
        store.timeSignatures,
        store.mixer,
        store.scoreAnnotations,
        store.displayTransposeSemitones,
        store.automationLanes,
        store.chords,
        // The binding map is mutated in place, so observe its contents.
        midiCcBindingsKey(store.midiCcBindings),
      ] as const,
    () => {
      if (store.initialized) dirty.value = true;
    },
  );

  const recentMenuNames = computed(() =>
    recentProjects.value.filter((name) => name !== store.projectName && name !== AUTOSAVE_SLOT),
  );

  /**
   * Reclaims OPFS audio/SoundFont storage no project references any more, after
   * an edit that may have orphaned media (a save that dropped clips, a deleted
   * project). Best-effort and never throws: storage hygiene must not break the
   * action that triggered it. The live document is passed so its media — even
   * if not yet written to a slot — is preserved.
   */
  async function reclaimUnusedMedia(): Promise<void> {
    if (!opfsAvailable) return;
    try {
      await garbageCollectMedia({ liveDocument: serializeProject() });
    } catch {
      // Reclaiming is opportunistic; a failure leaves the orphans for next time.
    }
  }

  async function markClean(): Promise<void> {
    await nextTick();
    // Reaching a clean state (after a load/save) means the change watcher may
    // have scheduled a save for content that is already persisted; drop it so
    // boot and open do not write a redundant autosave.
    autosave.cancelPending();
    dirty.value = false;
  }

  /**
   * Boots into the start screen rather than silently loading content. A clean
   * empty project is loaded first so the shell renders behind the launcher
   * overlay; the user then picks what to open (continue last session, a new or
   * saved project, or the demo song). This keeps a first-time visitor from
   * landing in an unfamiliar project they never created.
   */
  async function bootProject(): Promise<void> {
    await loadProjectDocument(createTemplate('empty'));
    await markClean();
    let autosavePresent = false;
    if (isOpfsAvailable()) {
      try {
        const stored = await listProjects();
        autosavePresent = stored.some((info) => info.name === AUTOSAVE_SLOT);
        storedProjects.value = stored.filter((info) => info.name !== AUTOSAVE_SLOT);
      } catch (err) {
        errorMessage.value = describeError(err);
      }
    }
    hasAutosave.value = autosavePresent;
    startScreenOpen.value = true;
  }

  /** Reopens the start screen, refreshing its saved-project list and autosave state. */
  async function openStartScreen(): Promise<void> {
    closeProjectMenu();
    if (isOpfsAvailable()) {
      try {
        const stored = await listProjects();
        hasAutosave.value = stored.some((info) => info.name === AUTOSAVE_SLOT);
        storedProjects.value = stored.filter((info) => info.name !== AUTOSAVE_SLOT);
      } catch (err) {
        errorMessage.value = describeError(err);
      }
    }
    startScreenOpen.value = true;
  }

  /** Restores the autosaved session from the start screen's "continue" action. */
  function continueSession(): void {
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const restored = await autosave.restoreAutosave();
      if (restored) {
        await markClean();
        startScreenOpen.value = false;
      }
    });
  }

  /** Loads the bundled demo song (lazily fetched) and dismisses the start screen. */
  function openDemo(): void {
    closeProjectMenu();
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      await loadProjectDocument(await makeBwv565Document());
      await markClean();
      startScreenOpen.value = false;
    });
  }

  function rememberRecentProject(name: string): void {
    recentProjects.value = withRecent(recentProjects.value, name);
    saveRecentProjects(recentProjects.value);
  }

  function closeProjectMenu(): void {
    projectMenuOpen.value = false;
  }

  function openNewDialog(): void {
    closeProjectMenu();
    newDialogOpen.value = true;
  }

  function onCreateProject(payload: { document: ProjectDocument; template: TemplateName }): void {
    newDialogOpen.value = false;
    void runAction(async () => {
      await loadProjectDocument(payload.document);
      await markClean();
      startScreenOpen.value = false;
    });
  }

  async function refreshStoredProjects(): Promise<void> {
    if (!opfsAvailable) {
      storedProjects.value = [];
      return;
    }
    storedProjects.value = (await listProjects()).filter((info) => info.name !== AUTOSAVE_SLOT);
  }

  function openOpenDialog(): void {
    closeProjectMenu();
    openDialogOpen.value = true;
    void runAction(refreshStoredProjects);
  }

  function confirmDiscard(): Promise<boolean> {
    if (!dirty.value) return Promise.resolve(true);
    return confirmAction(t.value.dialogs.prompts.discardUnsavedMessage, {
      title: t.value.dialogs.prompts.unsavedChangesTitle,
      confirmLabel: t.value.dialogs.prompts.discard,
    });
  }

  async function openStoredProject(name: string): Promise<void> {
    if (!(await confirmDiscard())) return;
    void runAction(async () => {
      const bytes = await loadProject(name);
      await loadProjectDocument(decodeSzd(bytes));
      store.projectName = name;
      rememberRecentProject(name);
      await markClean();
      openDialogOpen.value = false;
      startScreenOpen.value = false;
    });
  }

  function openRecentProject(name: string): void {
    closeProjectMenu();
    void openStoredProject(name);
  }

  async function deleteStoredProject(name: string): Promise<void> {
    if (
      !(await confirmAction(formatMessage(t.value.dialogs.prompts.deleteProjectMessage, { name }), {
        title: t.value.dialogs.prompts.deleteProjectTitle,
        confirmLabel: t.value.dialogs.prompts.delete,
      }))
    )
      return;
    void runAction(async () => {
      await deleteProject(name);
      recentProjects.value = withoutRecent(recentProjects.value, name);
      saveRecentProjects(recentProjects.value);
      await refreshStoredProjects();
      // Deleting a project may strand media only it referenced.
      await reclaimUnusedMedia();
    });
  }

  async function importSzdFile(): Promise<void> {
    if (!(await confirmDiscard())) return;
    void runAction(async () => {
      const picked = await pickAndReadSzd();
      if (!picked) return;
      const doc = decodeSzd(picked.bytes);
      // Restore any bundled audio/SoundFonts into OPFS so the document's ids
      // resolve; without a store there is nowhere to put them (clips stay
      // silent), and a restore hiccup must not block opening the project.
      if (opfsAvailable) {
        try {
          await restoreProjectBundle(decodeSzdBundle(picked.bytes));
        } catch (err) {
          errorMessage.value = describeError(err);
        }
      }
      await loadProjectDocument(doc);
      await markClean();
      openDialogOpen.value = false;
      startScreenOpen.value = false;
    });
  }

  function importMidiAction(): void {
    closeProjectMenu();
    midiImportInput.value?.click();
  }

  function onMidiImportChange(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0] ?? null;
    if (input) input.value = '';
    if (!file) return;
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const doc = await smfToProjectDocument(await file.arrayBuffer(), file.name);
      await loadProjectDocument(doc);
      await markClean();
      openDialogOpen.value = false;
      startScreenOpen.value = false;
    });
  }

  async function saveToOpfs(name: string): Promise<void> {
    const doc = serializeProject();
    const bytes = encodeSzd(doc, { savedAt: new Date().toISOString() });
    await saveProject(name, bytes);
    rememberRecentProject(name);
    await autosave.saveNow();
    await markClean();
    // Edits since the last save may have stranded imported media.
    await reclaimUnusedMedia();
  }

  function saveProjectAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      await saveToOpfs(store.projectName);
    });
  }

  function saveProjectAsAction(): void {
    closeProjectMenu();
    void (async () => {
      const name = await promptDialog({
        title: t.value.dialogs.prompts.saveProjectAsTitle,
        message: t.value.dialogs.prompts.saveProjectAsMessage,
        defaultValue: store.projectName,
        placeholder: t.value.dialogs.prompts.projectNamePlaceholder,
        confirmLabel: t.value.dialogs.prompts.save,
      });
      if (!name) return;
      void runAction(async () => {
        store.projectName = name;
        await saveToOpfs(name);
      });
    })();
  }

  function exportSzdAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      const doc = serializeProject();
      // Disk exports travel to other machines/browsers, so bundle the
      // referenced audio + SoundFonts the OPFS store would otherwise hold.
      const bundle = opfsAvailable ? await gatherProjectBundle(doc) : undefined;
      const bytes = encodeSzd(doc, { savedAt: new Date().toISOString() }, bundle);
      downloadSzd(store.projectName, bytes);
    });
  }

  function exportSmfAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      const result = await exportProjectSmf();
      downloadBlobFile(
        new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' }),
        result.filename,
      );
    });
  }

  function exportMidi2Action(): void {
    closeProjectMenu();
    void runAction(async () => {
      const result = exportProjectClipFile();
      downloadBlobFile(
        new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' }),
        result.filename,
      );
    });
  }

  /** No teardown needed: AppModal owns the open-dialog focus-trap lifecycle. */
  function disposeProjectPersistence(): void {
    // Intentionally empty.
  }

  return {
    dirty,
    opfsAvailable,
    projectMenuOpen,
    projectMenuRoot,
    midiImportInput,
    newDialogOpen,
    openDialogOpen,
    startScreenOpen,
    hasAutosave,
    storedProjects,
    recentMenuNames,
    bootProject,
    openStartScreen,
    continueSession,
    openDemo,
    markClean,
    closeProjectMenu,
    openNewDialog,
    onCreateProject,
    openOpenDialog,
    openStoredProject,
    openRecentProject,
    deleteStoredProject,
    importSzdFile,
    importMidiAction,
    onMidiImportChange,
    saveProjectAction,
    saveProjectAsAction,
    exportSzdAction,
    exportSmfAction,
    exportMidi2Action,
    disposeProjectPersistence,
  };
}
