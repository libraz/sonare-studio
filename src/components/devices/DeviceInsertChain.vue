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
