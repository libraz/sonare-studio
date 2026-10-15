<script lang="ts">
import { ref as moduleRef } from 'vue';
import { errorMessage } from '@/lib/errors';

/** Operation groups shown as tabs above the operation toolbar. */
const OPS_GROUPS = [
  'edit',
  'pitch',
  'time',
  'repair',
  'spectral',
  'match',
  'markers',
  'room',
] as const;
type OpsGroup = (typeof OPS_GROUPS)[number];

// Module scope: the editor remounts per clip, and the chosen group should survive that.
const lastOpsGroup = moduleRef<OpsGroup>('edit');
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import BusyIndicator from '@/components/shell/BusyIndicator.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useNoteNames } from '@/composables/useNoteNames';
import { leaseAudioAssets } from '@/persistence/asset-leases';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatChannels, formatSampleRate } from '@/ui/media/asset-list';
import {
  type AssetVersion,
  createHistory,
  selectVersion,
  type VersionHistoryState,
} from '@/ui/sample-editor/history';
import { formatMidiNote } from '@/ui/sample-editor/note-names';
import { declipWithheld, repairChannelSummaries } from '@/ui/sample-editor/repair-analysis';
import { MODE_OPTIONS, rootOptions } from '@/ui/sample-editor/scales';
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
  roomEstimateHasGeometry,
  type SampleEditorWasmOps,
  type SpectralEditMode,
  type WasmOpAvailability,
  wasmOpAvailability,
} from '@/ui/sample-editor/wasm-ops';
import type { MasteringRepairStageName } from '@/wasm/index.js';

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
const { system: noteNameSystem } = useNoteNames();

/** Scale-root choices in the selected note-name system. */
const ROOT_OPTIONS = computed(() => rootOptions(noteNameSystem.value));
const project = useProjectStore();

const asset = shallowRef<LoadedAudioAsset | null>(null);
const currentAssetId = ref(props.assetId);
const historyState = ref<VersionHistoryState>(
  createHistory({ assetId: props.assetId, label: t.value.shell.sampleEditor.ops.original }),
);
const historyLease = leaseAudioAssets(
  historyState.value.versions.map((version) => version.assetId),
);
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
let disposed = false;
let loadGeneration = 0;

const wasmOps = shallowRef<SampleEditorWasmOps | null>(null);
const wasmFailed = ref(false);
const wasmAvail = computed(() => wasmOpAvailability(wasmOps.value));

const markers = useSampleMarkers({
  wasmOps: () => wasmOps.value,
  asset: () => asset.value,
  silenceThresholdInput: () => operations.silenceThresholdInput.value,
  busy,
  setError: (message) => {
    error.value = message;
  },
  clearError: () => {
    error.value = null;
  },
});
const { onsetFrames, noteRegions } = markers;

const selectionControls = useSampleSelection({
  asset,
  onsetFrames,
  getViewport: () => viewportControls.getViewport(),
  localX: (event) => viewportControls.localX(event),
  frameAtPointer: (view, x) => viewportControls.frameAtPointer(view, x),
});
const {
  selection,
  selRange,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown: onSelectionKeyDown,
  selectAll: selectAllSelection,
  setSelectionRange,
} = selectionControls;

const viewportControls = useSampleViewport({
  asset,
  selection,
  onsetFrames,
  noteRegions,
  formatNote: (midi) => formatMidiNote(midi, noteNameSystem.value),
  selRange: () => selRange.value,
});
const { wrapRef, canvasRef, scheduleDraw, zoomToFit, onWheel } = viewportControls;

const { onDetectTransients, onDetectNotes, onSplitSilence, onClearTransients } = markers;

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
  isDisposed: () => disposed,
  getProjectGeneration: () => project.documentGeneration,
});
const {
  notices,
  resultStatus,
  gainDbInput,
  normalizeTargetInput,
  pitchInput,
  tuneNoteInput,
  scaleRootInput,
  scaleModeInput,
  voicePitchInput,
  voiceFormantInput,
  voiceFormantAbsolute,
  autoTuneDetect,
  autoTuneStrengthInput,
  stretchInput,
  noteShiftMsInput,
  silenceThresholdInput,
  spectralLowHzInput,
  spectralHighHzInput,
  spectralGainDbInput,
  spectralModeInput,
  roomPresetId,
  restorePresetId,
  restorePresetOptions,
  selectRestorePreset,
  roomWetInput,
  roomAirAbsorption,
  referenceAssetId,
  matchEqAmountInput,
  matchEqAnalysis,
  analyzingMatchEq,
  roomEstimate,
  estimatingRoom,
  acousticAnalysis,
  analyzingAcoustic,
  repairAnalysis,
  repairStageChecked,
  analyzingRepair,
  setRepairStageChecked,
  referenceOptions,
  roomPresetOptions,
  spectralModeOptions,
  matchEqCurvePoints,
  onGain,
  onNormalize,
  onFadeIn,
  onFadeOut,
  onReverse,
  onSilence,
  onTrim,
  onDelete,
  onDuplicate,
  onPitchShift,
  onPitchCorrect,
  onPitchCorrectTimevarying,
  onTuneReference,
  onScaleCorrect,
  onAutoTune,
  onVoiceChange,
  onTimeStretch,
  onNoteStretch,
  onNoteMove,
  onDeclick,
  onDenoise,
  denoiseDepthInput,
  onRestore,
  onDeclip,
  onDecrackle,
  onDehum,
  onDereverb,
  onTrimSilenceRepair,
  onAnalyzeRepair,
  onApplyRepair,
  onHarmonic,
  onPercussive,
  onSpectralDenoise,
  onSpectralEdit,
  onPlaceInRoom,
  onSynthesizeRir,
  onEstimateRoom,
  onAnalyzeImpulseResponse,
  onDetectAcoustic,
  onMatchEq,
  onAnalyzeMatchEq,
} = operations;

const repairSummaries = computed(() =>
  repairAnalysis.value ? repairChannelSummaries(repairAnalysis.value) : [],
);
const repairAnyChecked = computed(
  () =>
    repairAnalysis.value?.recommended.some((stage) => repairStageChecked.value[stage.stage]) ??
    false,
);

/** Tooltip of a repair stage toggle: the single-stage button's description. */
function repairStageTitle(stage: MasteringRepairStageName): string {
  const text = t.value.shell.sampleEditor;
  const titles: Record<MasteringRepairStageName, string> = {
    declip: text.declipTitle,
    declick: text.declickTitle,
    decrackle: text.decrackleTitle,
    dehum: text.dehumTitle,
    denoise: text.denoiseTitle,
    dereverb: text.dereverbTitle,
  };
  return titles[stage];
}

const readout = computed(() => {
  const meta = asset.value?.meta;
  if (!meta) return '';
  return selectionReadout(selRange.value, meta.numFrames, meta.sampleRate);
});
const selectionStartFrame = computed(() => selRange.value?.startFrame ?? 0);
const selectionEndFrame = computed(
  () => selRange.value?.endFrame ?? asset.value?.meta.numFrames ?? 0,
);

function onSelectionBoundaryInput(boundary: 'start' | 'end', event: Event): void {
  const totalFrames = asset.value?.meta.numFrames;
  if (totalFrames === undefined) return;
  const frame = Number((event.target as HTMLInputElement).value);
  const current = selRange.value ?? { startFrame: 0, endFrame: totalFrames };
  setSelectionRange(
    boundary === 'start' ? frame : current.startFrame,
    boundary === 'end' ? frame : current.endFrame,
  );
}

function clearSelection(): void {
  selection.value = null;
}
const assetInfo = computed(() => {
  const meta = asset.value?.meta;
  if (!meta) return '';
  return `${formatChannels(meta.numChannels)} · ${formatSampleRate(meta.sampleRate)}`;
});

// --- Loading ---------------------------------------------------------------

async function loadCurrent(assetId: string): Promise<void> {
  const generation = ++loadGeneration;
  loading.value = true;
  error.value = null;
  try {
    const loaded = await loadAsset(assetId);
    if (disposed || generation !== loadGeneration) return;
    asset.value = loaded;
    // Markers belong to the previous buffer; a new version invalidates them.
    onsetFrames.value = [];
    noteRegions.value = [];
    viewportControls.syncViewportToFrames(loaded.meta.numFrames);
    selectionControls.clampSelectionTo(loaded.meta.numFrames);
  } catch (err) {
    if (disposed || generation !== loadGeneration) return;
    asset.value = null;
    error.value = errorMessage(err);
  } finally {
    if (!disposed && generation === loadGeneration) {
      loading.value = false;
      scheduleDraw();
    }
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

watch(
  historyState,
  (history) => historyLease.update(history.versions.map((version) => version.assetId)),
  { flush: 'sync' },
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

/** Handles waveform-local selection keys and version-history undo/redo. */
function onWaveKeyDown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    // The sample editor's immutable asset history is deliberately separate
    // from project history. Consume this even at either history boundary so a
    // waveform-focused shortcut can never undo an unrelated arrangement edit.
    event.preventDefault();
    const delta = event.shiftKey ? 1 : -1;
    const targetIndex = historyState.value.currentIndex + delta;
    if (targetIndex >= 0 && targetIndex < historyState.value.versions.length) {
      void onSelectVersion(targetIndex);
    }
    return;
  }
  onSelectionKeyDown(event);
}

function onApply(): void {
  if (asset.value) emit('apply-asset', currentAssetId.value);
}

function setSpectralMode(value: string): void {
  spectralModeInput.value = value as SpectralEditMode;
}

function versionTitle(version: AssetVersion): string {
  return `${version.label} — ${version.assetId}`;
}

// --- Clip warp (tempo follow) ---------------------------------------------------

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
  nextWarpAnchor,
  onToggleWarp,
  onWarpBpmChange,
  onAnchorEdit,
  onRemoveAnchor,
  onAddAnchor,
  onAutoWarp,
} = warp;

// --- Availability gates ---------------------------------------------------------

const se = computed(() => t.value.shell.sampleEditor);

/** Gates anything that reads the loaded audio (view, selection, apply). */
const assetBlocked = computed(() =>
  firstBlock([loading.value, se.value.reasons.loading], [!asset.value, se.value.reasons.loadFailed]),
);

/** Gates every operation that writes a new version or runs an analysis. */
const editBlocked = computed(() =>
  firstBlock(
    assetBlocked.value,
    [asset.value?.meta.numFrames === 0, se.value.reasons.emptyAudio],
    [busy.value, t.value.reasons.busy],
  ),
);

type OpKey = keyof WasmOpAvailability;

/** Per-operation gate: the edit gate, then whether this build provides the processor. */
const opBlocked = computed(() => {
  const tools = firstBlock(
    [wasmFailed.value, se.value.reasons.toolsFailed],
    [!wasmOps.value, se.value.reasons.toolsLoading],
  );
  const gates = {} as Record<OpKey, string | null>;
  for (const key of Object.keys(wasmAvail.value) as OpKey[]) {
    gates[key] = firstBlock(editBlocked.value, tools, [!wasmAvail.value[key], se.value.unavailable]);
  }
  return gates;
});

const selectionBlocked = computed(() =>
  firstBlock([!selRange.value, se.value.reasons.noSelection]),
);
const selectionIsWhole = computed(() => {
  const range = selRange.value;
  const total = asset.value?.meta.numFrames ?? 0;
  return range !== null && range.startFrame <= 0 && range.endFrame >= total;
});

const clearSelectionBlocked = computed(() =>
  firstBlock(assetBlocked.value, selectionBlocked.value),
);
const applyBlocked = computed(() =>
  firstBlock(
    assetBlocked.value,
    [busy.value, t.value.reasons.busy],
    [project.activeClip?.assetId === currentAssetId.value, se.value.reasons.alreadyInUse],
  ),
);
const trimBlocked = computed(() =>
  firstBlock(editBlocked.value, selectionBlocked.value, [
    selectionIsWhole.value,
    se.value.reasons.selectionIsWhole,
  ]),
);
const deleteBlocked = computed(() =>
  firstBlock(editBlocked.value, selectionBlocked.value, [
    selectionIsWhole.value,
    se.value.reasons.deleteWhole,
  ]),
);

// Note stretch and move act on one note, so the whole file is not a valid target.
const noteSelectionBlocked = computed(() =>
  firstBlock([!selRange.value, se.value.reasons.noNoteSelection]),
);
const noteStretchBlocked = computed(() =>
  firstBlock(opBlocked.value.noteStretch, noteSelectionBlocked.value),
);
const noteMoveBlocked = computed(() =>
  firstBlock(opBlocked.value.noteMove, noteSelectionBlocked.value),
);
/** The stretch rate feeds both Stretch and Note; usable while either is. */
const stretchInputBlocked = computed(() =>
  opBlocked.value.timeStretch === null ? null : opBlocked.value.noteStretch,
);

const restoreBlocked = computed(() =>
  firstBlock(opBlocked.value.restore, [
    restorePresetOptions.value.length === 0,
    se.value.unavailable,
  ]),
);

const analyzeRepairBlocked = computed(() =>
  firstBlock(opBlocked.value.repairSession, [analyzingRepair.value, se.value.reasons.analyzing]),
);
const repairStagesBlocked = computed(() => editBlocked.value);
const applyRepairBlocked = computed(() =>
  firstBlock(repairStagesBlocked.value, [!repairAnyChecked.value, se.value.reasons.noRepairStage]),
);

const spectralGainBlocked = computed(() =>
  firstBlock(opBlocked.value.spectralEdit, [
    spectralModeInput.value === 'mute' || spectralModeInput.value === 'heal',
    se.value.reasons.spectralGainUnused,
  ]),
);

/** The reference picker list holds a placeholder plus every other stored asset. */
const referencePickerBlocked = computed(() =>
  firstBlock(opBlocked.value.matchEq, [
    referenceOptions.value.length <= 1,
    se.value.reasons.noReferenceAssets,
  ]),
);
const noReferenceGate = computed(() =>
  firstBlock([referenceAssetId.value === '', se.value.reasons.noReference]),
);
const matchEqBlocked = computed(() =>
  firstBlock(referencePickerBlocked.value, noReferenceGate.value),
);
const matchEqAnalyzeBlocked = computed(() =>
  firstBlock(
    opBlocked.value.matchEqAnalyze,
    referencePickerBlocked.value,
    noReferenceGate.value,
    [analyzingMatchEq.value, se.value.reasons.analyzing],
  ),
);

const estimateRoomBlocked = computed(() =>
  firstBlock(opBlocked.value.estimateRoom, [estimatingRoom.value, se.value.reasons.analyzing]),
);
const analyzeImpulseBlocked = computed(() =>
  firstBlock(opBlocked.value.analyzeImpulseResponse, [
    analyzingAcoustic.value,
    se.value.reasons.analyzing,
  ]),
);
const detectAcousticBlocked = computed(() =>
  firstBlock(opBlocked.value.detectAcoustic, [
    analyzingAcoustic.value,
    se.value.reasons.analyzing,
  ]),
);

const warpOffBlocked = computed(() => firstBlock([!warpEnabled.value, se.value.reasons.warpOff]));
const addAnchorBlocked = computed(() =>
  firstBlock(warpOffBlocked.value, [nextWarpAnchor.value === null, se.value.reasons.noAnchorRoom]),
);

const historyBlocked = computed(() => firstBlock([busy.value, t.value.reasons.busy]));

const opsGroups = OPS_GROUPS;
const opsGroup = lastOpsGroup;

function selectOpsGroup(group: OpsGroup): void {
  opsGroup.value = group;
}

// --- Lifecycle -----------------------------------------------------------------

onMounted(() => {
  void loadCurrent(props.assetId);
  void operations.refreshReferenceAssets();
  void loadSampleEditorWasm().then((ops) => {
    if (disposed) return;
    wasmOps.value = ops;
    wasmFailed.value = ops === null;
  });
});

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration++;
  operations.dispose();
  historyLease.release();
});
</script>

<template>
  <div class="sample-editor">
    <div class="toolbar head">
      <span class="asset-name" v-tooltip="currentAssetId">
        {{ asset?.meta.name ?? se.loading }}
      </span>
      <span v-if="assetInfo" class="asset-info">{{ assetInfo }}</span>
      <span
        class="readout"
        aria-live="polite"
        aria-atomic="true"
        :aria-label="se.selectionStatus"
      >{{ readout }}</span>
      <span class="spacer" />
      <button
        type="button"
        :disabled="!!assetBlocked"
        v-tooltip="{ text: se.fitTitle, reason: assetBlocked }"
        @click="zoomToFit"
      >
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
        {{ se.fit }}
      </button>
      <button
        type="button"
        class="primary"
        :disabled="!!applyBlocked"
        v-tooltip="{ text: se.useInProjectTitle, reason: applyBlocked }"
        @click="onApply"
      >
        {{ se.useInProject }}
      </button>
    </div>
    <div class="toolbar selection-toolbar" role="group" :aria-label="se.selectionRange">
      <span class="selection-title help" v-tooltip="se.selectionKeyboardHelp">
        {{ se.selectionRange }}
      </span>
      <label v-tooltip="{ reason: assetBlocked }">
        {{ se.selectionStart }}
        <input
          class="num frames selection-start"
          type="number"
          min="0"
          :max="asset?.meta.numFrames ?? 0"
          :disabled="!!assetBlocked"
          :value="selectionStartFrame"
          @change="onSelectionBoundaryInput('start', $event)"
        />
      </label>
      <label v-tooltip="{ reason: assetBlocked }">
        {{ se.selectionEnd }}
        <input
          class="num frames selection-end"
          type="number"
          min="0"
          :max="asset?.meta.numFrames ?? 0"
          :disabled="!!assetBlocked"
          :value="selectionEndFrame"
          @change="onSelectionBoundaryInput('end', $event)"
        />
      </label>
      <button
        type="button"
        :disabled="!!assetBlocked"
        v-tooltip="{ text: se.selectAllTitle, reason: assetBlocked }"
        @click="selectAllSelection"
      >
        {{ se.selectAll }}
      </button>
      <button
        type="button"
        :disabled="!!clearSelectionBlocked"
        v-tooltip="{ text: se.clearSelectionTitle, reason: clearSelectionBlocked }"
        @click="clearSelection"
      >
        {{ se.clearSelection }}
      </button>
    </div>
    <div class="ops-panel">
      <div v-tablist class="ops-tabs" role="tablist" :aria-label="se.opsGroupsLabel">
        <button
          v-for="group in opsGroups"
          :key="group"
          type="button"
          class="tab ops-tab"
          :class="{ active: opsGroup === group }"
          role="tab"
          :aria-selected="opsGroup === group"
          @click="selectOpsGroup(group)"
        >
          {{ se.opsGroups[group] }}
        </button>
      </div>

      <div v-show="opsGroup === 'edit'" class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.edit">
        <div class="op-cluster">
          <label v-tooltip="{ text: se.gainTitle, reason: editBlocked }">
            {{ se.gain }}
            <input v-model="gainDbInput" class="num" type="number" step="0.5" :disabled="!!editBlocked" />
            <span class="unit">dB</span>
          </label>
          <button
            type="button"
            :disabled="!!editBlocked"
            v-tooltip="{ text: se.gainTitle, reason: editBlocked }"
            @click="onGain"
          >
            {{ se.apply }}
          </button>
        </div>
        <div class="op-cluster">
          <label>
            {{ se.normalize }}
            <SelectMenu
              v-model="normalizeTargetInput"
              :options="NORMALIZE_TARGET_OPTIONS"
              :aria-label="se.normalizeTarget"
              :disabled="!!editBlocked"
              :reason="editBlocked"
              size="sm"
            />
          </label>
          <button
            type="button"
            :disabled="!!editBlocked"
            v-tooltip="{ text: se.normalizeTitle, reason: editBlocked }"
            @click="onNormalize"
          >
            {{ se.apply }}
          </button>
        </div>
        <div class="op-cluster">
          <button
            type="button"
            :disabled="!!editBlocked"
            v-tooltip="{ text: se.fadeInTitle, reason: editBlocked }"
            @click="onFadeIn"
          >
            <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 14 14 2v12Z" fill="currentColor" />
            </svg>
            {{ se.fadeIn }}
          </button>
          <button
            type="button"
            :disabled="!!editBlocked"
            v-tooltip="{ text: se.fadeOutTitle, reason: editBlocked }"
            @click="onFadeOut"
          >
            <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 2 14 14H2Z" fill="currentColor" />
            </svg>
            {{ se.fadeOut }}
          </button>
          <button
            type="button"
            :disabled="!!editBlocked"
            v-tooltip="{ text: se.reverseTitle, reason: editBlocked }"
            @click="onReverse"
          >
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
            {{ se.reverse }}
          </button>
          <button
            type="button"
            :disabled="!!editBlocked"
            v-tooltip="{ text: se.silenceTitle, reason: editBlocked }"
            @click="onSilence"
          >
            {{ se.silence }}
          </button>
        </div>
        <div class="op-cluster">
          <button
            type="button"
            :disabled="!!trimBlocked"
            v-tooltip="{ text: se.trimTitle, reason: trimBlocked }"
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
            {{ se.trim }}
          </button>
          <button
            type="button"
            :disabled="!!deleteBlocked"
            v-tooltip="{ text: se.deleteTitle, reason: deleteBlocked }"
            @click="onDelete"
          >
            {{ se.delete }}
          </button>
          <button
            type="button"
            :disabled="!!editBlocked"
            v-tooltip="{ text: se.duplicateTitle, reason: editBlocked }"
            @click="onDuplicate"
          >
            {{ se.duplicate }}
          </button>
        </div>
      </div>

      <div v-show="opsGroup === 'pitch'" class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.pitch">
        <div class="op-cluster">
          <label v-tooltip="{ text: se.pitchTitle, reason: opBlocked.pitchShift }">
            {{ se.pitch }}
            <input
              v-model="pitchInput"
              class="num"
              type="number"
              step="1"
              :disabled="!!opBlocked.pitchShift"
            />
            <span class="unit">st</span>
          </label>
          <button
            type="button"
            :disabled="!!opBlocked.pitchShift"
            v-tooltip="{ text: se.pitchTitle, reason: opBlocked.pitchShift }"
            @click="onPitchShift"
          >
            {{ se.apply }}
          </button>
        </div>
        <div class="op-cluster">
          <label v-tooltip="{ text: se.tuneNoteTitle, reason: opBlocked.pitchCorrect }">
            {{ se.tune }}
            <input
              v-model="tuneNoteInput"
              class="num"
              type="text"
              :disabled="!!opBlocked.pitchCorrect"
            />
          </label>
          <button
            type="button"
            :disabled="!!opBlocked.pitchCorrect"
            v-tooltip="{ text: se.tuneTitle, reason: opBlocked.pitchCorrect }"
            @click="onPitchCorrect"
          >
            {{ se.apply }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.pitchCorrectTimevarying"
            v-tooltip="{ text: se.tuneContourTitle, reason: opBlocked.pitchCorrectTimevarying }"
            @click="onPitchCorrectTimevarying"
          >
            {{ se.tuneContour }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.tuneReference"
            v-tooltip="{ text: se.tuneReferenceTitle, reason: opBlocked.tuneReference }"
            @click="onTuneReference"
          >
            {{ se.tuneReference }}
          </button>
        </div>
        <div class="op-cluster">
          <span class="cluster-label">{{ se.tuneScale }}</span>
          <SelectMenu
            :model-value="scaleRootInput"
            size="sm"
            :options="ROOT_OPTIONS"
            :disabled="!!opBlocked.scaleCorrect"
            :reason="opBlocked.scaleCorrect"
            :aria-label="se.scaleRoot"
            @change="(value: string) => (scaleRootInput = value)"
          />
          <SelectMenu
            :model-value="scaleModeInput"
            size="sm"
            :options="MODE_OPTIONS"
            :disabled="!!opBlocked.scaleCorrect"
            :reason="opBlocked.scaleCorrect"
            :aria-label="se.scaleMode"
            @change="(value: string) => (scaleModeInput = value)"
          />
          <button
            type="button"
            :disabled="!!opBlocked.scaleCorrect"
            v-tooltip="{ text: se.tuneScaleTitle, reason: opBlocked.scaleCorrect }"
            @click="onScaleCorrect"
          >
            {{ se.apply }}
          </button>
        </div>
        <div class="op-cluster">
          <ToggleButton
            v-model="autoTuneDetect"
            :label="se.autoTuneDetect"
            :title="se.autoTuneDetectTitle"
            :reason="opBlocked.autoTune"
            size="sm"
          />
          <label v-tooltip="{ text: se.autoTuneStrengthTitle, reason: opBlocked.autoTune }">
            {{ se.autoTuneStrength }}
            <input
              v-model="autoTuneStrengthInput"
              class="num"
              type="number"
              step="5"
              min="0"
              max="100"
              :disabled="!!opBlocked.autoTune"
            />
            <span class="unit">%</span>
          </label>
          <button
            type="button"
            :disabled="!!opBlocked.autoTune"
            v-tooltip="{ text: se.autoTuneTitle, reason: opBlocked.autoTune }"
            @click="onAutoTune"
          >
            {{ se.autoTune }}
          </button>
        </div>
      </div>

      <div v-show="opsGroup === 'time'" class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.time">
        <div class="op-cluster">
          <label v-tooltip="{ text: se.stretchTitle, reason: stretchInputBlocked }">
            {{ se.stretch }}
            <input
              v-model="stretchInput"
              class="num"
              type="number"
              step="0.05"
              min="0.1"
              :disabled="!!stretchInputBlocked"
            />
            <span class="unit">×</span>
          </label>
          <button
            type="button"
            :disabled="!!opBlocked.timeStretch"
            v-tooltip="{ text: se.stretchTitle, reason: opBlocked.timeStretch }"
            @click="onTimeStretch"
          >
            {{ se.apply }}
          </button>
          <button
            type="button"
            :disabled="!!noteStretchBlocked"
            v-tooltip="{ text: se.noteStretchTitle, reason: noteStretchBlocked }"
            @click="onNoteStretch"
          >
            {{ se.noteStretch }}
          </button>
        </div>
        <div class="op-cluster">
          <label v-tooltip="{ text: se.noteMoveTitle, reason: noteMoveBlocked }">
            {{ se.noteShift }}
            <input
              v-model="noteShiftMsInput"
              class="num"
              type="number"
              step="5"
              :disabled="!!noteMoveBlocked"
            />
            <span class="unit">ms</span>
          </label>
          <button
            type="button"
            :disabled="!!noteMoveBlocked"
            v-tooltip="{ text: se.noteMoveTitle, reason: noteMoveBlocked }"
            @click="onNoteMove"
          >
            {{ se.noteMove }}
          </button>
        </div>
        <div class="op-cluster">
          <label v-tooltip="{ reason: opBlocked.voiceChange }">
            {{ se.voicePitch }}
            <input
              v-model="voicePitchInput"
              class="num"
              type="number"
              step="1"
              :disabled="!!opBlocked.voiceChange"
            />
            <span class="unit">st</span>
          </label>
          <label v-tooltip="{ reason: opBlocked.voiceChange }">
            {{ se.voiceFormant }}
            <input
              v-model="voiceFormantInput"
              class="num"
              type="number"
              step="0.05"
              min="0.1"
              :disabled="!!opBlocked.voiceChange"
            />
            <span class="unit">×</span>
          </label>
          <ToggleButton
            v-model="voiceFormantAbsolute"
            :label="se.voiceFormantAbsolute"
            :title="se.voiceFormantAbsoluteTitle"
            :reason="opBlocked.voiceChange"
            size="sm"
          />
          <button
            type="button"
            :disabled="!!opBlocked.voiceChange"
            v-tooltip="{ text: se.voiceTitle, reason: opBlocked.voiceChange }"
            @click="onVoiceChange"
          >
            {{ se.voice }}
          </button>
        </div>
      </div>

      <div v-show="opsGroup === 'repair'" class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.repair">
        <div class="op-cluster">
          <button
            type="button"
            :disabled="!!analyzeRepairBlocked"
            v-tooltip="{ text: se.analyzeRepairTitle, reason: analyzeRepairBlocked }"
            @click="onAnalyzeRepair"
          >
            {{ se.analyzeRepair }}
          </button>
        </div>
        <div class="op-cluster">
          <button
            type="button"
            :disabled="!!opBlocked.declick"
            v-tooltip="{ text: se.declickTitle, reason: opBlocked.declick }"
            @click="onDeclick"
          >
            {{ se.declick }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.declip"
            v-tooltip="{ text: se.declipTitle, reason: opBlocked.declip }"
            @click="onDeclip"
          >
            {{ se.declip }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.decrackle"
            v-tooltip="{ text: se.decrackleTitle, reason: opBlocked.decrackle }"
            @click="onDecrackle"
          >
            {{ se.decrackle }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.dehum"
            v-tooltip="{ text: se.dehumTitle, reason: opBlocked.dehum }"
            @click="onDehum"
          >
            {{ se.dehum }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.dereverb"
            v-tooltip="{ text: se.dereverbTitle, reason: opBlocked.dereverb }"
            @click="onDereverb"
          >
            {{ se.dereverb }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.trimSilence"
            v-tooltip="{ text: se.trimSilenceTitle, reason: opBlocked.trimSilence }"
            @click="onTrimSilenceRepair"
          >
            {{ se.trimSilence }}
          </button>
        </div>
        <div class="op-cluster">
          <label v-tooltip="{ text: se.denoiseDepthTitle, reason: opBlocked.denoise }">
            {{ se.denoiseDepth }}
            <input
              v-model="denoiseDepthInput"
              class="num"
              type="number"
              min="0"
              step="1"
              :disabled="!!opBlocked.denoise"
            />
            <span class="unit">dB</span>
          </label>
          <button
            type="button"
            :disabled="!!opBlocked.denoise"
            v-tooltip="{ text: se.denoiseTitle, reason: opBlocked.denoise }"
            @click="onDenoise"
          >
            {{ se.denoise }}
          </button>
        </div>
        <div class="op-cluster">
          <SelectMenu
            :model-value="restorePresetId"
            size="sm"
            :options="restorePresetOptions"
            :disabled="!!restoreBlocked"
            :reason="restoreBlocked"
            :aria-label="se.restorePreset"
            @change="selectRestorePreset"
          />
          <button
            type="button"
            :disabled="!!restoreBlocked"
            v-tooltip="{ text: se.restoreTitle, reason: restoreBlocked }"
            @click="onRestore"
          >
            {{ se.restore }}
          </button>
        </div>
      </div>

      <div v-show="opsGroup === 'spectral'" class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.spectral">
        <div class="op-cluster">
          <button
            type="button"
            :disabled="!!opBlocked.harmonic"
            v-tooltip="{ text: se.harmonicTitle, reason: opBlocked.harmonic }"
            @click="onHarmonic"
          >
            {{ se.harmonic }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.percussive"
            v-tooltip="{ text: se.percussiveTitle, reason: opBlocked.percussive }"
            @click="onPercussive"
          >
            {{ se.percussive }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.spectralEdit"
            v-tooltip="{ text: se.spectralDenoiseTitle, reason: opBlocked.spectralEdit }"
            @click="onSpectralDenoise"
          >
            {{ se.spectralDenoise }}
          </button>
        </div>
        <div class="op-cluster">
          <SelectMenu
            :model-value="spectralModeInput"
            size="sm"
            :options="spectralModeOptions"
            :disabled="!!opBlocked.spectralEdit"
            :reason="opBlocked.spectralEdit"
            :aria-label="se.spectralMode"
            @change="setSpectralMode"
          />
          <label v-tooltip="{ text: se.spectralLowTitle, reason: opBlocked.spectralEdit }">
            {{ se.spectralLow }}
            <input
              v-model="spectralLowHzInput"
              class="num freq"
              type="number"
              step="100"
              min="0"
              :disabled="!!opBlocked.spectralEdit"
            />
          </label>
          <label v-tooltip="{ text: se.spectralHighTitle, reason: opBlocked.spectralEdit }">
            {{ se.spectralHigh }}
            <input
              v-model="spectralHighHzInput"
              class="num freq"
              type="number"
              step="100"
              min="0"
              :disabled="!!opBlocked.spectralEdit"
            />
            <span class="unit">Hz</span>
          </label>
          <label v-tooltip="{ text: se.spectralGainTitle, reason: spectralGainBlocked }">
            {{ se.spectralGain }}
            <input
              v-model="spectralGainDbInput"
              class="num"
              type="number"
              step="1"
              :disabled="!!spectralGainBlocked"
            />
            <span class="unit">dB</span>
          </label>
          <button
            type="button"
            :disabled="!!opBlocked.spectralEdit"
            v-tooltip="{ text: se.spectralEditTitle, reason: opBlocked.spectralEdit }"
            @click="onSpectralEdit"
          >
            {{ se.spectralEdit }}
          </button>
        </div>
      </div>

      <div v-show="opsGroup === 'match'" class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.match">
        <div class="op-cluster">
          <SelectMenu
            :model-value="referenceAssetId"
            size="sm"
            :options="referenceOptions"
            :disabled="!!referencePickerBlocked"
            :reason="referencePickerBlocked"
            :aria-label="se.matchReference"
            @change="(value: string) => (referenceAssetId = value)"
          />
          <button
            type="button"
            :disabled="!!matchEqAnalyzeBlocked"
            v-tooltip="{ text: se.matchEqAnalyzeTitle, reason: matchEqAnalyzeBlocked }"
            @click="onAnalyzeMatchEq"
          >
            {{ se.matchEqAnalyze }}
          </button>
        </div>
        <div class="op-cluster">
          <label v-tooltip="{ text: se.matchEqAmountTitle, reason: matchEqBlocked }">
            {{ se.matchEqAmount }}
            <input
              v-model="matchEqAmountInput"
              class="num"
              type="number"
              step="5"
              min="0"
              max="100"
              :disabled="!!matchEqBlocked"
            />
            <span class="unit">%</span>
          </label>
          <button
            type="button"
            :disabled="!!matchEqBlocked"
            v-tooltip="{ text: se.matchEqTitle, reason: matchEqBlocked }"
            @click="onMatchEq"
          >
            {{ se.matchEq }}
          </button>
        </div>
      </div>

      <div v-show="opsGroup === 'markers'" class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.markers">
        <div class="op-cluster">
          <button
            type="button"
            :disabled="!!opBlocked.detectOnsets"
            v-tooltip="{ text: se.detectTransientsTitle, reason: opBlocked.detectOnsets }"
            @click="onDetectTransients"
          >
            {{ se.detectTransients }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.detectNotes"
            v-tooltip="{ text: se.detectNotesTitle, reason: opBlocked.detectNotes }"
            @click="onDetectNotes"
          >
            {{ se.detectNotes }}
          </button>
        </div>
        <div class="op-cluster">
          <label v-tooltip="{ text: se.silenceThresholdTitle, reason: opBlocked.splitSilence }">
            {{ se.silenceThreshold }}
            <input
              v-model="silenceThresholdInput"
              class="num"
              type="number"
              step="1"
              min="1"
              :disabled="!!opBlocked.splitSilence"
            />
            <span class="unit">dB</span>
          </label>
          <button
            type="button"
            :disabled="!!opBlocked.splitSilence"
            v-tooltip="{ text: se.splitSilenceTitle, reason: opBlocked.splitSilence }"
            @click="onSplitSilence"
          >
            {{ se.splitSilence }}
          </button>
        </div>
        <div v-if="onsetFrames.length > 0" class="op-cluster">
          <button
            type="button"
            v-tooltip="se.clearTransientsTitle"
            @click="onClearTransients"
          >
            {{ formatMessage(se.clearTransients, { count: onsetFrames.length }) }}
          </button>
        </div>
      </div>

      <div v-show="opsGroup === 'room'" class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.room">
        <div class="op-cluster">
          <SelectMenu
            :model-value="roomPresetId"
            size="sm"
            :options="roomPresetOptions"
            :disabled="!!opBlocked.roomMorph"
            :reason="opBlocked.roomMorph"
            :aria-label="se.roomPreset"
            @change="(value: string) => (roomPresetId = value)"
          />
          <label v-tooltip="{ text: se.roomWetTitle, reason: opBlocked.roomMorph }">
            {{ se.roomWet }}
            <input
              v-model="roomWetInput"
              class="num"
              type="number"
              step="5"
              min="0"
              max="100"
              :disabled="!!opBlocked.roomMorph"
            />
            <span class="unit">%</span>
          </label>
          <ToggleButton
            v-model="roomAirAbsorption"
            :label="se.roomAirAbsorption"
            :title="se.roomAirAbsorptionTitle"
            :reason="opBlocked.roomMorph"
            size="sm"
          />
          <button
            type="button"
            :disabled="!!opBlocked.roomMorph"
            v-tooltip="{ text: se.placeInRoomTitle, reason: opBlocked.roomMorph }"
            @click="onPlaceInRoom"
          >
            {{ se.placeInRoom }}
          </button>
          <button
            type="button"
            :disabled="!!opBlocked.synthesizeRir"
            v-tooltip="{ text: se.synthesizeRirTitle, reason: opBlocked.synthesizeRir }"
            @click="onSynthesizeRir"
          >
            {{ se.synthesizeRir }}
          </button>
        </div>
        <div class="op-cluster">
          <button
            type="button"
            :disabled="!!estimateRoomBlocked"
            v-tooltip="{ text: se.estimateRoomTitle, reason: estimateRoomBlocked }"
            @click="onEstimateRoom"
          >
            {{ se.estimateRoom }}
          </button>
          <button
            type="button"
            :disabled="!!analyzeImpulseBlocked"
            v-tooltip="{ text: se.analyzeImpulseTitle, reason: analyzeImpulseBlocked }"
            @click="onAnalyzeImpulseResponse"
          >
            {{ se.analyzeImpulse }}
          </button>
          <button
            type="button"
            :disabled="!!detectAcousticBlocked"
            v-tooltip="{ text: se.detectAcousticTitle, reason: detectAcousticBlocked }"
            @click="onDetectAcoustic"
          >
            {{ se.detectAcoustic }}
          </button>
        </div>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-for="notice in notices" :key="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="resultStatus" class="result-status" role="status">{{ resultStatus }}</p>
    <div v-if="repairAnalysis" class="match-eq-analysis repair-analysis" role="status">
      <div class="match-eq-head">
        <span class="match-eq-title">{{ se.repairAnalysisTitle }}</span>
        <span v-if="Number.isFinite(repairAnalysis.integratedLufs)" class="match-eq-loudness">
          {{ repairAnalysis.integratedLufs.toFixed(1) }} LUFS
        </span>
      </div>
      <dl class="repair-channels">
        <template v-for="row in repairSummaries" :key="row.channel">
          <dt>{{ row.channel }}</dt>
          <dd>
            <span v-for="item in row.items" :key="item.kind" class="repair-defect">
              <span class="repair-defect-label">{{ se.repairDefects[item.kind] }}</span>
              {{ item.value }}
            </span>
            <span v-if="row.items.length === 0">—</span>
          </dd>
        </template>
      </dl>
      <p v-if="declipWithheld(repairAnalysis)" class="repair-note">
        {{ se.repairDeclipWithheld }}
      </p>
      <div
        v-if="repairAnalysis.recommended.length > 0"
        class="toolbar"
        role="group"
        :aria-label="se.repairStages"
      >
        <ToggleButton
          v-for="stage in repairAnalysis.recommended"
          :key="stage.stage"
          :model-value="repairStageChecked[stage.stage] === true"
          :label="se[stage.stage]"
          :title="repairStageTitle(stage.stage)"
          :reason="repairStagesBlocked"
          size="sm"
          @update:model-value="(checked: boolean) => setRepairStageChecked(stage.stage, checked)"
        />
        <button
          type="button"
          :disabled="!!applyRepairBlocked"
          v-tooltip="{ text: se.repairApplyTitle, reason: applyRepairBlocked }"
          @click="onApplyRepair"
        >
          {{ se.repairApply }}
        </button>
      </div>
      <p v-else class="repair-note">{{ se.repairNoStages }}</p>
    </div>
    <div v-if="matchEqAnalysis" class="match-eq-analysis">
      <div class="match-eq-head">
        <span class="match-eq-title">{{ se.matchEqAnalysisTitle }}</span>
        <span v-if="matchEqAnalysis.loudness" class="match-eq-loudness">
          {{ se.matchEqLoudness }}:
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
        :aria-label="se.matchEqCurveLabel"
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
    <div v-if="roomEstimate" class="match-eq-analysis room-estimate" role="status">
      <div class="match-eq-head">
        <span class="match-eq-title">{{ se.roomEstimateTitle }}</span>
        <span class="match-eq-loudness">
          {{ se.roomEstimateConfidence }}:
          {{ Math.round(roomEstimate.confidence * 100) }}%
        </span>
      </div>
      <dl class="room-estimate-grid">
        <dt>{{ se.roomEstimateSize }}</dt>
        <dd v-if="roomEstimateHasGeometry(roomEstimate)">
          {{ roomEstimate.length.toFixed(1) }} × {{ roomEstimate.width.toFixed(1) }} ×
          {{ roomEstimate.height.toFixed(1) }} m
        </dd>
        <dd v-else>—</dd>
        <dt>{{ se.roomEstimateVolume }}</dt>
        <dd>
          {{ Number.isFinite(roomEstimate.volume) ? roomEstimate.volume.toFixed(0) : '—' }} m³
        </dd>
        <dt>{{ se.roomEstimateRt60 }}</dt>
        <dd>
          {{ Number.isFinite(roomEstimate.rt60Mid) ? roomEstimate.rt60Mid.toFixed(2) : '—' }} s
        </dd>
        <dt>{{ se.roomEstimateDrr }}</dt>
        <dd>{{ roomEstimate.drrDb.toFixed(1) }} dB</dd>
      </dl>
    </div>
    <div v-if="acousticAnalysis" class="match-eq-analysis room-estimate" role="status">
      <div class="match-eq-head">
        <span class="match-eq-title">
          {{
            acousticAnalysis.kind === 'impulse'
              ? se.impulseAnalysisTitle
              : se.acousticAnalysisTitle
          }}
        </span>
        <span class="match-eq-loudness">
          {{ se.roomEstimateConfidence }}:
          {{ Math.round(acousticAnalysis.confidence * 100) }}%
        </span>
      </div>
      <dl class="room-estimate-grid">
        <dt>{{ se.roomEstimateRt60 }}</dt>
        <dd>
          {{ Number.isFinite(acousticAnalysis.rt60) ? acousticAnalysis.rt60.toFixed(2) : '—' }} s
        </dd>
        <dt>{{ se.acousticEdt }}</dt>
        <dd>
          {{ Number.isFinite(acousticAnalysis.edt) ? acousticAnalysis.edt.toFixed(2) : '—' }} s
        </dd>
        <dt>{{ se.acousticClarity }}</dt>
        <dd>
          C50 {{ Number.isFinite(acousticAnalysis.c50) ? acousticAnalysis.c50.toFixed(1) : '—' }}
          dB / C80
          {{ Number.isFinite(acousticAnalysis.c80) ? acousticAnalysis.c80.toFixed(1) : '—' }} dB
        </dd>
        <dt>{{ se.acousticDefinition }}</dt>
        <dd>
          {{ Number.isFinite(acousticAnalysis.d50) ? Math.round(acousticAnalysis.d50 * 100) : '—' }}%
        </dd>
      </dl>
    </div>
    <div
      ref="wrapRef"
      class="wave-wrap"
      tabindex="0"
      :aria-label="se.waveform"
      :aria-description="se.selectionKeyboardHelp"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onWaveKeyDown"
      @wheel.prevent="onWheel"
    >
      <canvas ref="canvasRef" class="wave-canvas" role="img" :aria-label="se.waveform" />
      <Transition name="fade">
        <BusyIndicator
          v-if="busy || loading"
          variant="overlay"
          size="md"
          :label="busy ? se.processing : se.loading"
        />
      </Transition>
      <EmptyState v-if="!busy && !loading && !asset" :message="se.loadFailedMessage" />
    </div>
    <div class="history" role="group" :aria-label="se.history">
      <span class="history-title">{{ se.history }}</span>
      <button
        v-for="(version, index) in historyState.versions"
        :key="`${index}-${version.assetId}`"
        type="button"
        class="history-entry"
        :class="{ current: index === historyState.currentIndex }"
        :aria-current="index === historyState.currentIndex ? 'true' : undefined"
        :disabled="!!historyBlocked"
        v-tooltip="{ text: versionTitle(version), reason: historyBlocked }"
        @click="onSelectVersion(index)"
      >
        {{ version.label }}
      </button>
    </div>
    <div v-if="warpClip" class="warp">
      <div class="toolbar">
        <span class="warp-title">{{ se.warp }}</span>
        <ToggleButton
          :model-value="warpEnabled"
          :label="se.followTempo"
          :title="se.warpTitle"
          size="sm"
          @update:model-value="onToggleWarp"
        />
        <label v-tooltip="{ text: se.sourceBpmTitle, reason: warpOffBlocked }">
          {{ se.sourceBpm }}
          <input
            v-model="warpBpmInput"
            class="num warp-source-bpm"
            type="number"
            step="0.1"
            min="1"
            :disabled="!!warpOffBlocked"
            @change="onWarpBpmChange"
          />
        </label>
        <button
          type="button"
          class="warp-anchor-add"
          :disabled="!!addAnchorBlocked"
          v-tooltip="{ text: se.addAnchorTitle, reason: addAnchorBlocked }"
          @click="onAddAnchor"
        >
          {{ se.addAnchor }}
        </button>
        <button
          type="button"
          class="warp-auto"
          v-tooltip="se.autoWarpTitle"
          @click="onAutoWarp"
        >
          {{ se.autoWarp }}
        </button>
        <span
          v-if="warpRatioHint"
          class="warp-segments"
          v-tooltip="se.ratioTitle"
        >
          {{ warpRatioHint }}
        </span>
      </div>
      <div
        v-for="(anchor, index) in warpAnchors"
        :key="`${index}-${anchor.ppq}`"
        class="toolbar warp-anchor"
      >
        <label v-tooltip="{ reason: warpOffBlocked }">
          {{ se.beat }}
          <input
            class="num"
            type="number"
            step="0.25"
            :disabled="!!warpOffBlocked"
            :value="anchor.ppq"
            @change="onAnchorEdit(index, 'ppq', $event)"
          />
        </label>
        <label v-tooltip="{ reason: warpOffBlocked }">
          {{ se.sourceSeconds }}
          <input
            class="num"
            type="number"
            step="0.01"
            :disabled="!!warpOffBlocked"
            :value="anchor.sourceSeconds"
            @change="onAnchorEdit(index, 'sourceSeconds', $event)"
          />
        </label>
        <button
          type="button"
          class="warp-anchor-remove"
          :disabled="!!warpOffBlocked"
          v-tooltip="{ text: se.removeAnchorTitle, reason: warpOffBlocked }"
          @click="onRemoveAnchor(index)"
        >
          {{ se.remove }}
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

/* A bare select sizes to its value; at full width it would take a wrapped row of its own. */
.toolbar > .select-menu {
  width: auto;
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

.toolbar .num.freq {
  width: 72px;
}

.toolbar .num.frames {
  width: 88px;
}

.unit {
  color: var(--text-3);
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

/* The one action that leaves the editor carries the accent face. */
.toolbar button.primary {
  background: var(--accent-strong);
  color: var(--accent-text);
  font-weight: var(--fw-semibold);
  box-shadow: none;
}

.toolbar button.primary:not(:disabled):hover {
  background: var(--accent-hover);
  box-shadow: none;
}

.toolbar button.primary:disabled {
  opacity: 0.5;
  color: var(--accent-text);
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

.selection-toolbar {
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-inset);
}

.selection-title {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

/* Marks a label whose hover carries usage help. */
.help {
  cursor: help;
  text-decoration: underline dotted var(--text-4);
  text-underline-offset: 3px;
}

.ops-panel {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-inset);
}

.ops-tabs {
  display: flex;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  padding: 0 var(--sp-2);
}

.ops-tab {
  padding: var(--sp-2) var(--sp-3);
  font: var(--fw-medium) var(--fs-sm) var(--font-sans);
  cursor: pointer;
}

.toolbar.ops {
  gap: var(--sp-3) 0;
  padding: var(--sp-3);
  /* Every group keeps the panel at one height so switching tabs never jumps. */
  min-height: 46px;
}

/* One purpose per cluster; a hairline divides neighbours on the same row. */
.op-cluster {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  border-left: 1px solid var(--border);
}

.op-cluster:first-child {
  padding-left: 0;
  border-left: none;
}

.op-cluster > .select-menu {
  width: auto;
}

.cluster-label {
  color: var(--text-2);
}

.spacer {
  flex: 1;
}

.error {
  margin: 0;
  color: var(--danger);
}

.notice {
  margin: 0;
  color: var(--warning);
}

.result-status {
  margin: 0;
  color: var(--text-2);
}

/* Status lines and analysis cards mount in response to a finished job. */
.error,
.notice,
.result-status,
.match-eq-analysis {
  animation: view-enter var(--dur-2) var(--ease-out);
}

.repair-channels {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--sp-1) var(--sp-4);
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.repair-channels dt {
  color: var(--text-3);
  font-weight: var(--fw-semibold);
}

.repair-channels dd {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-5);
  margin: 0;
  color: var(--text-1);
}

.repair-defect-label {
  color: var(--text-3);
}

.repair-note {
  margin: 0;
  color: var(--text-3);
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
  font-weight: var(--fw-semibold);
  box-shadow: none;
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
