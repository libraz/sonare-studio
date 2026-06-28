<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import type { CommandGestureOptions, MixerStripTarget } from '@/project/commands';
import {
  isMixerBusStripTarget,
  mixerBusIdFromTarget,
  setInsertSidechain,
} from '@/project/commands';
import { createDefaultStrip, type InsertSlot, type MixerStrip } from '@/project/mixer';
import { listQuickControls, type QuickControl, setQuickControl } from '@/project/quick-controls';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { midiLearnInsertTargetId } from '@/ui/midi/midi-learn';
import {
  groupInsertCatalogEntries,
  humanizeInsertName,
  type InsertCatalogGroup,
  loadInsertCatalogEntries,
} from '@/ui/mixer/insert-catalog';
import {
  addInsertSlot,
  adjustExpandedAfterRemove,
  isSidechainKeyedProcessor,
  removeInsertSlot,
  reorderInsertSlots,
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
 *
 * Sidechain-keyed processors (ducking/sidechainRouter) on track strips get a
 * key-source select picking which other track's audio drives the sidechain;
 * the master strip has no engine lane to key from, so it shows none.
 */

const props = defineProps<{
  /** Strip the rack edits: a track id or 'master'. */
  target: MixerStripTarget;
}>();

const store = useProjectStore();
const { t } = useI18n();

const strip = computed<MixerStrip>(() => {
  if (props.target === 'master') return store.mixer.master;
  if (isMixerBusStripTarget(props.target)) {
    const busId = mixerBusIdFromTarget(props.target);
    return store.mixer.buses.find((bus) => bus.id === busId)?.strip ?? createDefaultStrip();
  }
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

// --- MIDI learn (shared app handle, injected; null in isolated tests) --------

const midiLearn = inject(MIDI_LEARN_KEY, null);

/** Learn target id for a control on the currently expanded insert slot. */
function learnTargetId(control: QuickControl): string {
  if (isMixerBusStripTarget(props.target)) return '';
  return midiLearnInsertTargetId(props.target, expandedIndex.value ?? -1, control.id);
}

/** MIDI-learn state for a control's knob menu, or undefined when unavailable. */
function learnState(control: QuickControl): 'unbound' | 'armed' | 'bound' | undefined {
  if (!midiLearn || isMixerBusStripTarget(props.target)) return undefined;
  const id = learnTargetId(control);
  if (midiLearn.isArmedId(id)) return 'armed';
  return midiLearn.bindingForId(id) ? 'bound' : 'unbound';
}

function onMidiLearn(control: QuickControl): void {
  if (isMixerBusStripTarget(props.target)) return;
  midiLearn?.armId(learnTargetId(control));
}

function onMidiForget(control: QuickControl): void {
  if (isMixerBusStripTarget(props.target)) return;
  midiLearn?.clearId(learnTargetId(control));
}

// --- Slot actions ------------------------------------------------------------

function onToggleEnabled(index: number): void {
  toggleInsertEnabled(props.target, index, strip.value.inserts[index]);
}

function onRemove(index: number): void {
  removeInsertSlot(props.target, index);
  expandedIndex.value = adjustExpandedAfterRemove(expandedIndex.value, index);
}

// --- Drag reorder ------------------------------------------------------------

const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);

function onDragStart(index: number, event: DragEvent): void {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  }
}

function onDragOver(index: number, event: DragEvent): void {
  if (dragIndex.value === null) return;
  event.preventDefault();
  dragOverIndex.value = index;
}

function onDrop(index: number): void {
  const from = dragIndex.value;
  dragIndex.value = null;
  dragOverIndex.value = null;
  if (from === null || from === index) return;
  try {
    reorderInsertSlots(props.target, strip.value.inserts, from, index);
    expandedIndex.value = null;
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function onDragEnd(): void {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

// --- Sidechain key source ------------------------------------------------------

/** Sidechain select value meaning "no key source" (track ids are never < 0). */
const SIDECHAIN_NONE = -1;

/** Tracks selectable as sidechain key sources (other non-group tracks). */
const sidechainSources = computed<EditorTrack[]>(() =>
  store.tracks.filter((track) => track.id !== props.target && track.kind !== 'group'),
);

/** Key-source options: "No key" plus every selectable source track. */
const sidechainOptions = computed<{ value: number; label: string }[]>(() => [
  { value: SIDECHAIN_NONE, label: t.value.shell.inserts.noKey },
  ...sidechainSources.value.map((track) => ({ value: track.id, label: track.name })),
]);

/** True when the slot gets a key-source select (keyed insert on a track strip). */
function hasSidechainSelect(slot: InsertSlot): boolean {
  return typeof props.target === 'number' && isSidechainKeyedProcessor(slot.processor);
}

function onSidechainChange(index: number, value: number): void {
  if (typeof props.target !== 'number') return;
  try {
    setInsertSidechain(props.target, index, value === SIDECHAIN_NONE ? null : value);
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

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
      <div
        class="insert-slot"
        :class="{ bypassed: !slot.enabled, 'drag-over': dragOverIndex === index }"
        @dragover="onDragOver(index, $event)"
        @drop="onDrop(index)"
        @dragend="onDragEnd"
      >
        <span
          class="insert-drag"
          draggable="true"
          :title="t.shell.inserts.dragReorder"
          aria-hidden="true"
          @dragstart="onDragStart(index, $event)"
        >⋮⋮</span>
        <button
          type="button"
          class="insert-power"
          :class="{ on: slot.enabled }"
          :title="slot.enabled ? t.shell.inserts.bypass : t.shell.inserts.enable"
          :aria-label="
            formatMessage(t.shell.inserts.power, { name: humanizeInsertName(slot.processor) })
          "
          :aria-pressed="slot.enabled"
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
          :title="t.shell.inserts.remove"
          :aria-label="
            formatMessage(t.shell.inserts.removeNamed, { name: humanizeInsertName(slot.processor) })
          "
          @click="onRemove(index)"
        >
          ×
        </button>
      </div>
      <div v-if="expandedIndex === index" class="insert-params">
        <label v-if="hasSidechainSelect(slot)" class="insert-sidechain">
          <span class="insert-sidechain-label">{{ t.shell.inserts.key }}</span>
          <SelectMenu
            class="insert-sidechain-select"
            :model-value="slot.sidechainSourceTrackId ?? SIDECHAIN_NONE"
            :options="sidechainOptions"
            :aria-label="t.shell.inserts.sidechainKey"
            size="sm"
            @change="(value) => onSidechainChange(index, value)"
          />
        </label>
        <p v-if="expandedControls.length === 0" class="insert-params-empty">
          {{ t.shell.inserts.noParameters }}
        </p>
        <MixerKnob
          v-for="control in expandedControls"
          :key="control.id"
          :value="control.value"
          :min="control.min"
          :max="control.max"
          :label="control.name"
          :display="controlDisplay(control)"
          :size="22"
          :midi-learn-state="learnState(control)"
          @change="(value, commit) => onParamChange(control, value, commit)"
          @midi-learn="onMidiLearn(control)"
          @midi-forget="onMidiForget(control)"
        />
      </div>
    </template>
    <div ref="addMenu" class="insert-add-wrap">
      <button
        type="button"
        class="insert-add"
        :title="t.shell.inserts.add"
        aria-haspopup="menu"
        :aria-expanded="addMenuOpen"
        @click="openAddMenu"
      >
        {{ t.shell.inserts.addButton }}
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
            <span class="catalog-item-label">{{ processor.label }}</span>
            <span v-if="processor.stereoOnly" class="catalog-item-tag">{{
              t.shell.inserts.stereoOnly
            }}</span>
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
  gap: var(--sp-1);
}

.insert-slot {
  display: flex;
  align-items: center;
  gap: 3px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 3px;
}

.insert-slot.drag-over {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent-muted);
}

.insert-slot.bypassed .insert-name {
  color: var(--text-4);
}

.insert-drag {
  flex: none;
  color: var(--text-4);
  font-size: 9px;
  line-height: 1;
  letter-spacing: -1px;
  cursor: grab;
  user-select: none;
}

.insert-drag:active {
  cursor: grabbing;
}

.insert-power {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--border-raised);
  background: transparent;
  box-shadow: none;
  padding: 0;
  cursor: pointer;
}

.insert-power.on {
  background: var(--success);
  border-color: var(--success);
}

.insert-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font: 9px var(--font-sans);
  color: var(--text-2);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 1px 0;
  cursor: pointer;
}

.insert-name.expanded {
  color: var(--accent);
}

.insert-remove {
  flex: none;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font: 10px var(--font-sans);
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.insert-remove:hover {
  color: var(--danger-text);
}

.insert-params {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-3);
  justify-content: center;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: var(--sp-2) var(--sp-1);
  box-shadow: var(--inset-well);
}

.insert-params-empty {
  margin: 0;
  font: 9px var(--font-sans);
  color: var(--text-4);
}

.insert-add-wrap {
  position: relative;
}

.insert-add {
  width: 100%;
  font: var(--fw-semibold) 9px var(--font-sans);
  color: var(--text-3);
  background: transparent;
  box-shadow: none;
  border-radius: 3px;
  padding: 2px 0;
  cursor: pointer;
  transition: color var(--dur-1) var(--ease-out);
}

.insert-add:hover {
  color: var(--text-2);
}

.insert-catalog {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 30;
  width: 150px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  padding: 2px 0;
}

.catalog-category {
  font: var(--fw-bold) 8px var(--font-sans);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-4);
  padding: 4px 8px 2px;
}

.catalog-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  width: 100%;
  text-align: left;
  font: 10px var(--font-sans);
  color: var(--text-2);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 3px 10px;
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out);
}

.catalog-item:hover {
  background: var(--surface-4);
}

.catalog-item-tag {
  flex: none;
  font: 8px var(--font-sans);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-3);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-1);
  padding: 0 4px;
}

.insert-error {
  margin: 0;
  font: 9px/1.3 var(--font-sans);
  color: var(--danger-text);
}
.insert-sidechain {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
}

.insert-sidechain-label {
  font-size: 9px;
  color: var(--text-3);
  text-transform: uppercase;
}

.insert-sidechain-select {
  flex: 1;
  min-width: 0;
}
</style>
