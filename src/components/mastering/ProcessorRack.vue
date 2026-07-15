<script setup lang="ts">
import { ref } from 'vue';
import ProcessorSlot from '@/components/mastering/ProcessorSlot.vue';
import type { InsertSlot } from '@/project/mixer';
import { useI18n } from '@/ui/i18n';
import type { MasteringControl } from '@/ui/mastering/chain-controls';
import type { InsertCatalogGroup } from '@/ui/mixer/insert-catalog';

/**
 * Ordered processor rack: the drag-reorderable slot list plus the add-processor
 * popover. Presentational — the chain edits, the drag-reorder plan, the
 * expanded-slot parameter controls and the lazily loaded catalog are owned by
 * the panel, which this rack drives through emitted intents. The add menu's
 * container is exposed so the panel keeps the shared outside-click dismissal.
 */

const props = defineProps<{
  /** The chain's processor slots, in order. */
  processors: ReadonlyArray<InsertSlot>;
  /** Index of the expanded slot, or null when none is expanded. */
  expandedIndex: number | null;
  /** Parameter controls for the expanded slot. */
  expandedControls: ReadonlyArray<MasteringControl>;
  /** Drag source index, or null. */
  dragIndex: number | null;
  /** Current drop-target index, or null. */
  dragOverIndex: number | null;
  /** True when the add-processor popover is open. */
  addMenuOpen: boolean;
  /** Grouped processor catalog for the add menu. */
  catalog: ReadonlyArray<InsertCatalogGroup>;
}>();

const emit = defineEmits<{
  (event: 'toggle-enabled', index: number): void;
  (event: 'toggle-expanded', index: number): void;
  (event: 'remove', index: number): void;
  (
    event: 'param-change',
    index: number,
    control: MasteringControl,
    value: number,
    commit: boolean,
  ): void;
  (event: 'drag-start', index: number, dragEvent: DragEvent): void;
  (event: 'drag-over', index: number, dragEvent: DragEvent): void;
  (event: 'drop', index: number): void;
  (event: 'drag-end'): void;
  (event: 'toggle-add-menu'): void;
  (event: 'add-processor', processorId: string): void;
}>();

const { t } = useI18n();

const addMenuEl = ref<HTMLDivElement | null>(null);

/** Controls passed to a slot: only the expanded slot receives them. */
function controlsFor(index: number): ReadonlyArray<MasteringControl> {
  return index === props.expandedIndex ? props.expandedControls : [];
}

defineExpose({ addMenuEl });
</script>

<template>
  <div class="chain-rack">
    <ProcessorSlot
      v-for="(slot, index) in processors"
      :key="slot.id ?? `${index}:${slot.processor}`"
      :slot="slot"
      :index="index"
      :expanded="expandedIndex === index"
      :dragging="dragIndex === index"
      :drop-target="dragOverIndex === index && dragIndex !== index"
      :controls="controlsFor(index)"
      @toggle-enabled="emit('toggle-enabled', $event)"
      @toggle-expanded="emit('toggle-expanded', $event)"
      @remove="emit('remove', $event)"
      @param-change="
        (slotIndex, control, value, commit) =>
          emit('param-change', slotIndex, control, value, commit)
      "
      @drag-start="(slotIndex, dragEvent) => emit('drag-start', slotIndex, dragEvent)"
      @drag-over="(slotIndex, dragEvent) => emit('drag-over', slotIndex, dragEvent)"
      @drop="emit('drop', $event)"
      @drag-end="emit('drag-end')"
    />
    <div ref="addMenuEl" class="chain-add-wrap">
      <button
        type="button"
        class="chain-add"
        v-tooltip="t.shell.mastering.addProcessorTitle"
        aria-haspopup="menu"
        :aria-expanded="addMenuOpen"
        @click="emit('toggle-add-menu')"
      >
        {{ t.shell.mastering.addProcessor }}
      </button>
      <Transition name="pop">
      <div v-if="addMenuOpen" class="chain-catalog" role="menu">
        <div v-for="group in catalog" :key="group.category" class="catalog-group">
          <div class="catalog-category">{{ group.label }}</div>
          <button
            v-for="processor in group.processors"
            :key="processor.id"
            type="button"
            role="menuitem"
            class="catalog-item"
            @click="emit('add-processor', processor.id)"
          >
            <span class="catalog-item-label">{{ processor.label }}</span>
            <span v-if="processor.stereoOnly" class="catalog-item-tag">{{
              t.shell.inserts.stereoOnly
            }}</span>
          </button>
        </div>
      </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped src="./processor-rack.css"></style>
