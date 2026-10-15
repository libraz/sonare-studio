<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { clamp } from '@/lib/math';
import { formatMessage, useI18n } from '@/ui/i18n';
import { clampVelocity, type StepPattern } from '@/ui/step-sequencer/pattern';
import { isTripletResolution } from '@/ui/step-sequencer/timing';
import StepCell from './StepCell.vue';

/**
 * The step grid: one row per lane, one cell per step. Left-click toggles a
 * step and dragging paints the toggled state across cells; right-drag
 * erases. Per-step velocity is shown as the cell's fill height. The grid is
 * purely presentational: every edit is emitted to the owning component.
 */

const props = defineProps<{
  /** Pattern to display. */
  pattern: StepPattern;
  /** Index of the row whose parameters are edited in the lane below. */
  selectedRow: number;
  /** Step under the transport playhead, or null when not playing through it. */
  playingStep?: number | null;
}>();

const emit = defineEmits<{
  /** Sets one step's active flag. */
  'set-step': [rowIndex: number, stepIndex: number, active: boolean];
  /** Selects a row for parameter editing / row operations. */
  'select-row': [rowIndex: number];
  /** Sets the velocity of one step from the accessible slider/keyboard path. */
  'set-velocity': [rowIndex: number, stepIndex: number, velocity: number];
}>();

const { t } = useI18n();

/** Steps per accent group (beat shading): 3 on triplet grids, else 4. */
const groupSize = computed(() => (isTripletResolution(props.pattern.resolution) ? 3 : 4));
const activeRow = ref(Math.max(0, props.selectedRow));
const activeStep = ref(0);
const liveStatus = ref('');
const gridRoot = ref<HTMLElement | null>(null);

const activeCell = computed(() => props.pattern.rows[activeRow.value]?.steps[activeStep.value]);
const activeCellLabel = computed(() => {
  const row = props.pattern.rows[activeRow.value];
  const step = row?.steps[activeStep.value];
  if (!row || !step) return t.value.shell.stepSequencer.accessibility.empty;
  return formatMessage(t.value.shell.stepSequencer.accessibility.step, {
    row: row.name,
    step: activeStep.value + 1,
    state: step.active
      ? t.value.shell.stepSequencer.accessibility.active
      : t.value.shell.stepSequencer.accessibility.inactive,
    velocity: step.velocity,
  });
});

/** Active paint drag: the value applied to every cell entered. */
let paint: { value: boolean } | null = null;

/** Resolves the cell coordinates from a grid cell element, if any. */
function cellFromElement(element: Element | null): { row: number; step: number } | null {
  const cell = element?.closest<HTMLElement>('[data-step]');
  if (!cell) return null;
  const row = Number(cell.dataset.row);
  const step = Number(cell.dataset.step);
  if (!Number.isInteger(row) || !Number.isInteger(step)) return null;
  return { row, step };
}

/** Applies the current paint value to a cell when it differs. */
function paintCell(row: number, step: number): void {
  if (!paint) return;
  const current = props.pattern.rows[row]?.steps[step];
  if (!current || current.active === paint.value) return;
  emit('set-step', row, step, paint.value);
}

function onPointerDown(event: PointerEvent): void {
  const cell = cellFromElement(event.target as Element | null);
  if (!cell) return;
  const erase = event.button === 2;
  const current = props.pattern.rows[cell.row]?.steps[cell.step];
  if (!current) return;
  paint = { value: erase ? false : !current.active };
  emit('select-row', cell.row);
  paintCell(cell.row, cell.step);
  const target = event.currentTarget as HTMLElement | null;
  // Pointer capture keeps move/up events flowing during fast drags; jsdom
  // (tests) does not implement it.
  if (target && typeof target.setPointerCapture === 'function') {
    target.setPointerCapture(event.pointerId);
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!paint) return;
  // With pointer capture the event target stays the grid, so hit-test the
  // cell under the cursor instead.
  const element =
    typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;
  const cell = cellFromElement(element);
  if (cell) paintCell(cell.row, cell.step);
}

function onPointerUp(): void {
  paint = null;
}

function setActiveCell(row: number, step: number, focus = false): void {
  activeRow.value = clamp(row, 0, props.pattern.rows.length - 1);
  activeStep.value = clamp(step, 0, props.pattern.stepCount - 1);
  emit('select-row', activeRow.value);
  liveStatus.value = activeCellLabel.value;
  if (focus) {
    void nextTick(() => {
      gridRoot.value
        ?.querySelector<HTMLElement>(
          `[data-step-grid-active="true"][data-row="${activeRow.value}"][data-step="${activeStep.value}"]`,
        )
        ?.focus();
    });
  }
}

function onGridFocusIn(event: FocusEvent): void {
  const cell = cellFromElement(event.target as Element | null);
  if (cell) onCellFocus(cell.row, cell.step);
}

function onGridKeyDown(event: KeyboardEvent): void {
  const cell = cellFromElement(event.target as Element | null);
  if (cell) onCellKeyDown(event, cell.row, cell.step);
}

function onCellFocus(row: number, step: number): void {
  if (row === activeRow.value && step === activeStep.value) return;
  setActiveCell(row, step);
}

function onCellKeyDown(event: KeyboardEvent, row: number, step: number): void {
  if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && event.shiftKey) {
    const current = props.pattern.rows[row]?.steps[step];
    if (!current) return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? 1 : -1;
    const velocity = clampVelocity(current.velocity + delta * (event.altKey ? 8 : 1));
    emit('set-velocity', row, step, velocity);
    liveStatus.value = formatMessage(t.value.shell.stepSequencer.accessibility.velocityChanged, {
      velocity,
    });
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    setActiveCell(row, step + (event.key === 'ArrowLeft' ? -1 : 1), true);
    return;
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    setActiveCell(row + (event.key === 'ArrowUp' ? -1 : 1), step, true);
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    setActiveCell(row, event.key === 'Home' ? 0 : props.pattern.stepCount - 1, true);
    return;
  }
  if (event.key === ' ' || event.key === 'Enter') {
    const current = props.pattern.rows[row]?.steps[step];
    if (!current) return;
    event.preventDefault();
    emit('select-row', row);
    emit('set-step', row, step, !current.active);
    liveStatus.value = formatMessage(t.value.shell.stepSequencer.accessibility.toggled, {
      state: current.active
        ? t.value.shell.stepSequencer.accessibility.inactive
        : t.value.shell.stepSequencer.accessibility.active,
    });
    return;
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    emit('select-row', row);
    liveStatus.value = t.value.shell.stepSequencer.accessibility.rowControls;
  }
}

function onVelocityInput(event: Event): void {
  const velocity = clampVelocity(Number((event.target as HTMLInputElement).value));
  emit('set-velocity', activeRow.value, activeStep.value, velocity);
  liveStatus.value = formatMessage(t.value.shell.stepSequencer.accessibility.velocityChanged, {
    velocity,
  });
}

watch(
  () => props.selectedRow,
  (row) => {
    activeRow.value = clamp(row, 0, props.pattern.rows.length - 1);
  },
);
</script>

<template>
  <div class="step-grid-wrap">
    <div
      ref="gridRoot"
      class="step-grid"
      role="grid"
      :aria-label="t.shell.stepSequencer.accessibility.grid"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @focusin="onGridFocusIn"
      @keydown="onGridKeyDown"
      @contextmenu.prevent
    >
      <div
        v-for="(row, rowIndex) in props.pattern.rows"
        :key="`${row.pitch}-${rowIndex}`"
        class="grid-row"
        role="row"
        :class="{ 'row-selected': rowIndex === props.selectedRow, 'row-muted': row.muted }"
      >
        <button
          type="button"
          role="rowheader"
          class="row-label"
          v-tooltip="`${row.name} (${row.pitch})`"
          @click="emit('select-row', rowIndex)"
        >
          <span class="row-name">{{ row.name }}</span>
          <svg v-if="row.muted" class="row-mute-flag" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 6h2.5L8 3v10L4.5 10H2z" />
            <path class="row-mute-slash" d="M11 5l4 6m0-6l-4 6" />
          </svg>
        </button>
        <div class="row-cells" role="presentation">
          <StepCell
            v-for="(step, stepIndex) in row.steps"
            :key="stepIndex"
            :step="step"
            :row-name="row.name"
            :row-index="rowIndex"
            :step-index="stepIndex"
            :accent="stepIndex % groupSize === 0"
            :playing="stepIndex === props.playingStep"
            :current="rowIndex === activeRow && stepIndex === activeStep"
          />
        </div>
      </div>
    </div>
    <label v-if="activeCell" class="step-velocity-accessible">
      <span>{{ t.shell.stepSequencer.accessibility.velocity }}</span>
      <input
        type="range"
        min="1"
        max="127"
        step="1"
        :value="activeCell.velocity"
        :aria-valuetext="String(activeCell.velocity)"
        @input="onVelocityInput"
      />
    </label>
    <div class="step-grid-live" role="status" aria-live="polite" aria-atomic="true">
      {{ liveStatus }}
    </div>
  </div>
</template>

<style scoped>
.step-grid-wrap {
  position: relative;
}

.step-grid {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2);
  background: var(--surface-1);
  touch-action: none;
  user-select: none;
}

.grid-row {
  display: flex;
  align-items: stretch;
  gap: var(--sp-2);
  min-height: 22px;
}

.row-label {
  flex: none;
  width: var(--seq-row-label-w);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 0 var(--sp-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-3);
  font: var(--fs-xs)/1.2 var(--font-sans);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: background var(--dur-1) var(--ease-out), color var(--dur-1) var(--ease-out);
}

.row-selected .row-label {
  border-color: var(--border);
  background: var(--surface-4);
  color: var(--text-1);
}

.row-muted .row-label {
  color: var(--text-4);
}

.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Muted-lane affordance: a speaker-slash glyph tinted with the warning token,
   replacing the former bare 'M' text marker. */
.row-mute-flag {
  flex: none;
  width: 0.9em;
  height: 0.9em;
  fill: var(--warning);
}

.row-mute-slash {
  fill: none;
  stroke: var(--warning);
  stroke-width: 1.5;
  stroke-linecap: round;
}

.row-cells {
  flex: 1;
  display: flex;
  gap: var(--sp-1);
  min-width: 0;
}

.grid-cell {
  position: relative;
  flex: 1;
  min-width: var(--seq-cell-min);
  border-radius: 2px;
  background: var(--surface-inset);
  overflow: hidden;
  cursor: pointer;
  box-shadow: var(--inset-well);
  border: 0;
  padding: 0;
  transition: background-color var(--dur-3) var(--ease-out);
}

.grid-cell:focus-visible {
  outline: 2px solid var(--focus-ring, var(--accent));
  outline-offset: 1px;
}

.cell-accent {
  background: var(--surface-3);
}

.row-muted .grid-cell {
  opacity: 0.45;
}

.grid-cell :deep(.cell-fill) {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--accent);
  border-radius: 2px 2px 0 0;
  transition: background var(--dur-1) var(--ease-out);
  /* A newly set step grows up from the cell floor. */
  transform-origin: bottom;
  animation: cell-fill-in var(--dur-2) var(--ease-spring);
}

@keyframes cell-fill-in {
  from {
    transform: scaleY(0.3);
    opacity: 0.4;
  }
}

.cell-active {
  box-shadow: none;
}

/* Playhead column: lights instantly, then fades out behind the moving step. */
.grid-cell.cell-playing {
  background: color-mix(in srgb, var(--accent) 16%, var(--surface-inset));
  transition: none;
}

/* A step that fires flashes and settles back to its velocity fill. */
.grid-row:not(.row-muted) .cell-active.cell-playing::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--accent-text);
  opacity: 0;
  pointer-events: none;
  animation: cell-trigger var(--dur-3) var(--ease-out);
}

@keyframes cell-trigger {
  from {
    opacity: 0.45;
  }
}

.step-velocity-accessible,
.step-grid-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.step-velocity-accessible:focus-within {
  z-index: 10;
  top: 4px;
  left: calc(var(--seq-row-label-w) + var(--sp-4));
  display: flex;
  width: min(320px, calc(100% - var(--seq-row-label-w) - var(--sp-6)));
  height: auto;
  gap: var(--sp-3);
  align-items: center;
  padding: var(--sp-2);
  overflow: visible;
  clip-path: none;
  background: var(--surface-1);
  color: var(--text-1);
}

.step-velocity-accessible input {
  flex: 1;
}
</style>
