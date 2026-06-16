<script setup lang="ts">
import SelectMenu from '@/components/shell/SelectMenu.vue';
import type { InsertSlot } from '@/project/mixer';
import { insertCategory, insertLabel } from '@/ui/devices/device-labels';

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
}>();
</script>

<template>
  <div class="insert-chain">
    <h4 class="chain-title">Inserts</h4>
    <p v-if="inserts.length === 0" class="chain-empty">No inserts</p>
    <ul v-else class="insert-list">
      <li
        v-for="(insertSlot, index) in inserts"
        :key="`${insertSlot.processor}-${index}`"
        class="insert-row"
        :class="{ selected: selectedDevice === index, bypassed: !insertSlot.enabled }"
      >
        <button
          type="button"
          class="insert-power"
          :class="{ on: insertSlot.enabled }"
          :title="insertSlot.enabled ? 'Bypass insert' : 'Enable insert'"
          :aria-label="`${insertLabel(insertSlot.processor)} power`"
          :aria-pressed="insertSlot.enabled"
          @click="emit('toggleInsert', index)"
        >
          ●
        </button>
        <button
          type="button"
          class="insert-name"
          :title="insertSlot.processor"
          @click="emit('selectInsert', index)"
        >
          {{ insertLabel(insertSlot.processor) }}
          <span class="insert-cat">{{ insertCategory(insertSlot.processor) }}</span>
        </button>
        <button
          type="button"
          class="insert-remove"
          title="Remove insert"
          :aria-label="`Remove ${insertLabel(insertSlot.processor)}`"
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
      aria-label="Add insert"
      :options="addInsertOptions"
      @update:model-value="emit('update:addInsertValue', $event)"
      @change="emit('addInsert', $event)"
    />
  </div>
</template>
