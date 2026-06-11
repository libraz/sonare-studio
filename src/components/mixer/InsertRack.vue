<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { CommandGestureOptions, MixerStripTarget } from '@/project/commands';
import { createDefaultStrip, type MixerStrip } from '@/project/mixer';
import { listQuickControls, type QuickControl, setQuickControl } from '@/project/quick-controls';
import { useProjectStore } from '@/project/store';
import {
  groupInsertCatalog,
  humanizeInsertName,
  type InsertCatalogGroup,
  loadInsertCatalog,
} from '@/ui/mixer/insert-catalog';
import {
  addInsertSlot,
  adjustExpandedAfterRemove,
  removeInsertSlot,
  toggleInsertEnabled,
} from '@/ui/mixer/insert-rack';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';
import MixerKnob from './MixerKnob.vue';

/**
 * Insert chain section of a channel strip: one row per slot with a bypass
 * dot, name (click expands the parameter knobs inline) and remove button,
 * plus an add button opening the processor catalog grouped by category.
 * All edits go through the undoable command layer; parameter knob drags
 * coalesce into one history entry via the quick-control gesture protocol.
 */

const props = defineProps<{
  /** Strip the rack edits: a track id or 'master'. */
  target: MixerStripTarget;
}>();

const store = useProjectStore();

const strip = computed<MixerStrip>(() => {
  if (props.target === 'master') return store.mixer.master;
  const track = store.tracks.find((t) => t.id === props.target);
  return track?.mixer ?? createDefaultStrip();
});

/** Surfaced when a command rejects (e.g. unknown processor at apply time). */
const error = ref('');

// --- Expand / parameter knobs ------------------------------------------------

const expandedIndex = ref<number | null>(null);

const expandedControls = computed<QuickControl[]>(() => {
  const index = expandedIndex.value;
  if (index === null || index >= strip.value.inserts.length) return [];
  try {
    return listQuickControls({ type: 'insert', trackId: props.target, index });
  } catch {
    return [];
  }
});

function toggleExpanded(index: number): void {
  expandedIndex.value = expandedIndex.value === index ? null : index;
}

/** In-flight knob gestures keyed by control id (one per dragged knob). */
const gestures = new Map<string, ValueGesture>();

function onParamChange(control: QuickControl, value: number, commit: boolean): void {
  const index = expandedIndex.value;
  if (index === null) return;
  const apply = (v: number, options: CommandGestureOptions): void => {
    setQuickControl({ type: 'insert', trackId: props.target, index }, control.id, v, options);
  };
  try {
    if (!commit) {
      let gesture = gestures.get(control.id);
      if (!gesture) {
        gesture = createValueGesture(apply, control.value);
        gestures.set(control.id, gesture);
      }
      gesture.update(value);
    } else {
      const gesture = gestures.get(control.id);
      if (gesture) gesture.end(value);
      else apply(value, { commit: true });
      gestures.delete(control.id);
    }
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** Formatted knob value with the control's unit. */
function controlDisplay(control: QuickControl): string {
  const value =
    Math.abs(control.value) >= 100 ? Math.round(control.value) : control.value.toFixed(1);
  return control.unit ? `${value} ${control.unit}` : `${value}`;
}

// --- Slot actions ------------------------------------------------------------

function onToggleEnabled(index: number): void {
  toggleInsertEnabled(props.target, index, strip.value.inserts[index]);
}

function onRemove(index: number): void {
  removeInsertSlot(props.target, index);
  expandedIndex.value = adjustExpandedAfterRemove(expandedIndex.value, index);
}

// --- Add popover ---------------------------------------------------------------

const addMenuOpen = ref(false);
const addMenu = ref<HTMLDivElement | null>(null);
const catalog = ref<InsertCatalogGroup[]>([]);

function openAddMenu(): void {
  if (!addMenuOpen.value) {
    // Loaded lazily: the wasm catalog may not exist at mount time.
    catalog.value = groupInsertCatalog(loadInsertCatalog());
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
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node) || !addMenu.value?.contains(event.target)) {
    addMenuOpen.value = false;
  }
}

watch(addMenuOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown, true);
  else document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});
</script>

<template>
  <div class="insert-rack">
    <template v-for="(slot, index) in strip.inserts" :key="index">
      <div class="insert-slot" :class="{ bypassed: !slot.enabled }">
        <button
          type="button"
          class="insert-power"
          :class="{ on: slot.enabled }"
          :title="slot.enabled ? 'Bypass insert' : 'Enable insert'"
          @click="onToggleEnabled(index)"
        />
        <button
          type="button"
          class="insert-name"
          :class="{ expanded: expandedIndex === index }"
          :title="slot.processor"
          @click="toggleExpanded(index)"
        >
          {{ humanizeInsertName(slot.processor) }}
        </button>
        <button
          type="button"
          class="insert-remove"
          title="Remove insert"
          @click="onRemove(index)"
        >
          ×
        </button>
      </div>
      <div v-if="expandedIndex === index" class="insert-params">
        <p v-if="expandedControls.length === 0" class="insert-params-empty">No parameters</p>
        <MixerKnob
          v-for="control in expandedControls"
          :key="control.id"
          :value="control.value"
          :min="control.min"
          :max="control.max"
          :label="control.name"
          :display="controlDisplay(control)"
          :size="22"
          @change="(value, commit) => onParamChange(control, value, commit)"
        />
      </div>
    </template>
    <div ref="addMenu" class="insert-add-wrap">
      <button type="button" class="insert-add" title="Add insert" @click="openAddMenu">
        + Insert
      </button>
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
            {{ processor.label }}
          </button>
        </div>
      </div>
    </div>
    <p v-if="error" class="insert-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.insert-rack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.insert-slot {
  display: flex;
  align-items: center;
  gap: 3px;
  background: #1a1d23;
  border: 1px solid #23262e;
  border-radius: 3px;
  padding: 1px 3px;
}

.insert-slot.bypassed .insert-name {
  color: #4a5160;
}

.insert-power {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: 1px solid #3a4150;
  background: transparent;
  padding: 0;
  cursor: pointer;
}

.insert-power.on {
  background: #4ade80;
  border-color: #4ade80;
}

.insert-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font: 9px system-ui, sans-serif;
  color: #c8cdd6;
  background: transparent;
  border: none;
  padding: 1px 0;
  cursor: pointer;
}

.insert-name.expanded {
  color: #9fc4f5;
}

.insert-remove {
  flex: none;
  border: none;
  background: transparent;
  color: #5b6270;
  font: 10px system-ui, sans-serif;
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.insert-remove:hover {
  color: #ffb4b4;
}

.insert-params {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  justify-content: center;
  background: #15171c;
  border: 1px solid #23262e;
  border-radius: 3px;
  padding: 4px 2px;
}

.insert-params-empty {
  margin: 0;
  font: 9px system-ui, sans-serif;
  color: #4a5160;
}

.insert-add-wrap {
  position: relative;
}

.insert-add {
  width: 100%;
  font: 600 9px system-ui, sans-serif;
  color: #8b93a3;
  background: transparent;
  border: 1px dashed #2a2e37;
  border-radius: 3px;
  padding: 2px 0;
  cursor: pointer;
}

.insert-add:hover {
  color: #c8cdd6;
  border-color: #3a4150;
}

.insert-catalog {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 30;
  width: 150px;
  max-height: 240px;
  overflow-y: auto;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
  padding: 2px 0;
}

.catalog-category {
  font: 700 8px system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #5b6270;
  padding: 4px 8px 2px;
}

.catalog-item {
  display: block;
  width: 100%;
  text-align: left;
  font: 10px system-ui, sans-serif;
  color: #c8cdd6;
  background: transparent;
  border: none;
  padding: 3px 10px;
  cursor: pointer;
}

.catalog-item:hover {
  background: #242832;
}

.insert-error {
  margin: 0;
  font: 9px/1.3 system-ui, sans-serif;
  color: #ffb4b4;
}
</style>
