<script setup lang="ts">
import { computed } from 'vue';
import type { StepPattern } from '@/ui/step-sequencer/pattern';
import { isTripletResolution } from '@/ui/step-sequencer/timing';

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
}>();

const emit = defineEmits<{
  /** Sets one step's active flag. */
  'set-step': [rowIndex: number, stepIndex: number, active: boolean];
  /** Selects a row for parameter editing / row operations. */
  'select-row': [rowIndex: number];
}>();

/** Steps per accent group (beat shading): 3 on triplet grids, else 4. */
const groupSize = computed(() => (isTripletResolution(props.pattern.resolution) ? 3 : 4));

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

function fillHeight(velocity: number): string {
  return `${Math.round((velocity / 127) * 100)}%`;
}
</script>

<template>
  <div
    class="step-grid"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @contextmenu.prevent
  >
    <div
      v-for="(row, rowIndex) in props.pattern.rows"
      :key="`${row.pitch}-${rowIndex}`"
      class="grid-row"
      :class="{ 'row-selected': rowIndex === props.selectedRow, 'row-muted': row.muted }"
    >
      <button
        type="button"
        class="row-label"
        :title="`${row.name} (${row.pitch})`"
        @click="emit('select-row', rowIndex)"
      >
        <span class="row-name">{{ row.name }}</span>
        <span v-if="row.muted" class="row-mute-flag">M</span>
      </button>
      <div class="row-cells">
        <div
          v-for="(step, stepIndex) in row.steps"
          :key="stepIndex"
          class="grid-cell"
          :class="{
            'cell-active': step.active,
            'cell-accent': stepIndex % groupSize === 0,
          }"
          :data-row="rowIndex"
          :data-step="stepIndex"
        >
          <div
            v-if="step.active"
            class="cell-fill"
            :style="{ height: fillHeight(step.velocity) }"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.step-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background: #101216;
  touch-action: none;
  user-select: none;
}

.grid-row {
  display: flex;
  align-items: stretch;
  gap: 4px;
  min-height: 22px;
}

.row-label {
  flex: none;
  width: 110px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: #181a20;
  color: #9aa1ad;
  font: 11px/1.2 system-ui, sans-serif;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

.row-selected .row-label {
  border-color: #3a4150;
  background: #1c1f26;
  color: #e2e6ed;
}

.row-muted .row-label {
  color: #5b6270;
}

.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-mute-flag {
  flex: none;
  font-weight: 700;
  color: #d97706;
}

.row-cells {
  flex: 1;
  display: flex;
  gap: 2px;
  min-width: 0;
}

.grid-cell {
  position: relative;
  flex: 1;
  min-width: 8px;
  border-radius: 2px;
  background: #1a1d24;
  overflow: hidden;
  cursor: pointer;
}

.cell-accent {
  background: #20242d;
}

.row-muted .grid-cell {
  opacity: 0.45;
}

.cell-fill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: #4f86d8;
  border-radius: 2px 2px 0 0;
}

.row-selected .cell-fill {
  background: #60a5fa;
}

.cell-active {
  box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.5);
}
</style>
