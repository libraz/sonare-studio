<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  type AssetVersion,
  createHistory,
  selectVersion,
  type VersionHistoryState,
} from '@/ui/sample-editor/history';
import { MODE_OPTIONS, ROOT_OPTIONS } from '@/ui/sample-editor/scales';
import { selectionReadout } from '@/ui/sample-editor/selection';
import { useSampleMarkers } from '@/ui/sample-editor/use-sample-markers';
import {
  MATCH_EQ_CURVE_HEIGHT,
  MATCH_EQ_CURVE_WIDTH,
  NORMALIZE_TARGET_OPTIONS,
  useSampleOperations,
} from '@/ui/sample-editor/use-sample-operations';
import { useSampleSelection } from '@/ui/sample-editor/use-sample-selection';
import { useSampleViewport } from '@/ui/sample-editor/use-sample-viewport';
import { useSampleWarp } from '@/ui/sample-editor/use-sample-warp';
import {
  loadSampleEditorWasm,
  type SampleEditorWasmOps,
  wasmOpAvailability,
} from '@/ui/sample-editor/wasm-ops';

/**
 * Sample editor panel: shows the full waveform of one stored audio asset
 * (stereo as stacked lanes) with click-drag range selection (shift-click
 * extends), cmd/ctrl+wheel zoom and wheel scroll, and offline operations on
 * the selection (or the whole file when nothing is selected).
 *
 * Editing is non-destructive: every operation stores a NEW asset version
 * (assets are content-addressed and immutable), emits `asset-created`, and
 * switches the editor to the new version. The session-local history list
 * jumps between versions. The component never writes to the project; the
 * shell decides what to do with new versions (see `apply-asset`).
 */

const props = defineProps<{
  /** Id of the stored audio asset to edit. */
  assetId: string;
}>();

const emit = defineEmits<{
  /**
   * A new asset version was stored by an edit. The shell may rebind project
   * clips from the source asset to the new one (or ignore the event).
   */
  'asset-created': [newAssetId: string, sourceAssetId: string];
  /** The user asked to use the currently shown version in the project. */
  'apply-asset': [assetId: string];
}>();

const { t } = useI18n();

const asset = shallowRef<LoadedAudioAsset | null>(null);
const currentAssetId = ref(props.assetId);
const historyState = ref<VersionHistoryState>(
  createHistory({ assetId: props.assetId, label: t.value.shell.sampleEditor.ops.original }),
);
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const wasmOps = shallowRef<SampleEditorWasmOps | null>(null);
const wasmAvail = computed(() => wasmOpAvailability(wasmOps.value));

const markers = useSampleMarkers({
  wasmOps: () => wasmOps.value,
  asset: () => asset.value,
  silenceThresholdInput: () => operations.silenceThresholdInput.value,
  setError: (message) => {
    error.value = message;
  },
  clearError: () => {
    error.value = null;
  },
});
const { onsetFrames } = markers;

const selectionControls = useSampleSelection({
  asset,
  onsetFrames,
  getViewport: () => viewportControls.getViewport(),
  localX: (event) => viewportControls.localX(event),
  frameAtPointer: (view, x) => viewportControls.frameAtPointer(view, x),
});
const { selection, selRange, onPointerDown, onPointerMove, onPointerUp } = selectionControls;

const viewportControls = useSampleViewport({
  asset,
  selection,
  onsetFrames,
  selRange: () => selRange.value,
});
const { wrapRef, canvasRef, scheduleDraw, zoomToFit, onWheel } = viewportControls;

const { onDetectTransients, onSplitSilence, onClearTransients } = markers;

const operations = useSampleOperations({
  asset,
  currentAssetId,
  historyState,
  busy,
  loading,
  error,
  wasmOps,
  selRange: () => selRange.value,
  loadCurrent,
  emitAssetCreated: (newAssetId, sourceAssetId) => emit('asset-created', newAssetId, sourceAssetId),
  clearSelection: () => {
    selection.value = null;
  },
});
const {
  gainDbInput,
  normalizeTargetInput,
  pitchInput,
  tuneNoteInput,
  scaleRootInput,
  scaleModeInput,
  voicePitchInput,
  voiceFormantInput,
  stretchInput,
  silenceThresholdInput,
  roomPresetId,
  roomWetInput,
  referenceAssetId,
  matchEqAmountInput,
  matchEqAnalysis,
  analyzingMatchEq,
  opsDisabled,
  referenceOptions,
  roomPresetOptions,
  matchEqCurvePoints,
  onGain,
  onNormalize,
  onFadeIn,
  onFadeOut,
  onReverse,
  onSilence,
  onTrim,
  onPitchShift,
  onPitchCorrect,
  onTuneReference,
  onScaleCorrect,
  onVoiceChange,
  onTimeStretch,
  onNoteStretch,
  onDeclick,
  onDenoise,
  onHarmonic,
  onPercussive,
  onPlaceInRoom,
  onMatchEq,
  onAnalyzeMatchEq,
} = operations;

const readout = computed(() => {
  const meta = asset.value?.meta;
  if (!meta) return '';
  return selectionReadout(selRange.value, meta.numFrames, meta.sampleRate);
});
const assetInfo = computed(() => {
  const meta = asset.value?.meta;
  if (!meta) return '';
  const channels =
    meta.numChannels === 1 ? 'mono' : meta.numChannels === 2 ? 'stereo' : `${meta.numChannels} ch`;
  return `${channels} · ${meta.sampleRate} Hz`;
});

// --- Loading ---------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadCurrent(assetId: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const loaded = await loadAsset(assetId);
    asset.value = loaded;
    // Markers belong to the previous buffer; a new version invalidates them.
    onsetFrames.value = [];
    viewportControls.syncViewportToFrames(loaded.meta.numFrames);
    selectionControls.clampSelectionTo(loaded.meta.numFrames);
  } catch (err) {
    asset.value = null;
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
    scheduleDraw();
  }
}

watch(
  () => props.assetId,
  (assetId) => {
    if (assetId === currentAssetId.value) return;
    currentAssetId.value = assetId;
    historyState.value = createHistory({
      assetId,
      label: t.value.shell.sampleEditor.ops.original,
    });
    selection.value = null;
    viewportControls.resetViewport();
    void loadCurrent(assetId);
  },
);

// The current asset cannot be its own reference; keep the picker list fresh
// (new edited versions become selectable references too).
watch(currentAssetId, (id) => {
  if (referenceAssetId.value === id) referenceAssetId.value = '';
  void operations.refreshReferenceAssets();
});

// --- History / apply ----------------------------------------------------------

async function onSelectVersion(index: number): Promise<void> {
  if (busy.value || index === historyState.value.currentIndex) return;
  historyState.value = selectVersion(historyState.value, index);
  const version = historyState.value.versions[index];
  currentAssetId.value = version.assetId;
  await loadCurrent(version.assetId);
}

function onApply(): void {
  if (asset.value) emit('apply-asset', currentAssetId.value);
}

function versionTitle(version: AssetVersion): string {
  return `${version.label} — ${version.assetId}`;
}

// --- Clip warp (tempo follow) ---------------------------------------------------

const project = useProjectStore();

const warp = useSampleWarp({
  project,
  assetId: () => props.assetId,
  setError: (message) => {
    error.value = message;
  },
});
const {
  warpClip,
  warpEnabled,
  warpAnchors,
  warpRatioHint,
  warpBpmInput,
  onToggleWarp,
  onWarpBpmChange,
  onAnchorEdit,
  onRemoveAnchor,
  onAddAnchor,
} = warp;

// --- Lifecycle -----------------------------------------------------------------

onMounted(() => {
  void loadCurrent(props.assetId);
  void operations.refreshReferenceAssets();
  void loadSampleEditorWasm().then((ops) => {
    wasmOps.value = ops;
  });
});
</script>

<template>
  <div class="sample-editor">
    <div class="toolbar">
      <span class="asset-name" v-tooltip="currentAssetId">
        {{ asset?.meta.name ?? t.shell.sampleEditor.loading }}
      </span>
      <span v-if="assetInfo" class="asset-info">{{ assetInfo }}</span>
      <span class="readout">{{ readout }}</span>
      <span class="spacer" />
      <button type="button" :disabled="!asset" @click="zoomToFit">
        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {{ t.shell.sampleEditor.fit }}
      </button>
      <button
        type="button"
        :disabled="!asset"
        v-tooltip="t.shell.sampleEditor.useInProjectTitle"
        @click="onApply"
      >
        {{ t.shell.sampleEditor.useInProject }}
      </button>
    </div>
    <div class="toolbar ops">
      <label>
        {{ t.shell.sampleEditor.gain }}
        <input v-model="gainDbInput" class="num" type="number" step="0.5" /> dB
      </label>
      <button type="button" :disabled="opsDisabled" @click="onGain">
        {{ t.shell.sampleEditor.apply }}
      </button>
      <span class="sep" />
      <label>
        {{ t.shell.sampleEditor.normalize }}
        <SelectMenu
          v-model="normalizeTargetInput"
          :options="NORMALIZE_TARGET_OPTIONS"
          :aria-label="t.shell.sampleEditor.normalizeTarget"
          size="sm"
        />
      </label>
      <button type="button" :disabled="opsDisabled" @click="onNormalize">
        {{ t.shell.sampleEditor.apply }}
      </button>
      <span class="sep" />
      <button type="button" :disabled="opsDisabled" @click="onFadeIn">
        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2 14 14 2v12Z"
            fill="currentColor"
          />
        </svg>
        {{ t.shell.sampleEditor.fadeIn }}
      </button>
      <button type="button" :disabled="opsDisabled" @click="onFadeOut">
        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2 2 14 14H2Z"
            fill="currentColor"
          />
        </svg>
        {{ t.shell.sampleEditor.fadeOut }}
      </button>
      <button type="button" :disabled="opsDisabled" @click="onReverse">
        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 5h8l-2-2M13 11H5l2 2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {{ t.shell.sampleEditor.reverse }}
      </button>
      <button type="button" :disabled="opsDisabled" @click="onSilence">
        {{ t.shell.sampleEditor.silence }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !selRange"
        v-tooltip="t.shell.sampleEditor.trimTitle"
        @click="onTrim"
      >
        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M14 3 6.5 9M14 13 6.5 7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="4" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.5" />
          <circle cx="4" cy="11" r="2" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
        {{ t.shell.sampleEditor.trim }}
      </button>
      <span class="sep" />
      <label>
        {{ t.shell.sampleEditor.pitch }}
        <input v-model="pitchInput" class="num" type="number" step="1" /> st
      </label>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.pitchShift"
        v-tooltip="
          wasmAvail.pitchShift ? t.shell.sampleEditor.pitchTitle : t.shell.sampleEditor.unavailable
        "
        @click="onPitchShift"
      >
        {{ t.shell.sampleEditor.apply }}
      </button>
      <label>
        {{ t.shell.sampleEditor.tune }}
        <input v-model="tuneNoteInput" class="num" type="text" />
      </label>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.pitchCorrect"
        v-tooltip="
          wasmAvail.pitchCorrect ? t.shell.sampleEditor.tuneTitle : t.shell.sampleEditor.unavailable
        "
        @click="onPitchCorrect"
      >
        {{ t.shell.sampleEditor.apply }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.tuneReference"
        v-tooltip="
          wasmAvail.tuneReference
            ? t.shell.sampleEditor.tuneReferenceTitle
            : t.shell.sampleEditor.unavailable
        "
        @click="onTuneReference"
      >
        {{ t.shell.sampleEditor.tuneReference }}
      </button>
      <label>{{ t.shell.sampleEditor.tuneScale }}</label>
      <SelectMenu
        :model-value="scaleRootInput"
        size="sm"
        :options="ROOT_OPTIONS"
        :disabled="opsDisabled || !wasmAvail.scaleCorrect"
        :aria-label="t.shell.sampleEditor.scaleRoot"
        @change="(value: string) => (scaleRootInput = value)"
      />
      <SelectMenu
        :model-value="scaleModeInput"
        size="sm"
        :options="MODE_OPTIONS"
        :disabled="opsDisabled || !wasmAvail.scaleCorrect"
        :aria-label="t.shell.sampleEditor.scaleMode"
        @change="(value: string) => (scaleModeInput = value)"
      />
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.scaleCorrect"
        v-tooltip="
          wasmAvail.scaleCorrect
            ? t.shell.sampleEditor.tuneScaleTitle
            : t.shell.sampleEditor.unavailable
        "
        @click="onScaleCorrect"
      >
        {{ t.shell.sampleEditor.apply }}
      </button>
      <span class="sep" />
      <label>
        {{ t.shell.sampleEditor.voicePitch }}
        <input v-model="voicePitchInput" class="num" type="number" step="1" /> st
      </label>
      <label>
        {{ t.shell.sampleEditor.voiceFormant }}
        <input v-model="voiceFormantInput" class="num" type="number" step="0.05" min="0.1" /> ×
      </label>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.voiceChange"
        v-tooltip="
          wasmAvail.voiceChange ? t.shell.sampleEditor.voiceTitle : t.shell.sampleEditor.unavailable
        "
        @click="onVoiceChange"
      >
        {{ t.shell.sampleEditor.voice }}
      </button>
      <label>
        {{ t.shell.sampleEditor.stretch }}
        <input v-model="stretchInput" class="num" type="number" step="0.05" min="0.1" /> ×
      </label>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.timeStretch"
        v-tooltip="
          wasmAvail.timeStretch ? t.shell.sampleEditor.stretchTitle : t.shell.sampleEditor.unavailable
        "
        @click="onTimeStretch"
      >
        {{ t.shell.sampleEditor.apply }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.noteStretch"
        v-tooltip="
          wasmAvail.noteStretch
            ? t.shell.sampleEditor.noteStretchTitle
            : t.shell.sampleEditor.unavailable
        "
        @click="onNoteStretch"
      >
        {{ t.shell.sampleEditor.noteStretch }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.declick"
        v-tooltip="
          wasmAvail.declick ? t.shell.sampleEditor.declickTitle : t.shell.sampleEditor.unavailable
        "
        @click="onDeclick"
      >
        {{ t.shell.sampleEditor.declick }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.denoise"
        v-tooltip="
          wasmAvail.denoise ? t.shell.sampleEditor.denoiseTitle : t.shell.sampleEditor.unavailable
        "
        @click="onDenoise"
      >
        {{ t.shell.sampleEditor.denoise }}
      </button>
      <span class="sep" />
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.harmonic"
        v-tooltip="
          wasmAvail.harmonic ? t.shell.sampleEditor.harmonicTitle : t.shell.sampleEditor.unavailable
        "
        @click="onHarmonic"
      >
        {{ t.shell.sampleEditor.harmonic }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.percussive"
        v-tooltip="
          wasmAvail.percussive
            ? t.shell.sampleEditor.percussiveTitle
            : t.shell.sampleEditor.unavailable
        "
        @click="onPercussive"
      >
        {{ t.shell.sampleEditor.percussive }}
      </button>
      <span class="sep" />
      <SelectMenu
        :model-value="referenceAssetId"
        size="sm"
        :options="referenceOptions"
        :disabled="opsDisabled || !wasmAvail.matchEq"
        :aria-label="t.shell.sampleEditor.matchReference"
        @change="(value: string) => (referenceAssetId = value)"
      />
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.matchEq || referenceAssetId === ''"
        v-tooltip="
          wasmAvail.matchEq ? t.shell.sampleEditor.matchEqTitle : t.shell.sampleEditor.unavailable
        "
        @click="onMatchEq"
      >
        {{ t.shell.sampleEditor.matchEq }}
      </button>
      <label v-tooltip="t.shell.sampleEditor.matchEqAmountTitle">
        {{ t.shell.sampleEditor.matchEqAmount }}
        <input
          v-model="matchEqAmountInput"
          class="num"
          type="number"
          step="5"
          min="0"
          max="100"
          :disabled="opsDisabled || !wasmAvail.matchEq"
        />
        %
      </label>
      <button
        type="button"
        :disabled="
          opsDisabled || !wasmAvail.matchEqAnalyze || referenceAssetId === '' || analyzingMatchEq
        "
        v-tooltip="
          wasmAvail.matchEqAnalyze
            ? t.shell.sampleEditor.matchEqAnalyzeTitle
            : t.shell.sampleEditor.unavailable
        "
        @click="onAnalyzeMatchEq"
      >
        {{ t.shell.sampleEditor.matchEqAnalyze }}
      </button>
      <span class="sep" />
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.detectOnsets"
        v-tooltip="
          wasmAvail.detectOnsets
            ? t.shell.sampleEditor.detectTransientsTitle
            : t.shell.sampleEditor.unavailable
        "
        @click="onDetectTransients"
      >
        {{ t.shell.sampleEditor.detectTransients }}
      </button>
      <label>
        {{ t.shell.sampleEditor.silenceThreshold }}
        <input v-model="silenceThresholdInput" class="num" type="number" step="1" min="1" /> dB
      </label>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.splitSilence"
        v-tooltip="
          wasmAvail.splitSilence
            ? t.shell.sampleEditor.splitSilenceTitle
            : t.shell.sampleEditor.unavailable
        "
        @click="onSplitSilence"
      >
        {{ t.shell.sampleEditor.splitSilence }}
      </button>
      <button
        v-if="onsetFrames.length > 0"
        type="button"
        v-tooltip="t.shell.sampleEditor.clearTransientsTitle"
        @click="onClearTransients"
      >
        {{ formatMessage(t.shell.sampleEditor.clearTransients, { count: onsetFrames.length }) }}
      </button>
      <span class="sep" />
      <SelectMenu
        :model-value="roomPresetId"
        size="sm"
        :options="roomPresetOptions"
        :disabled="opsDisabled || !wasmAvail.roomMorph"
        :aria-label="t.shell.sampleEditor.roomPreset"
        @change="(value: string) => (roomPresetId = value)"
      />
      <label v-tooltip="t.shell.sampleEditor.roomWetTitle">
        {{ t.shell.sampleEditor.roomWet }}
        <input
          v-model="roomWetInput"
          class="num"
          type="number"
          step="5"
          min="0"
          max="100"
          :disabled="opsDisabled || !wasmAvail.roomMorph"
        />
        %
      </label>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.roomMorph"
        v-tooltip="
          wasmAvail.roomMorph
            ? t.shell.sampleEditor.placeInRoomTitle
            : t.shell.sampleEditor.unavailable
        "
        @click="onPlaceInRoom"
      >
        {{ t.shell.sampleEditor.placeInRoom }}
      </button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="matchEqAnalysis" class="match-eq-analysis">
      <div class="match-eq-head">
        <span class="match-eq-title">{{ t.shell.sampleEditor.matchEqAnalysisTitle }}</span>
        <span v-if="matchEqAnalysis.loudness" class="match-eq-loudness">
          {{ t.shell.sampleEditor.matchEqLoudness }}:
          {{ matchEqAnalysis.loudness.sourceLufs.toFixed(1) }} →
          {{ matchEqAnalysis.loudness.referenceLufs.toFixed(1) }} LUFS
          ({{ matchEqAnalysis.loudness.gainToMatchDb >= 0 ? '+' : ''
          }}{{ matchEqAnalysis.loudness.gainToMatchDb.toFixed(1) }} dB)
        </span>
      </div>
      <svg
        v-if="matchEqCurvePoints"
        class="match-eq-curve"
        :viewBox="`0 0 ${MATCH_EQ_CURVE_WIDTH} ${MATCH_EQ_CURVE_HEIGHT}`"
        preserveAspectRatio="none"
        role="img"
        :aria-label="t.shell.sampleEditor.matchEqCurveLabel"
      >
        <line
          class="match-eq-zero"
          x1="0"
          :y1="MATCH_EQ_CURVE_HEIGHT / 2"
          :x2="MATCH_EQ_CURVE_WIDTH"
          :y2="MATCH_EQ_CURVE_HEIGHT / 2"
        />
        <polyline class="match-eq-line" :points="matchEqCurvePoints" />
      </svg>
      <ul v-if="matchEqAnalysis.tonalBalance.length > 0" class="match-eq-bands">
        <li
          v-for="(band, index) in matchEqAnalysis.tonalBalance"
          :key="index"
          :class="{ over: band.deviationDb > 0, under: band.deviationDb < 0 }"
        >
          <span class="match-eq-band-hz">{{ Math.round(band.lowHz) }}–{{ Math.round(band.highHz) }} Hz</span>
          <span class="match-eq-band-db">
            {{ band.deviationDb >= 0 ? '+' : '' }}{{ band.deviationDb.toFixed(1) }} dB
          </span>
        </li>
      </ul>
    </div>
    <div
      ref="wrapRef"
      class="wave-wrap"
      tabindex="0"
      :aria-label="t.shell.sampleEditor.waveform"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel.prevent="onWheel"
    >
      <canvas ref="canvasRef" class="wave-canvas" role="img" :aria-label="t.shell.sampleEditor.waveform" />
      <div v-if="busy || loading" class="busy">
        {{ busy ? t.shell.sampleEditor.processing : t.shell.sampleEditor.loading }}
      </div>
      <div v-else-if="!asset" class="empty-state">
        {{ t.shell.sampleEditor.emptyMessage }}
      </div>
    </div>
    <div class="history">
      <span class="history-title">{{ t.shell.sampleEditor.history }}</span>
      <button
        v-for="(version, index) in historyState.versions"
        :key="`${index}-${version.assetId}`"
        type="button"
        class="history-entry"
        :class="{ current: index === historyState.currentIndex }"
        :disabled="busy"
        v-tooltip="versionTitle(version)"
        @click="onSelectVersion(index)"
      >
        {{ version.label }}
      </button>
    </div>
    <div v-if="warpClip" class="warp">
      <div class="toolbar">
        <span class="warp-title">{{ t.shell.sampleEditor.warp }}</span>
        <ToggleButton
          :model-value="warpEnabled"
          :label="t.shell.sampleEditor.followTempo"
          :title="t.shell.sampleEditor.warpTitle"
          size="sm"
          @update:model-value="onToggleWarp"
        />
        <label>
          {{ t.shell.sampleEditor.sourceBpm }}
          <input
            v-model="warpBpmInput"
            class="num warp-source-bpm"
            type="number"
            step="0.1"
            min="1"
            @change="onWarpBpmChange"
          />
        </label>
        <button type="button" class="warp-anchor-add" @click="onAddAnchor">
          {{ t.shell.sampleEditor.addAnchor }}
        </button>
        <span
          v-if="warpRatioHint"
          class="warp-segments"
          v-tooltip="t.shell.sampleEditor.ratioTitle"
        >
          {{ warpRatioHint }}
        </span>
      </div>
      <div
        v-for="(anchor, index) in warpAnchors"
        :key="`${index}-${anchor.ppq}`"
        class="toolbar warp-anchor"
      >
        <label>
          {{ t.shell.sampleEditor.beat }}
          <input
            class="num"
            type="number"
            step="0.25"
            :value="anchor.ppq"
            @change="onAnchorEdit(index, 'ppq', $event)"
          />
        </label>
        <label>
          {{ t.shell.sampleEditor.sourceSeconds }}
          <input
            class="num"
            type="number"
            step="0.01"
            :value="anchor.sourceSeconds"
            @change="onAnchorEdit(index, 'sourceSeconds', $event)"
          />
        </label>
        <button
          type="button"
          class="warp-anchor-remove"
          v-tooltip="t.shell.sampleEditor.removeAnchorTitle"
          @click="onRemoveAnchor(index)"
        >
          {{ t.shell.sampleEditor.remove }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sample-editor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
  color: var(--text-2);
  font: var(--fs-sm) var(--font-sans);
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
}

.toolbar label {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  white-space: nowrap;
}

.toolbar .num {
  width: 56px;
  /* Steady digit width so scrubbed numeric values don't jitter. */
  font-variant-numeric: tabular-nums;
}

/* Dense pro-tool controls on the shared raised-face recipe (no drawn border). */
.toolbar input {
  background: var(--surface-inset);
  color: var(--text-1);
  border: none;
  border-radius: var(--radius-md);
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  box-shadow: var(--control-edge), var(--inset-well);
}

.toolbar button {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  background: var(--control-bg);
  color: var(--text-1);
  border: none;
  border-radius: var(--radius-md);
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition:
    background-color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out);
}

/* Inline glyph that scans by shape; inherits the button's text color. */
.btn-icon {
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--text-3);
}

.toolbar button:not(:disabled):hover .btn-icon {
  color: currentColor;
}

.toolbar button:disabled .btn-icon {
  color: currentColor;
}

.toolbar button:disabled {
  color: var(--text-4);
  box-shadow: var(--control-edge);
  cursor: default;
}

.toolbar button:not(:disabled):hover {
  background: var(--control-bg-hover);
  box-shadow: var(--control-lift-hover);
}

.asset-name {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.asset-info {
  color: var(--text-3);
}

.readout {
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.spacer {
  flex: 1;
}

.sep {
  width: 1px;
  align-self: stretch;
  background: var(--border);
}

.error {
  margin: 0;
  color: var(--danger);
}

.match-eq-analysis {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-inset);
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.match-eq-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-4);
  justify-content: space-between;
}

.match-eq-title {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.match-eq-loudness {
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.match-eq-curve {
  width: 100%;
  height: 64px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.match-eq-zero {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.match-eq-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.match-eq-bands {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-5);
  margin: 0;
  padding: 0;
  list-style: none;
  font-variant-numeric: tabular-nums;
}

.match-eq-bands li {
  display: flex;
  gap: var(--sp-2);
  color: var(--text-3);
}

.match-eq-bands li.over .match-eq-band-db {
  color: var(--warning);
}

.match-eq-bands li.under .match-eq-band-db {
  color: var(--accent);
}

.wave-wrap {
  position: relative;
  min-height: 96px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  touch-action: none;
  cursor: text;
  box-shadow: var(--inset-well);
}

.wave-wrap:focus-visible {
  outline: 2px solid transparent; /* visible under forced-colors mode */
  box-shadow: var(--inset-well), var(--ring);
}

.wave-canvas {
  display: block;
  width: 100%;
}

.busy {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  color: var(--text-1);
}

/* No-asset guidance over the empty dark canvas (keeps the canvas aesthetic). */
.empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--sp-5);
  text-align: center;
  color: var(--text-3);
  font-size: var(--fs-sm);
  pointer-events: none;
}

.history {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.history-title {
  color: var(--text-3);
  margin-right: 2px;
}

.history-entry {
  background: var(--control-bg);
  color: var(--text-2);
  border: none;
  border-radius: var(--radius-md);
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition:
    background-color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out);
}

.history-entry:not(:disabled):hover {
  background: var(--control-bg-hover);
  box-shadow: var(--control-lift-hover);
}

.history-entry.current {
  background: var(--surface-selected);
  color: var(--text-1);
  box-shadow: inset 0 0 0 1px var(--accent), var(--control-edge);
}

.history-entry:disabled {
  color: var(--text-4);
  box-shadow: var(--control-edge);
  cursor: default;
}

.warp {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  border-top: 1px solid var(--border);
  padding-top: var(--sp-3);
}

.warp-title {
  color: var(--text-3);
  font-weight: var(--fw-semibold);
  margin-right: 2px;
}

.warp-segments {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.warp-anchor {
  padding-left: 14px;
}
</style>
