<script setup lang="ts">
import { computed, ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { CLIP_EXPRESSION_CURVES, PIANO_ROLL_CC_LANES } from '@/project/midi-cc';
import type { ClipExpressionCurve } from '@/project/types';
import { useI18n } from '@/ui/i18n';
import { LANE_PARAMS } from './lane-params';

/**
 * Lane header column of the piano roll: the lane mode picker plus, for
 * expression lanes, the channel and curve pickers and the MPE limitation note.
 */

defineProps<{
  /** True when a note-parameter lane (not an expression lane) is shown. */
  noteLaneActive: boolean;
}>();

const laneMode = defineModel<string>('laneMode', { required: true });
const laneChannel = defineModel<number>('laneChannel', { required: true });
const laneCurve = defineModel<ClipExpressionCurve>('laneCurve', { required: true });

const { t } = useI18n();

/** The scrollable lane-parameter tab column on the left of the lane. */
const laneLabelColumn = ref<HTMLElement | null>(null);

/**
 * The editor root swallows wheel events for zoom/pan (it preventDefaults them),
 * which also blocks native scrolling of this overflowing tab column. When the
 * column can scroll, stop the event before it reaches the root so the browser
 * scrolls the column normally; otherwise let it bubble up to zoom as usual.
 */
function onLabelWheel(event: WheelEvent): void {
  const column = laneLabelColumn.value;
  if (!column || column.scrollHeight <= column.clientHeight) return;
  event.stopPropagation();
}

/** The 16 MIDI channel options for the CC-lane channel picker (0-based value). */
const laneChannelOptions = computed(() =>
  Array.from({ length: 16 }, (_, i) => ({
    value: i,
    label: `${t.value.shell.pianoRoll.laneChannelPrefix}${i + 1}`,
  })),
);

const laneCurveOptions = computed(() =>
  CLIP_EXPRESSION_CURVES.map((curve) => ({
    value: curve,
    label: t.value.shell.pianoRoll.expressionCurve[curve],
  })),
);

const laneModeOptions = computed(() => [
  ...LANE_PARAMS.map((laneSpec) => ({
    value: `note:${laneSpec.id}`,
    label: `${t.value.shell.pianoRoll.laneGroupNote} · ${laneSpec.label}`,
  })),
  ...PIANO_ROLL_CC_LANES.map((cc) => ({
    value: `cc:${cc.controller}`,
    label: `${t.value.shell.pianoRoll.laneGroupCc} · ${cc.label}`,
  })),
  {
    value: 'expr:bend',
    label: `${t.value.shell.pianoRoll.laneGroupExpression} · ${t.value.shell.pianoRoll.bendLaneTab}`,
  },
  {
    value: 'expr:pressure',
    label: `${t.value.shell.pianoRoll.laneGroupExpression} · ${t.value.shell.pianoRoll.pressureLaneTab}`,
  },
  {
    value: 'expr:poly-pressure',
    label: `${t.value.shell.pianoRoll.laneGroupExpression} · ${t.value.shell.pianoRoll.polyPressureLaneTab}`,
  },
]);
</script>

<template>
  <div
    ref="laneLabelColumn"
    class="cell-velocity-label"
    role="group"
    :aria-label="t.shell.pianoRoll.noteLaneParameter"
    @wheel="onLabelWheel"
  >
    <SelectMenu
      v-model="laneMode"
      class="lane-mode-select"
      size="sm"
      :options="laneModeOptions"
      :aria-label="t.shell.pianoRoll.noteLaneParameter"
    />
    <SelectMenu
      v-if="!noteLaneActive"
      v-model="laneChannel"
      class="lane-channel"
      size="sm"
      :options="laneChannelOptions"
      :aria-label="t.shell.pianoRoll.laneChannelTitle"
      :title="t.shell.pianoRoll.laneChannelTitle"
    />
    <SelectMenu
      v-if="!noteLaneActive"
      v-model="laneCurve"
      class="lane-curve"
      size="sm"
      :options="laneCurveOptions"
      :aria-label="t.shell.pianoRoll.expressionCurveTitle"
      :title="t.shell.pianoRoll.expressionCurveTitle"
    />
    <p v-if="!noteLaneActive" class="mpe-unsupported-note" role="note">
      {{ t.shell.pianoRoll.mpeUnsupported }}
    </p>
  </div>
</template>

<style scoped>
/* Keep the channel picker from stretching as a flex item in the lane column;
 * the frosted trigger carries its own surface, padding and typography. */
.lane-channel,
.lane-curve {
  flex: none;
  min-height: 0;
}

.lane-mode-select {
  flex: none;
  min-width: 0;
}

.mpe-unsupported-note {
  margin: 2px 3px;
  color: var(--text-3);
  font: var(--fs-2xs) var(--font-sans);
  line-height: 1.25;
}
</style>
