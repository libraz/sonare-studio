<script setup lang="ts">
import { ref, watch } from 'vue';
import { setTimeSignatures } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { TimeSignatureSegment } from '@/project/types';
import { barBeatFromPpq, formatBarBeat, parseBarBeat } from './bar-beat';
import {
  MAX_TIME_SIGNATURE_NUMERATOR,
  mergeTimeSignatureSegments,
  TIME_SIGNATURE_DENOMINATORS,
  validateTimeSignatureRows,
} from './row-validation';

/**
 * Time-signature list editor: one row per meter segment (bar position,
 * numerator, denominator). Rows are edited as a local draft and committed in
 * one undoable setTimeSignatures call on Apply; while the draft is clean it
 * follows the store mirror (undo/redo included).
 *
 * Positions are parsed against the CURRENT meter map: a row's bar number
 * keeps its meaning while editing even when other draft rows change.
 */

const store = useProjectStore();

/** One editable draft row; values stay strings until Apply parses them. */
interface DraftRow {
  key: number;
  position: string;
  numerator: string;
  denominator: string;
}

let nextRowKey = 1;
const rows = ref<DraftRow[]>([]);
const dirty = ref(false);
const errors = ref<string[]>([]);

/** Rebuilds the draft from the store mirror. */
function rowsFromStore(): DraftRow[] {
  return store.timeSignatures.map((segment) => ({
    key: nextRowKey++,
    position: formatBarBeat(segment.startPpq, store.timeSignatures),
    numerator: String(segment.numerator),
    denominator: String(segment.denominator),
  }));
}

// The mirror is replaced wholesale after every command; resync the draft
// whenever it is clean so undo/redo and external edits show through.
watch(
  () => store.timeSignatures,
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

/** Appends a row one bar after the last entry, inheriting its meter. */
function addRow(): void {
  const last = rows.value[rows.value.length - 1];
  let position = '1.1';
  let numerator = '4';
  let denominator = '4';
  if (last) {
    const lastPpq = parseBarBeat(last.position, store.timeSignatures);
    if (lastPpq !== null) {
      const { bar } = barBeatFromPpq(lastPpq, store.timeSignatures);
      position = `${bar + 1}.1`;
    }
    numerator = last.numerator;
    denominator = last.denominator;
  }
  rows.value = [...rows.value, { key: nextRowKey++, position, numerator, denominator }];
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

/** Validates the draft and commits it as one undoable meter-map edit. */
function apply(): void {
  if (!dirty.value) return;
  const issues: string[] = [];
  const parsed: TimeSignatureSegment[] = [];
  rows.value.forEach((row, index) => {
    const startPpq = parseBarBeat(row.position, store.timeSignatures);
    if (startPpq === null) {
      issues.push(
        `Row ${index + 1}: invalid position "${row.position}" (use bars.beats, e.g. 5.1)`,
      );
      return;
    }
    parsed.push({
      startPpq,
      numerator: Number(row.numerator),
      denominator: Number(row.denominator),
    });
  });
  if (issues.length === 0) {
    for (const issue of validateTimeSignatureRows(parsed)) {
      issues.push(issue.row >= 0 ? `Row ${issue.row + 1}: ${issue.message}` : issue.message);
    }
  }
  errors.value = issues;
  if (issues.length > 0) return;
  setTimeSignatures(mergeTimeSignatureSegments(parsed));
  dirty.value = false;
}
</script>

<template>
  <div class="list-editor">
    <table class="list-table">
      <thead>
        <tr>
          <th scope="col">Position</th>
          <th scope="col">Beats</th>
          <th scope="col">Unit</th>
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
              :aria-label="`Meter entry ${index + 1} position (bars.beats)`"
              @input="markDirty"
              @keydown.enter.prevent="apply"
              @keydown.esc.prevent="revert"
            />
          </td>
          <td>
            <input
              v-model="row.numerator"
              class="cell-input cell-number"
              type="number"
              min="1"
              :max="MAX_TIME_SIGNATURE_NUMERATOR"
              step="1"
              :aria-label="`Meter entry ${index + 1} beats per bar`"
              @input="markDirty"
              @keydown.enter.prevent="apply"
              @keydown.esc.prevent="revert"
            />
          </td>
          <td>
            <select
              v-model="row.denominator"
              class="cell-input cell-number"
              :aria-label="`Meter entry ${index + 1} beat unit`"
              @change="markDirty"
            >
              <option
                v-for="denominator in TIME_SIGNATURE_DENOMINATORS"
                :key="denominator"
                :value="String(denominator)"
              >
                {{ denominator }}
              </option>
            </select>
          </td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              :aria-label="`Delete meter entry ${index + 1}`"
              @click="deleteRow(index)"
            >
              ✕
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="list-empty">No meter entries — add one below.</p>
    <p v-for="error in errors" :key="error" class="list-error" role="alert">{{ error }}</p>
    <div class="list-actions">
      <button type="button" @click="addRow">Add meter</button>
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
  font-size: 12px;
  color: #c7cdd9;
  overflow: auto;
  min-height: 0;
}

.list-table {
  border-collapse: collapse;
  width: 100%;
}

.list-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: #8b93a3;
  padding: 0.15rem 0.4rem 0.15rem 0;
  border-bottom: 1px solid #2a2e38;
}

.list-table td {
  padding: 0.12rem 0.4rem 0.12rem 0;
}

.cell-input {
  width: 100%;
  box-sizing: border-box;
  background: #0b0d11;
  border: 1px solid #2a2e38;
  border-radius: 3px;
  color: #e2e6ee;
  font: inherit;
  font-variant-numeric: tabular-nums;
  padding: 0.15rem 0.3rem;
}

.cell-input:focus {
  outline: none;
  border-color: #60a5fa;
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
  color: #8b93a3;
  cursor: pointer;
  padding: 0.1rem 0.25rem;
  font-size: 11px;
}

.row-button:hover {
  color: #f87171;
}

.list-empty {
  margin: 0;
  color: #8b93a3;
}

.list-error {
  margin: 0;
  background: #3b1219;
  border: 1px solid #ef4444;
  border-radius: 3px;
  color: #ffb4b4;
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
