<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  dbToFaderPosition,
  FADER_MAX_DB,
  FADER_MIN_DB,
  faderPositionToDb,
  formatDb,
} from '@/ui/mixer/db-scale';
import { FINE_FACTOR } from '@/ui/mixer/drag';
import { useControlInteractions } from '@/ui/mixer/use-control-interactions';

/**
 * Vertical channel fader with a tapered dB scale (0 dB at 3/4 throw), a tick
 * column with an emphasized unity marker, click-anywhere jump, shift-drag fine
 * adjust, mouse-wheel adjust, double-click reset to 0 dB, keyboard nudging and
 * a right-click menu (reset / copy / paste). Like the knob, every value is
 * emitted with a commit flag so a drag coalesces into a single undo entry.
 */

const props = withDefaults(
  defineProps<{
    /** Current gain in dB (controlled from outside). */
    valueDb: number;
    /** Fader throw height in px. */
    height?: number;
    /** Disables all interaction. */
    disabled?: boolean;
  }>(),
  { height: 132, disabled: false },
);

const emit = defineEmits<{
  /** New gain in dB; commit=false while dragging, true at gesture end. */
  change: [db: number, commit: boolean];
}>();

const { t } = useI18n();

/** Coarse / fine keyboard + wheel nudge steps in dB. */
const NUDGE_DB = 1;
const FINE_NUDGE_DB = 0.1;

/** Scale ticks rendered next to the throw (dB). */
const TICK_DBS = [12, 6, 0, -6, -12, -24, -48] as const;

const trackEl = ref<HTMLDivElement | null>(null);
const dragging = ref(false);
let dragDb = 0;
let lastY = 0;
let relativeGrab = false;

/** Thumb center offset from the top of the throw, in px. */
const thumbTopPx = computed(() => (1 - dbToFaderPosition(props.valueDb)) * props.height);

/** Converts a pointer event into a dB value via the throw geometry. */
function dbFromPointer(event: PointerEvent): number {
  const track = trackEl.value;
  if (!track) return props.valueDb;
  const rect = track.getBoundingClientRect();
  const position = 1 - (event.clientY - rect.top) / rect.height;
  return faderPositionToDb(position);
}

/** Clamps a dB value to the fader range. */
function clampDb(db: number): number {
  return Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, db));
}

/** Nudges the gain by one step in the given direction (commit). */
function nudge(direction: 1 | -1, fine: boolean): void {
  if (props.disabled) return;
  const step = fine ? FINE_NUDGE_DB : NUDGE_DB;
  emit('change', clampDb(props.valueDb + direction * step), true);
}

const interactions = useControlInteractions({
  getValue: () => props.valueDb,
  getRange: () => ({ min: FADER_MIN_DB, max: FADER_MAX_DB }),
  commit: (value) => emit('change', value, true),
  nudge,
  getDefault: () => 0,
  isDisabled: () => props.disabled,
});

function onPointerDown(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = true;
  relativeGrab = event.target instanceof Element && event.target.closest('.fader-thumb') !== null;
  dragDb = relativeGrab ? props.valueDb : dbFromPointer(event);
  lastY = event.clientY;
  if (!relativeGrab) emit('change', dragDb, false);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return;
  if (relativeGrab || event.shiftKey) {
    // Fine drag: move relative to the current value in tapered position space.
    const deltaUp = lastY - event.clientY;
    const position = dbToFaderPosition(dragDb) + (deltaUp / props.height) * FINE_FACTOR;
    dragDb = faderPositionToDb(Math.min(1, Math.max(0, position)));
  } else {
    dragDb = dbFromPointer(event);
  }
  lastY = event.clientY;
  emit('change', dragDb, false);
}

function onPointerUp(): void {
  if (!dragging.value) return;
  dragging.value = false;
  relativeGrab = false;
  emit('change', dragDb, true);
}

function onDoubleClick(): void {
  if (props.disabled) return;
  emit('change', 0, true);
}

function onKeyDown(event: KeyboardEvent): void {
  if (props.disabled) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') nudge(1, event.shiftKey);
  else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') nudge(-1, event.shiftKey);
  else return;
  event.preventDefault();
}

/** Tick offset from the top of the throw, in px. */
function tickTopPx(db: number): number {
  return (1 - dbToFaderPosition(db)) * props.height;
}
</script>

<template>
  <div class="fader" :style="{ height: `${props.height}px` }">
    <div class="fader-scale" aria-hidden="true">
      <span
        v-for="db in TICK_DBS"
        :key="db"
        class="fader-tick"
        :class="{ unity: db === 0 }"
        :style="{ top: `${tickTopPx(db)}px` }"
      >
        {{ db === 0 ? '0' : `${db > 0 ? '+' : ''}${db}` }}
      </span>
    </div>
    <div
      ref="trackEl"
      class="fader-track"
      :class="{ disabled: props.disabled, dragging }"
      role="slider"
      :aria-label="t.shell.mixer.controls.stripGain"
      aria-orientation="vertical"
      :aria-valuemin="FADER_MIN_DB"
      :aria-valuemax="FADER_MAX_DB"
      :aria-valuenow="props.valueDb"
      :aria-valuetext="`${formatDb(props.valueDb)} dB`"
      :tabindex="props.disabled ? -1 : 0"
      v-tooltip="formatMessage(t.shell.mixer.controls.gainTitle, { value: formatDb(props.valueDb) })"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDoubleClick"
      @wheel="interactions.onWheel"
      @contextmenu.stop.prevent="interactions.onContextMenu"
      @keydown="onKeyDown"
    >
      <span class="fader-groove" />
      <span class="fader-unity" :style="{ top: `${tickTopPx(0)}px` }" />
      <span class="fader-thumb" :style="{ top: `${thumbTopPx}px` }" />
    </div>
    <Transition name="pop">
    <div
      v-if="interactions.menu.open"
      class="control-menu"
      :style="{ left: `${interactions.menu.x}px`, top: `${interactions.menu.y}px` }"
      role="menu"
    >
      <button type="button" role="menuitem" @click="interactions.resetToDefault">
        {{ t.shell.mixer.controls.resetToZero }}
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
    </div>
    </Transition>
  </div>
</template>

<style scoped>
.fader {
  display: flex;
  align-items: stretch;
  gap: 2px;
}

.fader-scale {
  position: relative;
  width: 18px;
  flex: none;
  user-select: none;
}

.fader-tick {
  position: absolute;
  right: 0;
  transform: translateY(-50%);
  font: var(--fs-chrome-sm) var(--font-sans);
  color: var(--text-4);
}

.fader-tick.unity {
  color: var(--text-3);
  font-weight: var(--fw-bold);
}

.fader-track {
  position: relative;
  width: 22px;
  flex: none;
  cursor: ns-resize;
  touch-action: none;
}

.fader-track:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.fader-track.disabled {
  opacity: 0.4;
  cursor: default;
}

.fader-groove {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 3px;
  margin-left: -1.5px;
  border-radius: 2px;
  background: var(--surface-0);
  border: 1px solid var(--border);
  box-shadow: var(--inset-well);
}

.fader-unity {
  position: absolute;
  left: 2px;
  right: 2px;
  height: 1px;
  background: var(--border-raised);
  pointer-events: none;
}

.fader-thumb {
  position: absolute;
  left: 1px;
  right: 1px;
  height: 14px;
  margin-top: -7px;
  border-radius: 3px;
  background: linear-gradient(var(--surface-4), var(--surface-2));
  border: 1px solid var(--border-raised);
  box-shadow:
    var(--shadow-1),
    var(--raise-hi);
  pointer-events: none;
  transition: border-color var(--dur-1) var(--ease-out);
}

.fader-thumb::after {
  content: '';
  position: absolute;
  left: 2px;
  right: 2px;
  top: 50%;
  height: 1px;
  background: var(--accent);
}

.fader-track.dragging .fader-thumb {
  border-color: var(--accent);
}
</style>
