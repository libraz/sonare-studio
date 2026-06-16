<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import MasteringLoudnessReadout from '@/components/mastering/MasteringLoudnessReadout.vue';
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
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  clampControlValue,
  type MasteringControl,
  masteringProcessorControls,
} from '@/ui/mastering/chain-controls';
import { applyChainReorder, planChainReorder } from '@/ui/mastering/chain-reorder';
import { isClippingRisk } from '@/ui/mastering/loudness';
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
const { t } = useI18n();

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
  return preset !== undefined ? humanizePresetName(preset) : t.value.shell.mastering.noPreset;
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
    { label: t.value.shell.mastering.loudness.peak, unit: 'dBFS', a: a?.peakDb, b: b?.peakDb },
    {
      label: t.value.shell.mastering.loudness.truePeak,
      unit: 'dBTP',
      a: a?.truePeakDb,
      b: b?.truePeakDb,
    },
    { label: t.value.shell.mastering.loudness.loudness, unit: 'LUFS', a: a?.lufs, b: b?.lufs },
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
      <span class="mastering-title">{{ t.shell.mastering.title }}</span>
      <div ref="presetMenuEl" class="preset-wrap">
        <button
          type="button"
          class="preset-button"
          :class="{ set: chain.preset !== undefined }"
          :title="t.shell.mastering.presetTitle"
          aria-haspopup="menu"
          :aria-expanded="presetMenuOpen"
          @click="togglePresetMenu"
        >
          {{ presetLabel }} ▾
        </button>
        <div v-if="presetMenuOpen" class="preset-menu" role="menu">
          <input
            v-model="presetQuery"
            type="search"
            class="preset-search"
            :placeholder="t.shell.mastering.searchPresets"
            :aria-label="t.shell.mastering.searchPresets"
          />
          <button type="button" role="menuitem" class="preset-item none" @click="onSelectPreset(null)">
            {{ t.shell.mastering.noPreset }}
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
          <p v-if="filteredPresets.length === 0" class="preset-empty">
            {{ t.shell.mastering.noMatches }}
          </p>
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
            <span class="chain-drag" :title="t.shell.mastering.dragReorder" aria-hidden="true">
              ⋮⋮
            </span>
            <button
              type="button"
              class="chain-power"
              :class="{ on: slot.enabled }"
              :title="
                slot.enabled ? t.shell.mastering.bypassProcessor : t.shell.mastering.enableProcessor
              "
              :aria-label="
                formatMessage(t.shell.mastering.processorPower, {
                  name: humanizeInsertName(slot.processor),
                })
              "
              :aria-pressed="slot.enabled"
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
              :title="t.shell.mastering.removeProcessor"
              :aria-label="
                formatMessage(t.shell.mastering.removeNamed, {
                  name: humanizeInsertName(slot.processor),
                })
              "
              @click="onRemove(index)"
            >
              ×
            </button>
          </div>
          <div v-if="expandedIndex === index" class="chain-params">
            <p v-if="expandedControls.length === 0" class="chain-params-empty">
              {{ t.shell.mastering.noParameters }}
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
              @change="(value, commit) => onParamChange(index, control, value, commit)"
            />
          </div>
        </template>
        <div ref="addMenuEl" class="chain-add-wrap">
          <button
            type="button"
            class="chain-add"
            :title="t.shell.mastering.addProcessorTitle"
            aria-haspopup="menu"
            :aria-expanded="addMenuOpen"
            @click="toggleAddMenu"
          >
            {{ t.shell.mastering.addProcessor }}
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
            {{ t.shell.mastering.preview }}
          </button>
          <button
            v-if="previewState?.status === 'rendering'"
            type="button"
            class="preview-cancel"
            @click="onCancelPreview"
          >
            {{ t.shell.mastering.cancel }}
          </button>
          <div class="ab-toggle" role="group" :aria-label="t.shell.mastering.abComparison">
            <button
              type="button"
              class="ab-button"
              :class="{ active: variant === 'processed' }"
              :disabled="!previewState?.processed"
              :title="t.shell.mastering.withChain"
              :aria-label="t.shell.mastering.previewWithChain"
              :aria-pressed="variant === 'processed'"
              @click="onSelectVariant('processed')"
            >
              A
            </button>
            <button
              type="button"
              class="ab-button"
              :class="{ active: variant === 'bypassed' }"
              :disabled="!previewState?.bypassed"
              :title="t.shell.mastering.chainBypassed"
              :aria-label="t.shell.mastering.previewBypassed"
              :aria-pressed="variant === 'bypassed'"
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
            {{ isPlaying ? `■ ${t.shell.mastering.stop}` : `▶ ${t.shell.mastering.play}` }}
          </button>
          <span v-if="previewStale" class="preview-stale" :title="t.shell.mastering.staleTitle">
            {{ t.shell.mastering.stale }}
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
        <MasteringLoudnessReadout :rows="loudnessRows" :clip-warning="clipWarning" />
      </div>
    </div>
  </div>
</template>

<style scoped src="./mastering-panel.css"></style>
