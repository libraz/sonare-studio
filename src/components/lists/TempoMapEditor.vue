<script setup lang="ts">
import { ref, watch } from 'vue';
import { setTempoSegments } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { TempoSegment } from '@/project/types';
import { barBeatFromPpq, formatBarBeat, parseBarBeat } from './bar-beat';
import { MAX_BPM, MIN_BPM, mergeTempoSegments, validateTempoRows } from './row-validation';

/**
 * Tempo-map list editor: one row per tempo segment (position in bars.beats,
 * BPM and an optional ramp target). Rows are edited as a local draft and
 * committed in one undoable setTempoSegments call on Apply; while the draft
 * is clean it follows the store mirror (undo/redo included).
 */

const store = useProjectStore();

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
        `Row ${index + 1}: invalid position "${row.position}" (use bars.beats, e.g. 5.1)`,
      );
      return;
    }
    const segment: TempoSegment = { startPpq, bpm: Number(row.bpm) };
    if (row.endBpm.trim() !== '') segment.endBpm = Number(row.endBpm);
    parsed.push(segment);
  });
  if (issues.length === 0) {
    for (const issue of validateTempoRows(parsed)) {
      issues.push(issue.row >= 0 ? `Row ${issue.row + 1}: ${issue.message}` : issue.message);
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
          <th scope="col">Position</th>
          <th scope="col">BPM</th>
          <th scope="col">Ramp to</th>
          <th scope="col"><span class="visually-hidden">Actions</span></th>
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
              :aria-label="`Tempo entry ${index + 1} position (bars.beats)`"
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
              :aria-label="`Tempo entry ${index + 1} BPM`"
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
              :aria-label="`Tempo entry ${index + 1} ramp target BPM`"
              @input="markDirty"
              @keydown.enter.prevent="apply"
              @keydown.esc.prevent="revert"
            />
          </td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              :aria-label="`Delete tempo entry ${index + 1}`"
              @click="deleteRow(index)"
            >
              ✕
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="list-empty">No tempo entries — add one below.</p>
    <p v-for="error in errors" :key="error" class="list-error" role="alert">{{ error }}</p>
    <div class="list-actions">
      <button type="button" @click="addRow">Add tempo</button>
      <span class="list-spacer" />
      <button type="button" :disabled="!dirty" @click="revert">Revert</button>
      <button type="button" :disabled="!dirty" @click="apply">Apply</button>
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
