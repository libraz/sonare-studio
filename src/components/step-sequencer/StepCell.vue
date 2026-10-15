<script setup lang="ts">
import { formatMessage, useI18n } from '@/ui/i18n';
import type { PatternStep } from '@/ui/step-sequencer/pattern';

/**
 * One grid cell. A separate component so a playhead move re-renders only the
 * cells whose own props changed instead of rebuilding the whole grid. Pointer
 * and keyboard handling is delegated to the owning grid through the
 * `data-row` / `data-step` attributes.
 */

const props = defineProps<{
  /** The step's data (replaced, never mutated, on edit). */
  step: PatternStep;
  rowName: string;
  rowIndex: number;
  stepIndex: number;
  /** True on the first step of each beat group. */
  accent: boolean;
  /** True while the playhead is on this column. */
  playing: boolean;
  /** True for the grid's roving-tabindex cell. */
  current: boolean;
}>();

const { t } = useI18n();

function fillHeight(velocity: number): string {
  return `${Math.round((velocity / 127) * 100)}%`;
}
</script>

<template>
  <button
    type="button"
    role="gridcell"
    class="grid-cell"
    :class="{
      'cell-active': props.step.active,
      'cell-accent': props.accent,
      'cell-playing': props.playing,
    }"
    :data-row="props.rowIndex"
    :data-step="props.stepIndex"
    :data-step-grid-active="props.current"
    :tabindex="props.current ? 0 : -1"
    :aria-selected="props.current"
    :aria-label="
      formatMessage(t.shell.stepSequencer.accessibility.step, {
        row: props.rowName,
        step: props.stepIndex + 1,
        state: props.step.active
          ? t.shell.stepSequencer.accessibility.active
          : t.shell.stepSequencer.accessibility.inactive,
        velocity: props.step.velocity,
      })
    "
  >
    <span
      v-if="props.step.active"
      class="cell-fill"
      :style="{ height: fillHeight(props.step.velocity) }"
    />
  </button>
</template>
