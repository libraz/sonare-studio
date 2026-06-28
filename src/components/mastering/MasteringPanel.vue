<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import MasteringLoudnessReadout from '@/components/mastering/MasteringLoudnessReadout.vue';
import MixerKnob from '@/components/mixer/MixerKnob.vue';
import CloseIcon from '@/components/shell/CloseIcon.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { renderMixdownInWorker } from '@/export/client';
import type { MixdownResult } from '@/export/mixdown';
import { ensureWasm } from '@/lib/wasm';
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
  type MasteringSuggestion,
  parseMasteringSuggestion,
  suggestedPreset,
} from '@/ui/mastering/assistant';
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
import { parseStreamingPreview, type StreamingTarget } from '@/ui/mastering/streaming';
import { createAudioPreview } from '@/ui/media/preview';
import {
  categoryLabel,
  groupInsertCatalogEntries,
  humanizeInsertName,
  type InsertCatalogGroup,
  loadInsertCatalogEntries,
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

// --- Mastering assistant --------------------------------------------------------

const suggestion = ref<MasteringSuggestion | null>(null);
const suggesting = ref(false);

/** Averages the rendered channels to a mono buffer for the assistant. */
function downmixMono(channels: ReadonlyArray<Float32Array>): Float32Array {
  if (channels.length === 1) return channels[0];
  const frames = channels[0]?.length ?? 0;
  const out = new Float32Array(frames);
  for (const channel of channels) {
    const n = Math.min(frames, channel.length);
    for (let i = 0; i < n; i++) out[i] += channel[i];
  }
  const inv = channels.length === 0 ? 0 : 1 / channels.length;
  for (let i = 0; i < frames; i++) out[i] *= inv;
  return out;
}

/**
 * Analyzes the chain-free (bypassed) render of the preview range with the
 * libsonare mastering assistant and applies its top genre as a preset. The
 * assistant's genre candidates are preset identifiers, so the suggestion maps
 * straight onto the (undoable) preset selector; the alternatives are shown as
 * chips the user can apply instead. Renders a preview first when none is ready.
 */
async function onAutoSuggest(): Promise<void> {
  if (suggesting.value) return;
  suggesting.value = true;
  error.value = '';
  try {
    if (!previewState.value?.bypassed || previewStale.value) await onPreview();
    const source = previewState.value?.bypassed;
    if (!source) {
      if (!error.value) error.value = t.value.shell.mastering.assistant.needsPreview;
      return;
    }
    const wasm = await ensureWasm();
    const suggest = wasm.masteringAssistantSuggest;
    if (typeof suggest !== 'function') {
      error.value = t.value.shell.mastering.assistant.unavailable;
      return;
    }
    const parsed = parseMasteringSuggestion(
      suggest(downmixMono(source.channels), source.sampleRate),
    );
    suggestion.value = parsed;
    if (presetCatalog.value.length === 0) presetCatalog.value = loadMasteringPresetCatalog();
    const preset = suggestedPreset(parsed, presetCatalog.value);
    if (preset) runCommand(() => setMasteringPreset(preset));
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    suggesting.value = false;
  }
}

// --- Streaming targets ----------------------------------------------------------

const streamingTargets = ref<StreamingTarget[] | null>(null);
const checkingTargets = ref(false);

/**
 * Measures the chain-applied (processed) render against the streaming-platform
 * loudness targets (Spotify / Apple Music / YouTube, from the wasm side) and
 * shows, per platform, the normalization gain each would apply and whether that
 * gain risks clipping the ceiling. Renders a preview first when none is ready.
 */
async function onCheckTargets(): Promise<void> {
  if (checkingTargets.value) return;
  checkingTargets.value = true;
  error.value = '';
  try {
    if (!previewState.value?.processed || previewStale.value) await onPreview();
    const source = previewState.value?.processed;
    if (!source) {
      if (!error.value) error.value = t.value.shell.mastering.assistant.needsPreview;
      return;
    }
    const wasm = await ensureWasm();
    const preview = wasm.masteringStreamingPreview;
    if (typeof preview !== 'function') {
      error.value = t.value.shell.mastering.streaming.unavailable;
      return;
    }
    streamingTargets.value = parseStreamingPreview(
      preview(downmixMono(source.channels), source.sampleRate),
    );
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    checkingTargets.value = false;
  }
}

/** Normalization gain with an explicit sign (e.g. '+1.2', '-3.4'). */
function signedGain(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
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
    // The mastering chain runs offline, so it may use the full processor set.
    catalog.value = groupInsertCatalogEntries(loadInsertCatalogEntries('offline'));
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
          <span class="preset-label">{{ presetLabel }}</span>
          <TransportIcon name="chevron-down" class="preset-caret" />
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
      <button
        type="button"
        class="assist-button"
        :disabled="suggesting"
        :title="t.shell.mastering.assistant.title"
        @click="onAutoSuggest"
      >
        {{ suggesting ? t.shell.mastering.assistant.analyzing : t.shell.mastering.assistant.suggest }}
      </button>
      <span class="toolbar-spacer" />
    </div>
    <p v-if="error" class="mastering-error" role="alert">{{ error }}</p>
    <div v-if="suggestion" class="assist-result">
      <div class="assist-candidates">
        <span class="assist-label">{{ t.shell.mastering.assistant.recommended }}</span>
        <button
          v-for="candidate in suggestion.genreCandidates"
          :key="candidate.name"
          type="button"
          class="assist-chip"
          :class="{ active: candidate.name === chain.preset }"
          @click="onSelectPreset(candidate.name)"
        >
          {{ humanizePresetName(candidate.name) }}
          <span class="assist-score">{{ Math.round(candidate.score * 100) }}</span>
        </button>
      </div>
      <ul v-if="suggestion.explanation.length" class="assist-explain">
        <li v-for="(line, index) in suggestion.explanation" :key="index">{{ line }}</li>
      </ul>
      <div v-if="suggestion.profile" class="assist-profile">
        <span>{{
          formatMessage(t.shell.mastering.assistant.lufs, {
            value: suggestion.profile.integratedLufs.toFixed(1),
          })
        }}</span>
        <span>{{
          formatMessage(t.shell.mastering.assistant.lra, {
            value: suggestion.profile.lraLu.toFixed(1),
          })
        }}</span>
        <span>{{
          formatMessage(t.shell.mastering.assistant.truePeak, {
            value: suggestion.profile.truePeakDb.toFixed(1),
          })
        }}</span>
      </div>
    </div>
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
              <svg class="chain-drag-icon" viewBox="0 0 6 10" fill="currentColor" focusable="false">
                <circle cx="1.5" cy="2" r="0.9" />
                <circle cx="4.5" cy="2" r="0.9" />
                <circle cx="1.5" cy="5" r="0.9" />
                <circle cx="4.5" cy="5" r="0.9" />
                <circle cx="1.5" cy="8" r="0.9" />
                <circle cx="4.5" cy="8" r="0.9" />
              </svg>
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
              <CloseIcon class="chain-remove-icon" />
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
                <span class="catalog-item-label">{{ processor.label }}</span>
                <span v-if="processor.stereoOnly" class="catalog-item-tag">{{
                  t.shell.inserts.stereoOnly
                }}</span>
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
            <TransportIcon :name="isPlaying ? 'stop' : 'play'" class="play-icon" />
            <span>{{ isPlaying ? t.shell.mastering.stop : t.shell.mastering.play }}</span>
          </button>
          <span v-if="previewStale" class="preview-stale" :title="t.shell.mastering.staleTitle">
            {{ t.shell.mastering.stale }}
          </span>
          <button
            type="button"
            class="targets-button"
            :disabled="checkingTargets"
            :title="t.shell.mastering.streaming.title"
            @click="onCheckTargets"
          >
            {{ checkingTargets ? t.shell.mastering.streaming.checking : t.shell.mastering.streaming.check }}
          </button>
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
        <table v-if="streamingTargets && streamingTargets.length" class="targets-table">
          <thead>
            <tr>
              <th class="targets-name">{{ t.shell.mastering.streaming.platform }}</th>
              <th>{{ t.shell.mastering.streaming.lufs }}</th>
              <th>{{ t.shell.mastering.streaming.gain }}</th>
              <th>{{ t.shell.mastering.streaming.peak }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="target in streamingTargets" :key="target.name">
              <td class="targets-name">{{ target.name }}</td>
              <td>{{ target.integratedLufs.toFixed(1) }}</td>
              <td>{{ signedGain(target.normalizationGainDb) }}</td>
              <td :class="{ risk: target.ceilingRisk }" :title="target.ceilingRisk ? t.shell.mastering.streaming.ceilingRisk : ''">
                {{ target.truePeakDb.toFixed(1) }}<svg
                  v-if="target.ceilingRisk"
                  class="targets-warn-icon"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                  focusable="false"
                ><path d="M8 2.5 14.5 13.5H1.5Z" /><path d="M8 6.5v3.2" /><path d="M8 11.8v0.2" /></svg>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped src="./mastering-panel.css"></style>
