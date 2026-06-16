<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  listQuickControls,
  type QuickControl,
  type QuickControlResolvers,
  type QuickControlTarget,
  setQuickControl,
} from '@/project/quick-controls';
import { formatControlValue, knobRotationDeg, knobValueForDrag } from '@/ui/devices/knob-math';

/**
 * Quick Controls: up to eight knobs for the selected device (instrument or
 * insert slot). Knob values come from the pure quick-control listing over the
 * store mirror; drags apply live values through setQuickControl with gesture
 * coalescing, so one knob drag lands as a single undo entry.
 */

const props = defineProps<{
  /** Device the knobs address (instrument or insert slot). */
  target: QuickControlTarget;
  /** Optional catalog resolvers (tests, custom catalogs). */
  resolvers?: QuickControlResolvers;
}>();

/** Surfaced when a control edit rejects. */
const error = ref('');

const controls = computed<QuickControl[]>(() => {
  try {
    return listQuickControls(props.target, props.resolvers);
  } catch {
    return [];
  }
});

/** Applies one control value through the undoable command layer. */
function apply(id: string, value: number, commit: boolean): void {
  try {
    setQuickControl(props.target, id, value, { commit });
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

// --- Knob dragging -----------------------------------------------------------

interface KnobDrag {
  id: string;
  pointerId: number;
  startY: number;
  startValue: number;
  lastValue: number;
  min: number;
  max: number;
  moved: boolean;
}

const drag = ref<KnobDrag | null>(null);

function onKnobPointerDown(control: QuickControl, event: PointerEvent): void {
  if (event.button !== 0) return;
  const el = event.currentTarget as HTMLElement;
  if (typeof el.setPointerCapture === 'function') el.setPointerCapture(event.pointerId);
  drag.value = {
    id: control.id,
    pointerId: event.pointerId,
    startY: event.clientY,
    startValue: control.value,
    lastValue: control.value,
    min: control.min,
    max: control.max,
    moved: false,
  };
}

function onKnobPointerMove(event: PointerEvent): void {
  const active = drag.value;
  if (!active || event.pointerId !== active.pointerId) return;
  const value = knobValueForDrag(
    active.startValue,
    event.clientY - active.startY,
    active.min,
    active.max,
    event.shiftKey,
  );
  if (value === active.lastValue) return;
  drag.value = { ...active, lastValue: value, moved: true };
  apply(active.id, value, false);
}

function onKnobPointerUp(event: PointerEvent): void {
  const active = drag.value;
  if (!active || event.pointerId !== active.pointerId) return;
  drag.value = null;
  // Closing the gesture with the final value lands the drag as one history
  // entry; a click without movement opened no gesture and commits a no-op.
  if (active.moved) apply(active.id, active.lastValue, true);
}

function onKnobPointerCancel(event: PointerEvent): void {
  onKnobPointerUp(event);
}

// --- Keyboard adjustment -----------------------------------------------------

/** Fraction of the range one arrow-key step moves. */
const KEY_STEP_FRACTION = 0.02;

function onKnobKeydown(control: QuickControl, event: KeyboardEvent): void {
  let direction = 0;
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') direction = 1;
  else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') direction = -1;
  else return;
  event.preventDefault();
  const scale = event.shiftKey ? KEY_STEP_FRACTION / 10 : KEY_STEP_FRACTION;
  const next = Math.min(
    control.max,
    Math.max(control.min, control.value + direction * (control.max - control.min) * scale),
  );
  if (next !== control.value) apply(control.id, next, true);
}
</script>

<template>
  <div class="quick-controls" aria-label="Quick controls">
    <p v-if="error" class="qc-error" role="alert">{{ error }}</p>
    <p v-if="controls.length === 0" class="qc-empty">No controls</p>
    <div v-else class="qc-grid">
      <div v-for="control in controls" :key="control.id" class="qc-cell">
        <div
          class="qc-knob"
          role="slider"
          tabindex="0"
          :data-control="control.id"
          :aria-label="control.name"
          :aria-valuemin="control.min"
          :aria-valuemax="control.max"
          :aria-valuenow="control.value"
          @pointerdown="onKnobPointerDown(control, $event)"
          @pointermove="onKnobPointerMove"
          @pointerup="onKnobPointerUp"
          @pointercancel="onKnobPointerCancel"
          @keydown="onKnobKeydown(control, $event)"
        >
          <div
            class="qc-knob-indicator"
            :style="{
              transform: `rotate(${knobRotationDeg(control.value, control.min, control.max)}deg)`,
            }"
          />
        </div>
        <span class="qc-name" :title="control.name">{{ control.name }}</span>
        <span class="qc-value">{{ formatControlValue(control.value, control.unit) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quick-controls {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.qc-error {
  margin: 0;
  padding: 2px 6px;
  background: var(--danger-surface);
  color: var(--danger-text);
  font: 10px/1.4 system-ui, sans-serif;
  border-radius: 3px;
}

.qc-empty {
  margin: 0;
  padding: 6px;
  color: var(--text-4);
  font: 11px system-ui, sans-serif;
}

.qc-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 4px;
  padding: 6px 2px;
}

.qc-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.qc-knob {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-full);
  background: radial-gradient(circle at 35% 30%, #2c313c, #1a1d24 70%);
  border: 1px solid var(--border);
  box-shadow: var(--inset-well);
  cursor: ns-resize;
  touch-action: none;
}

.qc-knob:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.qc-knob-indicator {
  position: absolute;
  inset: 0;
}

.qc-knob-indicator::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 3px;
  width: 2px;
  height: 11px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--accent);
}

.qc-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 600 9px system-ui, sans-serif;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.qc-value {
  font: 10px system-ui, sans-serif;
  color: var(--text-2);
}
</style>
