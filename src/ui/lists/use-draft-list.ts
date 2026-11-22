/**
 * Shared draft-row state for the list editors (tempo map, time signatures):
 * a locally edited row list that follows the store mirror while clean, the
 * dirty/error bookkeeping, and the generation-guarded audio-clip detection
 * wrapper.
 */

import { computed, onBeforeUnmount, type Ref, ref, watch } from 'vue';
import { barBeatFromPpq, parseBarBeat } from '@/components/lists/bar-beat';
import { formatRowIssue, type RowIssue } from '@/components/lists/row-validation';
import { errorMessage } from '@/lib/errors';
import { useProjectStore } from '@/project/store';
import { type EditorClip, isAudioClip } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';

/** Options for {@link useDraftList}. */
export interface DraftListOptions<Row extends { key: number }> {
  /** Builds the draft rows from the store mirror, drawing row keys from `nextKey`. */
  buildRows: (nextKey: () => number) => Row[];
  /** Reactive source of the store mirror the draft follows while clean. */
  source: () => unknown;
}

/** Draft-row state and actions returned by {@link useDraftList}. */
export interface DraftList<Row extends { key: number }> {
  rows: Ref<Row[]>;
  dirty: Ref<boolean>;
  errors: Ref<string[]>;
  isDetecting: Ref<boolean>;
  nextKey: () => number;
  markDirty: () => void;
  deleteRow: (index: number) => void;
  /** Discards the draft and reloads the rows from the store. */
  revert: () => void;
  /** Reason Detect is unavailable, or null. */
  detectBlocked: Readonly<Ref<string | null>>;
  /** Reason Apply/Revert are unavailable, or null. */
  draftBlocked: Readonly<Ref<string | null>>;
  /** Bar-start position text one bar after the given position (`1.1` when none). */
  nextBarPosition: (lastPosition: string | undefined) => string;
  /** Localized message for a draft row whose position text does not parse. */
  invalidPositionMessage: (index: number, position: string) => string;
  /** Localized messages for structured row validation issues. */
  formatIssues: (issues: ReadonlyArray<RowIssue>) => string[];
  /**
   * Runs a detection against the active audio clip. The callback must check
   * `isCurrent()` after each await before touching the draft; errors thrown
   * by a still-current run surface in `errors`. The signal aborts when the
   * owner unmounts, the active clip changes or a newer run starts; an aborted
   * run is no longer current.
   */
  guardedDetect: (
    run: (clip: EditorClip, isCurrent: () => boolean, signal: AbortSignal) => Promise<void>,
  ) => Promise<void>;
}

/** Creates the shared draft state for a list editor. */
export function useDraftList<Row extends { key: number }>(
  options: DraftListOptions<Row>,
): DraftList<Row> {
  const store = useProjectStore();
  const { t } = useI18n();

  let rowKey = 1;
  const nextKey = (): number => rowKey++;
  const rows = ref([]) as Ref<Row[]>;
  const dirty = ref(false);
  const errors = ref<string[]>([]);
  const isDetecting = ref(false);
  let detectGeneration = 0;
  let detectController: AbortController | null = null;

  /** The active clip when it is an audio clip carrying an asset, else null. */
  const detectableAudioClip = computed(() => {
    const clip = store.activeClip;
    return clip && isAudioClip(clip) && clip.assetId !== undefined ? clip : null;
  });
  const detectBlocked = computed(() =>
    firstBlock(
      [detectableAudioClip.value === null, t.value.reasons.noAudioClip],
      [isDetecting.value, t.value.reasons.busy],
    ),
  );
  const draftBlocked = computed(() =>
    firstBlock([!dirty.value, t.value.shell.lists.reasons.noEdits]),
  );

  // The mirror is replaced wholesale after every command; resync the draft
  // whenever it is clean so undo/redo and external edits show through.
  watch(
    options.source,
    () => {
      if (dirty.value) return;
      rows.value = options.buildRows(nextKey);
      errors.value = [];
    },
    { immediate: true },
  );

  watch(
    () => detectableAudioClip.value?.id,
    () => detectController?.abort(),
  );
  onBeforeUnmount(() => detectController?.abort());

  function markDirty(): void {
    dirty.value = true;
  }

  function deleteRow(index: number): void {
    rows.value = rows.value.filter((_, i) => i !== index);
    dirty.value = true;
  }

  function revert(): void {
    rows.value = options.buildRows(nextKey);
    dirty.value = false;
    errors.value = [];
  }

  function nextBarPosition(lastPosition: string | undefined): string {
    if (lastPosition === undefined) return '1.1';
    const lastPpq = parseBarBeat(lastPosition, store.timeSignatures);
    if (lastPpq === null) return '1.1';
    return `${barBeatFromPpq(lastPpq, store.timeSignatures).bar + 1}.1`;
  }

  function invalidPositionMessage(index: number, position: string): string {
    return formatMessage(t.value.shell.lists.common.rowInvalidPosition, {
      row: index + 1,
      position,
    });
  }

  function formatIssues(issues: ReadonlyArray<RowIssue>): string[] {
    return issues.map((issue) => {
      const message = formatRowIssue(issue.issue, t.value.shell.lists.common.validation);
      return issue.row >= 0
        ? formatMessage(t.value.shell.lists.common.rowIssue, { row: issue.row + 1, message })
        : message;
    });
  }

  async function guardedDetect(
    run: (clip: EditorClip, isCurrent: () => boolean, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const clip = detectableAudioClip.value;
    if (!clip || isDetecting.value) return;
    const generation = ++detectGeneration;
    detectController?.abort();
    const controller = new AbortController();
    detectController = controller;
    errors.value = [];
    isDetecting.value = true;
    const isCurrent = () =>
      generation === detectGeneration &&
      !controller.signal.aborted &&
      detectableAudioClip.value?.id === clip.id;
    try {
      await run(clip, isCurrent, controller.signal);
    } catch (err) {
      if (!isCurrent()) return;
      errors.value = [errorMessage(err)];
    } finally {
      if (generation === detectGeneration) isDetecting.value = false;
      if (detectController === controller) detectController = null;
    }
  }

  return {
    rows,
    dirty,
    errors,
    isDetecting,
    nextKey,
    markDirty,
    deleteRow,
    revert,
    detectBlocked,
    draftBlocked,
    nextBarPosition,
    invalidPositionMessage,
    formatIssues,
    guardedDetect,
  };
}
