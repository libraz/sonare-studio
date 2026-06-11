<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import MixerKnob from '@/components/mixer/MixerKnob.vue';
import { renderMixdownInWorker } from '@/export/client';
import type { MixdownResult } from '@/export/mixdown';
import {
  addMasteringProcessor,
  type CommandGestureOptions,
  removeMasteringProcessor,
  setMasteringEnabled,
  setMasteringParam,
  setMasteringPreset,
} from '@/project/commands';
import { createDefaultMasteringChain, type MasteringChainState } from '@/project/mixer';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import {
  clampControlValue,
  type MasteringControl,
  masteringProcessorControls,
} from '@/ui/mastering/chain-controls';
import { applyChainReorder, planChainReorder } from '@/ui/mastering/chain-reorder';
import { formatLevel, isClippingRisk, loudnessBarFraction } from '@/ui/mastering/loudness';
import {
  filterPresetCatalog,
  humanizePresetName,
  loadMasteringPresetCatalog,
} from '@/ui/mastering/preset-catalog';
import {
  createMasteringPreviewController,
  type MasteringPreviewState,
  type PreviewRenderFn,
} from '@/ui/mastering/preview';
import { DEFAULT_PREVIEW_BARS, derivePreviewRange } from '@/ui/mastering/preview-range';
import { createAudioPreview } from '@/ui/media/preview';
import {
  categoryLabel,
  groupInsertCatalog,
  humanizeInsertName,
  type InsertCatalogGroup,
  loadInsertCatalog,
} from '@/ui/mixer/insert-catalog';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';

/**
 * Mastering panel for the editor dock: the project mastering chain as an
 * ordered processor rack (preset stage plus drag-reorderable processor
 * slots, each with inline parameter knobs), a short A/B mixdown preview
 * rendered by the export worker, and a loudness readout for the previewed
 * audio. All chain edits go through the undoable mastering commands; preview
 * playback uses a panel-local AudioContext and never touches the engine.
 */

const props = withDefaults(
  defineProps<{
    /** True when a transport loop region is active (used as preview range). */
    loopEnabled?: boolean;
    /** Loop start in PPQ. */
    loopStartPpq?: number;
    /** Loop end in PPQ (exclusive). */
    loopEndPpq?: number;
    /** Preview length in bars when no loop is active. */
    previewBars?: number;
    /** Render function override (tests); null uses the export worker client. */
    renderMixdown?: PreviewRenderFn | null;
  }>(),
  {
    loopEnabled: false,
    loopStartPpq: 0,
    loopEndPpq: 0,
    previewBars: DEFAULT_PREVIEW_BARS,
    renderMixdown: null,
  },
);

const store = useProjectStore();

const chain = computed<MasteringChainState>(
  () => store.mixer.masteringChain ?? createDefaultMasteringChain(),
);

/** Surfaced when a command or render rejects. */
const error = ref('');

function runCommand(action: () => void): void {
  try {
    action();
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

// --- Preset selector -----------------------------------------------------------

const presetMenuOpen = ref(false);
const presetMenuEl = ref<HTMLDivElement | null>(null);
const presetQuery = ref('');
const presetCatalog = ref<string[]>([]);

const filteredPresets = computed(() => filterPresetCatalog(presetCatalog.value, presetQuery.value));

const presetLabel = computed(() => {
  const preset = chain.value.preset;
  return preset !== undefined ? humanizePresetName(preset) : 'No preset';
});

function togglePresetMenu(): void {
  if (!presetMenuOpen.value) {
    // Loaded lazily: the wasm catalog may not exist at mount time.
    presetCatalog.value = loadMasteringPresetCatalog();
    presetQuery.value = '';
  }
  presetMenuOpen.value = !presetMenuOpen.value;
}

function onSelectPreset(preset: string | null): void {
  presetMenuOpen.value = false;
  runCommand(() => setMasteringPreset(preset));
}

// --- Processor rack ------------------------------------------------------------

const expandedIndex = ref<number | null>(null);

const expandedControls = computed<MasteringControl[]>(() => {
  const index = expandedIndex.value;
  if (index === null) return [];
  const slot = chain.value.processors[index];
  if (!slot) return [];
  return masteringProcessorControls(slot);
});

function processorCategory(processor: string): string {
  return processor.includes('.') ? processor.slice(0, processor.indexOf('.')) : 'other';
}

function toggleExpanded(index: number): void {
  expandedIndex.value = expandedIndex.value === index ? null : index;
}

function onToggleEnabled(index: number): void {
  const slot = chain.value.processors[index];
  if (!slot) return;
  runCommand(() => setMasteringEnabled(index, !slot.enabled));
}

function onRemove(index: number): void {
  runCommand(() => removeMasteringProcessor(index));
  if (expandedIndex.value !== null) {
    if (expandedIndex.value === index) expandedIndex.value = null;
    else if (expandedIndex.value > index) expandedIndex.value -= 1;
  }
}

/** In-flight knob gestures keyed by `${slot index}:${param}`. */
const gestures = new Map<string, ValueGesture>();

function onParamChange(
  index: number,
  control: MasteringControl,
  value: number,
  commit: boolean,
): void {
  const gestureKey = `${index}:${control.id}`;
  const apply = (v: number, options: CommandGestureOptions): void => {
    setMasteringParam(index, control.id, clampControlValue(control, v), options);
  };
  try {
    if (!commit) {
      let gesture = gestures.get(gestureKey);
      if (!gesture) {
        gesture = createValueGesture(apply, control.value);
        gestures.set(gestureKey, gesture);
      }
      gesture.update(value);
    } else {
      const gesture = gestures.get(gestureKey);
      if (gesture) gesture.end(value);
      else apply(value, { commit: true });
      gestures.delete(gestureKey);
    }
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** Formatted knob value with the control's unit. */
function controlDisplay(control: MasteringControl): string {
  const value =
    Math.abs(control.value) >= 100 ? Math.round(control.value) : control.value.toFixed(1);
  return control.unit ? `${value} ${control.unit}` : `${value}`;
}

// --- Drag reorder ----------------------------------------------------------------

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
  runCommand(() => {
    const steps = planChainReorder(chain.value.processors, from, index);
    applyChainReorder(steps, {
      remove: removeMasteringProcessor,
      append: (processor, params) => {
        addMasteringProcessor(processor, params);
      },
      setEnabled: setMasteringEnabled,
    });
  });
  expandedIndex.value = null;
}

function onDragEnd(): void {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

// --- Add processor popover -------------------------------------------------------

const addMenuOpen = ref(false);
const addMenuEl = ref<HTMLDivElement | null>(null);
const catalog = ref<InsertCatalogGroup[]>([]);

function toggleAddMenu(): void {
  if (!addMenuOpen.value) {
    catalog.value = groupInsertCatalog(loadInsertCatalog());
  }
  addMenuOpen.value = !addMenuOpen.value;
}

function onAddProcessor(processorId: string): void {
  addMenuOpen.value = false;
  runCommand(() => {
    expandedIndex.value = addMasteringProcessor(processorId);
  });
}

// --- Popover dismiss -------------------------------------------------------------

function onDocumentPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node)) return;
  if (!addMenuEl.value?.contains(event.target)) addMenuOpen.value = false;
  if (!presetMenuEl.value?.contains(event.target)) presetMenuOpen.value = false;
}

const anyMenuOpen = computed(() => addMenuOpen.value || presetMenuOpen.value);

watch(anyMenuOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown, true);
  else document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

// --- Preview ---------------------------------------------------------------------

const previewState = shallowRef<MasteringPreviewState>();

const controller = createMasteringPreviewController({
  render: (doc, options, onProgress) =>
    (props.renderMixdown ?? renderMixdownInWorker)(doc, options, onProgress),
  onChange: (state) => {
    previewState.value = state;
  },
});
previewState.value = controller.state();

/** A = chain applied, B = chain bypassed. */
const variant = ref<'processed' | 'bypassed'>('processed');

const activeResult = computed<MixdownResult | null>(() => {
  const state = previewState.value;
  if (!state) return null;
  return variant.value === 'processed' ? state.processed : state.bypassed;
});

/** Bumped on any project change that could affect the rendered preview. */
const projectRevision = ref(0);
/** projectRevision at the time of the last applied preview render. */
const previewRevision = ref<number | null>(null);

watch(
  [
    () => store.mixer,
    () => store.tracks,
    () => store.clips,
    () => store.tempoSegments,
    () => store.timeSignatures,
    () => [props.loopEnabled, props.loopStartPpq, props.loopEndPpq, props.previewBars],
  ],
  () => {
    projectRevision.value += 1;
  },
  { deep: true },
);

const previewStale = computed(
  () => previewState.value?.status === 'ready' && previewRevision.value !== projectRevision.value,
);

async function onPreview(): Promise<void> {
  let doc: ReturnType<typeof serializeProject>;
  try {
    doc = serializeProject();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return;
  }
  const range = derivePreviewRange(
    {
      enabled: props.loopEnabled,
      startPpq: props.loopStartPpq,
      endPpq: props.loopEndPpq,
    },
    store.timeSignatures,
    props.previewBars,
  );
  const revision = projectRevision.value;
  audioPreview.stop();
  const applied = await controller.request(doc, range);
  if (applied) previewRevision.value = revision;
}

function onCancelPreview(): void {
  controller.cancel();
}

// --- Preview playback (panel-local AudioContext, never the engine) ----------------

const playingId = ref<string | null>(null);

const audioPreview = createAudioPreview({
  onChange: (id) => {
    playingId.value = id;
  },
});

const isPlaying = computed(() => playingId.value !== null);

function playActiveResult(): void {
  const result = activeResult.value;
  if (!result) return;
  audioPreview.play(`mastering-preview:${variant.value}`, {
    channels: result.channels,
    sampleRate: result.sampleRate,
  });
}

function onTogglePlay(): void {
  if (isPlaying.value) audioPreview.stop();
  else playActiveResult();
}

function onSelectVariant(next: 'processed' | 'bypassed'): void {
  if (variant.value === next) return;
  variant.value = next;
  // Keep the A/B comparison seamless: restart playback on the other render.
  if (isPlaying.value) playActiveResult();
}

// --- Loudness readout --------------------------------------------------------------

/** One readout row: label plus the A and B values. */
interface LoudnessRow {
  label: string;
  unit: string;
  a: number | undefined;
  b: number | undefined;
}

const loudnessRows = computed<LoudnessRow[]>(() => {
  const state = previewState.value;
  const a = state?.processed?.report;
  const b = state?.bypassed?.report;
  if (!a && !b) return [];
  return [
    { label: 'Peak', unit: 'dBFS', a: a?.peakDb, b: b?.peakDb },
    { label: 'True peak', unit: 'dBTP', a: a?.truePeakDb, b: b?.truePeakDb },
    { label: 'Loudness', unit: 'LUFS', a: a?.lufs, b: b?.lufs },
  ];
});

const clipWarning = computed(() =>
  isClippingRisk(previewState.value?.processed?.report.truePeakDb),
);

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  controller.dispose();
  audioPreview.dispose();
});
</script>

<template>
  <div class="mastering-panel">
    <div class="mastering-toolbar">
      <span class="mastering-title">MASTERING</span>
      <div ref="presetMenuEl" class="preset-wrap">
        <button
          type="button"
          class="preset-button"
          :class="{ set: chain.preset !== undefined }"
          title="Mastering preset"
          @click="togglePresetMenu"
        >
          {{ presetLabel }} ▾
        </button>
        <div v-if="presetMenuOpen" class="preset-menu" role="menu">
          <input
            v-model="presetQuery"
            type="search"
            class="preset-search"
            placeholder="Search presets…"
            aria-label="Search presets"
          />
          <button type="button" role="menuitem" class="preset-item none" @click="onSelectPreset(null)">
            No preset
          </button>
          <button
            v-for="preset in filteredPresets"
            :key="preset"
            type="button"
            role="menuitem"
            class="preset-item"
            :class="{ active: preset === chain.preset }"
            @click="onSelectPreset(preset)"
          >
            {{ humanizePresetName(preset) }}
          </button>
          <p v-if="filteredPresets.length === 0" class="preset-empty">No matches</p>
        </div>
      </div>
      <span class="toolbar-spacer" />
    </div>
    <p v-if="error" class="mastering-error" role="alert">{{ error }}</p>
    <div class="mastering-body">
      <div class="chain-rack">
        <template v-for="(slot, index) in chain.processors" :key="`${index}:${slot.processor}`">
          <div
            class="chain-slot"
            :class="{
              bypassed: !slot.enabled,
              dragging: dragIndex === index,
              'drop-target': dragOverIndex === index && dragIndex !== index,
            }"
            draggable="true"
            @dragstart="onDragStart(index, $event)"
            @dragover="onDragOver(index, $event)"
            @drop="onDrop(index)"
            @dragend="onDragEnd"
          >
            <span class="chain-drag" title="Drag to reorder">⋮⋮</span>
            <button
              type="button"
              class="chain-power"
              :class="{ on: slot.enabled }"
              :title="slot.enabled ? 'Bypass processor' : 'Enable processor'"
              @click="onToggleEnabled(index)"
            />
            <button
              type="button"
              class="chain-name"
              :class="{ expanded: expandedIndex === index }"
              :title="slot.processor"
              @click="toggleExpanded(index)"
            >
              {{ humanizeInsertName(slot.processor) }}
            </button>
            <span class="chain-badge">{{ categoryLabel(processorCategory(slot.processor)) }}</span>
            <button
              type="button"
              class="chain-remove"
              title="Remove processor"
              @click="onRemove(index)"
            >
              ×
            </button>
          </div>
          <div v-if="expandedIndex === index" class="chain-params">
            <p v-if="expandedControls.length === 0" class="chain-params-empty">No parameters</p>
            <MixerKnob
              v-for="control in expandedControls"
              :key="control.id"
              :value="control.value"
              :min="control.min"
              :max="control.max"
              :label="control.name"
              :display="controlDisplay(control)"
              :size="22"
              @change="(value, commit) => onParamChange(index, control, value, commit)"
            />
          </div>
        </template>
        <div ref="addMenuEl" class="chain-add-wrap">
          <button type="button" class="chain-add" title="Add processor" @click="toggleAddMenu">
            + Processor
          </button>
          <div v-if="addMenuOpen" class="chain-catalog" role="menu">
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
      </div>
      <div class="preview-pane">
        <div class="preview-controls">
          <button
            type="button"
            class="preview-button"
            :disabled="previewState?.status === 'rendering'"
            @click="onPreview"
          >
            Preview
          </button>
          <button
            v-if="previewState?.status === 'rendering'"
            type="button"
            class="preview-cancel"
            @click="onCancelPreview"
          >
            Cancel
          </button>
          <div class="ab-toggle" role="group" aria-label="A/B comparison">
            <button
              type="button"
              class="ab-button"
              :class="{ active: variant === 'processed' }"
              :disabled="!previewState?.processed"
              title="With mastering chain"
              @click="onSelectVariant('processed')"
            >
              A
            </button>
            <button
              type="button"
              class="ab-button"
              :class="{ active: variant === 'bypassed' }"
              :disabled="!previewState?.bypassed"
              title="Chain bypassed"
              @click="onSelectVariant('bypassed')"
            >
              B
            </button>
          </div>
          <button
            type="button"
            class="play-button"
            :disabled="!activeResult"
            @click="onTogglePlay"
          >
            {{ isPlaying ? '■ Stop' : '▶ Play' }}
          </button>
          <span v-if="previewStale" class="preview-stale" title="Project changed since this preview was rendered">
            stale
          </span>
        </div>
        <div v-if="previewState?.status === 'rendering'" class="preview-progress">
          <div class="progress-track">
            <div
              class="progress-fill"
              :style="{ width: `${Math.round((previewState?.progress ?? 0) * 100)}%` }"
            />
          </div>
          <span class="progress-stage">{{ previewState?.stage }}</span>
        </div>
        <p v-if="previewState?.status === 'error'" class="mastering-error" role="alert">
          {{ previewState?.error }}
        </p>
        <div v-if="loudnessRows.length > 0" class="loudness-readout">
          <div class="loudness-head">
            <span class="loudness-label" />
            <span class="loudness-col">A · chain</span>
            <span class="loudness-col">B · bypass</span>
          </div>
          <div v-for="row in loudnessRows" :key="row.label" class="loudness-row">
            <span class="loudness-label">{{ row.label }}</span>
            <span class="loudness-cell">
              <span class="loudness-bar">
                <span class="loudness-fill" :style="{ width: `${loudnessBarFraction(row.a) * 100}%` }" />
              </span>
              <span class="loudness-value">{{ formatLevel(row.a) }} {{ row.unit }}</span>
            </span>
            <span class="loudness-cell">
              <span class="loudness-bar">
                <span class="loudness-fill" :style="{ width: `${loudnessBarFraction(row.b) * 100}%` }" />
              </span>
              <span class="loudness-value">{{ formatLevel(row.b) }} {{ row.unit }}</span>
            </span>
          </div>
          <p v-if="clipWarning" class="clip-warning" role="alert">
            ⚠ True peak above −0.3 dBTP — risk of clipping on lossy encodes
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mastering-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #14161b;
  overflow: hidden;
}

.mastering-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.5);
  flex: none;
}

.mastering-title {
  font: 700 9px system-ui, sans-serif;
  letter-spacing: 0.08em;
  color: #5b6270;
  user-select: none;
}

.toolbar-spacer {
  flex: 1;
}

.preset-wrap {
  position: relative;
}

.preset-button {
  font: 600 10px system-ui, sans-serif;
  color: #8b93a3;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
}

.preset-button.set {
  color: #9fc4f5;
}

.preset-button:hover {
  background: #242832;
}

.preset-menu {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 40;
  width: 170px;
  max-height: 260px;
  overflow-y: auto;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
  padding: 4px;
}

.preset-search {
  width: 100%;
  box-sizing: border-box;
  font: 10px system-ui, sans-serif;
  color: #c8cdd6;
  background: #14161b;
  border: 1px solid #2a2e37;
  border-radius: 3px;
  padding: 2px 5px;
  margin-bottom: 3px;
}

.preset-item {
  display: block;
  width: 100%;
  text-align: left;
  font: 10px system-ui, sans-serif;
  color: #c8cdd6;
  background: transparent;
  border: none;
  padding: 3px 6px;
  border-radius: 3px;
  cursor: pointer;
}

.preset-item:hover {
  background: #242832;
}

.preset-item.active {
  color: #9fc4f5;
}

.preset-item.none {
  color: #8b93a3;
  font-style: italic;
}

.preset-empty {
  margin: 0;
  font: 9px system-ui, sans-serif;
  color: #4a5160;
  padding: 3px 6px;
}

.mastering-error {
  margin: 0;
  padding: 2px 8px;
  background: #3b1219;
  color: #ffb4b4;
  font: 10px/1.4 system-ui, sans-serif;
  flex: none;
}

.mastering-body {
  display: flex;
  gap: 10px;
  flex: 1;
  min-height: 0;
  padding: 6px 8px;
  overflow: auto;
}

.chain-rack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 230px;
  flex: none;
}

.chain-slot {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #1a1d23;
  border: 1px solid #23262e;
  border-radius: 3px;
  padding: 2px 4px;
}

.chain-slot.dragging {
  opacity: 0.5;
}

.chain-slot.drop-target {
  border-color: #9fc4f5;
}

.chain-slot.bypassed .chain-name {
  color: #4a5160;
}

.chain-drag {
  flex: none;
  font: 9px system-ui, sans-serif;
  color: #4a5160;
  cursor: grab;
  user-select: none;
  letter-spacing: -1px;
}

.chain-power {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: 1px solid #3a4150;
  background: transparent;
  padding: 0;
  cursor: pointer;
}

.chain-power.on {
  background: #4ade80;
  border-color: #4ade80;
}

.chain-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font: 10px system-ui, sans-serif;
  color: #c8cdd6;
  background: transparent;
  border: none;
  padding: 1px 0;
  cursor: pointer;
}

.chain-name.expanded {
  color: #9fc4f5;
}

.chain-badge {
  flex: none;
  font: 700 7px system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #5b6270;
  background: #14161b;
  border: 1px solid #23262e;
  border-radius: 2px;
  padding: 1px 3px;
}

.chain-remove {
  flex: none;
  border: none;
  background: transparent;
  color: #5b6270;
  font: 10px system-ui, sans-serif;
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.chain-remove:hover {
  color: #ffb4b4;
}

.chain-params {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  justify-content: center;
  background: #15171c;
  border: 1px solid #23262e;
  border-radius: 3px;
  padding: 4px 2px;
}

.chain-params-empty {
  margin: 0;
  font: 9px system-ui, sans-serif;
  color: #4a5160;
}

.chain-add-wrap {
  position: relative;
}

.chain-add {
  width: 100%;
  font: 600 9px system-ui, sans-serif;
  color: #8b93a3;
  background: transparent;
  border: 1px dashed #2a2e37;
  border-radius: 3px;
  padding: 3px 0;
  cursor: pointer;
}

.chain-add:hover {
  color: #c8cdd6;
  border-color: #3a4150;
}

.chain-catalog {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 30;
  width: 160px;
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

.preview-pane {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.preview-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.preview-button,
.preview-cancel,
.play-button {
  font: 600 10px system-ui, sans-serif;
  color: #c8cdd6;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
}

.preview-button:disabled,
.play-button:disabled {
  color: #4a5160;
  cursor: default;
}

.preview-button:not(:disabled):hover,
.preview-cancel:hover,
.play-button:not(:disabled):hover {
  background: #242832;
}

.ab-toggle {
  display: flex;
}

.ab-button {
  font: 700 10px system-ui, sans-serif;
  color: #8b93a3;
  background: #1d2027;
  border: 1px solid #2a2e37;
  padding: 2px 8px;
  cursor: pointer;
}

.ab-button:first-child {
  border-radius: 4px 0 0 4px;
}

.ab-button:last-child {
  border-radius: 0 4px 4px 0;
  border-left: none;
}

.ab-button.active {
  color: #9fc4f5;
  background: #242c3a;
}

.ab-button:disabled {
  color: #3a4150;
  cursor: default;
}

.preview-stale {
  font: 600 9px system-ui, sans-serif;
  color: #f5c97f;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.preview-progress {
  display: flex;
  align-items: center;
  gap: 6px;
}

.progress-track {
  flex: 1;
  height: 4px;
  background: #1a1d23;
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #9fc4f5;
  transition: width 0.15s linear;
}

.progress-stage {
  flex: none;
  font: 9px system-ui, sans-serif;
  color: #5b6270;
  min-width: 80px;
}

.loudness-readout {
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: #15171c;
  border: 1px solid #23262e;
  border-radius: 3px;
  padding: 5px 6px;
}

.loudness-head,
.loudness-row {
  display: grid;
  grid-template-columns: 60px 1fr 1fr;
  gap: 8px;
  align-items: center;
}

.loudness-col {
  font: 700 8px system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #5b6270;
}

.loudness-label {
  font: 9px system-ui, sans-serif;
  color: #8b93a3;
}

.loudness-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.loudness-bar {
  flex: 1;
  height: 4px;
  background: #1a1d23;
  border-radius: 2px;
  overflow: hidden;
}

.loudness-fill {
  display: block;
  height: 100%;
  background: #4ade80;
}

.loudness-value {
  flex: none;
  font: 9px ui-monospace, monospace;
  color: #c8cdd6;
  min-width: 70px;
  text-align: right;
}

.clip-warning {
  margin: 2px 0 0;
  font: 9px/1.3 system-ui, sans-serif;
  color: #f5c97f;
}
</style>
