<script setup lang="ts">
import { computed, ref } from 'vue';
import { applyDrag, type DragRange, nudgeValue } from '@/ui/mixer/drag';

/**
 * Rotary knob primitive: vertical pointer drag (shift = fine), keyboard
 * nudging and double-click reset. Emits every value with a commit flag so
 * callers can coalesce a whole drag into one undo entry — intermediate moves
 * arrive with commit=false, releasing the pointer (or any keyboard/reset
 * edit) commits.
 */

const props = withDefaults(
  defineProps<{
    /** Current value (controlled from outside). */
    value: number;
    /** Lower bound of the value range. */
    min: number;
    /** Upper bound of the value range. */
    max: number;
    /** Double-click reset target; omit to disable reset. */
    defaultValue?: number;
    /** Caption under the knob. */
    label?: string;
    /** Formatted value for the tooltip / aria text (defaults to the number). */
    display?: string;
    /** Knob diameter in px. */
    size?: number;
    /** Disables all interaction. */
    disabled?: boolean;
  }>(),
  { defaultValue: undefined, label: '', display: '', size: 26, disabled: false },
);

const emit = defineEmits<{
  /** New value; commit=false while dragging, true when the gesture ends. */
  change: [value: number, commit: boolean];
}>();

/** Knob rotation sweep in degrees (centered on 12 o'clock). */
const SWEEP_DEG = 270;

const dragging = ref(false);
let dragValue = 0;
let lastY = 0;

const range = computed<DragRange>(() => ({ min: props.min, max: props.max }));

/** Pointer angle for the current value (-135deg at min, +135deg at max). */
const angleDeg = computed(() => {
  const span = props.max - props.min;
  const norm = span > 0 ? (props.value - props.min) / span : 0;
  return (Math.min(1, Math.max(0, norm)) - 0.5) * SWEEP_DEG;
});

const displayText = computed(() => props.display || `${props.value}`);

function onPointerDown(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = true;
  dragValue = props.value;
  lastY = event.clientY;
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return;
  const deltaUp = lastY - event.clientY;
  lastY = event.clientY;
  if (deltaUp === 0) return;
  dragValue = applyDrag(dragValue, deltaUp, range.value, { fine: event.shiftKey });
  emit('change', dragValue, false);
}

function onPointerUp(): void {
  if (!dragging.value) return;
  dragging.value = false;
  emit('change', dragValue, true);
}

function onDoubleClick(): void {
  if (props.disabled || props.defaultValue === undefined) return;
  emit('change', props.defaultValue, true);
}

function onKeyDown(event: KeyboardEvent): void {
  if (props.disabled) return;
  let direction: 1 | -1;
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') direction = 1;
  else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') direction = -1;
  else return;
  event.preventDefault();
  emit('change', nudgeValue(props.value, range.value, direction, event.shiftKey), true);
}
</script>

<template>
  <div class="knob-wrap">
    <div
      class="knob"
      :class="{ disabled: props.disabled, dragging }"
      :style="{ width: `${props.size}px`, height: `${props.size}px` }"
      role="slider"
      :tabindex="props.disabled ? -1 : 0"
      :aria-label="props.label || 'Knob'"
      :aria-valuemin="props.min"
      :aria-valuemax="props.max"
      :aria-valuenow="props.value"
      :aria-valuetext="displayText"
      :title="`${props.label ? `${props.label} ` : ''}${displayText}`"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDoubleClick"
      @keydown="onKeyDown"
    >
      <span class="knob-pointer" :style="{ transform: `rotate(${angleDeg}deg)` }" />
    </div>
    <span v-if="props.label" class="knob-label">{{ props.label }}</span>
  </div>
</template>

<style scoped>
.knob-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}

.knob {
  position: relative;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #2c313c, #1a1d24 70%);
  border: 1px solid #2a2e37;
  cursor: ns-resize;
  touch-action: none;
  flex: none;
}

.knob:focus-visible {
  outline: 1px solid #60a5fa;
  outline-offset: 1px;
}

.knob.dragging {
  border-color: #60a5fa;
}

.knob.disabled {
  opacity: 0.4;
  cursor: default;
}

.knob-pointer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.knob-pointer::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 8%;
  width: 2px;
  height: 38%;
  margin-left: -1px;
  border-radius: 1px;
  background: #9fc4f5;
}

.knob-label {
  font: 8px system-ui, sans-serif;
  color: #5b6270;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  user-select: none;
}
</style>
