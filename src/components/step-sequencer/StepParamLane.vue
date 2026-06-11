<script setup lang="ts">
import { type CSSProperties, computed, ref } from 'vue';
import {
  isBipolarParam,
  paramRatio,
  paramValueForRatio,
  type StepParamKind,
} from '@/ui/step-sequencer/param-lane';
import type { PatternStep } from '@/ui/step-sequencer/pattern';

/**
 * Per-step parameter lane for the selected row: one draggable mini-bar per
 * step. Velocity and gate draw from the bottom; offset is bipolar and draws
 * from the center line. Dragging emits a value per pointer sample; the
 * pattern is session state, so no gesture coalescing is involved.
 */

const props = defineProps<{
  /** Steps of the selected row. */
  steps: PatternStep[];
  /** Parameter being edited. */
  param: StepParamKind;
}>();

const emit = defineEmits<{
  /** Sets the edited parameter on one step (already clamped). */
  'set-value': [stepIndex: number, value: number];
}>();

const lane = ref<HTMLDivElement | null>(null);

const bipolar = computed(() => isBipolarParam(props.param));

/** Bar geometry per step, in percent of the lane height. */
const bars = computed<CSSProperties[]>(() =>
  props.steps.map((step) => {
    const ratio = Math.min(1, Math.max(0, paramRatio(props.param, step)));
    if (!bipolar.value) return { bottom: '0%', height: `${ratio * 100}%` };
    const from = Math.min(0.5, ratio);
    return { bottom: `${from * 100}%`, height: `${Math.abs(ratio - 0.5) * 100}%` };
  }),
);

let dragging = false;

/** Emits the value under a pointer position; bails without layout (jsdom). */
function applyPointer(event: PointerEvent): void {
  const el = lane.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || props.steps.length === 0) return;
  const index = Math.min(
    props.steps.length - 1,
    Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * props.steps.length)),
  );
  const ratio = 1 - (event.clientY - rect.top) / rect.height;
  emit('set-value', index, paramValueForRatio(props.param, ratio));
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  dragging = true;
  const target = event.currentTarget as HTMLElement | null;
  if (target && typeof target.setPointerCapture === 'function') {
    target.setPointerCapture(event.pointerId);
  }
  applyPointer(event);
}

function onPointerMove(event: PointerEvent): void {
  if (dragging) applyPointer(event);
}

function onPointerUp(): void {
  dragging = false;
}
</script>

<template>
  <div
    ref="lane"
    class="param-lane"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div v-if="bipolar" class="lane-center-line" />
    <div class="lane-bars">
      <div
        v-for="(step, index) in props.steps"
        :key="index"
        class="bar-slot"
        :class="{ 'bar-inactive': !step.active }"
      >
        <div class="bar" :style="bars[index]" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.param-lane {
  position: relative;
  height: 72px;
  padding: 2px 4px;
  background: #14161b;
  border-top: 1px solid rgba(0, 0, 0, 0.4);
  touch-action: none;
  user-select: none;
  cursor: ns-resize;
}

.lane-center-line {
  position: absolute;
  left: 4px;
  right: 4px;
  top: 50%;
  border-top: 1px solid #2a2f39;
  pointer-events: none;
}

.lane-bars {
  display: flex;
  gap: 2px;
  height: 100%;
}

.bar-slot {
  position: relative;
  flex: 1;
  min-width: 8px;
}

.bar {
  position: absolute;
  left: 1px;
  right: 1px;
  background: #4f86d8;
  border-radius: 1px;
}

.bar-inactive .bar {
  background: #2e3542;
}
</style>
