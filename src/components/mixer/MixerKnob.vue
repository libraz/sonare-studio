<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '@/ui/i18n';
import { DEFAULT_DRAG_PIXELS, type DragRange, FINE_FACTOR, NUDGE_DIVISIONS } from '@/ui/mixer/drag';
import { useControlInteractions } from '@/ui/mixer/use-control-interactions';

/**
 * Rotary knob primitive: vertical pointer drag (shift = fine), mouse-wheel
 * adjust, keyboard nudging, double-click reset and a right-click menu (reset /
 * copy / paste). Position math runs in a normalized [0, 1] space so the same
 * control serves linear ranges and logarithmic (e.g. frequency) ranges. Emits
 * every value with a commit flag so callers coalesce a whole drag into one undo
 * entry — intermediate moves arrive with commit=false, the gesture end commits.
 */

const props = withDefaults(
  defineProps<{
    /** Current value (controlled from outside). */
    value: number;
    /** Lower bound of the value range. */
    min: number;
    /** Upper bound of the value range. */
    max: number;
    /** Value mapping across the knob travel. Log requires min > 0. */
    scale?: 'linear' | 'log';
    /** Double-click / menu reset target; omit to disable reset. */
    defaultValue?: number;
    /** Caption under the knob (also used as the slider aria-label). */
    label?: string;
    /** Slider aria-label when no visible caption is wanted (overrides label). */
    ariaLabel?: string;
    /** Formatted value for the tooltip / aria text (defaults to the number). */
    display?: string;
    /** Knob diameter in px. */
    size?: number;
    /** Disables all interaction. */
    disabled?: boolean;
    /**
     * MIDI-learn affordance shown in the right-click menu: 'unbound' offers
     * "MIDI Learn", 'armed' shows it listening, 'bound' adds a "Forget"
     * action. Omit to hide the affordance (the control is not learnable).
     */
    midiLearnState?: 'unbound' | 'armed' | 'bound';
  }>(),
  {
    scale: 'linear',
    defaultValue: undefined,
    label: '',
    ariaLabel: '',
    display: '',
    size: 26,
    disabled: false,
    midiLearnState: undefined,
  },
);

const emit = defineEmits<{
  /** New value; commit=false while dragging, true when the gesture ends. */
  change: [value: number, commit: boolean];
  /** Menu action: arm (or cancel) MIDI learn for this control. */
  midiLearn: [];
  /** Menu action: forget this control's MIDI binding. */
  midiForget: [];
}>();

const { t } = useI18n();

/** Knob rotation sweep in degrees (centered on 12 o'clock). */
const SWEEP_DEG = 270;

const dragging = ref(false);
let dragNorm = 0;
let lastY = 0;

const range = computed<DragRange>(() => ({ min: props.min, max: props.max }));

/** Maps a value to its normalized [0, 1] position under the active scale. */
function toNorm(value: number): number {
  const span = props.max - props.min;
  if (props.scale === 'log' && props.min > 0 && props.max > props.min) {
    return Math.log(Math.max(props.min, value) / props.min) / Math.log(props.max / props.min);
  }
  return span > 0 ? (value - props.min) / span : 0;
}

/** Maps a normalized [0, 1] position back to a value under the active scale. */
function fromNorm(norm: number): number {
  const n = Math.min(1, Math.max(0, norm));
  if (props.scale === 'log' && props.min > 0 && props.max > props.min) {
    return props.min * (props.max / props.min) ** n;
  }
  return props.min + n * (props.max - props.min);
}

/** Pointer angle for the current value (-135deg at min, +135deg at max). */
const angleDeg = computed(() => (Math.min(1, Math.max(0, toNorm(props.value))) - 0.5) * SWEEP_DEG);

const displayText = computed(() => props.display || `${props.value}`);

/** Nudges the value by one normalized step in the given direction (commit). */
function nudge(direction: 1 | -1, fine: boolean): void {
  if (props.disabled) return;
  const step = (fine ? FINE_FACTOR : 1) / NUDGE_DIVISIONS;
  emit('change', fromNorm(toNorm(props.value) + direction * step), true);
}

const interactions = useControlInteractions({
  getValue: () => props.value,
  getRange: () => range.value,
  commit: (value) => emit('change', value, true),
  nudge,
  getDefault: () => props.defaultValue,
  isDisabled: () => props.disabled,
});

function onPointerDown(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = true;
  dragNorm = toNorm(props.value);
  lastY = event.clientY;
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return;
  const deltaUp = lastY - event.clientY;
  lastY = event.clientY;
  if (deltaUp === 0) return;
  const factor = event.shiftKey ? FINE_FACTOR : 1;
  dragNorm = Math.min(1, Math.max(0, dragNorm + (deltaUp / DEFAULT_DRAG_PIXELS) * factor));
  emit('change', fromNorm(dragNorm), false);
}

function onPointerUp(): void {
  if (!dragging.value) return;
  dragging.value = false;
  emit('change', fromNorm(dragNorm), true);
}

function onDoubleClick(): void {
  if (props.disabled || props.defaultValue === undefined) return;
  emit('change', props.defaultValue, true);
}

function onKeyDown(event: KeyboardEvent): void {
  if (props.disabled) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') nudge(1, event.shiftKey);
  else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') nudge(-1, event.shiftKey);
  else return;
  event.preventDefault();
}

/** Menu action: toggle MIDI-learn arming for this control. */
function onMidiLearn(): void {
  emit('midiLearn');
  interactions.closeMenu();
}

/** Menu action: forget this control's MIDI binding. */
function onMidiForget(): void {
  emit('midiForget');
  interactions.closeMenu();
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
      :aria-label="props.ariaLabel || props.label || t.shell.mixer.controls.knob"
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
      @wheel="interactions.onWheel"
      @contextmenu.stop.prevent="interactions.onContextMenu"
      @keydown="onKeyDown"
    >
      <span class="knob-pointer" :style="{ transform: `rotate(${angleDeg}deg)` }" />
    </div>
    <span v-if="props.label" class="knob-label">{{ props.label }}</span>
    <div
      v-if="interactions.menu.open"
      class="control-menu"
      :style="{ left: `${interactions.menu.x}px`, top: `${interactions.menu.y}px` }"
      role="menu"
    >
      <button
        v-if="interactions.canReset()"
        type="button"
        role="menuitem"
        @click="interactions.resetToDefault"
      >
        {{ t.shell.mixer.controls.reset }}
      </button>
      <button type="button" role="menuitem" @click="interactions.copyValue">
        {{ t.shell.mixer.controls.copyValue }}
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="!interactions.canPaste()"
        @click="interactions.pasteValue"
      >
        {{ t.shell.mixer.controls.pasteValue }}
      </button>
      <button
        v-if="props.midiLearnState"
        type="button"
        role="menuitem"
        :class="{ 'menu-armed': props.midiLearnState === 'armed' }"
        @click="onMidiLearn"
      >
        {{
          props.midiLearnState === 'armed'
            ? t.shell.mixer.controls.midiLearnListening
            : t.shell.mixer.controls.midiLearn
        }}
      </button>
      <button
        v-if="props.midiLearnState === 'bound'"
        type="button"
        role="menuitem"
        @click="onMidiForget"
      >
        {{ t.shell.mixer.controls.midiForget }}
      </button>
    </div>
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
  background: radial-gradient(circle at 35% 30%, var(--surface-4), var(--surface-2) 72%);
  border: 1px solid var(--border);
  box-shadow: var(--raise-hi);
  cursor: ns-resize;
  touch-action: none;
  flex: none;
  transition: border-color var(--dur-1) var(--ease-out);
}

.knob:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.knob.dragging {
  border-color: var(--accent);
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
  background: var(--accent);
}

.knob-label {
  font: var(--fw-normal) 8px var(--font-sans);
  color: var(--text-4);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  user-select: none;
}

.menu-armed {
  color: var(--accent);
}
</style>
