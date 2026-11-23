<script lang="ts">
import { ref as moduleRef } from 'vue';
import { describeError } from '@/lib/errors';

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
import ToggleButton from '@/components/shell/ToggleButton.vue';
import SampleEditorEditPanel from './SampleEditorEditPanel.vue';
import SampleEditorMarkersPanel from './SampleEditorMarkersPanel.vue';
import SampleEditorMatchPanel from './SampleEditorMatchPanel.vue';
import SampleEditorPitchPanel from './SampleEditorPitchPanel.vue';
import SampleEditorRepairPanel from './SampleEditorRepairPanel.vue';
import SampleEditorRoomPanel from './SampleEditorRoomPanel.vue';
import SampleEditorSpectralPanel from './SampleEditorSpectralPanel.vue';
import SampleEditorTimePanel from './SampleEditorTimePanel.vue';
import { useNoteNames } from '@/composables/useNoteNames';
import { useShortcuts } from '@/composables/useShortcuts';
import { leaseAudioAssets } from '@/persistence/asset-leases';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';
import { formatChannels, formatSampleRate } from '@/ui/media/asset-list';
import { readInputNumber, restoreInputValue } from '@/ui/numeric-input';
import {
  type AssetVersion,
  createHistory,
  selectVersion,
  type VersionHistoryState,
} from '@/ui/sample-editor/history';
import { formatMidiNote } from '@/ui/sample-editor/note-names';
import { declipWithheld, repairChannelSummaries } from '@/ui/sample-editor/repair-analysis';
import { roomEstimateHasGeometry } from '@/ui/sample-editor/room-acoustics';
import { rootOptions } from '@/ui/sample-editor/scales';
import { selectionReadout } from '@/ui/sample-editor/selection';
import { useSampleEditorAvailability } from '@/ui/sample-editor/use-sample-editor-availability';
import { useSampleMarkers } from '@/ui/sample-editor/use-sample-markers';
import {
  MATCH_EQ_CURVE_HEIGHT,
  MATCH_EQ_CURVE_WIDTH,
  useSampleOperations,
} from '@/ui/sample-editor/use-sample-operations';
import { useSampleSelection } from '@/ui/sample-editor/use-sample-selection';
import { useSampleViewport } from '@/ui/sample-editor/use-sample-viewport';
import { useSampleWarp } from '@/ui/sample-editor/use-sample-warp';
import {
  loadSampleEditorWasm,
  type SampleEditorWasmOps,
} from '@/ui/sample-editor/wasm-ops';
import type { MasteringRepairStageName } from '@libraz/libsonare';

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

const wrapRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const viewportControls = useSampleViewport({
  wrapRef,
  canvasRef,
  asset,
  selection,
  onsetFrames,
  noteRegions,
  formatNote: (midi) => formatMidiNote(midi, noteNameSystem.value),
  selRange: () => selRange.value,
});
const { scheduleDraw, zoomToFit, onWheel } = viewportControls;

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
  const frame = readInputNumber(event);
  if (frame === null) {
    restoreInputValue(
      event,
      boundary === 'start' ? selectionStartFrame.value : selectionEndFrame.value,
    );
    return;
  }
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
    error.value = describeError(err, t.value.notices.errors);
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

const shortcuts = useShortcuts();

/** Handles waveform-local selection keys and version-history undo/redo. */
function onWaveKeyDown(event: KeyboardEvent): void {
  const action = shortcuts.match(event, 'editor');
  if (action === 'edit.undo' || action === 'edit.redo') {
    // The sample editor's immutable asset history is deliberately separate
    // from project history. Consume this even at either history boundary so a
    // waveform-focused shortcut can never undo an unrelated arrangement edit.
    event.preventDefault();
    const delta = action === 'edit.redo' ? 1 : -1;
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

const {
  assetBlocked,
  editBlocked,
  opBlocked,
  clearSelectionBlocked,
  applyBlocked,
  trimBlocked,
  deleteBlocked,
  noteStretchBlocked,
  noteMoveBlocked,
  stretchInputBlocked,
  restoreBlocked,
  analyzeRepairBlocked,
  repairStagesBlocked,
  applyRepairBlocked,
  spectralGainBlocked,
  referencePickerBlocked,
  matchEqBlocked,
  matchEqAnalyzeBlocked,
  estimateRoomBlocked,
  analyzeImpulseBlocked,
  detectAcousticBlocked,
  warpOffBlocked,
  addAnchorBlocked,
  historyBlocked,
} = useSampleEditorAvailability({
  project,
  loading,
  asset,
  busy,
  wasmOps,
  wasmFailed,
  selRange,
  currentAssetId,
  restorePresetOptions,
  analyzingRepair,
  repairAnyChecked,
  spectralModeInput,
  referenceOptions,
  referenceAssetId,
  analyzingMatchEq,
  estimatingRoom,
  analyzingAcoustic,
  warpEnabled,
  nextWarpAnchor,
});

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

      <SampleEditorEditPanel
        v-show="opsGroup === 'edit'"
        v-model:gain-db-input="gainDbInput"
        v-model:normalize-target-input="normalizeTargetInput"
        :edit-blocked="editBlocked"
        :trim-blocked="trimBlocked"
        :delete-blocked="deleteBlocked"
        @gain="onGain"
        @normalize="onNormalize"
        @fade-in="onFadeIn"
        @fade-out="onFadeOut"
        @reverse="onReverse"
        @silence="onSilence"
        @trim="onTrim"
        @delete="onDelete"
        @duplicate="onDuplicate"
      />

      <SampleEditorPitchPanel
        v-show="opsGroup === 'pitch'"
        v-model:pitch-input="pitchInput"
        v-model:tune-note-input="tuneNoteInput"
        v-model:scale-root-input="scaleRootInput"
        v-model:scale-mode-input="scaleModeInput"
        v-model:auto-tune-detect="autoTuneDetect"
        v-model:auto-tune-strength-input="autoTuneStrengthInput"
        :op-blocked="opBlocked"
        :root-options="ROOT_OPTIONS"
        @pitch-shift="onPitchShift"
        @pitch-correct="onPitchCorrect"
        @pitch-correct-timevarying="onPitchCorrectTimevarying"
        @tune-reference="onTuneReference"
        @scale-correct="onScaleCorrect"
        @auto-tune="onAutoTune"
      />

      <SampleEditorTimePanel
        v-show="opsGroup === 'time'"
        v-model:stretch-input="stretchInput"
        v-model:note-shift-ms-input="noteShiftMsInput"
        v-model:voice-pitch-input="voicePitchInput"
        v-model:voice-formant-input="voiceFormantInput"
        v-model:voice-formant-absolute="voiceFormantAbsolute"
        :op-blocked="opBlocked"
        :stretch-input-blocked="stretchInputBlocked"
        :note-stretch-blocked="noteStretchBlocked"
        :note-move-blocked="noteMoveBlocked"
        @time-stretch="onTimeStretch"
        @note-stretch="onNoteStretch"
        @note-move="onNoteMove"
        @voice-change="onVoiceChange"
      />

      <SampleEditorRepairPanel
        v-show="opsGroup === 'repair'"
        v-model:denoise-depth-input="denoiseDepthInput"
        :op-blocked="opBlocked"
        :analyze-repair-blocked="analyzeRepairBlocked"
        :restore-blocked="restoreBlocked"
        :restore-preset-id="restorePresetId"
        :restore-preset-options="restorePresetOptions"
        @analyze-repair="onAnalyzeRepair"
        @declick="onDeclick"
        @declip="onDeclip"
        @decrackle="onDecrackle"
        @dehum="onDehum"
        @dereverb="onDereverb"
        @trim-silence-repair="onTrimSilenceRepair"
        @denoise="onDenoise"
        @restore="onRestore"
        @select-restore-preset="selectRestorePreset"
      />

      <SampleEditorSpectralPanel
        v-show="opsGroup === 'spectral'"
        v-model:spectral-mode-input="spectralModeInput"
        v-model:spectral-low-hz-input="spectralLowHzInput"
        v-model:spectral-high-hz-input="spectralHighHzInput"
        v-model:spectral-gain-db-input="spectralGainDbInput"
        :op-blocked="opBlocked"
        :spectral-gain-blocked="spectralGainBlocked"
        :spectral-mode-options="spectralModeOptions"
        @harmonic="onHarmonic"
        @percussive="onPercussive"
        @spectral-denoise="onSpectralDenoise"
        @spectral-edit="onSpectralEdit"
      />

      <SampleEditorMatchPanel
        v-show="opsGroup === 'match'"
        v-model:reference-asset-id="referenceAssetId"
        v-model:match-eq-amount-input="matchEqAmountInput"
        :reference-picker-blocked="referencePickerBlocked"
        :match-eq-analyze-blocked="matchEqAnalyzeBlocked"
        :match-eq-blocked="matchEqBlocked"
        :reference-options="referenceOptions"
        @analyze-match-eq="onAnalyzeMatchEq"
        @match-eq="onMatchEq"
      />

      <SampleEditorMarkersPanel
        v-show="opsGroup === 'markers'"
        v-model:silence-threshold-input="silenceThresholdInput"
        :op-blocked="opBlocked"
        :onset-frames="onsetFrames"
        @detect-transients="onDetectTransients"
        @detect-notes="onDetectNotes"
        @split-silence="onSplitSilence"
        @clear-transients="onClearTransients"
      />

      <SampleEditorRoomPanel
        v-show="opsGroup === 'room'"
        v-model:room-preset-id="roomPresetId"
        v-model:room-wet-input="roomWetInput"
        v-model:room-air-absorption="roomAirAbsorption"
        :op-blocked="opBlocked"
        :estimate-room-blocked="estimateRoomBlocked"
        :analyze-impulse-blocked="analyzeImpulseBlocked"
        :detect-acoustic-blocked="detectAcousticBlocked"
        :room-preset-options="roomPresetOptions"
        @place-in-room="onPlaceInRoom"
        @synthesize-rir="onSynthesizeRir"
        @estimate-room="onEstimateRoom"
        @analyze-impulse-response="onAnalyzeImpulseResponse"
        @detect-acoustic="onDetectAcoustic"
      />
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

<style scoped src="./sample-editor-panel.css"></style>

<style scoped>
.sample-editor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
  color: var(--text-2);
  font: var(--fs-sm) var(--font-sans);
}

.toolbar .num.frames {
  width: 88px;
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
