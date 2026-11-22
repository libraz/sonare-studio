/**
 * Disabled reasons for every sample editor control. Each gate is a
 * `firstBlock` chain: the asset gate, then the edit gate, then whether this
 * build provides the operation's processor, then the control's own condition.
 * A null gate means the control is usable; otherwise it is the tooltip reason.
 */

import { computed, type Ref } from 'vue';
import type { LoadedAudioAsset } from '@/persistence/assets';
import type { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import type { SampleRange } from './ops';
import {
  type SampleEditorWasmOps,
  type SpectralEditMode,
  type WasmOpAvailability,
  wasmOpAvailability,
} from './wasm-ops';

/** Options for {@link useSampleEditorAvailability}. */
export interface UseSampleEditorAvailabilityOptions {
  /** Project store; the apply gate reads the active clip's asset. */
  project: ReturnType<typeof useProjectStore>;
  loading: Readonly<Ref<boolean>>;
  asset: Readonly<Ref<LoadedAudioAsset | null>>;
  busy: Readonly<Ref<boolean>>;
  /** Loaded WASM ops (null until ready or when loading failed). */
  wasmOps: Readonly<Ref<SampleEditorWasmOps | null>>;
  wasmFailed: Readonly<Ref<boolean>>;
  selRange: Readonly<Ref<SampleRange | null>>;
  currentAssetId: Readonly<Ref<string>>;
  restorePresetOptions: Readonly<Ref<readonly unknown[]>>;
  analyzingRepair: Readonly<Ref<boolean>>;
  repairAnyChecked: Readonly<Ref<boolean>>;
  spectralModeInput: Readonly<Ref<SpectralEditMode>>;
  /** Reference picker entries, the placeholder included. */
  referenceOptions: Readonly<Ref<readonly unknown[]>>;
  referenceAssetId: Readonly<Ref<string>>;
  analyzingMatchEq: Readonly<Ref<boolean>>;
  estimatingRoom: Readonly<Ref<boolean>>;
  analyzingAcoustic: Readonly<Ref<boolean>>;
  warpEnabled: Readonly<Ref<boolean>>;
  /** Next anchor the warp editor would add (null when there is no room). */
  nextWarpAnchor: Readonly<Ref<unknown>>;
}

/** Builds the disabled-reason gates the sample editor template binds. */
export function useSampleEditorAvailability(options: UseSampleEditorAvailabilityOptions) {
  const {
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
  } = options;
  const { t } = useI18n();
  const wasmAvail = computed(() => wasmOpAvailability(wasmOps.value));

  const se = computed(() => t.value.shell.sampleEditor);

  /** Gates anything that reads the loaded audio (view, selection, apply). */
  const assetBlocked = computed(() =>
    firstBlock(
      [loading.value, se.value.reasons.loading],
      [!asset.value, se.value.reasons.loadFailed],
    ),
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
      gates[key] = firstBlock(editBlocked.value, tools, [
        !wasmAvail.value[key],
        se.value.unavailable,
      ]);
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
    firstBlock(repairStagesBlocked.value, [
      !repairAnyChecked.value,
      se.value.reasons.noRepairStage,
    ]),
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
    firstBlock(warpOffBlocked.value, [
      nextWarpAnchor.value === null,
      se.value.reasons.noAnchorRoom,
    ]),
  );

  const historyBlocked = computed(() => firstBlock([busy.value, t.value.reasons.busy]));

  return {
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
  };
}
