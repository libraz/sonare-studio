<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { DISPLAY_TRANSPOSE_MAX, DISPLAY_TRANSPOSE_MIN } from '@/project/annotations';
import { useI18n } from '@/ui/i18n';
import { SCORE_PAGE_FORMATS, type ScorePageFormatKey } from '@/ui/score/layout';

/**
 * Layout popover for the engraved score: page format, orientation, margins,
 * rendering scale, staff spacing and engraving-only display transpose. Layout
 * settings are exposed as v-model bindings; the display transpose is reported
 * through `transpose-change` so the owner can route it to its command.
 */

const props = defineProps<{
  pageFormat: ScorePageFormatKey;
  landscape: boolean;
  pageMarginMm: number;
  scalePercent: number;
  spacingStaff: number;
  barsPerSystem: number;
  barsPerPage: number;
  grandStaffSplitPitch: number;
  /** Current display transpose in semitones (driven by the project store). */
  transpose: number;
}>();

const emit = defineEmits<{
  'update:pageFormat': [value: ScorePageFormatKey];
  'update:landscape': [value: boolean];
  'update:pageMarginMm': [value: number];
  'update:scalePercent': [value: number];
  'update:spacingStaff': [value: number];
  'update:barsPerSystem': [value: number];
  'update:barsPerPage': [value: number];
  'update:grandStaffSplitPitch': [value: number];
  /** Requests a display transpose change in semitones. */
  transposeChange: [value: number];
}>();

const { t } = useI18n();

/** Display transpose choices offered in the popover (semitones). */
const TRANSPOSE_CHOICES: ReadonlyArray<number> = Array.from(
  { length: DISPLAY_TRANSPOSE_MAX - DISPLAY_TRANSPOSE_MIN + 1 },
  (_, i) => DISPLAY_TRANSPOSE_MIN + i,
);

/** Page format options for the layout popover select. */
const pageFormatOptions = computed(() =>
  Object.entries(SCORE_PAGE_FORMATS).map(([key, format]) => ({ value: key, label: format.label })),
);

/** Orientation options; values mirror the boolean `landscape` flag. */
const ORIENTATION_OPTIONS: ReadonlyArray<{ value: 'portrait' | 'landscape'; label: string }> = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];

/** String proxy over the boolean `landscape` flag for the select binding. */
const orientation = computed<'portrait' | 'landscape'>({
  get: () => (props.landscape ? 'landscape' : 'portrait'),
  set: (value) => emit('update:landscape', value === 'landscape'),
});

/** Page format proxy bridging the typed key to the select binding. */
const pageFormatModel = computed<ScorePageFormatKey>({
  get: () => props.pageFormat,
  set: (value) => emit('update:pageFormat', value),
});

/** Margin proxy for the numeric input binding. */
const pageMarginModel = computed<number>({
  get: () => props.pageMarginMm,
  set: (value) => emit('update:pageMarginMm', value),
});

/** Scale proxy for the numeric input binding. */
const scaleModel = computed<number>({
  get: () => props.scalePercent,
  set: (value) => emit('update:scalePercent', value),
});

/** Staff spacing proxy for the numeric input binding. */
const spacingModel = computed<number>({
  get: () => props.spacingStaff,
  set: (value) => emit('update:spacingStaff', value),
});

const barsPerSystemModel = computed<number>({
  get: () => props.barsPerSystem,
  set: (value) => emit('update:barsPerSystem', value),
});

const barsPerPageModel = computed<number>({
  get: () => props.barsPerPage,
  set: (value) => emit('update:barsPerPage', value),
});

const grandStaffSplitPitchModel = computed<number>({
  get: () => props.grandStaffSplitPitch,
  set: (value) => {
    if (Number.isInteger(value) && value >= 0 && value <= 127) {
      emit('update:grandStaffSplitPitch', value);
    }
  },
});

/** Display transpose options for the popover select (semitones). */
const transposeOptions = computed(() =>
  TRANSPOSE_CHOICES.map((n) => ({ value: n, label: n > 0 ? `+${n}` : String(n) })),
);
</script>

<template>
  <div class="layout-popover">
    <label class="layout-row">
      {{ t.shell.score.page }}
      <SelectMenu
        v-model="pageFormatModel"
        :options="pageFormatOptions"
        :aria-label="t.shell.score.pageFormat"
        size="sm"
      />
    </label>
    <label class="layout-row">
      {{ t.shell.score.orientation }}
      <SelectMenu
        v-model="orientation"
        :options="ORIENTATION_OPTIONS"
        :aria-label="t.shell.score.orientation"
        size="sm"
      />
    </label>
    <label class="layout-row">
      {{ t.shell.score.margin }}
      <input v-model.number="pageMarginModel" type="number" min="0" max="40" step="1" />
    </label>
    <label class="layout-row">
      {{ t.shell.score.scale }}
      <input v-model.number="scaleModel" type="number" min="20" max="100" step="5" />
    </label>
    <label class="layout-row">
      {{ t.shell.score.staffSpacing }}
      <input v-model.number="spacingModel" type="number" min="0" max="48" step="1" />
    </label>
    <label class="layout-row">
      {{ t.shell.score.barsPerSystem }}
      <input v-model.number="barsPerSystemModel" type="number" min="0" max="12" step="1" />
    </label>
    <label class="layout-row">
      {{ t.shell.score.barsPerPage }}
      <input v-model.number="barsPerPageModel" type="number" min="0" max="48" step="1" />
    </label>
    <label class="layout-row" v-tooltip="t.shell.score.grandStaffSplitTitle">
      {{ t.shell.score.grandStaffSplit }}
      <input v-model.number="grandStaffSplitPitchModel" type="number" min="0" max="127" step="1" />
    </label>
    <label
      class="layout-row"
      v-tooltip="t.shell.score.transposeTitle"
    >
      {{ t.shell.score.transpose }}
      <SelectMenu
        :model-value="transpose"
        :options="transposeOptions"
        :aria-label="t.shell.score.displayTranspose"
        size="sm"
        @change="emit('transposeChange', $event)"
      />
    </label>
  </div>
</template>

<style scoped src="./layout-popover.css"></style>
