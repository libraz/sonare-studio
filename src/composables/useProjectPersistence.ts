import {
  type ComputedRef,
  computed,
  nextTick,
  onScopeDispose,
  type Ref,
  ref,
  watch,
  watchEffect,
} from 'vue';
import type { useAutosave } from '@/composables/useAutosave';
import { promptDialog } from '@/composables/useDialogs';
import { importDawprojectWithMediaResult } from '@/export/dawproject';
import { describeError } from '@/lib/errors';
import { preflightXmlBytes } from '@/lib/xml-preflight';
import { importMusicXmlInWorker } from '@/notation/musicxml-import-client';
import { extractMusicXmlFromMxl } from '@/notation/musicxml-mxl';
import { leaseAudioAssets, leaseFonts } from '@/persistence/asset-leases';
import {
  createBrowserBackupWithReport,
  reclaimOrphanedRestoreStagesAtStartup,
  restoreBrowserBackup,
} from '@/persistence/backup';
import { gatherProjectBundleWithReport, restoreProjectBundle } from '@/persistence/bundle';
import { garbageCollectMedia } from '@/persistence/gc';
import {
  downloadBrowserBackup,
  downloadSzd,
  matchPickedExternalAudioFile,
  pickAndReadBrowserBackup,
  pickAndReadDawproject,
  pickAndReadExternalAudioFiles,
  pickAndReadSzd,
  pickViaInputElement,
  readFileBytesBounded,
} from '@/persistence/local-file';
import {
  deleteProject,
  isOpfsAvailable,
  isReservedProjectName,
  listProjects,
  loadProjectWithRevision,
  renameProject,
  type StoredProjectInfo,
  sanitizeProjectName,
  saveProjectChecked,
} from '@/persistence/opfs';
import { MAX_SMF_FILE_BYTES } from '@/persistence/resource-limits';
import {
  decodeSzdInWorker,
  decodeSzdWithBundleInWorker,
  encodeSzd,
  encodeSzdStreaming,
  SZD_FILE_EXTENSION,
} from '@/persistence/szd';
import { collectReferencedAudioAssetIds } from '@/project/asset-references';
import { collectHistoryReferencedMediaIds } from '@/project/commands';
import { makeBwv565Document } from '@/project/demo/bwv565';
import { exportProjectClipFile, exportProjectSmf } from '@/project/export';
import {
  formatMediaCompletenessReport,
  type MediaCompletenessReport,
} from '@/project/media-completeness';
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
  confirmLossAction: ConfirmAction;
  downloadBlobFile: DownloadBlobFile;
  errorMessage: Ref<string>;
  runAction: RunAction;
  /** Shared persisted-state revision, avoiding duplicate full-document hashes. */
  persistedStateKey?: ComputedRef<string>;
  /** Releases project-scoped render caches before replacing the document. */
  onProjectDocumentWillLoad?: () => void;
}

export function useProjectPersistence(options: ProjectPersistenceOptions) {
  const { autosave, confirmAction, confirmLossAction, downloadBlobFile, errorMessage, runAction } =
    options;
  const store = useProjectStore();
  const { t } = useI18n();

  const dirty = ref(false);
  // Document title and OPFS slot identity are intentionally distinct. A new
  // or imported document has no named slot until Save/Save As succeeds.
  const savedProjectSlot = ref<string | null>(null);
  const savedProjectRevision = ref<string | null>(null);
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

  async function replaceProjectDocument(document: ProjectDocument): Promise<void> {
    options.onProjectDocumentWillLoad?.();
    await loadProjectDocument(document);
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

  // Hold a tab-lifetime lease over the live document's media so another tab's
  // GC — which cannot see this tab's unsaved Pinia document, and whose autosave
  // slot may be up to 30 s behind — never deletes an asset or SoundFont this
  // tab still references. The lease is broadcast cross-tab (asset-leases.ts).
  const liveAssetLease = leaseAudioAssets([]);
  const liveFontLease = leaseFonts([]);
  watchEffect(() => {
    const fontIds = new Set<string>();
    for (const track of store.tracks) {
      if (track.instrument?.kind === 'sf2' && track.instrument.fontId) {
        fontIds.add(track.instrument.fontId);
      }
    }
    const historyRefs = collectHistoryReferencedMediaIds();
    const assetIds = collectReferencedAudioAssetIds(store.clips, store.tracks);
    for (const assetId of historyRefs.assetIds) assetIds.add(assetId);
    for (const fontId of historyRefs.fontIds) fontIds.add(fontId);
    try {
      liveAssetLease.update(assetIds);
      liveFontLease.update(fontIds);
    } catch {
      // A concurrent delete of a now-referenced id is a transient race; the
      // next document change re-attempts the lease.
    }
  });
  onScopeDispose(() => {
    liveAssetLease.release();
    liveFontLease.release();
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
    throw autosave.lastError.value ?? new Error('Autosave failed');
  }

  async function confirmIncompletePortableExport(
    report: MediaCompletenessReport,
  ): Promise<boolean> {
    if (report.complete) return true;
    return confirmLossAction(
      formatMessage(t.value.shell.project.mediaCompleteness.message, {
        items: formatMediaCompletenessReport(report),
      }),
      {
        title: t.value.shell.project.mediaCompleteness.title,
        confirmLabel: t.value.shell.project.mediaCompleteness.confirm,
      },
    );
  }

  /**
   * Boots into the start screen rather than silently loading content. A clean
   * empty project is loaded first so the shell renders behind the launcher
   * overlay; the user then picks what to open (continue last session, a new or
   * saved project, or the demo song). This keeps a first-time visitor from
   * landing in an unfamiliar project they never created.
   */
  async function bootProject(): Promise<void> {
    await replaceProjectDocument(createTemplate('empty'));
    savedProjectSlot.value = null;
    savedProjectRevision.value = null;
    await markClean();
    let autosavePresent = false;
    if (isOpfsAvailable()) {
      try {
        await reclaimOrphanedRestoreStagesAtStartup();
        const stored = await listProjects();
        autosavePresent = stored.some((info) => isReservedProjectName(info.name));
        storedProjects.value = stored.filter((info) => !isReservedProjectName(info.name));
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
        hasAutosave.value = stored.some((info) => isReservedProjectName(info.name));
        storedProjects.value = stored.filter((info) => !isReservedProjectName(info.name));
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
    if (!(await confirmDiscard())) return;
    void runAction(async () => {
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
    if (
      !(await confirmAction(formatMessage(t.value.dialogs.prompts.deleteProjectMessage, { name }), {
        title: t.value.dialogs.prompts.deleteProjectTitle,
        confirmLabel: t.value.dialogs.prompts.delete,
      }))
    )
      return;
    void runAction(async () => {
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
      // Deleting a project may strand media only it referenced.
      await reclaimUnusedMedia();
    });
  }

  async function renameStoredProject(name: string): Promise<void> {
    const next = await promptDialog({
      title: t.value.dialogs.openProject.renameTitle,
      message: formatMessage(t.value.dialogs.openProject.renameMessage, { name }),
      defaultValue: name,
      placeholder: name,
      confirmLabel: t.value.dialogs.openProject.rename,
    });
    if (next === null) return;
    const safeName = sanitizeProjectName(next);
    if (safeName === '') return;
    if (isReservedProjectName(safeName)) {
      throw new RangeError(`${safeName} is reserved`);
    }
    void runAction(async () => {
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
      await replaceProjectDocument(doc);
      savedProjectSlot.value = null;
      savedProjectRevision.value = null;
      const documentKey = await saveLoadedProjectToAutosave();
      await markClean(documentKey);
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
        accept: '.musicxml,.xml,.mxl',
        read: async (files) => {
          const file = files[0];
          if (!file) return null;
          preflightXmlBytes(file.size, file.name);
          const isMxl = file.name.toLowerCase().endsWith('.mxl');
          return {
            name: file.name,
            text: isMxl
              ? extractMusicXmlFromMxl(new Uint8Array(await file.arrayBuffer()), file.name)
              : await file.text(),
          };
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
        const confirmed = await confirmLossAction(
          formatMessage(t.value.shell.project.musicXmlLoss.message, { items }),
          {
            title: t.value.shell.project.musicXmlLoss.title,
            confirmLabel: t.value.shell.project.musicXmlLoss.confirm,
          },
        );
        if (!confirmed) return;
      }
      await replaceProjectDocument(imported.document);
      savedProjectSlot.value = null;
      savedProjectRevision.value = null;
      const documentKey = await saveLoadedProjectToAutosave();
      await markClean(documentKey);
      openDialogOpen.value = false;
      startScreenOpen.value = false;
    });
  }

  function createExternalAudioResolver(): (path: string) => Promise<Uint8Array | null> {
    let pickedFiles = null as ReturnType<typeof pickAndReadExternalAudioFiles> | null;
    const explicitRelinks = new Map<string, Uint8Array | null>();
    return async (path: string) => {
      if (explicitRelinks.has(path)) return explicitRelinks.get(path) ?? null;
      pickedFiles ??= pickAndReadExternalAudioFiles();
      const files = await pickedFiles;
      if (!files || files.length === 0) return null;
      const match = matchPickedExternalAudioFile(path, files);
      if (match.status === 'exact-path' || match.status === 'unique-basename') {
        return match.file.bytes;
      }
      if (match.status === 'unresolved') return null;

      const candidates = match.files
        .map((file) => file.relativePath ?? file.name)
        .sort()
        .join('\n');
      const confirmed = await confirmAction(
        formatMessage(t.value.shell.project.externalMediaRelink.message, {
          path,
          candidates,
        }),
        {
          title: t.value.shell.project.externalMediaRelink.title,
          confirmLabel: t.value.shell.project.externalMediaRelink.confirm,
        },
      );
      if (!confirmed) {
        explicitRelinks.set(path, null);
        return null;
      }
      const selected = await pickAndReadExternalAudioFiles();
      const selectedMatch = matchPickedExternalAudioFile(path, selected ?? []);
      const resolved =
        selectedMatch.status === 'exact-path' || selectedMatch.status === 'unique-basename'
          ? selectedMatch.file.bytes
          : selected?.length === 1
            ? selected[0].bytes
            : null;
      explicitRelinks.set(path, resolved);
      return resolved;
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
      await replaceProjectDocument(imported.document);
      savedProjectSlot.value = null;
      savedProjectRevision.value = null;
      const documentKey = await saveLoadedProjectToAutosave();
      await markClean(documentKey);
      openDialogOpen.value = false;
      startScreenOpen.value = false;
      if (imported.media.issues.length > 0) {
        const paths = imported.media.issues.slice(0, 3).map((issue) => issue.path);
        errorMessage.value = formatMessage(t.value.shell.project.importDawprojectMediaIssues, {
          count: imported.media.issues.length,
          paths: paths.join(', '),
        });
      } else if (imported.losses.length > 0) {
        const details = imported.losses.slice(0, 3).map((loss) => {
          if (loss.kind === 'unsupported-time-unit') return `${loss.attribute}=${loss.unit}`;
          if (loss.kind === 'unsupported-warp') return `${loss.clipName}: warp ${loss.reason}`;
          if (loss.kind === 'disabled-clip') return `${loss.clipName}: disabled clip skipped`;
          return `${loss.clipName}: nested clip ${loss.reason}`;
        });
        const onlyTimeUnits = imported.losses.every(
          (loss) => loss.kind === 'unsupported-time-unit',
        );
        errorMessage.value = onlyTimeUnits
          ? formatMessage(t.value.shell.project.importDawprojectTimeUnitIssues, {
              count: imported.losses.length,
              details: details.join(', '),
            })
          : formatMessage(t.value.shell.project.importDawprojectStructureIssues, {
              count: imported.losses.length,
              details: details.join(', '),
            });
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
      const doc = await smfToProjectDocument(
        await readFileBytesBounded(file, MAX_SMF_FILE_BYTES),
        file.name,
      );
      await replaceProjectDocument(doc);
      savedProjectSlot.value = null;
      savedProjectRevision.value = null;
      const documentKey = await saveLoadedProjectToAutosave();
      await markClean(documentKey);
      openDialogOpen.value = false;
      startScreenOpen.value = false;
    });
  }

  async function writeProjectToOpfs(
    name: string,
    documentName: string,
    expectedRevision: string | null,
  ): Promise<{ documentKey: string; revision: string; slot: string }> {
    if (isReservedProjectName(name)) {
      throw new Error(t.value.dialogs.prompts.projectNameReserved);
    }
    const doc = serializeProject();
    doc.name = documentName;
    const documentKey = JSON.stringify(doc);
    const bytes = encodeSzd(doc, { savedAt: new Date().toISOString() });
    const revision = await saveProjectChecked(name, bytes, expectedRevision);
    const slot = sanitizeProjectName(name);
    rememberRecentProject(slot);
    return { documentKey, revision, slot };
  }

  async function finishSuccessfulSave(documentKey: string): Promise<void> {
    await autosave.saveNow();
    await markClean(documentKey);
    // Edits since the last save may have stranded imported media.
    await reclaimUnusedMedia();
  }

  async function saveToOpfs(name: string): Promise<void> {
    const slot = sanitizeProjectName(name);
    let expectedRevision = slot === savedProjectSlot.value ? savedProjectRevision.value : null;
    // A new/imported document has no loaded revision. Saving it under an
    // existing name is an intentional overwrite, not a cross-tab conflict;
    // use the same explicit confirmation path as Save As.
    if (savedProjectSlot.value === null) {
      const exists = (await listProjects()).some((project) => project.name === slot);
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
        const slot = sanitizeProjectName(name);
        const exists = (await listProjects()).some((project) => project.name === slot);
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
        if (slot === savedProjectSlot.value) expectedRevision = savedProjectRevision.value;
        const saved = await writeProjectToOpfs(slot, name, expectedRevision);
        store.projectName = name;
        savedProjectSlot.value = saved.slot;
        savedProjectRevision.value = saved.revision;
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
      const gathered = opfsAvailable ? await gatherProjectBundleWithReport(doc) : undefined;
      if (gathered && !(await confirmIncompletePortableExport(gathered.report))) return;
      const bundle = gathered?.bundle;
      const bytes = await encodeSzdStreaming(doc, { savedAt: new Date().toISOString() }, bundle);
      downloadSzd(store.projectName, bytes);
    });
  }

  function exportBrowserBackupAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      const backup = await createBrowserBackupWithReport();
      if (!(await confirmIncompletePortableExport(backup.completeness))) return;
      downloadBrowserBackup('sonare-studio', backup.bytes);
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
      const restored = await restoreBrowserBackup(picked.bytes);
      await refreshStoredProjects();
      await reclaimUnusedMedia();
      const skipped = [
        ...(restored.skippedAssetIds ?? []).map((id) => `Audio: ${id}`),
        ...(restored.skippedFontIds ?? []).map((id) => `SoundFont: ${id}`),
      ];
      if (skipped.length > 0) {
        await confirmLossAction(
          formatMessage(t.value.dialogs.prompts.restoreBackupMediaSkippedMessage, {
            items: skipped.map((id) => `• ${id}`).join('\n'),
          }),
          {
            title: t.value.dialogs.prompts.restoreBackupMediaSkippedTitle,
            confirmLabel: t.value.dialogs.prompts.restoreBackupMediaSkippedConfirm,
          },
        );
      }
    });
  }

  function exportSmfAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      const result = await exportProjectSmf();
      const loss = result.smfLoss;
      if (
        loss !== undefined &&
        (loss.emptyMidiClips > 0 || loss.emptyMidiTracks > 0 || loss.mutedMidiTracks > 0) &&
        !(await confirmLossAction(
          formatMessage(t.value.dialogs.prompts.exportSmfLossMessage, {
            clips: String(loss.emptyMidiClips),
            tracks: String(loss.emptyMidiTracks),
            mutedTracks: String(loss.mutedMidiTracks),
          }),
          {
            title: t.value.dialogs.prompts.exportSmfLossTitle,
            confirmLabel: t.value.dialogs.prompts.exportSmfLossConfirm,
          },
        ))
      ) {
        return;
      }
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
      const loss = result.midi2ClipLoss;
      if (
        loss !== undefined &&
        (loss.expressionLanes > 0 || loss.sysExPackets > 0) &&
        !(await confirmLossAction(
          formatMessage(t.value.dialogs.prompts.exportMidi2LossMessage, {
            expressionLanes: String(loss.expressionLanes),
            sysExPackets: String(loss.sysExPackets),
          }),
          {
            title: t.value.dialogs.prompts.exportMidi2LossTitle,
            confirmLabel: t.value.dialogs.prompts.exportMidi2LossConfirm,
          },
        ))
      ) {
        return;
      }
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
    renameStoredProject,
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
