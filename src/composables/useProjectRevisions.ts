/**
 * Named revisions of the project the document is saved under: snapshot,
 * list, restore into the editor and delete.
 */

import { type Ref, ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import {
  deleteProjectRevision,
  listProjectRevisions,
  loadProjectRevision,
  type ProjectRevision,
  saveProjectRevision,
} from '@/persistence/revisions';
import { decodeSzdInWorker, encodeSzd } from '@/persistence/szd';
import { type ProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

type RunAction = (action: () => Promise<void>) => Promise<void>;

/** Configuration for {@link useProjectRevisions}. */
export interface ProjectRevisionsOptions {
  closeProjectMenu: () => void;
  /** Resolves true when there are no unsaved changes or the user discards them. */
  confirmDiscard: () => Promise<boolean>;
  /** Unsaved-changes flag; a restored revision stays dirty until an explicit Save. */
  dirty: Ref<boolean>;
  markClean: (expectedDocumentKey?: string) => Promise<boolean>;
  opfsAvailable: boolean;
  /** Reclaims storage no project references any more; never throws. */
  reclaimUnusedMedia: () => Promise<void>;
  replaceProjectDocument: (document: ProjectDocument) => Promise<void>;
  runAction: RunAction;
  /** Writes the live document to the autosave slot and resolves its document key. */
  saveLoadedProjectToAutosave: () => Promise<string>;
  /** OPFS slot the document is saved under, or null before its first save. */
  savedProjectSlot: Ref<string | null>;
  startScreenOpen: Ref<boolean>;
}

/** Revision list state and actions returned by {@link useProjectRevisions}. */
export interface ProjectRevisions {
  /** Named revisions of the project the document is saved under. */
  revisions: Ref<ProjectRevision[]>;
  revisionsDialogOpen: Ref<boolean>;
  saveRevisionAction(): void;
  /** Reloads the revision list of the project the document is saved under. */
  refreshRevisions(): Promise<void>;
  openRevisionsDialog(): void;
  restoreRevision(slot: string): void;
  deleteRevision(slot: string): void;
}

/**
 * Creates the revisions dialog state and its snapshot, restore and delete actions.
 *
 * @param options - The saved slot, session flags and the document-replacement steps.
 * @returns The revision list, dialog flag and actions.
 */
export function useProjectRevisions(options: ProjectRevisionsOptions): ProjectRevisions {
  const {
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
  } = options;
  const store = useProjectStore();
  const { t } = useI18n();
  /** Named revisions of the project the document is saved under. */
  const revisions = ref<ProjectRevision[]>([]);
  const revisionsDialogOpen = ref(false);

  /** Snapshots the current document under a user-supplied label. */
  function saveRevisionAction(): void {
    closeProjectMenu();
    void (async () => {
      const label = await promptDialog({
        title: t.value.dialogs.prompts.saveRevisionTitle,
        message: t.value.dialogs.prompts.saveRevisionMessage,
        defaultValue: '',
        placeholder: t.value.dialogs.prompts.revisionLabelPlaceholder,
        confirmLabel: t.value.dialogs.prompts.save,
      });
      if (!label) return;
      void runAction(async () => {
        const doc = serializeProject();
        doc.name = store.projectName;
        const bytes = encodeSzd(doc, { savedAt: new Date().toISOString() });
        await saveProjectRevision(
          savedProjectSlot.value ?? store.projectName,
          label,
          bytes,
          Date.now(),
        );
        await refreshRevisions();
      });
    })();
  }

  /** Reloads the revision list of the project the document is saved under. */
  async function refreshRevisions(): Promise<void> {
    if (!opfsAvailable) {
      revisions.value = [];
      return;
    }
    revisions.value = await listProjectRevisions(savedProjectSlot.value ?? store.projectName);
  }

  function openRevisionsDialog(): void {
    closeProjectMenu();
    revisionsDialogOpen.value = true;
    void runAction(refreshRevisions);
  }

  /** Replaces the live document with a stored revision (discard confirmed). */
  function restoreRevision(slot: string): void {
    void (async () => {
      if (!(await confirmDiscard())) return;
      void runAction(async () => {
        // Restoring a revision replaces only the live document. The slot and
        // the revision this tab last loaded or saved stay the Save baseline,
        // so a save from another tab since then still raises a conflict.
        const bytes = await loadProjectRevision(slot);
        await replaceProjectDocument(await decodeSzdInWorker(bytes));
        const documentKey = await saveLoadedProjectToAutosave();
        await markClean(documentKey);
        // The autosave protects crash recovery, but it is not the named
        // project commit promised by the revisions dialog. Keep the restored
        // document dirty so opening another project still asks whether to
        // discard it until an explicit Save succeeds.
        dirty.value = true;
        revisionsDialogOpen.value = false;
        startScreenOpen.value = false;
      });
    })();
  }

  function deleteRevision(slot: string): void {
    void runAction(async () => {
      await deleteProjectRevision(slot);
      await refreshRevisions();
      // A dropped revision can be the last reference to imported media.
      await reclaimUnusedMedia();
    });
  }

  return {
    revisions,
    revisionsDialogOpen,
    saveRevisionAction,
    refreshRevisions,
    openRevisionsDialog,
    restoreRevision,
    deleteRevision,
  };
}
