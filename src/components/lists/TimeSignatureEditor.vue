<script setup lang="ts">
import { computed, ref } from 'vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  detectActiveAudioClipTimeSignatures,
  estimateActiveAudioClipMeter,
  ODD_METER_CANDIDATES,
} from '@/project/audio-tempo';
import { setTimeSignatures } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { TimeSignatureSegment } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatBarBeat, parseBarBeat } from './bar-beat';
import ListIcon from './ListIcon.vue';
import {
  MAX_TIME_SIGNATURE_NUMERATOR,
  mergeTimeSignatureSegments,
  TIME_SIGNATURE_DENOMINATORS,
  validateTimeSignatureRows,
} from './row-validation';
import { useDraftList } from './use-draft-list';

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

/** Reads one meter for the whole clip, odd meters included, instead of per-bar changes. */
const detectOddMeters = ref(false);

/** Builds a draft row from a meter segment. */
function rowFromSegment(segment: TimeSignatureSegment, key: number): DraftRow {
  return {
    key,
    position: formatBarBeat(segment.startPpq, store.timeSignatures),
    numerator: String(segment.numerator),
    denominator: String(segment.denominator),
    grouping: segment.grouping?.join('+') ?? '',
  };
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
  buildRows: (nextKey) => store.timeSignatures.map((segment) => rowFromSegment(segment, nextKey())),
  source: () => store.timeSignatures,
});

/** Odd meters is an option of Detect, so it shares Detect's gate. */
const oddMetersBlocked = computed(() => firstBlock(detectBlocked.value));

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

/** Appends a row one bar after the last entry, inheriting its meter. */
function addRow(): void {
  const last = rows.value[rows.value.length - 1];
  rows.value = [
    ...rows.value,
    {
      key: nextKey(),
      position: nextBarPosition(last?.position),
      numerator: last?.numerator ?? '4',
      denominator: last?.denominator ?? '4',
      grouping: '',
    },
  ];
  dirty.value = true;
}

/**
 * Tracks beats and downbeats in the active audio clip and replaces the draft
 * with the resulting meter map (one segment per bar where the meter changes,
 * anchored at song start). The draft awaits review before Apply.
 */
function detectFromClip(): Promise<void> {
  return guardedDetect(async (clip, isCurrent) => {
    const segments = detectOddMeters.value
      ? await estimateActiveAudioClipMeter(clip.id, ODD_METER_CANDIDATES)
      : await detectActiveAudioClipTimeSignatures(clip.id, {
          maxNumerator: MAX_TIME_SIGNATURE_NUMERATOR,
        });
    if (!isCurrent()) return;
    if (segments.length === 0) {
      errors.value = [t.value.shell.lists.meter.noneDetected];
      return;
    }
    rows.value = segments.map((segment) => rowFromSegment(segment, nextKey()));
    dirty.value = true;
  });
}

/** Validates the draft and commits it as one undoable meter-map edit. */
function apply(): void {
  if (!dirty.value) return;
  const issues: string[] = [];
  const parsed: TimeSignatureSegment[] = [];
  rows.value.forEach((row, index) => {
    const startPpq = parseBarBeat(row.position, store.timeSignatures);
    if (startPpq === null) {
      issues.push(invalidPositionMessage(index, row.position));
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
  if (issues.length === 0) issues.push(...formatIssues(validateTimeSignatureRows(parsed)));
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
              class="cell-input cell-position"
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
              v-tooltip="t.shell.lists.common.deleteTitle"
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
        :disabled="!!detectBlocked"
        v-tooltip="{ text: t.shell.lists.meter.detectFromClipTitle, reason: detectBlocked }"
        @click="detectFromClip"
      >
        {{ t.shell.lists.meter.detectFromClip }}
      </button>
      <label
        class="option-check"
        :class="{ 'is-disabled': !!oddMetersBlocked }"
        v-tooltip="{ text: t.shell.lists.meter.oddMetersTitle, reason: oddMetersBlocked }"
      >
        <input v-model="detectOddMeters" type="checkbox" :disabled="!!oddMetersBlocked" />
        {{ t.shell.lists.meter.oddMeters }}
      </label>
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

<style scoped>
.cell-grouping {
  width: 7rem;
}

.option-check {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}

.option-check.is-disabled {
  color: var(--text-4);
}
</style>
