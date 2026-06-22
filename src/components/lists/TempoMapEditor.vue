<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { detectActiveAudioClipTempo, detectActiveAudioClipTempoMap } from '@/project/audio-tempo';
import { setTempoSegments } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { isAudioClip, type TempoSegment } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { barBeatFromPpq, formatBarBeat, parseBarBeat } from './bar-beat';
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
  bpm: string;
  endBpm: string;
}

let nextRowKey = 1;
const rows = ref<DraftRow[]>([]);
const dirty = ref(false);
const errors = ref<string[]>([]);
/** True while a tempo detection is awaiting the engine. */
const isDetecting = ref(false);

/** The active clip when it is an audio clip carrying an asset, else null. */
const detectableAudioClip = computed(() => {
  const clip = store.activeClip;
  return clip && isAudioClip(clip) && clip.assetId !== undefined ? clip : null;
});

/** Formats a BPM value without floating-point noise. */
function formatBpm(bpm: number): string {
  return String(Math.round(bpm * 1000) / 1000);
}

/** Rebuilds the draft from the store mirror. */
function rowsFromStore(): DraftRow[] {
  return store.tempoSegments.map((segment) => ({
    key: nextRowKey++,
    position: formatBarBeat(segment.startPpq, store.timeSignatures),
    bpm: formatBpm(segment.bpm),
    endBpm: segment.endBpm !== undefined && segment.endBpm > 0 ? formatBpm(segment.endBpm) : '',
  }));
}

// The mirror is replaced wholesale after every command; resync the draft
// whenever it is clean so undo/redo and external edits show through.
watch(
  () => store.tempoSegments,
  () => {
    if (dirty.value) return;
    rows.value = rowsFromStore();
    errors.value = [];
  },
  { immediate: true },
);

function markDirty(): void {
  dirty.value = true;
}

/** Appends a row one bar after the last entry, inheriting its tempo. */
function addRow(): void {
  const last = rows.value[rows.value.length - 1];
  let position = '1.1';
  let bpm = formatBpm(store.tempoBpm || 120);
  if (last) {
    const lastPpq = parseBarBeat(last.position, store.timeSignatures);
    if (lastPpq !== null) {
      const { bar } = barBeatFromPpq(lastPpq, store.timeSignatures);
      position = `${bar + 1}.1`;
    }
    bpm = last.bpm;
  }
  rows.value = [...rows.value, { key: nextRowKey++, position, bpm, endBpm: '' }];
  dirty.value = true;
}

function deleteRow(index: number): void {
  rows.value = rows.value.filter((_, i) => i !== index);
  dirty.value = true;
}

/**
 * Detects the active audio clip's tempo and writes it into the draft as the
 * song-start (1.1) BPM, leaving the existing rows for review before Apply.
 */
async function detectFromClip(): Promise<void> {
  const clip = detectableAudioClip.value;
  if (!clip || isDetecting.value) return;
  errors.value = [];
  isDetecting.value = true;
  try {
    const bpm = await detectActiveAudioClipTempo(clip.id);
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
        : [{ key: nextRowKey++, position: '1.1', bpm: text, endBpm: '' }, ...rows.value];
    dirty.value = true;
  } catch (err) {
    errors.value = [err instanceof Error ? err.message : String(err)];
  } finally {
    isDetecting.value = false;
  }
}

/**
 * Tracks beats in the active audio clip and replaces the draft with the
 * resulting variable tempo map (one constant segment per detected beat
 * interval, anchored at song start). The draft awaits review before Apply.
 */
async function detectMapFromClip(): Promise<void> {
  const clip = detectableAudioClip.value;
  if (!clip || isDetecting.value) return;
  errors.value = [];
  isDetecting.value = true;
  try {
    const segments = await detectActiveAudioClipTempoMap(clip.id, {
      minBpm: MIN_BPM,
      maxBpm: MAX_BPM,
    });
    if (segments.length === 0) {
      errors.value = [t.value.shell.lists.tempo.noBeatsDetected];
      return;
    }
    rows.value = segments.map((segment) => ({
      key: nextRowKey++,
      position: formatBarBeat(segment.startPpq, store.timeSignatures),
      bpm: formatBpm(segment.bpm),
      endBpm: '',
    }));
    dirty.value = true;
  } catch (err) {
    errors.value = [err instanceof Error ? err.message : String(err)];
  } finally {
    isDetecting.value = false;
  }
}

/** Discards the draft and reloads the rows from the store. */
function revert(): void {
  rows.value = rowsFromStore();
  dirty.value = false;
  errors.value = [];
}

/** Validates the draft and commits it as one undoable tempo-map edit. */
function apply(): void {
  if (!dirty.value) return;
  const issues: string[] = [];
  const parsed: TempoSegment[] = [];
  rows.value.forEach((row, index) => {
    const startPpq = parseBarBeat(row.position, store.timeSignatures);
    if (startPpq === null) {
      issues.push(
        formatMessage(t.value.shell.lists.common.rowInvalidPosition, {
          row: index + 1,
          position: row.position,
        }),
      );
      return;
    }
    const segment: TempoSegment = { startPpq, bpm: Number(row.bpm) };
    if (row.endBpm.trim() !== '') segment.endBpm = Number(row.endBpm);
    parsed.push(segment);
  });
  if (issues.length === 0) {
    for (const issue of validateTempoRows(parsed)) {
      issues.push(
        issue.row >= 0
          ? formatMessage(t.value.shell.lists.common.rowIssue, {
              row: issue.row + 1,
              message: issue.message,
            })
          : issue.message,
      );
    }
  }
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
              class="cell-input"
              type="text"
              inputmode="decimal"
              :aria-label="
                formatMessage(t.shell.lists.tempo.entryPosition, { row: index + 1 })
              "
              @input="markDirty"
              @keydown.enter.prevent="apply"
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
              @keydown.enter.prevent="apply"
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
              @keydown.enter.prevent="apply"
              @keydown.esc.prevent="revert"
            />
          </td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              :aria-label="formatMessage(t.shell.lists.tempo.deleteEntry, { row: index + 1 })"
              @click="deleteRow(index)"
            >
              ✕
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="list-empty">{{ t.shell.lists.tempo.empty }}</p>
    <p v-for="error in errors" :key="error" class="list-error" role="alert">{{ error }}</p>
    <div class="list-actions">
      <button type="button" @click="addRow">{{ t.shell.lists.tempo.add }}</button>
      <button
        type="button"
        :disabled="detectableAudioClip === null || isDetecting"
        :title="t.shell.lists.tempo.detectFromClipTitle"
        @click="detectFromClip"
      >
        {{ t.shell.lists.tempo.detectFromClip }}
      </button>
      <button
        type="button"
        :disabled="detectableAudioClip === null || isDetecting"
        :title="t.shell.lists.tempo.detectMapFromClipTitle"
        @click="detectMapFromClip"
      >
        {{ t.shell.lists.tempo.detectMapFromClip }}
      </button>
      <span class="list-spacer" />
      <button type="button" :disabled="!dirty" @click="revert">
        {{ t.shell.lists.common.revert }}
      </button>
      <button type="button" :disabled="!dirty" @click="apply">
        {{ t.shell.lists.common.apply }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.list-editor {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  font-size: var(--fs-sm);
  color: var(--text-2);
  overflow: auto;
  min-height: 0;
}

.list-table {
  border-collapse: collapse;
  width: 100%;
}

.list-table th {
  text-align: left;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
  padding: 0.15rem 0.4rem 0.15rem 0;
  border-bottom: 1px solid var(--border);
}

.list-table td {
  padding: 0.12rem 0.4rem 0.12rem 0;
}

.cell-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-1);
  font: inherit;
  font-variant-numeric: tabular-nums;
  padding: 0.15rem 0.3rem;
  box-shadow: var(--control-edge), var(--inset-well);
  transition: box-shadow var(--dur-1) var(--ease-out);
}

.cell-input:focus {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
}

.cell-number {
  width: 5.5rem;
}

.cell-actions {
  width: 1.6rem;
  text-align: right;
}

.row-button {
  background: none;
  border: none;
  box-shadow: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 0.1rem 0.25rem;
  font-size: var(--fs-xs);
  transition: color var(--dur-1) var(--ease-out);
}

.row-button:hover {
  color: var(--danger);
}

.list-empty {
  margin: 0;
  color: var(--text-3);
}

.list-error {
  margin: 0;
  background: var(--danger-surface);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  color: var(--danger-text);
  padding: 0.25rem 0.5rem;
}

.list-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.list-spacer {
  flex: 1;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
