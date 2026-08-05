<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { detectActiveAudioClipTimeSignatures } from '@/project/audio-tempo';
import { setTimeSignatures } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { isAudioClip, type TimeSignatureSegment } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { barBeatFromPpq, formatBarBeat, parseBarBeat } from './bar-beat';
import ListIcon from './ListIcon.vue';
import {
  formatRowIssue,
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
const { t } = useI18n();

/** Beat-unit picker options; values stay strings to match the draft rows. */
const DENOMINATOR_OPTIONS = TIME_SIGNATURE_DENOMINATORS.map((denominator) => ({
  value: String(denominator),
  label: String(denominator),
}));

/** One editable draft row; values stay strings until Apply parses them. */
interface DraftRow {
  key: number;
  position: string;
  numerator: string;
  denominator: string;
  /** Additive beat groups, e.g. `2+2+3`; blank means conventional grouping. */
  grouping: string;
}

let nextRowKey = 1;
const rows = ref<DraftRow[]>([]);
const dirty = ref(false);
const errors = ref<string[]>([]);
/** True while a meter detection is awaiting the engine. */
const isDetecting = ref(false);
let detectGeneration = 0;

/** The active clip when it is an audio clip carrying an asset, else null. */
const detectableAudioClip = computed(() => {
  const clip = store.activeClip;
  return clip && isAudioClip(clip) && clip.assetId !== undefined ? clip : null;
});

/** Rebuilds the draft from the store mirror. */
function rowsFromStore(): DraftRow[] {
  return store.timeSignatures.map((segment) => ({
    key: nextRowKey++,
    position: formatBarBeat(segment.startPpq, store.timeSignatures),
    numerator: String(segment.numerator),
    denominator: String(segment.denominator),
    grouping: segment.grouping?.join('+') ?? '',
  }));
}

/** Parses a user-entered additive grouping; blank selects conventional grouping. */
function parseGrouping(text: string, numerator: number): number[] | null {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const grouping = trimmed.split(/[+\s]+/).map((value) => Number(value));
  if (
    grouping.length === 0 ||
    !grouping.every((value) => Number.isInteger(value) && value > 0) ||
    grouping.reduce((sum, value) => sum + value, 0) !== numerator
  ) {
    return null;
  }
  return grouping;
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
  rows.value = [
    ...rows.value,
    { key: nextRowKey++, position, numerator, denominator, grouping: '' },
  ];
  dirty.value = true;
}

function deleteRow(index: number): void {
  rows.value = rows.value.filter((_, i) => i !== index);
  dirty.value = true;
}

/**
 * Tracks beats and downbeats in the active audio clip and replaces the draft
 * with the resulting meter map (one segment per bar where the meter changes,
 * anchored at song start). The draft awaits review before Apply.
 */
async function detectFromClip(): Promise<void> {
  const clip = detectableAudioClip.value;
  if (!clip || isDetecting.value) return;
  const generation = ++detectGeneration;
  errors.value = [];
  isDetecting.value = true;
  const isCurrent = () =>
    generation === detectGeneration && detectableAudioClip.value?.id === clip.id;
  try {
    const segments = await detectActiveAudioClipTimeSignatures(clip.id, {
      maxNumerator: MAX_TIME_SIGNATURE_NUMERATOR,
    });
    if (!isCurrent()) return;
    if (segments.length === 0) {
      errors.value = [t.value.shell.lists.meter.noneDetected];
      return;
    }
    rows.value = segments.map((segment) => ({
      key: nextRowKey++,
      position: formatBarBeat(segment.startPpq, store.timeSignatures),
      numerator: String(segment.numerator),
      denominator: String(segment.denominator),
      grouping: '',
    }));
    dirty.value = true;
  } catch (err) {
    if (!isCurrent()) return;
    errors.value = [err instanceof Error ? err.message : String(err)];
  } finally {
    if (generation === detectGeneration) isDetecting.value = false;
  }
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
        formatMessage(t.value.shell.lists.common.rowInvalidPosition, {
          row: index + 1,
          position: row.position,
        }),
      );
      return;
    }
    const numerator = Number(row.numerator);
    const grouping = parseGrouping(row.grouping, numerator);
    if (grouping === null) {
      issues.push(
        formatMessage(t.value.shell.lists.meter.invalidGrouping, {
          row: index + 1,
          numerator: row.numerator,
        }),
      );
      return;
    }
    const segment: TimeSignatureSegment = {
      startPpq,
      numerator,
      denominator: Number(row.denominator),
    };
    if (grouping.length > 0) segment.grouping = grouping;
    parsed.push(segment);
  });
  if (issues.length === 0) {
    for (const issue of validateTimeSignatureRows(parsed)) {
      const message = formatRowIssue(issue.issue, t.value.shell.lists.common.validation);
      issues.push(
        issue.row >= 0
          ? formatMessage(t.value.shell.lists.common.rowIssue, {
              row: issue.row + 1,
              message,
            })
          : message,
      );
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
          <th scope="col">{{ t.shell.lists.columns.position }}</th>
          <th scope="col">{{ t.shell.lists.columns.beats }}</th>
          <th scope="col">{{ t.shell.lists.columns.unit }}</th>
          <th scope="col">{{ t.shell.lists.columns.grouping }}</th>
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
              :aria-label="formatMessage(t.shell.lists.meter.entryPosition, { row: index + 1 })"
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
              :aria-label="formatMessage(t.shell.lists.meter.entryBeats, { row: index + 1 })"
              @input="markDirty"
              @keydown.enter.prevent="apply"
              @keydown.esc.prevent="revert"
            />
          </td>
          <td>
            <SelectMenu
              v-model="row.denominator"
              class="cell-input cell-number"
              size="sm"
              :options="DENOMINATOR_OPTIONS"
              :aria-label="formatMessage(t.shell.lists.meter.entryUnit, { row: index + 1 })"
              @change="markDirty"
            />
          </td>
          <td>
            <input
              v-model="row.grouping"
              class="cell-input cell-grouping"
              type="text"
              placeholder="2+2+3"
              :aria-label="formatMessage(t.shell.lists.meter.entryGrouping, { row: index + 1 })"
              @input="markDirty"
              @keydown.enter.prevent="apply"
              @keydown.esc.prevent="revert"
            />
          </td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              :aria-label="formatMessage(t.shell.lists.meter.deleteEntry, { row: index + 1 })"
              @click="deleteRow(index)"
            >
              <ListIcon name="delete" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <EmptyState v-if="rows.length === 0" variant="inline" :message="t.shell.lists.meter.empty" />
    <p v-for="error in errors" :key="error" class="list-error" role="alert">{{ error }}</p>
    <div class="list-actions">
      <button type="button" @click="addRow">{{ t.shell.lists.meter.add }}</button>
      <button
        type="button"
        :disabled="detectableAudioClip === null || isDetecting"
        v-tooltip="t.shell.lists.meter.detectFromClipTitle"
        @click="detectFromClip"
      >
        {{ t.shell.lists.meter.detectFromClip }}
      </button>
      <span class="list-spacer" />
      <button type="button" :disabled="!dirty" @click="revert">
        {{ t.shell.lists.common.revert }}
      </button>
      <button type="button" class="primary" :disabled="!dirty" @click="apply">
        {{ t.shell.lists.common.apply }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./lists.css"></style>
