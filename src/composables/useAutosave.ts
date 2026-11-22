import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue';
import { getCurrentScope, onScopeDispose, ref, toValue, watch } from 'vue';
import {
  loadProject,
  OpfsUnavailableError,
  ProjectNotFoundError,
  saveProject,
} from '@/persistence/opfs';
import {
  loadLatestAutosaveSessionRevision,
  saveAutosaveSessionRevision,
} from '@/persistence/recovery';
import { decodeSzd, encodeSzd } from '@/persistence/szd';
import { persistedProjectStateKey } from '@/project/persisted-state';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';

/** Default debounce delay between the last edit and the autosave write. */
const DEFAULT_INTERVAL_MS = 30000;

/** Default OPFS slot (project name) the autosave writes to. */
const DEFAULT_SLOT_NAME = 'autosave';

/** Options accepted by {@link useAutosave}. */
export interface UseAutosaveOptions {
  /**
   * Debounce delay in milliseconds between the last change and the write.
   * Accepts a ref/getter so a live user preference applies to the next save.
   */
  intervalMs?: MaybeRefOrGetter<number>;
  /** OPFS project name used as the autosave slot. */
  slotName?: string;
  /** Shared persisted-state revision, avoiding duplicate full-document hashes. */
  persistedStateKey?: ComputedRef<string>;
}

/** Reactive autosave state and actions returned by {@link useAutosave}. */
export interface UseAutosaveReturn {
  /** Wall-clock time of the last successful autosave write, or null. */
  lastSavedAt: Ref<Date | null>;
  /** Exact serialized document revision written by the last successful save. */
  lastSavedDocumentKey: Ref<string | null>;
  /** True while an autosave write is in flight. */
  saving: Ref<boolean>;
  /** Last save/restore failure, cleared by the next successful save. */
  lastError: Ref<Error | null>;
  /**
   * Flushes any pending debounce and saves immediately.
   *
   * @returns True on success; false when the store is uninitialized or the
   *   write failed (the failure lands in `lastError`).
   */
  saveNow(): Promise<boolean>;
  /**
   * Loads the autosave slot back into the project (replacing the open
   * project and clearing the undo history).
   *
   * @param load Replaces the open document; the caller's document-swap owner,
   *   so its will-load hooks run. Defaults to a bare document load.
   * @returns True when an autosave was restored; false when no autosave
   *   exists or OPFS is unavailable.
   * @throws Error when the stored bytes are corrupt or fail to replay.
   */
  restoreAutosave(load?: (document: ProjectDocument) => Promise<unknown>): Promise<boolean>;
  /**
   * Cancels a pending debounced write without saving. Used when the project
   * reaches a clean state (e.g. just after a load) so the change watcher's
   * scheduled save does not redundantly re-persist unchanged content.
   */
  cancelPending(): void;
  /** Stops watching and cancels any pending write. Called on scope dispose. */
  dispose(): void;
}

/**
 * Vue composable that autosaves the open project to an OPFS slot.
 *
 * Watches the project store's persisted mirror state (which is replaced
 * wholesale after every command, so a shallow watch sees every undoable edit
 * plus the project name) and, after a quiet period of `intervalMs`, encodes
 * the current document to .szd bytes and writes them to OPFS. Encoding is
 * synchronous but small (plain JSON + deflate); the OPFS write is async, so
 * the UI thread is never blocked noticeably. Writes are serialized: a save
 * triggered while another is in flight waits for it.
 *
 * @param options Debounce interval and slot name overrides.
 * @returns Reactive autosave state plus saveNow/restoreAutosave actions.
 */
export function useAutosave(options: UseAutosaveOptions = {}): UseAutosaveReturn {
  const resolveIntervalMs = (): number => toValue(options.intervalMs) ?? DEFAULT_INTERVAL_MS;
  const slotName = options.slotName ?? DEFAULT_SLOT_NAME;
  const store = useProjectStore();

  const lastSavedAt = ref<Date | null>(null);
  const lastSavedDocumentKey = ref<string | null>(null);
  const saving = ref(false);
  const lastError = ref<Error | null>(null);

  let timer: ReturnType<typeof setTimeout> | null = null;
  // Save and restore share one recovery-safe chain: a failed restore must not
  // poison later autosaves, and a restore never races an in-flight write.
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = chain.then(operation);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const cancelPending = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const toError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));

  /**
   * Serializes, encodes and writes the current project to the slot. A document
   * this composable already wrote successfully is not rewritten, so a stale tab
   * never restamps the shared slot with a newer savedAt.
   */
  const runSave = (): Promise<boolean> => {
    return enqueue(async (): Promise<boolean> => {
      if (disposed || !store.initialized) return false;
      saving.value = true;
      try {
        const doc = serializeProject();
        const documentKey = JSON.stringify(doc);
        if (documentKey === lastSavedDocumentKey.value && lastError.value === null) return true;
        const savedAt = new Date().toISOString();
        const bytes = encodeSzd(doc, { savedAt, documentJson: documentKey });
        await saveProject(slotName, bytes);
        if (slotName === DEFAULT_SLOT_NAME) {
          await saveAutosaveSessionRevision(bytes, documentKey, savedAt);
        }
        lastSavedAt.value = new Date();
        lastSavedDocumentKey.value = documentKey;
        lastError.value = null;
        return true;
      } catch (error) {
        lastError.value = toError(error);
        return false;
      } finally {
        saving.value = false;
      }
    });
  };

  /** Trailing debounce: (re)starts the quiet-period timer. */
  const scheduleSave = (): void => {
    cancelPending();
    timer = setTimeout(() => {
      timer = null;
      void runSave();
    }, resolveIntervalMs());
  };

  const stopWatch = watch(
    () => options.persistedStateKey?.value ?? persistedProjectStateKey(store),
    () => {
      if (store.initialized) scheduleSave();
    },
  );

  const saveNow = (): Promise<boolean> => {
    cancelPending();
    return runSave();
  };

  const restoreAutosave = (
    load: (document: ProjectDocument) => Promise<unknown> = loadProjectDocument,
  ): Promise<boolean> => {
    cancelPending();
    return enqueue(async (): Promise<boolean> => {
      if (disposed) return false;
      let bytes: Uint8Array;
      try {
        bytes =
          slotName === DEFAULT_SLOT_NAME
            ? ((await loadLatestAutosaveSessionRevision()) ?? (await loadProject(slotName)))
            : await loadProject(slotName);
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return false;
        if (error instanceof OpfsUnavailableError) {
          lastError.value = error;
          return false;
        }
        lastError.value = toError(error);
        throw error;
      }
      if (disposed) return false;
      try {
        await load(decodeSzd(bytes));
        lastError.value = null;
        return true;
      } catch (error) {
        lastError.value = toError(error);
        throw error;
      }
    });
  };

  const dispose = (): void => {
    disposed = true;
    cancelPending();
    stopWatch();
  };

  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  return {
    lastSavedAt,
    lastSavedDocumentKey,
    saving,
    lastError,
    saveNow,
    restoreAutosave,
    cancelPending,
    dispose,
  };
}

/**
 * Page-exit and pre-update flushes that never write the launcher's placeholder
 * document over the crash-recovery autosave.
 *
 * @param options.hasLiveDocument Whether the store holds a document the user
 *   created, opened or restored (false while the start screen is open).
 * @param options.saveNow The autosave flush.
 */
export function liveDocumentFlushes(options: {
  hasLiveDocument: () => boolean;
  saveNow: () => Promise<boolean>;
}): { flushOnExit: () => Promise<boolean>; flushBeforeUpdate: () => Promise<boolean> } {
  return {
    flushOnExit: async () => (options.hasLiveDocument() ? options.saveNow() : false),
    // An update must stay usable before the user creates or opens a project.
    flushBeforeUpdate: async () => (options.hasLiveDocument() ? options.saveNow() : true),
  };
}
