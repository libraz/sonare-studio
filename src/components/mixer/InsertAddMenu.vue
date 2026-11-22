<script setup lang="ts">
import { ref } from 'vue';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { describeError } from '@/lib/errors';
import type { MixerStripTarget } from '@/project/commands';
import { useI18n } from '@/ui/i18n';
import {
  groupInsertCatalogEntries,
  type InsertCatalogGroup,
  loadInsertCatalogEntries,
} from '@/ui/mixer/insert-catalog';
import { addInsertSlot } from '@/ui/mixer/insert-rack';

/**
 * Add button of the insert rack and the processor catalog popover it opens,
 * grouped by category. A new slot is expanded once added.
 */

const props = defineProps<{
  /** Strip the new insert is added to. */
  target: MixerStripTarget;
}>();

/** Index of the expanded slot in the rack. */
const expandedIndex = defineModel<number | null>('expandedIndex', { required: true });
/** The rack's error banner. */
const error = defineModel<string>('error', { required: true });

const { t } = useI18n();

// --- Add popover ---------------------------------------------------------------

const addMenuOpen = ref(false);
const addMenu = ref<HTMLDivElement | null>(null);
const catalog = ref<InsertCatalogGroup[]>([]);

function openAddMenu(): void {
  if (!addMenuOpen.value) {
    // Loaded lazily: the wasm catalog may not exist at mount time. Mixer
    // strips run inserts in the realtime engine, so offer only the
    // insert-safe subset (the engine rejects offline-only processors).
    catalog.value = groupInsertCatalogEntries(loadInsertCatalogEntries('realtime'));
  }
  addMenuOpen.value = !addMenuOpen.value;
}

function onAddProcessor(processorId: string): void {
  addMenuOpen.value = false;
  try {
    const index = addInsertSlot(props.target, processorId);
    expandedIndex.value = index;
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

useOutsidePointerDown(
  addMenuOpen,
  (target) => !!addMenu.value?.contains(target),
  () => {
    addMenuOpen.value = false;
  },
);
</script>

<template>
  <div ref="addMenu" class="insert-add-wrap">
    <button
      type="button"
      class="insert-add"
      v-tooltip="t.shell.inserts.add"
      aria-haspopup="menu"
      :aria-expanded="addMenuOpen"
      @click="openAddMenu"
    >
      {{ t.shell.inserts.addButton }}
    </button>
    <Transition name="pop">
    <div v-if="addMenuOpen" class="insert-catalog" role="menu">
      <div v-for="group in catalog" :key="group.category" class="catalog-group">
        <div class="catalog-category">{{ group.label }}</div>
        <button
          v-for="processor in group.processors"
          :key="processor.id"
          type="button"
          role="menuitem"
          class="catalog-item"
          @click="onAddProcessor(processor.id)"
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
</template>

<style scoped src="./insert-rack.css"></style>
