import { computed, nextTick, type Ref, ref, watch } from 'vue';
import type { useAutosave } from '@/composables/useAutosave';
import { promptDialog } from '@/composables/useDialogs';
import { importDawprojectWithMediaResult } from '@/export/dawproject';
import { describeError } from '@/lib/errors';
import { importMusicXmlInWorker } from '@/notation/musicxml-import-client';
import { createBrowserBackup, restoreBrowserBackup } from '@/persistence/backup';
import { gatherProjectBundle, restoreProjectBundle } from '@/persistence/bundle';
import { garbageCollectMedia } from '@/persistence/gc';
import {
  downloadBrowserBackup,
  downloadSzd,
  pickAndReadBrowserBackup,
  pickAndReadDawproject,
  pickAndReadExternalAudioFiles,
  pickAndReadSzd,
  pickViaInputElement,
} from '@/persistence/local-file';
import {
  deleteProject,
  isOpfsAvailable,
  isReservedProjectName,
  listProjects,
  loadProject,
  type StoredProjectInfo,
  sanitizeProjectName,
  saveProject,
} from '@/persistence/opfs';
import {
  decodeSzd,
  decodeSzdWithBundleInWorker,
  encodeSzd,
  SZD_FILE_EXTENSION,
} from '@/persistence/szd';
import { collectHistoryReferencedMediaIds } from '@/project/commands';
import { makeBwv565Document } from '@/project/demo/bwv565';
import { exportProjectClipFile, exportProjectSmf } from '@/project/export';
import { persistedProjectStateKey } from '@/project/persisted-state';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { smfToProjectDocument } from '@/project/smf';
import { useProjectStore } from '@/project/store';
import { createTemplate, type TemplateName } from '@/project/templates';
import { formatMessage, useI18n } from '@/ui/i18n';
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
  // Document title and OPFS slot identity are intentionally distinct. A new
  // or imported document has no named slot until Save/Save As succeeds.
  const savedProjectSlot = ref<string | null>(null);
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
    () => persistedProjectStateKey(store),
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
      const historyRefs = collectHistoryReferencedMediaIds();
      await garbageCollectMedia({
        liveDocument: serializeProject(),
        referencedAssetIds: historyRefs.assetIds,
        referencedFontIds: historyRefs.fontIds,
      });
    } catch {
      // Reclaiming is opportunistic; a failure leaves the orphans for next time.
    }
  }

  async function markClean(expectedDocumentKey?: string): Promise<boolean> {
    await nextTick();
    if (
      expectedDocumentKey !== undefined &&
      JSON.stringify(serializeProject()) !== expectedDocumentKey
    ) {
      return false;
    }
    // Reaching a clean state (after a load/save) means the change watcher may
    // have scheduled a save for content that is already persisted; drop it so
    // boot and open do not write a redundant autosave.
    autosave.cancelPending();
    dirty.value = false;
    return true;
  }

  async function saveLoadedProjectToAutosave(): Promise<void> {
    if (await autosave.saveNow()) return;
    throw autosave.lastError.value ?? new Error('Autosave failed');
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
    savedProjectSlot.value = null;
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
        savedProjectSlot.value = null;
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
      savedProjectSlot.value = null;
      await saveLoadedProjectToAutosave();
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
      savedProjectSlot.value = null;
      await saveLoadedProjectToAutosave();
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
      savedProjectSlot.value = sanitizeProjectName(name);
      rememberRecentProject(name);
      await saveLoadedProjectToAutosave();
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
      // Guard against a non-project file slipping past the picker hint: the
      // archive must carry the .szd extension before we try to decode it.
      if (!picked.name.toLowerCase().endsWith(SZD_FILE_EXTENSION)) {
        errorMessage.value = formatMessage(t.value.shell.project.importInvalidType, {
          name: picked.name,
        });
        return;
      }
      const decoded = await decodeSzdWithBundleInWorker(picked.bytes);
      const doc = decoded.document;
      // Restore only document-referenced media after a full conflict preflight.
      // A conflicting/malformed bundle must block the import before the active
      // project changes, otherwise its ids could alias unrelated shared media.
      if (opfsAvailable) {
        await restoreProjectBundle(doc, decoded.bundle);
      }
      await loadProjectDocument(doc);
      savedProjectSlot.value = null;
      await saveLoadedProjectToAutosave();
      await markClean();
      openDialogOpen.value = false;
      startScreenOpen.value = false;
    });
  }

  function importMidiAction(): void {
    closeProjectMenu();
    midiImportInput.value?.click();
  }

  function importMusicXmlAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const picked = await pickViaInputElement({
        accept: '.musicxml,.xml',
        read: async (files) => {
          const file = files[0];
          if (!file) return null;
          return { name: file.name, text: await file.text() };
        },
      });
      if (!picked) return;
      const imported = await importMusicXmlInWorker(picked.text, picked.name);
      if (imported.report.issues.length > 0) {
        const items = imported.report.issues
          .map((issue) =>
            formatMessage(t.value.shell.project.musicXmlLoss.items[issue.feature], {
              count: issue.count,
            }),
          )
          .map((item) => `• ${item}`)
          .join('\n');
        const confirmed = await confirmAction(
          formatMessage(t.value.shell.project.musicXmlLoss.message, { items }),
          {
            title: t.value.shell.project.musicXmlLoss.title,
            confirmLabel: t.value.shell.project.musicXmlLoss.confirm,
          },
        );
        if (!confirmed) return;
      }
      await loadProjectDocument(imported.document);
      savedProjectSlot.value = null;
      await saveLoadedProjectToAutosave();
      await markClean();
      openDialogOpen.value = false;
      startScreenOpen.value = false;
    });
  }

  function normalizeMediaPath(path: string): string {
    return path.replaceAll('\\', '/').toLowerCase();
  }

  function mediaFileName(path: string): string {
    const normalized = normalizeMediaPath(path);
    const slash = normalized.lastIndexOf('/');
    return slash >= 0 ? normalized.slice(slash + 1) : normalized;
  }

  function createExternalAudioResolver(): (path: string) => Promise<Uint8Array | null> {
    let pickedFiles: Promise<Map<string, Uint8Array> | null> | null = null;
    async function pickFiles(): Promise<Map<string, Uint8Array> | null> {
      const files = await pickAndReadExternalAudioFiles();
      if (!files || files.length === 0) return null;
      const byPath = new Map<string, Uint8Array>();
      for (const file of files) {
        byPath.set(normalizeMediaPath(file.name), file.bytes);
        byPath.set(mediaFileName(file.name), file.bytes);
        if (file.relativePath) {
          byPath.set(normalizeMediaPath(file.relativePath), file.bytes);
          byPath.set(mediaFileName(file.relativePath), file.bytes);
        }
      }
      return byPath;
    }
    return async (path: string) => {
      pickedFiles ??= pickFiles();
      const byPath = await pickedFiles;
      if (!byPath) return null;
      return byPath.get(normalizeMediaPath(path)) ?? byPath.get(mediaFileName(path)) ?? null;
    };
  }

  function importDawprojectAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const picked = await pickAndReadDawproject();
      if (!picked) return;
      if (!picked.name.toLowerCase().endsWith('.dawproject')) {
        errorMessage.value = formatMessage(t.value.shell.project.importDawprojectInvalidType, {
          name: picked.name,
        });
        return;
      }
      const imported = await importDawprojectWithMediaResult(picked.bytes, {
        resolveExternalAudio: createExternalAudioResolver(),
      });
      await loadProjectDocument(imported.document);
      savedProjectSlot.value = null;
      await saveLoadedProjectToAutosave();
      await markClean();
      openDialogOpen.value = false;
      startScreenOpen.value = false;
      if (imported.media.issues.length > 0) {
        const paths = imported.media.issues.slice(0, 3).map((issue) => issue.path);
        errorMessage.value = `DAWproject imported with ${imported.media.issues.length} missing or failed audio file(s): ${paths.join(', ')}`;
      }
    });
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
      savedProjectSlot.value = null;
      await saveLoadedProjectToAutosave();
      await markClean();
      openDialogOpen.value = false;
      startScreenOpen.value = false;
    });
  }

  async function writeProjectToOpfs(
    name: string,
    documentName: string,
  ): Promise<{ documentKey: string; slot: string }> {
    if (isReservedProjectName(name)) {
      throw new Error(t.value.dialogs.prompts.projectNameReserved);
    }
    const doc = serializeProject();
    doc.name = documentName;
    const documentKey = JSON.stringify(doc);
    const bytes = encodeSzd(doc, { savedAt: new Date().toISOString() });
    await saveProject(name, bytes);
    const slot = sanitizeProjectName(name);
    rememberRecentProject(slot);
    return { documentKey, slot };
  }

  async function finishSuccessfulSave(documentKey: string): Promise<void> {
    await autosave.saveNow();
    await markClean(documentKey);
    // Edits since the last save may have stranded imported media.
    await reclaimUnusedMedia();
  }

  async function saveToOpfs(name: string): Promise<void> {
    const saved = await writeProjectToOpfs(name, store.projectName);
    savedProjectSlot.value = saved.slot;
    await finishSuccessfulSave(saved.documentKey);
  }

  function saveProjectAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      await saveToOpfs(savedProjectSlot.value ?? store.projectName);
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
        const slot = sanitizeProjectName(name);
        const exists = (await listProjects()).some((project) => project.name === slot);
        if (exists && slot !== savedProjectSlot.value) {
          const confirmed = await confirmAction(
            formatMessage(t.value.dialogs.prompts.saveProjectOverwriteMessage, { name: slot }),
            {
              title: t.value.dialogs.prompts.saveProjectOverwriteTitle,
              confirmLabel: t.value.dialogs.prompts.save,
            },
          );
          if (!confirmed) return;
        }
        const saved = await writeProjectToOpfs(slot, name);
        store.projectName = name;
        savedProjectSlot.value = saved.slot;
        await finishSuccessfulSave(saved.documentKey);
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

  function exportBrowserBackupAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      const bytes = await createBrowserBackup();
      downloadBrowserBackup('sonare-studio', bytes);
    });
  }

  function importBrowserBackupAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      if (
        !(await confirmAction(t.value.dialogs.prompts.restoreBackupMessage, {
          title: t.value.dialogs.prompts.restoreBackupTitle,
          confirmLabel: t.value.dialogs.prompts.restore,
        }))
      )
        return;
      const picked = await pickAndReadBrowserBackup();
      if (!picked) return;
      await restoreBrowserBackup(picked.bytes);
      await refreshStoredProjects();
      await reclaimUnusedMedia();
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
    importDawprojectAction,
    importMusicXmlAction,
    importMidiAction,
    onMidiImportChange,
    saveProjectAction,
    saveProjectAsAction,
    exportSzdAction,
    exportBrowserBackupAction,
    importBrowserBackupAction,
    exportSmfAction,
    exportMidi2Action,
    disposeProjectPersistence,
  };
}
