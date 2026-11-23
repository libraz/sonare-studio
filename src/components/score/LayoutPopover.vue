<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  DISPLAY_TRANSPOSE_MAX,
  DISPLAY_TRANSPOSE_MIN,
  SCORE_LAYOUT_BOUNDS,
  type ScoreLayoutNumberKey,
} from '@/project/annotations';
import { MAX_PITCH, MIN_PITCH } from '@/ui/canvas/timeline-range';
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
const orientationOptions = computed<
  ReadonlyArray<{ value: 'portrait' | 'landscape'; label: string }>
>(() => [
  { value: 'portrait', label: t.value.shell.score.portrait },
  { value: 'landscape', label: t.value.shell.score.landscape },
]);

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

/**
 * Numeric layout proxy for a `v-model.number` input. A blank or out-of-range
 * entry is not emitted, so the project only ever holds a value a reload keeps.
 */
function layoutNumberModel(key: ScoreLayoutNumberKey, update: (value: number) => void) {
  return computed<number>({
    get: () => props[key],
    set: (value) => {
      const { min, max, integer } = SCORE_LAYOUT_BOUNDS[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      if (value < min || value > max || (integer && !Number.isInteger(value))) return;
      update(value);
    },
  });
}

const pageMarginModel = layoutNumberModel('pageMarginMm', (value) =>
  emit('update:pageMarginMm', value),
);
const scaleModel = layoutNumberModel('scalePercent', (value) => emit('update:scalePercent', value));
const spacingModel = layoutNumberModel('spacingStaff', (value) =>
  emit('update:spacingStaff', value),
);
const barsPerSystemModel = layoutNumberModel('barsPerSystem', (value) =>
  emit('update:barsPerSystem', value),
);
const barsPerPageModel = layoutNumberModel('barsPerPage', (value) =>
  emit('update:barsPerPage', value),
);

const grandStaffSplitPitchModel = computed<number>({
  get: () => props.grandStaffSplitPitch,
  set: (value) => {
    if (Number.isInteger(value) && value >= MIN_PITCH && value <= MAX_PITCH) {
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
        :options="orientationOptions"
        :aria-label="t.shell.score.orientation"
        size="sm"
      />
    </label>
    <label class="layout-row">
      {{ t.shell.score.margin }}
      <input v-model.number="pageMarginModel" type="number" :min="SCORE_LAYOUT_BOUNDS.pageMarginMm.min" :max="SCORE_LAYOUT_BOUNDS.pageMarginMm.max" step="1" />
    </label>
    <label class="layout-row">
      {{ t.shell.score.scale }}
      <input v-model.number="scaleModel" type="number" :min="SCORE_LAYOUT_BOUNDS.scalePercent.min" :max="SCORE_LAYOUT_BOUNDS.scalePercent.max" step="5" />
    </label>
    <label class="layout-row">
      {{ t.shell.score.staffSpacing }}
      <input v-model.number="spacingModel" type="number" :min="SCORE_LAYOUT_BOUNDS.spacingStaff.min" :max="SCORE_LAYOUT_BOUNDS.spacingStaff.max" step="1" />
    </label>
    <label class="layout-row">
      {{ t.shell.score.barsPerSystem }}
      <input v-model.number="barsPerSystemModel" type="number" :min="SCORE_LAYOUT_BOUNDS.barsPerSystem.min" :max="SCORE_LAYOUT_BOUNDS.barsPerSystem.max" step="1" />
    </label>
    <label class="layout-row">
      {{ t.shell.score.barsPerPage }}
      <input v-model.number="barsPerPageModel" type="number" :min="SCORE_LAYOUT_BOUNDS.barsPerPage.min" :max="SCORE_LAYOUT_BOUNDS.barsPerPage.max" step="1" />
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
