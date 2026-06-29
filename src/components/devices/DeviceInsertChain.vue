<script setup lang="ts">
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
}>();

const { t } = useI18n();
</script>

<template>
  <div class="insert-chain">
    <h4 class="chain-title">{{ t.shell.inserts.title }}</h4>
    <p v-if="inserts.length === 0" class="chain-empty">{{ t.shell.inserts.empty }}</p>
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
