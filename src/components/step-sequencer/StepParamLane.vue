<script setup lang="ts">
import { type CSSProperties, computed, ref } from 'vue';
import { clamp, clamp01 } from '@/lib/math';
import {
  isBipolarParam,
  paramRatio,
  paramValueForRatio,
  type StepParamKind,
} from '@/ui/step-sequencer/param-lane';
import { MAX_GATE, MAX_OFFSET, MIN_GATE, type PatternStep } from '@/ui/step-sequencer/pattern';

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
  /** Localized full parameter name for slider semantics. */
  paramLabel: string;
  /** Localized word used before the one-based step number. */
  stepLabel: string;
}>();

const emit = defineEmits<{
  /** Sets the edited parameter on one step (already clamped). */
  'set-value': [stepIndex: number, value: number];
}>();

const lane = ref<HTMLDivElement | null>(null);
const stepControls = ref<HTMLElement[]>([]);
const activeStep = ref(0);
/** The lane's single tab stop: the last focused step, held inside a row that may have shrunk. */
const tabStop = computed(() => Math.min(activeStep.value, props.steps.length - 1));

const bipolar = computed(() => isBipolarParam(props.param));

/** Bar geometry per step, in percent of the lane height. */
const bars = computed<CSSProperties[]>(() =>
  props.steps.map((step) => {
    const ratio = clamp01(paramRatio(props.param, step));
    if (!bipolar.value) return { bottom: '0%', height: `${ratio * 100}%` };
    const from = Math.min(0.5, ratio);
    return { bottom: `${from * 100}%`, height: `${Math.abs(ratio - 0.5) * 100}%` };
  }),
);

let dragging = false;

function parameterBounds(): { min: number; max: number; step: number; page: number } {
  switch (props.param) {
    case 'velocity':
      return { min: 1, max: 127, step: 1, page: 10 };
    case 'gate':
      return { min: MIN_GATE, max: MAX_GATE, step: 0.05, page: 0.25 };
    case 'offset':
      return { min: -MAX_OFFSET, max: MAX_OFFSET, step: 0.01, page: 0.1 };
  }
}

function parameterValue(step: PatternStep): number {
  switch (props.param) {
    case 'velocity':
      return step.velocity;
    case 'gate':
      return step.gate;
    case 'offset':
      return step.offset;
  }
}

function parameterValueText(step: PatternStep): string {
  const value = parameterValue(step);
  if (props.param === 'velocity') return String(Math.round(value));
  if (props.param === 'gate') return `${Math.round(value * 100)}%`;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function setKeyboardValue(stepIndex: number, value: number): void {
  const { min, max } = parameterBounds();
  emit('set-value', stepIndex, clamp(value, min, max));
}

function focusStep(stepIndex: number): void {
  activeStep.value = stepIndex;
  stepControls.value[stepIndex]?.focus();
}

function onStepKeyDown(stepIndex: number, event: KeyboardEvent): void {
  const step = props.steps[stepIndex];
  if (!step) return;
  const { min, max, step: increment, page } = parameterBounds();
  switch (event.key) {
    case 'ArrowLeft':
      event.preventDefault();
      focusStep(Math.max(0, stepIndex - 1));
      return;
    case 'ArrowRight':
      event.preventDefault();
      focusStep(Math.min(props.steps.length - 1, stepIndex + 1));
      return;
    case 'ArrowDown':
      event.preventDefault();
      setKeyboardValue(stepIndex, parameterValue(step) - increment);
      return;
    case 'ArrowUp':
      event.preventDefault();
      setKeyboardValue(stepIndex, parameterValue(step) + increment);
      return;
    case 'PageDown':
      event.preventDefault();
      setKeyboardValue(stepIndex, parameterValue(step) - page);
      return;
    case 'PageUp':
      event.preventDefault();
      setKeyboardValue(stepIndex, parameterValue(step) + page);
      return;
    case 'Home':
      event.preventDefault();
      setKeyboardValue(stepIndex, min);
      return;
    case 'End':
      event.preventDefault();
      setKeyboardValue(stepIndex, max);
      return;
  }
}

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
    role="group"
    :aria-label="paramLabel"
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
        ref="stepControls"
        class="bar-slot"
        :class="{ 'bar-inactive': !step.active }"
        role="slider"
        aria-orientation="vertical"
        :tabindex="index === tabStop ? 0 : -1"
        :aria-label="`${paramLabel}, ${stepLabel} ${index + 1}`"
        :aria-valuemin="parameterBounds().min"
        :aria-valuemax="parameterBounds().max"
        :aria-valuenow="parameterValue(step)"
        :aria-valuetext="parameterValueText(step)"
        @focus="activeStep = index"
        @keydown="onStepKeyDown(index, $event)"
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
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-inset);
  border-top: 1px solid var(--border-strong);
  box-shadow: var(--inset-well);
  touch-action: none;
  user-select: none;
  cursor: ns-resize;
}

.param-lane:focus {
  outline: none;
}

/* Make the draggable editing surface legible to keyboard / focus users. */
.param-lane:focus-visible {
  box-shadow: var(--inset-well), var(--ring);
}

.lane-center-line {
  position: absolute;
  left: var(--sp-2);
  right: var(--sp-2);
  top: 50%;
  border-top: 1px solid var(--border);
  pointer-events: none;
}

.lane-bars {
  display: flex;
  gap: var(--sp-1);
  height: 100%;
}

.bar-slot {
  position: relative;
  flex: 1;
  min-width: var(--seq-cell-min);
}

.bar {
  position: absolute;
  left: 1px;
  right: 1px;
  background: var(--accent);
  border-radius: 1px;
  transition: background var(--dur-1) var(--ease-out);
}

/* Highlight the step under the cursor so the editable column is obvious. */
.bar-slot:hover .bar {
  background: var(--accent-hover);
}

.bar-inactive .bar {
  background: var(--surface-4);
}
</style>
