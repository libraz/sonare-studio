<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  dbToFaderPosition,
  FADER_MAX_DB,
  FADER_MIN_DB,
  faderPositionToDb,
  formatDb,
} from '@/ui/mixer/db-scale';

/**
 * Vertical channel fader with a tapered dB scale (0 dB at 3/4 throw), a tick
 * column with an emphasized unity marker, double-click reset to 0 dB and
 * keyboard nudging (shift = fine). Like the knob, every value is emitted with
 * a commit flag so a drag coalesces into a single undo entry.
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

/** Coarse / fine keyboard nudge steps in dB. */
const NUDGE_DB = 1;
const FINE_NUDGE_DB = 0.1;

/** Scale ticks rendered next to the throw (dB). */
const TICK_DBS = [12, 6, 0, -6, -12, -24, -48] as const;

const trackEl = ref<HTMLDivElement | null>(null);
const dragging = ref(false);
let dragDb = 0;

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

function onPointerDown(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = true;
  dragDb = dbFromPointer(event);
  emit('change', dragDb, false);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return;
  dragDb = dbFromPointer(event);
  emit('change', dragDb, false);
}

function onPointerUp(): void {
  if (!dragging.value) return;
  dragging.value = false;
  emit('change', dragDb, true);
}

function onDoubleClick(): void {
  if (props.disabled) return;
  emit('change', 0, true);
}

function onKeyDown(event: KeyboardEvent): void {
  if (props.disabled) return;
  let direction: 1 | -1;
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') direction = 1;
  else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') direction = -1;
  else return;
  event.preventDefault();
  const step = event.shiftKey ? FINE_NUDGE_DB : NUDGE_DB;
  const next = Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, props.valueDb + direction * step));
  emit('change', next, true);
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
      aria-label="Strip gain"
      aria-orientation="vertical"
      :aria-valuemin="FADER_MIN_DB"
      :aria-valuemax="FADER_MAX_DB"
      :aria-valuenow="props.valueDb"
      :aria-valuetext="`${formatDb(props.valueDb)} dB`"
      :tabindex="props.disabled ? -1 : 0"
      :title="`Gain ${formatDb(props.valueDb)} dB`"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDoubleClick"
      @keydown="onKeyDown"
    >
      <span class="fader-groove" />
      <span class="fader-unity" :style="{ top: `${tickTopPx(0)}px` }" />
      <span class="fader-thumb" :style="{ top: `${thumbTopPx}px` }" />
    </div>
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
  font: 7px system-ui, sans-serif;
  color: #4a5160;
}

.fader-tick.unity {
  color: #9ca3af;
  font-weight: 700;
}

.fader-track {
  position: relative;
  width: 22px;
  flex: none;
  cursor: ns-resize;
  touch-action: none;
}

.fader-track:focus-visible {
  outline: 1px solid #60a5fa;
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
  background: #0b0d11;
  border: 1px solid #2a2e37;
}

.fader-unity {
  position: absolute;
  left: 2px;
  right: 2px;
  height: 1px;
  background: #3a4150;
  pointer-events: none;
}

.fader-thumb {
  position: absolute;
  left: 1px;
  right: 1px;
  height: 14px;
  margin-top: -7px;
  border-radius: 3px;
  background: linear-gradient(#343a47, #20242d);
  border: 1px solid #3a4150;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}

.fader-thumb::after {
  content: '';
  position: absolute;
  left: 2px;
  right: 2px;
  top: 50%;
  height: 1px;
  background: #9fc4f5;
}

.fader-track.dragging .fader-thumb {
  border-color: #60a5fa;
}
</style>
