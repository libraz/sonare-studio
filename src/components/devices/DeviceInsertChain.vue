<script setup lang="ts">
import { ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import type { InsertSlot } from '@/project/mixer';
import { insertCategory, insertLabel } from '@/ui/devices/device-labels';
import { formatMessage, useI18n } from '@/ui/i18n';

defineProps<{
  inserts: readonly InsertSlot[];
  selectedDevice: 'instrument' | number;
  addInsertValue: string;
  addInsertOptions: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
}>();

const emit = defineEmits<{
  'update:addInsertValue': [value: string];
  addInsert: [processor: string];
  toggleInsert: [index: number];
  removeInsert: [index: number];
  selectInsert: [index: number];
  moveInsert: [from: number, to: number];
}>();

const { t } = useI18n();

/**
 * Index of the row being dragged, tracked in component state rather than the
 * drag dataTransfer so the reorder works without serialising payloads (and is
 * testable without a DataTransfer implementation).
 */
const draggingIndex = ref<number | null>(null);

/** Index currently hovered as a drop position (for the insertion marker). */
const dragOverIndex = ref<number | null>(null);

function onDragStart(index: number): void {
  draggingIndex.value = index;
}

function onDragEnter(index: number): void {
  if (draggingIndex.value !== null) dragOverIndex.value = index;
}

function onDrop(index: number): void {
  const from = draggingIndex.value;
  draggingIndex.value = null;
  dragOverIndex.value = null;
  if (from !== null && from !== index) emit('moveInsert', from, index);
}

function onDragEnd(): void {
  draggingIndex.value = null;
  dragOverIndex.value = null;
}
</script>

<template>
  <div class="insert-chain">
    <h4 class="chain-title">{{ t.shell.inserts.title }}</h4>
    <p v-if="inserts.length === 0" class="chain-empty">{{ t.shell.inserts.empty }}</p>
    <ul v-else class="insert-list">
      <li
        v-for="(insertSlot, index) in inserts"
        :key="insertSlot.id ?? `${insertSlot.processor}-${index}`"
        class="insert-row"
        :class="{
          selected: selectedDevice === index,
          bypassed: !insertSlot.enabled,
          dragging: draggingIndex === index,
          'drag-over': dragOverIndex === index && draggingIndex !== index,
        }"
        draggable="true"
        @dragstart="onDragStart(index)"
        @dragenter.prevent="onDragEnter(index)"
        @dragover.prevent
        @drop="onDrop(index)"
        @dragend="onDragEnd"
      >
        <span class="insert-grip" v-tooltip="t.shell.inserts.dragReorder" aria-hidden="true">⠿</span>
        <button
          type="button"
          class="insert-power"
          :class="{ on: insertSlot.enabled }"
          v-tooltip="insertSlot.enabled ? t.shell.inserts.bypass : t.shell.inserts.enable"
          :aria-label="
            formatMessage(t.shell.inserts.power, { name: insertLabel(insertSlot.processor) })
          "
          :aria-pressed="insertSlot.enabled"
          @click="emit('toggleInsert', index)"
        >
          ●
        </button>
        <button
          type="button"
          class="insert-name"
          v-tooltip="insertSlot.processor"
          @click="emit('selectInsert', index)"
        >
          {{ insertLabel(insertSlot.processor) }}
          <span class="insert-cat">{{ insertCategory(insertSlot.processor) }}</span>
        </button>
        <button
          type="button"
          class="insert-remove"
          v-tooltip="t.shell.inserts.remove"
          :aria-label="
            formatMessage(t.shell.inserts.removeNamed, { name: insertLabel(insertSlot.processor) })
          "
          @click="emit('removeInsert', index)"
        >
          ×
        </button>
      </li>
    </ul>
    <SelectMenu
      :model-value="addInsertValue"
      class="add-insert"
      size="sm"
      :aria-label="t.shell.inserts.add"
      :options="addInsertOptions"
      @update:model-value="emit('update:addInsertValue', $event)"
      @change="emit('addInsert', $event)"
    />
  </div>
</template>

<style scoped src="./device-chain.css"></style>

<style scoped>
.insert-chain {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.insert-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.insert-row {
  display: flex;
  align-items: stretch;
  gap: var(--sp-1);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--raise-hi);
  overflow: hidden;
}

.insert-row.selected {
  border-color: var(--accent);
}

.insert-row.bypassed .insert-name {
  color: var(--text-4);
}

.insert-row.dragging {
  opacity: 0.5;
}

.insert-row.drag-over {
  border-color: var(--accent);
  box-shadow: inset 0 2px 0 -1px var(--accent), var(--raise-hi);
}

.insert-grip {
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 2px;
  color: var(--text-4);
  cursor: grab;
  font-size: var(--fs-2xs);
  line-height: 1;
  user-select: none;
}

.insert-row.dragging .insert-grip {
  cursor: grabbing;
}

.insert-power {
  flex: none;
  width: 20px;
  background: transparent;
  border: none;
  box-shadow: none;
  color: var(--text-4);
  cursor: pointer;
  font-size: var(--fs-chrome-lg);
}

.insert-power.on {
  color: var(--success);
}

.insert-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  background: transparent;
  border: none;
  box-shadow: none;
  color: var(--text-2);
  font: var(--fw-semibold) var(--fs-xs) var(--font-sans);
  text-align: left;
  padding: var(--sp-2) 0;
  cursor: pointer;
  overflow: hidden;
}

.insert-cat {
  font: var(--fs-chrome-lg) var(--font-sans);
  color: var(--text-4);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.insert-remove {
  flex: none;
  width: 18px;
  background: transparent;
  border: none;
  box-shadow: none;
  color: var(--text-4);
  cursor: pointer;
  font-size: var(--fs-sm);
}

.insert-remove:hover {
  color: var(--danger-text);
}

.add-insert {
  /* Pass-through wrapper: the inner SelectMenu trigger carries the control face. */
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  cursor: pointer;
}
</style>
