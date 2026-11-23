<script setup lang="ts">
import EmptyState from '@/components/shell/EmptyState.vue';
import { detectActiveAudioClipTempo, detectActiveAudioClipTempoMap } from '@/project/audio-tempo';
import { setTempoSegments } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { DEFAULT_TEMPO_BPM } from '@/project/tempo-map';
import type { TempoSegment } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { isImeComposing } from '@/ui/keyboard/ime';
import { useDraftList } from '@/ui/lists/use-draft-list';
import { isBlankInput, type NumericInputValue } from '@/ui/numeric-input';
import { formatBarBeat, parseBarBeat } from './bar-beat';
import ListIcon from './ListIcon.vue';
import { MAX_BPM, MIN_BPM, mergeTempoSegments, validateTempoRows } from './row-validation';

/**
 * Tempo-map list editor: one row per tempo segment (position in bars.beats,
 * BPM and an optional ramp target). Rows are edited as a local draft and
 * committed in one undoable setTempoSegments call on Apply; while the draft
 * is clean it follows the store mirror (undo/redo included).
 */

const store = useProjectStore();
const { t } = useI18n();

/** One editable draft row; values stay strings until Apply parses them. */
interface DraftRow {
  key: number;
  position: string;
  bpm: NumericInputValue;
  endBpm: NumericInputValue;
}

/** Formats a BPM value without floating-point noise. */
function formatBpm(bpm: number): string {
  return String(Math.round(bpm * 1000) / 1000);
}

const {
  rows,
  dirty,
  errors,
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
} = useDraftList<DraftRow>({
  buildRows: (nextKey) =>
    store.tempoSegments.map((segment) => ({
      key: nextKey(),
      position: formatBarBeat(segment.startPpq, store.timeSignatures),
      bpm: formatBpm(segment.bpm),
      endBpm: segment.endBpm !== undefined && segment.endBpm > 0 ? formatBpm(segment.endBpm) : '',
    })),
  source: () => store.tempoSegments,
});

/** Appends a row one bar after the last entry, inheriting its tempo. */
function addRow(): void {
  const last = rows.value[rows.value.length - 1];
  const bpm = last ? last.bpm : formatBpm(store.tempoBpm || DEFAULT_TEMPO_BPM);
  rows.value = [
    ...rows.value,
    { key: nextKey(), position: nextBarPosition(last?.position), bpm, endBpm: '' },
  ];
  dirty.value = true;
}

/**
 * Detects the active audio clip's tempo and writes it into the draft as the
 * song-start (1.1) BPM, leaving the existing rows for review before Apply.
 */
function detectFromClip(): Promise<void> {
  return guardedDetect(async (clip, isCurrent, signal) => {
    const bpm = await detectActiveAudioClipTempo(clip.id, signal);
    if (!isCurrent()) return;
    if (bpm === null) {
      errors.value = [t.value.shell.lists.tempo.noneDetected];
      return;
    }
    const text = formatBpm(bpm);
    const startIndex = rows.value.findIndex(
      (row) => parseBarBeat(row.position, store.timeSignatures) === 0,
    );
    rows.value =
      startIndex >= 0
        ? rows.value.map((row, i) => (i === startIndex ? { ...row, bpm: text } : row))
        : [{ key: nextKey(), position: '1.1', bpm: text, endBpm: '' }, ...rows.value];
    dirty.value = true;
  });
}

/**
 * Tracks beats in the active audio clip and replaces the draft with the
 * resulting variable tempo map (one constant segment per detected beat
 * interval, anchored at song start). The draft awaits review before Apply.
 */
function detectMapFromClip(): Promise<void> {
  return guardedDetect(async (clip, isCurrent, signal) => {
    const segments = await detectActiveAudioClipTempoMap(
      clip.id,
      { minBpm: MIN_BPM, maxBpm: MAX_BPM },
      signal,
    );
    if (!isCurrent()) return;
    if (segments.length === 0) {
      errors.value = [t.value.shell.lists.tempo.noBeatsDetected];
      return;
    }
    rows.value = segments.map((segment) => ({
      key: nextKey(),
      position: formatBarBeat(segment.startPpq, store.timeSignatures),
      bpm: formatBpm(segment.bpm),
      endBpm: '',
    }));
    dirty.value = true;
  });
}

/** Validates the draft and commits it as one undoable tempo-map edit. */
/** Enter applies the draft unless it is confirming an IME composition. */
function onEnter(event: KeyboardEvent): void {
  if (isImeComposing(event)) return;
  event.preventDefault();
  apply();
}

function apply(): void {
  if (!dirty.value) return;
  const issues: string[] = [];
  const parsed: TempoSegment[] = [];
  rows.value.forEach((row, index) => {
    const startPpq = parseBarBeat(row.position, store.timeSignatures);
    if (startPpq === null) {
      issues.push(invalidPositionMessage(index, row.position));
      return;
    }
    const segment: TempoSegment = { startPpq, bpm: Number(row.bpm) };
    if (!isBlankInput(row.endBpm)) segment.endBpm = Number(row.endBpm);
    parsed.push(segment);
  });
  if (issues.length === 0) issues.push(...formatIssues(validateTempoRows(parsed)));
  errors.value = issues;
  if (issues.length > 0) return;
  setTempoSegments(mergeTempoSegments(parsed));
  dirty.value = false;
}
</script>

<template>
  <div class="list-editor">
    <table class="list-table">
      <thead>
        <tr>
          <th scope="col">{{ t.shell.lists.columns.position }}</th>
          <th scope="col">{{ t.shell.lists.columns.bpm }}</th>
          <th scope="col">{{ t.shell.lists.columns.rampTo }}</th>
          <th scope="col"><span class="visually-hidden">{{ t.shell.lists.columns.actions }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in rows" :key="row.key">
          <td>
            <input
              v-model="row.position"
              class="cell-input cell-position"
              type="text"
              inputmode="decimal"
              :aria-label="
                formatMessage(t.shell.lists.tempo.entryPosition, { row: index + 1 })
              "
              @input="markDirty"
              @keydown.enter="onEnter"
              @keydown.esc.prevent="revert"
            />
          </td>
          <td>
            <input
              v-model="row.bpm"
              class="cell-input cell-number"
              type="number"
              :min="MIN_BPM"
              :max="MAX_BPM"
              step="0.1"
              :aria-label="formatMessage(t.shell.lists.tempo.entryBpm, { row: index + 1 })"
              @input="markDirty"
              @keydown.enter="onEnter"
              @keydown.esc.prevent="revert"
            />
          </td>
          <td>
            <input
              v-model="row.endBpm"
              class="cell-input cell-number"
              type="number"
              :min="MIN_BPM"
              :max="MAX_BPM"
              step="0.1"
              placeholder="—"
              :aria-label="formatMessage(t.shell.lists.tempo.entryRamp, { row: index + 1 })"
              @input="markDirty"
              @keydown.enter="onEnter"
              @keydown.esc.prevent="revert"
            />
          </td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              v-tooltip="t.shell.lists.common.deleteTitle"
              :aria-label="formatMessage(t.shell.lists.tempo.deleteEntry, { row: index + 1 })"
              @click="deleteRow(index)"
            >
              <ListIcon name="delete" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <EmptyState v-if="rows.length === 0" variant="inline" :message="t.shell.lists.tempo.empty" />
    <p v-for="error in errors" :key="error" class="list-error" role="alert">{{ error }}</p>
    <div class="list-actions">
      <button type="button" @click="addRow">{{ t.shell.lists.tempo.add }}</button>
      <button
        type="button"
        :disabled="!!detectBlocked"
        v-tooltip="{ text: t.shell.lists.tempo.detectFromClipTitle, reason: detectBlocked }"
        @click="detectFromClip"
      >
        {{ t.shell.lists.tempo.detectFromClip }}
      </button>
      <button
        type="button"
        :disabled="!!detectBlocked"
        v-tooltip="{ text: t.shell.lists.tempo.detectMapFromClipTitle, reason: detectBlocked }"
        @click="detectMapFromClip"
      >
        {{ t.shell.lists.tempo.detectMapFromClip }}
      </button>
      <span class="list-spacer" />
      <button
        type="button"
        :disabled="!!draftBlocked"
        v-tooltip="{ text: t.shell.lists.common.revertTitle, reason: draftBlocked }"
        @click="revert"
      >
        {{ t.shell.lists.common.revert }}
      </button>
      <button
        type="button"
        class="primary"
        :disabled="!!draftBlocked"
        v-tooltip="{ text: t.shell.lists.common.applyTitle, reason: draftBlocked }"
        @click="apply"
      >
        {{ t.common.apply }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./lists.css"></style>
