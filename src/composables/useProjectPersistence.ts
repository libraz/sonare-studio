import { type ComputedRef, computed, nextTick, type Ref, ref, watch } from 'vue';
import type { useAutosave } from '@/composables/useAutosave';
import { promptDialog } from '@/composables/useDialogs';
import { useForeignFormatImports } from '@/composables/useForeignFormatImports';
import { useLiveMediaLeases } from '@/composables/useLiveMediaLeases';
import { useProjectRevisions } from '@/composables/useProjectRevisions';
import { describeError } from '@/lib/errors';
import { reclaimOrphanedRestoreStagesAtStartup, restoreBrowserBackup } from '@/persistence/backup';
import { type ProjectBundleRestoreLease, restoreProjectBundle } from '@/persistence/bundle';
import { garbageCollectMedia } from '@/persistence/gc';
import {
  type PickedSzdFile,
  pickAndReadBrowserBackup,
  pickAndReadSzd,
  readSzdFile,
} from '@/persistence/local-file';
import {
  deleteProject,
  InvalidProjectNameError,
  isAutosaveProjectName,
  isOpfsAvailable,
  isReservedProjectName,
  listProjectNames,
  listProjects,
  loadProjectWithRevision,
  renameProject,
  type StoredProjectInfo,
  sanitizeProjectName,
  saveProjectChecked,
} from '@/persistence/opfs';
import { deleteProjectRevisions } from '@/persistence/revisions';
import {
  decodeSzdInWorker,
  decodeSzdWithBundleInWorker,
  encodeSzd,
  SZD_FILE_EXTENSION,
} from '@/persistence/szd';
import { collectHistoryReferencedMediaIds } from '@/project/commands';
import { makeBwv565Document } from '@/project/demo/bwv565';
import { persistedProjectStateKey } from '@/project/persisted-state';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { createTemplate, type TemplateName } from '@/project/templates';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  loadRecentProjects,
  saveRecentProjects,
  withoutRecent,
  withRecent,
} from '@/ui/shell/recent-projects';

type Autosave = ReturnType<typeof useAutosave>;
type ConfirmAction = (
  message: string,
  opts?: { danger?: boolean; confirmLabel?: string; title?: string },
) => Promise<boolean>;
type RunAction = (action: () => Promise<void>) => Promise<void>;

export interface ProjectPersistenceOptions {
  autosave: Autosave;
  confirmAction: ConfirmAction;
  confirmLossAction: ConfirmAction;
  errorMessage: Ref<string>;
  runAction: RunAction;
  /** Shared persisted-state revision, avoiding duplicate full-document hashes. */
  persistedStateKey?: ComputedRef<string>;
  /** Releases project-scoped render caches before replacing the document. */
  onProjectDocumentWillLoad?: () => void;
}

export function useProjectPersistence(options: ProjectPersistenceOptions) {
  const { autosave, confirmAction, confirmLossAction, errorMessage, runAction } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  const dirty = ref(false);
  // Document title and OPFS slot identity are intentionally distinct. A new
  // or imported document has no named slot until Save/Save As succeeds.
  const savedProjectSlot = ref<string | null>(null);
  const savedProjectRevision = ref<string | null>(null);
  /** Open slot a browser-backup restore replaced since it was last loaded or saved. */
  const restoreReplacedSlot = ref<string | null>(null);
  // Any new baseline (open, save, revision restore) supersedes the replacement.
  watch(
    savedProjectRevision,
    () => {
      restoreReplacedSlot.value = null;
    },
    { flush: 'sync' },
  );
  const opfsAvailable = isOpfsAvailable();
  const projectMenuOpen = ref(false);
  const projectMenuRoot = ref<HTMLElement | null>(null);
  const newDialogOpen = ref(false);
  const openDialogOpen = ref(false);
  // The launcher covers the shell from first paint; `booting` keeps its actions
  // inert until the empty project and the saved-project list are ready.
  const startScreenOpen = ref(true);
  const booting = ref(true);
  const hasAutosave = ref(false);
  const storedProjects = ref<StoredProjectInfo[]>([]);
  const recentProjects = ref<string[]>(loadRecentProjects());

  async function replaceProjectDocument(document: ProjectDocument): Promise<void> {
    options.onProjectDocumentWillLoad?.();
    const dropped = await loadProjectDocument(document);
    if (dropped.length === 0) return;
    console.warn('Settings the project schema upgrade could not carry over', dropped);
    errorMessage.value = formatMessage(t.value.notices.upgradeDroppedSettings, {
      count: dropped.length,
      keys: [...new Set(dropped.map((drop) => drop.key))].join(', '),
    });
  }

  watch(
    () => options.persistedStateKey?.value ?? persistedProjectStateKey(store),
    () => {
      if (store.initialized) dirty.value = true;
    },
  );

  const recentMenuNames = computed(() =>
    recentProjects.value.filter(
      (name) => name !== store.projectName && !isReservedProjectName(name),
    ),
  );

  const { holdBundleRestoreLease, handOffBundleRestoreLease } = useLiveMediaLeases({
    errorMessage,
  });

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

  async function markClean(
    expectedDocumentKey = JSON.stringify(serializeProject()),
  ): Promise<boolean> {
    await nextTick();
    if (JSON.stringify(serializeProject()) !== expectedDocumentKey) {
      return false;
    }
    // Reaching a clean state (after a load/save) means the change watcher may
    // have scheduled a save for content that is already persisted; drop it so
    // boot and open do not write a redundant autosave.
    autosave.cancelPending();
    dirty.value = false;
    return true;
  }

  async function saveLoadedProjectToAutosave(): Promise<string> {
    if (await autosave.saveNow()) {
      const documentKey = autosave.lastSavedDocumentKey.value;
      if (documentKey !== null) return documentKey;
      throw new Error('Autosave completed without a persisted document revision');
    }
    throw autosave.lastError.value ?? new Error(t.value.shell.autosaveFailed);
  }

  /** Makes the project just loaded the clean saved state and closes the open/start surfaces. */
  async function settleLoadedProject(): Promise<void> {
    savedProjectSlot.value = null;
    savedProjectRevision.value = null;
    const documentKey = await saveLoadedProjectToAutosave();
    await markClean(documentKey);
    openDialogOpen.value = false;
    startScreenOpen.value = false;
  }

  /**
   * Boots into the start screen rather than silently loading content. A clean
   * empty project is loaded first so the shell renders behind the launcher
   * overlay; the user then picks what to open (continue last session, a new or
   * saved project, or the demo song). This keeps a first-time visitor from
   * landing in an unfamiliar project they never created.
   */
  async function bootProject(): Promise<void> {
    try {
      await loadBootProject();
    } finally {
      booting.value = false;
    }
  }

  async function loadBootProject(): Promise<void> {
    // List saved projects before the wasm load so the launcher shows its
    // final rows (including "continue") while the engine is still loading.
    let autosavePresent = false;
    if (isOpfsAvailable()) {
      try {
        await reclaimOrphanedRestoreStagesAtStartup();
        const stored = await listProjects();
        autosavePresent = stored.some((info) => isAutosaveProjectName(info.name));
        storedProjects.value = stored.filter((info) => !isReservedProjectName(info.name));
      } catch (err) {
        errorMessage.value = describeError(err, t.value.notices.errors);
      }
    }
    hasAutosave.value = autosavePresent;
    await replaceProjectDocument(createTemplate('empty'));
    savedProjectSlot.value = null;
    savedProjectRevision.value = null;
    await markClean();
    startScreenOpen.value = true;
  }

  /** Reopens the start screen, refreshing its saved-project list and autosave state. */
  async function openStartScreen(): Promise<void> {
    closeProjectMenu();
    if (isOpfsAvailable()) {
      try {
        const stored = await listProjects();
        hasAutosave.value = stored.some((info) => isAutosaveProjectName(info.name));
        storedProjects.value = stored.filter((info) => !isReservedProjectName(info.name));
      } catch (err) {
        errorMessage.value = describeError(err, t.value.notices.errors);
      }
    }
    startScreenOpen.value = true;
  }

  /** Restores the autosaved session from the start screen's "continue" action. */
  function continueSession(): void {
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const restored = await autosave.restoreAutosave(replaceProjectDocument);
      if (restored) {
        savedProjectSlot.value = null;
        savedProjectRevision.value = null;
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
      await replaceProjectDocument(await makeBwv565Document());
      savedProjectSlot.value = null;
      savedProjectRevision.value = null;
      const documentKey = await saveLoadedProjectToAutosave();
      await markClean(documentKey);
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
      await replaceProjectDocument(payload.document);
      savedProjectSlot.value = null;
      savedProjectRevision.value = null;
      const documentKey = await saveLoadedProjectToAutosave();
      await markClean(documentKey);
      startScreenOpen.value = false;
    });
  }

  async function refreshStoredProjects(): Promise<void> {
    if (!opfsAvailable) {
      storedProjects.value = [];
      return;
    }
    storedProjects.value = (await listProjects()).filter(
      (info) => !isReservedProjectName(info.name),
    );
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
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const stored = await loadProjectWithRevision(name);
      await replaceProjectDocument(await decodeSzdInWorker(stored.bytes));
      store.projectName = name;
      savedProjectSlot.value = sanitizeProjectName(name);
      savedProjectRevision.value = stored.revision;
      rememberRecentProject(name);
      const documentKey = await saveLoadedProjectToAutosave();
      await markClean(documentKey);
      openDialogOpen.value = false;
      startScreenOpen.value = false;
    });
  }

  function openRecentProject(name: string): void {
    closeProjectMenu();
    void openStoredProject(name);
  }

  async function deleteStoredProject(name: string): Promise<void> {
    void runAction(async () => {
      if (
        !(await confirmAction(
          formatMessage(t.value.dialogs.prompts.deleteProjectMessage, { name }),
          {
            title: t.value.dialogs.prompts.deleteProjectTitle,
            confirmLabel: t.value.common.delete,
          },
        ))
      )
        return;
      await deleteProject(name);
      // Deleting the slot the open project was saved to strands its revision
      // baseline, which would make the next save fail its optimistic-revision
      // check against a slot that no longer exists. Fall back to a fresh save.
      if (sanitizeProjectName(name) === savedProjectSlot.value) {
        savedProjectSlot.value = null;
        savedProjectRevision.value = null;
      }
      recentProjects.value = withoutRecent(recentProjects.value, name);
      saveRecentProjects(recentProjects.value);
      await refreshStoredProjects();
      // Revisions belong to the project; keeping them would pin its media in
      // storage forever with no way to reach them. A revision-store failure
      // must not undo the deletion that already succeeded, so it is reported
      // rather than thrown.
      try {
        await deleteProjectRevisions(name);
        await refreshRevisions();
      } catch (err) {
        errorMessage.value = describeError(err, t.value.notices.errors);
      }
      // Deleting a project may strand media only it referenced.
      await reclaimUnusedMedia();
    });
  }

  /** Sanitized slot for a user-entered name; rejects unusable names with localized text. */
  function projectSlotName(name: string): string {
    let slot: string;
    try {
      slot = sanitizeProjectName(name);
    } catch (error) {
      if (error instanceof InvalidProjectNameError) {
        throw new Error(t.value.dialogs.prompts.projectNameInvalid);
      }
      throw error;
    }
    if (isReservedProjectName(slot)) throw new Error(t.value.dialogs.prompts.projectNameReserved);
    return slot;
  }

  async function renameStoredProject(name: string): Promise<void> {
    void runAction(async () => {
      const next = await promptDialog({
        title: t.value.dialogs.openProject.renameTitle,
        message: formatMessage(t.value.dialogs.openProject.renameMessage, { name }),
        defaultValue: name,
        placeholder: name,
        confirmLabel: t.value.dialogs.openProject.rename,
      });
      if (next === null) return;
      const safeName = projectSlotName(next);
      await renameProject(name, safeName);
      if (sanitizeProjectName(name) === savedProjectSlot.value) {
        savedProjectSlot.value = safeName;
        store.projectName = safeName;
      }
      recentProjects.value = withoutRecent(recentProjects.value, name);
      rememberRecentProject(safeName);
      await refreshStoredProjects();
    });
  }

  async function importSzdFile(launched?: PickedSzdFile): Promise<void> {
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const picked = launched ?? (await pickAndReadSzd());
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
      let restoreLease: ProjectBundleRestoreLease | undefined;
      let documentBecameLive = false;
      try {
        if (opfsAvailable) {
          restoreLease = await restoreProjectBundle(doc, decoded.bundle);
        }
        await replaceProjectDocument(doc);
        documentBecameLive = true;
        savedProjectSlot.value = null;
        savedProjectRevision.value = null;
        // Vue's live-document watcher normally runs in this turn. Await its
        // flush, then make the lease handoff explicit before autosave; a later
        // autosave failure must not roll back media the live document uses.
        await nextTick();
        if (restoreLease !== undefined) {
          handOffBundleRestoreLease(restoreLease);
          restoreLease = undefined;
        }
        const documentKey = await saveLoadedProjectToAutosave();
        await markClean(documentKey);
        openDialogOpen.value = false;
        startScreenOpen.value = false;
      } catch (error) {
        if (restoreLease !== undefined) {
          if (documentBecameLive) {
            // The document now references these ids. Keep the temporary lease
            // until the retryable live-lease handoff succeeds; deleting them
            // here would turn a recoverable autosave failure into data loss.
            holdBundleRestoreLease(restoreLease);
          } else {
            try {
              await restoreLease.rollback();
            } catch {
              // Preserve the import failure; rollback releases the lease in
              // its own finally block even when storage cleanup cannot
              // complete.
            }
          }
        }
        throw error;
      }
    });
  }

  async function importLaunchedSzdFile(file: File): Promise<void> {
    await importSzdFile(await readSzdFile(file));
  }

  const {
    midiImportInput,
    importMidiAction,
    importMusicXmlAction,
    importDawprojectAction,
    onMidiImportChange,
  } = useForeignFormatImports({
    closeProjectMenu,
    confirmAction,
    confirmDiscard,
    confirmLossAction,
    errorMessage,
    replaceProjectDocument,
    settleLoadedProject,
    runAction,
  });

  async function writeProjectToOpfs(
    name: string,
    documentName: string,
    expectedRevision: string | null,
  ): Promise<{ documentKey: string; revision: string; slot: string }> {
    const slot = projectSlotName(name);
    const doc = serializeProject();
    doc.name = documentName;
    const documentKey = JSON.stringify(doc);
    const bytes = encodeSzd(doc, {
      savedAt: new Date().toISOString(),
      documentJson: documentKey,
    });
    const revision = await saveProjectChecked(name, bytes, expectedRevision);
    rememberRecentProject(slot);
    return { documentKey, revision, slot };
  }

  async function finishSuccessfulSave(documentKey: string): Promise<void> {
    await autosave.saveNow();
    await markClean(documentKey);
    // Edits since the last save may have stranded imported media.
    await reclaimUnusedMedia();
  }

  /**
   * Baseline for overwriting the open slot after a backup restore replaced it:
   * the restored copy's revision once the user agrees to replace it, or
   * undefined when they decline.
   */
  async function confirmReplacingRestoredSlot(slot: string): Promise<string | null | undefined> {
    const revision = (await loadProjectWithRevision(slot)).revision;
    const confirmed = await confirmAction(
      formatMessage(t.value.dialogs.prompts.saveRestoredSlotMessage, { name: slot }),
      {
        title: t.value.dialogs.prompts.saveProjectOverwriteTitle,
        confirmLabel: t.value.dialogs.prompts.save,
      },
    );
    return confirmed ? revision : undefined;
  }

  async function saveToOpfs(name: string): Promise<void> {
    const slot = projectSlotName(name);
    let expectedRevision = slot === savedProjectSlot.value ? savedProjectRevision.value : null;
    if (slot === savedProjectSlot.value && restoreReplacedSlot.value === slot) {
      const confirmed = await confirmReplacingRestoredSlot(slot);
      if (confirmed === undefined) return;
      expectedRevision = confirmed;
    }
    // A new/imported document has no loaded revision. Saving it under an
    // existing name is an intentional overwrite, not a cross-tab conflict;
    // use the same explicit confirmation path as Save As.
    if (savedProjectSlot.value === null) {
      const exists = (await listProjectNames()).includes(slot);
      if (exists) {
        expectedRevision = (await loadProjectWithRevision(slot)).revision;
        const confirmed = await confirmAction(
          formatMessage(t.value.dialogs.prompts.saveProjectOverwriteMessage, { name: slot }),
          {
            title: t.value.dialogs.prompts.saveProjectOverwriteTitle,
            confirmLabel: t.value.dialogs.prompts.save,
          },
        );
        if (!confirmed) return;
      }
    }
    const saved = await writeProjectToOpfs(name, store.projectName, expectedRevision);
    savedProjectSlot.value = saved.slot;
    savedProjectRevision.value = saved.revision;
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
        const slot = projectSlotName(name);
        const exists = (await listProjectNames()).includes(slot);
        let expectedRevision: string | null = null;
        if (exists && slot !== savedProjectSlot.value) {
          expectedRevision = (await loadProjectWithRevision(slot)).revision;
          const confirmed = await confirmAction(
            formatMessage(t.value.dialogs.prompts.saveProjectOverwriteMessage, { name: slot }),
            {
              title: t.value.dialogs.prompts.saveProjectOverwriteTitle,
              confirmLabel: t.value.dialogs.prompts.save,
            },
          );
          if (!confirmed) return;
        }
        if (slot === savedProjectSlot.value) {
          expectedRevision = savedProjectRevision.value;
          if (restoreReplacedSlot.value === slot) {
            const confirmed = await confirmReplacingRestoredSlot(slot);
            if (confirmed === undefined) return;
            expectedRevision = confirmed;
          }
        }
        const saved = await writeProjectToOpfs(slot, name, expectedRevision);
        store.projectName = name;
        savedProjectSlot.value = saved.slot;
        savedProjectRevision.value = saved.revision;
        await finishSuccessfulSave(saved.documentKey);
      });
    })();
  }

  const {
    revisions,
    revisionsDialogOpen,
    saveRevisionAction,
    refreshRevisions,
    openRevisionsDialog,
    restoreRevision,
    deleteRevision,
  } = useProjectRevisions({
    closeProjectMenu,
    confirmDiscard,
    dirty,
    markClean,
    opfsAvailable,
    reclaimUnusedMedia,
    replaceProjectDocument,
    runAction,
    saveLoadedProjectToAutosave,
    savedProjectSlot,
    startScreenOpen,
  });

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
      const restored = await restoreBrowserBackup(picked.bytes);
      // The restore may have replaced the open project's slot. Saving must then
      // ask before overwriting the restored copy rather than report a conflict.
      const slot = savedProjectSlot.value;
      if (slot !== null && (await listProjectNames()).includes(slot)) {
        const { revision } = await loadProjectWithRevision(slot);
        if (revision !== savedProjectRevision.value) restoreReplacedSlot.value = slot;
      }
      await refreshStoredProjects();
      await reclaimUnusedMedia();
      const prompts = t.value.dialogs.prompts;
      const skipped = [
        ...(restored.skippedAssetIds ?? []).map((id) =>
          formatMessage(prompts.restoreBackupSkippedAudio, { id }),
        ),
        ...(restored.skippedFontIds ?? []).map((id) =>
          formatMessage(prompts.restoreBackupSkippedSoundFont, { id }),
        ),
      ];
      if (skipped.length > 0) {
        await confirmLossAction(
          formatMessage(t.value.dialogs.prompts.restoreBackupMediaSkippedMessage, {
            items: skipped.map((id) => `• ${id}`).join('\n'),
          }),
          {
            title: t.value.dialogs.prompts.restoreBackupMediaSkippedTitle,
            confirmLabel: t.value.common.ok,
          },
        );
      }
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
    revisions,
    revisionsDialogOpen,
    saveRevisionAction,
    openRevisionsDialog,
    restoreRevision,
    deleteRevision,
    startScreenOpen,
    booting,
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
    renameStoredProject,
    importSzdFile,
    importLaunchedSzdFile,
    importDawprojectAction,
    importMusicXmlAction,
    importMidiAction,
    onMidiImportChange,
    saveProjectAction,
    saveProjectAsAction,
    importBrowserBackupAction,
    disposeProjectPersistence,
  };
}
