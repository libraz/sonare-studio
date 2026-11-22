<script setup lang="ts">
import { computed, ref } from 'vue';
import AssistantPanel from '@/components/mastering/AssistantPanel.vue';
import PresetSelector from '@/components/mastering/PresetSelector.vue';
import PreviewPane from '@/components/mastering/PreviewPane.vue';
import ProcessorRack from '@/components/mastering/ProcessorRack.vue';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { describeError } from '@/lib/errors';
import { createDefaultMasteringChain, type MasteringChainState } from '@/project/mixer';
import { getWasmModule } from '@/project/runtime';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import { hasPresetControlOverride } from '@/ui/mastering/preset-controls';
import type { PreviewRenderFn } from '@/ui/mastering/preview';
import { DEFAULT_PREVIEW_BARS } from '@/ui/mastering/preview-range';
import type { MasteringReferenceAudio } from '@/ui/mastering/reference-audio';
import { useMasteringLoudnessReadout } from '@/ui/mastering/use-mastering-loudness-readout';
import { useMasteringPresetStage } from '@/ui/mastering/use-mastering-preset-stage';
import { useMasteringPreview } from '@/ui/mastering/use-mastering-preview';
import { useMasteringPreviewAnalysis } from '@/ui/mastering/use-mastering-preview-analysis';
import { useMasteringProcessorRack } from '@/ui/mastering/use-mastering-processor-rack';
import type { PreviewContextFactory } from '@/ui/media/preview';

/**
 * Mastering panel for the editor dock: the project mastering chain as an
 * ordered processor rack (preset stage plus drag-reorderable processor
 * slots, each with inline parameter knobs), a short A/B mixdown preview
 * rendered by the export worker, and a loudness readout for the previewed
 * audio. All chain edits go through the undoable mastering commands; preview
 * playback uses a panel-local AudioContext and never touches the engine.
 *
 * The orchestration lives in the src/ui/mastering composables — preset stage,
 * processor rack, preview render and playback, loudness readout and preview
 * analyses. The panel owns the command runner, the popover dismissal and the
 * processor runtime note, and delegates the presentation to the preset
 * selector, assistant, processor rack and preview pane child components.
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
    /** Browser decoder override for reference-comparison tests. */
    decodeReference?: ((file: File) => Promise<MasteringReferenceAudio>) | null;
    /** AudioContext factory override for A/B monitor tests. */
    previewContextFactory?: PreviewContextFactory | null;
  }>(),
  {
    loopEnabled: false,
    loopStartPpq: 0,
    loopEndPpq: 0,
    previewBars: DEFAULT_PREVIEW_BARS,
    renderMixdown: null,
    decodeReference: null,
    previewContextFactory: null,
  },
);

const store = useProjectStore();
const { t } = useI18n();

const chain = computed<MasteringChainState>(
  () => store.mixer.masteringChain ?? createDefaultMasteringChain(),
);

type ProcessorRuntime = 'live-export' | 'preview-export' | 'unknown';

/**
 * The live engine accepts only the names returned by its authoritative insert
 * catalog. The authoritative name API is read directly here so a valid empty
 * array remains an empty set; only an unavailable or malformed API result is
 * shown as unknown rather than guessing from a processor category or the
 * offline catalog.
 */
const realtimeProcessorNames = computed<ReadonlySet<string> | null>(() => {
  if (!store.initialized) return null;
  try {
    const names = getWasmModule().masteringInsertNames();
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) return null;
    return new Set(names);
  } catch {
    return null;
  }
});

function processorRuntime(processor: string): ProcessorRuntime {
  const names = realtimeProcessorNames.value;
  if (!names) return 'unknown';
  return names.has(processor) ? 'live-export' : 'preview-export';
}

const processorRuntimeStates = computed<ProcessorRuntime[]>(() =>
  chain.value.processors.map((slot) => processorRuntime(slot.processor)),
);

const hasUnknownProcessorRuntime = computed(() =>
  processorRuntimeStates.value.some((state) => state === 'unknown'),
);

/** Surfaced when a command or render rejects. */
const error = ref('');

function runCommand(action: () => void): void {
  try {
    action();
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

// --- Preset stage ----------------------------------------------------------------

const presetSelectorRef = ref<InstanceType<typeof PresetSelector> | null>(null);
const {
  presetMenuOpen,
  presetQuery,
  filteredPresets,
  presetLabel,
  togglePresetMenu,
  onSelectPreset,
  PRESET_SECTIONS,
  presetControlSections,
  presetOverrideEntries,
  formatOverrideValue,
  presetControlValue,
  presetControlLabel,
  presetControlHint,
  presetBlocked,
  presetControlBlocked,
  presetControlUnit,
  presetControlMin,
  presetControlMax,
  presetControlStep,
  onPresetControlInput,
  onResetPresetControl,
  onClearPresetOverride,
} = useMasteringPresetStage({ chain, error, runCommand });

// --- Processor rack ------------------------------------------------------------

const processorRackRef = ref<InstanceType<typeof ProcessorRack> | null>(null);
const {
  expandedIndex,
  expandedControls,
  toggleExpanded,
  onToggleEnabled,
  onRemove,
  onParamChange,
  dragIndex,
  dragOverIndex,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMoveProcessor,
  addMenuOpen,
  catalog,
  toggleAddMenu,
  onAddProcessor,
} = useMasteringProcessorRack({ chain, error, runCommand });

// --- Popover dismiss -------------------------------------------------------------

useOutsidePointerDown(
  addMenuOpen,
  (target) => !!processorRackRef.value?.addMenuEl?.contains(target),
  () => {
    addMenuOpen.value = false;
  },
);
useOutsidePointerDown(
  presetMenuOpen,
  (target) => !!presetSelectorRef.value?.root?.contains(target),
  () => {
    presetMenuOpen.value = false;
  },
);

// --- Preview ---------------------------------------------------------------------

const preview = useMasteringPreview({ props, error });
const {
  previewState,
  monoCompatibility,
  variant,
  levelMatchEnabled,
  canPlayPreview,
  previewStale,
  levelMatch,
  onPreview,
  onCancelPreview,
  isPlaying,
  onTogglePlay,
  onSelectVariant,
  onToggleLevelMatch,
  renderError,
} = preview;

const { loudnessRows, clipWarning, clipCensus, targetLimited } = useMasteringLoudnessReadout({
  previewState,
});

// --- Preview analyses ------------------------------------------------------------

const {
  suggestion,
  suggesting,
  suggestionAdjustments,
  suggestBlocked,
  onAutoSuggest,
  streamingTargets,
  streamingPlatforms,
  checkingTargets,
  onCheckTargets,
  onAddStreamingPlatform,
  onRemoveStreamingPlatform,
  onUpdateStreamingPlatform,
  referenceAudio,
  referenceAnalysis,
  analyzingReference,
  compareBlocked,
  onReferenceFile,
  onCompareReference,
} = useMasteringPreviewAnalysis({ props, chain, error, runCommand, preview });
</script>

<template>
  <div class="mastering-panel">
    <div class="mastering-toolbar">
      <span class="mastering-title">{{ t.shell.mastering.title }}</span>
      <PresetSelector
        ref="presetSelectorRef"
        :preset="chain.preset"
        :preset-label="presetLabel"
        :menu-open="presetMenuOpen"
        :query="presetQuery"
        :filtered-presets="filteredPresets"
        @toggle="togglePresetMenu"
        @update:query="presetQuery = $event"
        @select="onSelectPreset"
      />
      <div
        class="mastering-signal-path"
        role="note"
        :aria-label="t.shell.mastering.signalPath.title"
      >
        <span class="mastering-signal-path-title">{{ t.shell.mastering.signalPath.title }}</span>
        <span class="mastering-signal-path-row">
          <span class="mastering-signal-path-label">{{ t.shell.mastering.signalPath.liveLabel }}</span>
          <span>{{ t.shell.mastering.signalPath.live }}</span>
        </span>
        <span class="mastering-signal-path-row">
          <span class="mastering-signal-path-label">{{ t.shell.mastering.signalPath.renderLabel }}</span>
          <span>{{ t.shell.mastering.signalPath.render }}</span>
        </span>
        <span v-if="hasUnknownProcessorRuntime" class="mastering-signal-path-warning">
          {{ t.shell.mastering.signalPath.classificationUnavailable }}
        </span>
      </div>
      <button
        type="button"
        class="assist-button"
        :disabled="!!suggestBlocked"
        v-tooltip="{ text: t.shell.mastering.assistant.title, reason: suggestBlocked }"
        @click="onAutoSuggest"
      >
        <span v-if="suggesting" class="spinner button-spinner" aria-hidden="true" />
        {{ suggesting ? t.shell.mastering.assistant.analyzing : t.shell.mastering.assistant.suggest }}
      </button>
      <span class="toolbar-spacer" />
    </div>
    <p v-if="error" class="mastering-error" role="alert">{{ error }}</p>
    <div class="mastering-body">
      <ProcessorRack
        ref="processorRackRef"
        :processors="chain.processors"
        :expanded-index="expandedIndex"
        :expanded-controls="expandedControls"
        :drag-index="dragIndex"
        :drag-over-index="dragOverIndex"
        :add-menu-open="addMenuOpen"
        :catalog="catalog"
        :processor-runtime="processorRuntimeStates"
        :realtime-processor-ids="realtimeProcessorNames"
        @toggle-enabled="onToggleEnabled"
        @toggle-expanded="toggleExpanded"
        @remove="onRemove"
        @param-change="onParamChange"
        @drag-start="onDragStart"
        @drag-over="onDragOver"
        @drop="onDrop"
        @drag-end="onDragEnd"
        @move="onMoveProcessor"
        @toggle-add-menu="toggleAddMenu"
        @add-processor="onAddProcessor"
      />
      <div class="mastering-workspace">
        <AssistantPanel
          v-if="suggestion"
          :suggestion="suggestion"
          :preset="chain.preset"
          :adjustments="suggestionAdjustments"
        />
        <section class="preset-overrides">
          <div class="preset-overrides-head">
            <span class="preset-overrides-title">
              {{ t.shell.mastering.presetOverrides.title }}
            </span>
            <span v-if="!presetBlocked" class="preset-overrides-note">
              {{ t.shell.mastering.presetOverrides.note }}
            </span>
          </div>
          <p v-if="presetBlocked" class="preset-overrides-empty">
            {{ t.shell.mastering.presetOverrides.needsPreset }}
          </p>
          <div class="preset-control-sections">
            <div
              v-for="section in PRESET_SECTIONS"
              :key="section"
              class="preset-control-section"
            >
              <h3 class="preset-control-section-title">
                {{ t.shell.mastering.presetOverrides[section] }}
              </h3>
              <div
                v-for="descriptor in presetControlSections[section]"
                :key="descriptor.key"
                class="preset-control"
                :class="{
                  overridden: hasPresetControlOverride(descriptor.key, chain.presetOverrides ?? {}),
                  blocked: !!presetControlBlocked[descriptor.key],
                }"
                :data-preset-control="descriptor.key"
                v-tooltip="{
                  text: presetControlHint(descriptor.key),
                  reason: presetControlBlocked[descriptor.key],
                  placement: 'end',
                }"
              >
                <span class="preset-control-label">{{ presetControlLabel(descriptor.key) }}</span>
                <span class="preset-control-input">
                  <input
                    v-if="descriptor.kind === 'boolean'"
                    type="checkbox"
                    :checked="Boolean(presetControlValue(descriptor))"
                    :disabled="!!presetControlBlocked[descriptor.key]"
                    :aria-label="presetControlLabel(descriptor.key)"
                    @change="onPresetControlInput(descriptor.key, $event)"
                  />
                  <select
                    v-else-if="descriptor.kind === 'enum'"
                    :value="presetControlValue(descriptor)"
                    :disabled="!!presetControlBlocked[descriptor.key]"
                    :aria-label="presetControlLabel(descriptor.key)"
                    @change="onPresetControlInput(descriptor.key, $event)"
                  >
                    <option v-for="option in descriptor.options" :key="option" :value="option">
                      {{ option }}
                    </option>
                  </select>
                  <input
                    v-else
                    type="number"
                    :value="presetControlValue(descriptor)"
                    :min="presetControlMin(descriptor)"
                    :max="presetControlMax(descriptor)"
                    :step="presetControlStep(descriptor)"
                    :disabled="!!presetControlBlocked[descriptor.key]"
                    :aria-label="presetControlLabel(descriptor.key)"
                    @change="onPresetControlInput(descriptor.key, $event)"
                  />
                </span>
                <span class="preset-control-unit">{{ presetControlUnit(descriptor) }}</span>
                <button
                  v-if="hasPresetControlOverride(descriptor.key, chain.presetOverrides ?? {})"
                  type="button"
                  class="preset-control-reset"
                  :aria-label="
                    formatMessage(t.shell.mastering.presetOverrides.reset, {
                      label: presetControlLabel(descriptor.key),
                    })
                  "
                  v-tooltip="{
                    text: formatMessage(t.shell.mastering.presetOverrides.reset, {
                      label: presetControlLabel(descriptor.key),
                    }),
                    reason: presetBlocked,
                  }"
                  :disabled="!!presetBlocked"
                  @click="onResetPresetControl(descriptor.key)"
                >
                  ↺
                </button>
              </div>
            </div>
          </div>
          <details v-if="presetOverrideEntries.length > 0" class="preset-override-advanced">
            <summary>
              {{ t.shell.mastering.presetOverrides.advanced }} ({{ presetOverrideEntries.length }})
            </summary>
            <ul class="preset-override-list">
              <li v-for="[key, value] in presetOverrideEntries" :key="key">
                <span class="preset-override-param">{{ key }}</span>
                <span class="preset-override-equals">=</span>
                <span class="preset-override-current">{{ formatOverrideValue(value) }}</span>
                <span class="preset-override-note">
                  {{ t.shell.mastering.presetOverrides.unknownValue }}
                </span>
                <button
                  type="button"
                  class="preset-override-remove"
                  :aria-label="t.shell.mastering.presetOverrides.remove"
                  @click="onClearPresetOverride(key)"
                >
                  ×
                </button>
              </li>
            </ul>
          </details>
        </section>
        <section class="mastering-reference">
          <div class="mastering-reference-head">
            <span class="mastering-reference-title">{{ t.shell.mastering.reference.title }}</span>
            <span class="mastering-reference-note">{{ t.shell.mastering.reference.note }}</span>
          </div>
          <div class="mastering-reference-controls">
            <label
              class="mastering-reference-file"
              v-tooltip="
                referenceAudio
                  ? t.shell.mastering.reference.changeTitle
                  : t.shell.mastering.reference.chooseTitle
              "
            >
              <input
                class="mastering-reference-input"
                type="file"
                accept="audio/*"
                @change="onReferenceFile"
              />
              <span class="mastering-reference-file-button">
                {{ t.shell.mastering.reference.choose }}
              </span>
              <span v-if="referenceAudio" class="mastering-reference-name">
                {{ referenceAudio.name }}
              </span>
            </label>
            <button
              type="button"
              class="mastering-reference-compare"
              :disabled="!!compareBlocked"
              v-tooltip="{ text: t.shell.mastering.reference.compareTitle, reason: compareBlocked }"
              @click="onCompareReference"
            >
              <span v-if="analyzingReference" class="spinner button-spinner" aria-hidden="true" />
              {{ analyzingReference ? t.shell.mastering.reference.analyzing : t.shell.mastering.reference.compare }}
            </button>
          </div>
          <div v-if="referenceAnalysis" class="mastering-reference-results view-enter" role="status">
            <span v-if="referenceAnalysis.loudness">
              {{ referenceAnalysis.loudness.sourceLufs.toFixed(1) }} →
              {{ referenceAnalysis.loudness.referenceLufs.toFixed(1) }} LUFS
              ({{ referenceAnalysis.loudness.gainToMatchDb >= 0 ? '+' : '' }}{{ referenceAnalysis.loudness.gainToMatchDb.toFixed(1) }} dB)
            </span>
            <span v-for="(band, index) in referenceAnalysis.tonalBalance" :key="index">
              {{ Math.round(band.lowHz) }}–{{ Math.round(band.highHz) }} Hz:
              {{ band.deviationDb >= 0 ? '+' : '' }}{{ band.deviationDb.toFixed(1) }} dB
            </span>
          </div>
        </section>
        <PreviewPane
          :rendering="previewState?.status === 'rendering'"
          :progress="previewState?.progress ?? 0"
          :stage="previewState?.stage ?? ''"
          :render-error="renderError"
          :has-processed="!!previewState?.processed"
          :has-bypassed="!!previewState?.bypassed"
          :variant="variant"
          :can-play="canPlayPreview"
          :is-playing="isPlaying"
          :level-match-enabled="levelMatchEnabled"
          :level-match-available="levelMatch.available"
          :processed-level-match-db="levelMatch.processedGainDb"
          :bypassed-level-match-db="levelMatch.bypassedGainDb"
          :stale="previewStale"
          :checking-targets="checkingTargets"
          :streaming-platforms="streamingPlatforms"
          :loudness-rows="loudnessRows"
          :clip-warning="clipWarning"
          :clip-census="clipCensus"
          :target-limited="targetLimited"
          :mono-compatibility="monoCompatibility"
          :streaming-targets="streamingTargets"
          @preview="onPreview"
          @cancel="onCancelPreview"
          @select-variant="onSelectVariant"
          @toggle-play="onTogglePlay"
          @toggle-level-match="onToggleLevelMatch"
          @check-targets="onCheckTargets"
          @add-streaming-platform="onAddStreamingPlatform"
          @remove-streaming-platform="onRemoveStreamingPlatform"
          @update-streaming-platform="onUpdateStreamingPlatform"
        />
      </div>
    </div>
  </div>
</template>

<style scoped src="./mastering-panel.css"></style>
