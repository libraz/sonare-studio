import type { MaybeRefOrGetter, Ref } from 'vue';
import { getCurrentScope, onScopeDispose, ref, toValue, watch } from 'vue';
import {
  loadProject,
  OpfsUnavailableError,
  ProjectNotFoundError,
  saveProject,
} from '@/persistence/opfs';
import { decodeSzd, encodeSzd } from '@/persistence/szd';
import { loadProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { midiCcBindingsKey } from '@/ui/midi/midi-learn';

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
}

/** Reactive autosave state and actions returned by {@link useAutosave}. */
export interface UseAutosaveReturn {
  /** Wall-clock time of the last successful autosave write, or null. */
  lastSavedAt: Ref<Date | null>;
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
   * @returns True when an autosave was restored; false when no autosave
   *   exists or OPFS is unavailable.
   * @throws Error when the stored bytes are corrupt or fail to replay.
   */
  restoreAutosave(): Promise<boolean>;
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
  const saving = ref(false);
  const lastError = ref<Error | null>(null);

  let timer: ReturnType<typeof setTimeout> | null = null;
  // Pending-write chain: keeps at most one OPFS write in flight at a time.
  let chain: Promise<unknown> = Promise.resolve();

  const cancelPending = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const toError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));

  /** Serializes, encodes and writes the current project to the slot. */
  const runSave = (): Promise<boolean> => {
    const run = chain.then(async (): Promise<boolean> => {
      if (!store.initialized) return false;
      saving.value = true;
      try {
        const doc = serializeProject();
        const bytes = encodeSzd(doc, { savedAt: new Date().toISOString() });
        await saveProject(slotName, bytes);
        lastSavedAt.value = new Date();
        lastError.value = null;
        return true;
      } catch (error) {
        lastError.value = toError(error);
        return false;
      } finally {
        saving.value = false;
      }
    });
    chain = run;
    return run;
  };

  /** Trailing debounce: (re)starts the quiet-period timer. */
  const scheduleSave = (): void => {
    cancelPending();
    timer = setTimeout(() => {
      timer = null;
      void runSave();
    }, resolveIntervalMs());
  };

  // The persisted state surface of the store mirror. Every mutating command
  // replaces these refs wholesale (refresh() rebuilds them from the Project),
  // so identity changes cover all undoable edits; editor-only state
  // (selection, snap, scale highlight) is deliberately excluded.
  const stopWatch = watch(
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
      if (store.initialized) scheduleSave();
    },
  );

  const saveNow = (): Promise<boolean> => {
    cancelPending();
    return runSave();
  };

  const restoreAutosave = async (): Promise<boolean> => {
    let bytes: Uint8Array;
    try {
      bytes = await loadProject(slotName);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) return false;
      if (error instanceof OpfsUnavailableError) {
        lastError.value = error;
        return false;
      }
      lastError.value = toError(error);
      throw error;
    }
    try {
      await loadProjectDocument(decodeSzd(bytes));
      return true;
    } catch (error) {
      lastError.value = toError(error);
      throw error;
    }
  };

  const dispose = (): void => {
    cancelPending();
    stopWatch();
  };

  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  return { lastSavedAt, saving, lastError, saveNow, restoreAutosave, cancelPending, dispose };
}
