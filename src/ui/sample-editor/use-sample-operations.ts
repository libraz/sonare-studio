/**
 * Offline audio operations for the sample editor. Owns every operation's input
 * model (gain, normalize, pitch, tune, scale, voice, stretch, room, match EQ),
 * the shared {@link runOp} wrapper that stores each result as a new immutable
 * asset version, and the Match EQ reference picker and analysis preview state.
 *
 * Every operation runs on the current selection (or the whole file when nothing
 * is selected), produces fresh channel buffers (asset channels are cached and
 * shared, so operations copy, never mutate), stores them as a new version,
 * emits `asset-created` and switches the editor to the new version.
 */

import { computed, type Ref, ref, watch } from 'vue';
import { useNoteNames } from '@/composables/useNoteNames';
import { downmixToMono } from '@/lib/audio-channels';
import { leaseAudioAssets } from '@/persistence/asset-leases';
import {
  type AudioAssetMeta,
  type LoadedAudioAsset,
  listAssets,
  loadAsset,
} from '@/persistence/assets';
import { formatMessage, useI18n } from '@/ui/i18n';
import { humanizePresetName, restorationPresets } from '@/ui/mastering/preset-catalog';
import type {
  AutoTuneKey,
  MasteringRepairAnalysis,
  MasteringRepairStageName,
  PitchClass,
  RirDiagnostic,
} from '@/wasm/index.js';
import type { VersionHistoryState } from './history';
import { parseNumber, parsePercentFraction } from './input-parse';
import type { MatchEqAnalysis } from './match-eq-analysis';
import { formatMidiNote, parseMidiNote } from './note-names';

import {
  applyGainDb,
  cutCrossfadeFrames,
  deleteRange,
  duplicateRange,
  fadeInLinear,
  fadeOutLinear,
  normalizeToDb,
  reverse,
  type SampleRange,
  silence,
  trimToRange,
} from './ops';
import { checkedRepairStages } from './repair-analysis';
import { createSampleOperationRunner, errorMessage } from './sample-operation-runner';
import { keyModeFor, modeMaskFor, modeOrdinalOf, scaleName } from './scales';
import {
  type AcousticAnalysisSummary,
  analyzeImpulseResponseRange,
  analyzeMatchEqToReference,
  analyzeRepairRange,
  autoTuneRange,
  declickRange,
  declipRange,
  decrackleRange,
  dehumRange,
  denoiseRange,
  dereverbRange,
  detectAcousticRange,
  estimateRoomRange,
  harmonicRange,
  matchEqToReference,
  noteMoveRange,
  noteStretchRange,
  percussiveRange,
  pitchCorrectRange,
  pitchCorrectTimevaryingRange,
  pitchShiftRange,
  type RoomEstimateSummary,
  type RoomMorphPreset,
  repairStagesRange,
  restoreRange,
  roomEstimateHasGeometry,
  roomEstimateToPreset,
  roomMorphChannels,
  type SampleEditorWasmOps,
  type SpectralEditMode,
  scaleCorrectRange,
  spectralDenoiseRange,
  spectralEditRange,
  synthesizeRirChannels,
  timeStretchRange,
  trimSilenceRange,
  tuneToReferenceRange,
  voiceChangeRange,
} from './wasm-ops';

/**
 * Room shapes offered by the "Place in room" reverb, smallest to largest. Each
 * pairs shoebox dimensions with a libsonare wall-material preset (1 concrete,
 * 2 wood, 4 carpet).
 */
const ROOM_PRESETS: ReadonlyArray<{ id: string; preset: RoomMorphPreset }> = [
  { id: 'smallRoom', preset: { lengthM: 4, widthM: 3, heightM: 2.6, materialPreset: 'wood' } },
  { id: 'largeRoom', preset: { lengthM: 9, widthM: 7, heightM: 3.5, materialPreset: 'carpet' } },
  {
    id: 'concertHall',
    preset: { lengthM: 24, widthM: 16, heightM: 10, materialPreset: 'concrete' },
  },
];
const ESTIMATED_ROOM_PRESET_ID = 'estimatedRoom';

/** Fallback sample rate (Hz) when no asset is loaded. */
const DEFAULT_SAMPLE_RATE_HZ = 48000;
/** Default room reverb wet mix, in percent. */
const DEFAULT_ROOM_WET_PERCENT = 35;
/** Default Match EQ strength, in percent. */
const DEFAULT_MATCH_EQ_AMOUNT_PERCENT = 100;

/** Peak targets (in dB) offered by the normalize control. */
export const NORMALIZE_TARGET_OPTIONS: { value: string; label: string }[] = [
  { value: '-1', label: '-1 dB' },
  { value: '-3', label: '-3 dB' },
  { value: '-6', label: '-6 dB' },
];

/** Viewport size for the inline match EQ curve preview, in SVG user units. */
export const MATCH_EQ_CURVE_WIDTH = 240;
export const MATCH_EQ_CURVE_HEIGHT = 64;
/** Half-range of the curve's symmetric dB axis (gains clamp to ±this). */
const MATCH_EQ_CURVE_DB_RANGE = 12;

export const SPECTRAL_EDIT_MODE_OPTIONS: { value: SpectralEditMode; labelKey: SpectralEditMode }[] =
  [
    { value: 'attenuate', labelKey: 'attenuate' },
    { value: 'gain', labelKey: 'gain' },
    { value: 'mute', labelKey: 'mute' },
    { value: 'heal', labelKey: 'heal' },
  ];

/** Options for {@link useSampleOperations}. */
export interface UseSampleOperationsOptions {
  /** Currently loaded asset ref (null when none). */
  asset: Ref<LoadedAudioAsset | null>;
  /** Id of the version currently shown (advanced after each stored edit). */
  currentAssetId: Ref<string>;
  /** Session-local version history (a new version is pushed per edit). */
  historyState: Ref<VersionHistoryState>;
  /** Busy flag (set while an offline operation runs). */
  busy: Ref<boolean>;
  /** Loading flag (true while a version loads). */
  loading: Ref<boolean>;
  /** Shared error message ref. */
  error: Ref<string | null>;
  /** Loaded WASM ops ref (null until ready). */
  wasmOps: Ref<SampleEditorWasmOps | null>;
  /** Normalized selection range getter (null = whole file). */
  selRange: () => SampleRange | null;
  /** Loads a stored version into the editor. */
  loadCurrent: (assetId: string) => Promise<void>;
  /** Emits that a new version was stored (source then new id). */
  emitAssetCreated: (newAssetId: string, sourceAssetId: string) => void;
  /** Clears the active selection (called after a trim consumes it). */
  clearSelection: () => void;
  /** True after the owning editor has unmounted. */
  isDisposed?: () => boolean;
  /** Current project document identity for delayed-commit rejection. */
  getProjectGeneration?: () => number;
}

/** Builds the operation models, the runOp wrapper and every operation action. */
export function useSampleOperations(options: UseSampleOperationsOptions) {
  const { asset, currentAssetId, busy, loading, error, wasmOps, selRange, clearSelection } =
    options;

  const { t } = useI18n();
  const noteNames = useNoteNames();
  const runner = createSampleOperationRunner(options, () => referenceAssetId.value);
  const { notices, resultStatus, beginOperation, operationIsCurrent, runOp, runBuiltinOp } = runner;

  const gainDbInput = ref('3');
  const normalizeTargetInput = ref('-1');
  const pitchInput = ref('0');
  const tuneNoteInput = ref('A4');
  /** "Tune to scale" target: root pitch class and Mode ordinal (as strings). */
  const scaleRootInput = ref('0');
  const scaleModeInput = ref('0');
  /** Voice-change controls: pitch transpose (semitones) and formant scale. */
  const voicePitchInput = ref('0');
  const voiceFormantInput = ref('1');
  /** Formant factor taken relative to the input whatever the pitch shift. */
  const voiceFormantAbsolute = ref(false);
  /** Auto-tune: detect the key (true) or use the scale picker's root and mode. */
  const autoTuneDetect = ref(true);
  /** Auto-tune correction strength as a percentage string (100 = full snap). */
  const autoTuneStrengthInput = ref('100');
  const stretchInput = ref('1');
  /** Note-move nudge in milliseconds (negative moves the note earlier). */
  const noteShiftMsInput = ref('0');
  /** Denoise depth in dB, starting at the library's own default. */
  const denoiseDepthInput = ref('26');
  /** Silence-split threshold in dB below the peak. */
  const silenceThresholdInput = ref('40');
  /** Rectangular spectral edit controls: frequency band, gain and edit mode. */
  const spectralLowHzInput = ref('4000');
  const spectralHighHzInput = ref('0');
  const spectralGainDbInput = ref('-18');
  const spectralModeInput = ref<SpectralEditMode>('attenuate');

  /** Selected room shape id (see {@link ROOM_PRESETS}). */
  const roomPresetId = ref(ROOM_PRESETS[0].id);
  const restorePresetId = ref<string>(restorationPresets()[0] ?? '');
  /** Room reverb wet/dry mix as a percentage string (0 = dry, 100 = fully wet). */
  const roomWetInput = ref(String(DEFAULT_ROOM_WET_PERCENT));
  const roomAirAbsorption = ref(false);

  /** Stored audio assets offered as the Match EQ reference. */
  const referenceAssets = ref<AudioAssetMeta[]>([]);
  /** Selected reference asset id ('' = none picked). */
  const referenceAssetId = ref('');
  /** Parallel match strength as a percentage string (100 = fully matched). */
  const matchEqAmountInput = ref(String(DEFAULT_MATCH_EQ_AMOUNT_PERCENT));
  /** Latest Match EQ analysis against the reference (null = none run). */
  const matchEqAnalysis = ref<MatchEqAnalysis | null>(null);
  /** True while a Match EQ analysis is awaiting the engine. */
  const analyzingMatchEq = ref(false);
  /** Latest room estimate for the selected range / whole file. */
  const roomEstimate = ref<RoomEstimateSummary | null>(null);
  /** True while room estimation is awaiting the engine. */
  const estimatingRoom = ref(false);
  /** Latest acoustic metrics from IR or blind acoustic analysis. */
  const acousticAnalysis = ref<AcousticAnalysisSummary | null>(null);
  /** True while acoustic analysis is awaiting the engine. */
  const analyzingAcoustic = ref(false);
  /** Latest repair analysis of the selection (or whole file). */
  const repairAnalysis = ref<MasteringRepairAnalysis | null>(null);
  /** Checked state per recommended repair stage. */
  const repairStageChecked = ref<Partial<Record<MasteringRepairStageName, boolean>>>({});
  /** True while the repair analysis is awaiting the engine. */
  const analyzingRepair = ref(false);

  const opsDisabled = computed(
    () => busy.value || loading.value || !asset.value || asset.value.meta.numFrames === 0,
  );

  /** Reference picker options: a placeholder plus every other stored asset. */
  const referenceOptions = computed(() => [
    { value: '', label: t.value.shell.sampleEditor.selectReference },
    ...referenceAssets.value
      .filter((meta) => meta.id !== currentAssetId.value)
      .map((meta) => ({ value: meta.id, label: meta.name })),
  ]);

  /** Room-shape picker options labelled from the localized preset names. */
  const roomPresetOptions = computed(() => {
    const estimated =
      roomEstimate.value && roomEstimateHasGeometry(roomEstimate.value)
        ? [{ value: ESTIMATED_ROOM_PRESET_ID, label: t.value.shell.sampleEditor.estimatedRoom }]
        : [];
    return [
      ...estimated,
      ...ROOM_PRESETS.map((entry) => ({
        value: entry.id,
        label:
          t.value.shell.sampleEditor.roomPresets[
            entry.id as keyof typeof t.value.shell.sampleEditor.roomPresets
          ],
      })),
    ];
  });

  const spectralModeOptions = computed(() =>
    SPECTRAL_EDIT_MODE_OPTIONS.map((entry) => ({
      value: entry.value,
      label: t.value.shell.sampleEditor.spectralModes[entry.labelKey],
    })),
  );

  /**
   * Maps the match EQ curve to an SVG polyline string: frequency on a log x axis
   * (first..last), gain on a symmetric dB y axis clamped to ±MATCH_EQ_CURVE_DB_RANGE
   * (0 dB centered). Empty when fewer than two points are available.
   */
  const matchEqCurvePoints = computed(() => {
    const curve = matchEqAnalysis.value?.curve;
    if (!curve || curve.frequencies.length < 2) return '';
    const first = curve.frequencies[0];
    const last = curve.frequencies[curve.frequencies.length - 1];
    const logFirst = Math.log(Math.max(first, 1));
    const logSpan = Math.log(Math.max(last, 1)) - logFirst;
    if (!(logSpan > 0)) return '';
    return curve.frequencies
      .map((frequency, index) => {
        const x = ((Math.log(Math.max(frequency, 1)) - logFirst) / logSpan) * MATCH_EQ_CURVE_WIDTH;
        const clamped = Math.max(
          -MATCH_EQ_CURVE_DB_RANGE,
          Math.min(MATCH_EQ_CURVE_DB_RANGE, curve.gainDb[index]),
        );
        const y = (0.5 - clamped / (2 * MATCH_EQ_CURVE_DB_RANGE)) * MATCH_EQ_CURVE_HEIGHT;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });

  // A new reference (or none) invalidates the displayed analysis.
  watch(referenceAssetId, () => {
    runner.invalidate();
    matchEqAnalysis.value = null;
  });

  watch(asset, () => {
    runner.invalidate();
    roomEstimate.value = null;
    repairAnalysis.value = null;
    if (roomPresetId.value === ESTIMATED_ROOM_PRESET_ID) {
      roomPresetId.value = ROOM_PRESETS[0].id;
    }
  });

  // A repair analysis describes the range it measured; another range voids it.
  watch(
    () => {
      const range = selRange();
      return range ? `${range.startFrame}:${range.endFrame}` : '';
    },
    () => {
      repairAnalysis.value = null;
    },
  );

  function selectedRoomPreset(): { id: string; label: string; preset: RoomMorphPreset } | null {
    if (roomPresetId.value === ESTIMATED_ROOM_PRESET_ID) {
      const estimate = roomEstimate.value;
      if (!estimate) return null;
      return {
        id: ESTIMATED_ROOM_PRESET_ID,
        label: t.value.shell.sampleEditor.estimatedRoom,
        preset: roomEstimateToPreset(estimate),
      };
    }
    const entry = ROOM_PRESETS.find((candidate) => candidate.id === roomPresetId.value);
    if (!entry) return null;
    return {
      id: entry.id,
      label:
        t.value.shell.sampleEditor.roomPresets[
          entry.id as keyof typeof t.value.shell.sampleEditor.roomPresets
        ],
      preset: entry.preset,
    };
  }

  function sampleRate(): number {
    return asset.value?.meta.sampleRate ?? DEFAULT_SAMPLE_RATE_HZ;
  }

  async function onGain(): Promise<void> {
    const db = parseNumber(gainDbInput.value);
    if (db === null) {
      error.value = t.value.shell.sampleEditor.errors.gain;
      return;
    }
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.gain, { db }),
      runBuiltinOp({ type: 'gain', db }, (channels, range) => applyGainDb(channels, db, range)),
    );
  }

  async function onNormalize(): Promise<void> {
    const target = parseNumber(normalizeTargetInput.value);
    if (target === null) {
      error.value = t.value.shell.sampleEditor.errors.normalizeTarget;
      return;
    }
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.normalize, { target }),
      runBuiltinOp({ type: 'normalize', targetDb: target }, (channels, range) =>
        normalizeToDb(channels, target, range),
      ),
    );
  }

  async function onFadeIn(): Promise<void> {
    await runOp(
      t.value.shell.sampleEditor.ops.fadeIn,
      runBuiltinOp({ type: 'fade-in' }, (channels, range) => fadeInLinear(channels, range)),
    );
  }

  async function onFadeOut(): Promise<void> {
    await runOp(
      t.value.shell.sampleEditor.ops.fadeOut,
      runBuiltinOp({ type: 'fade-out' }, (channels, range) => fadeOutLinear(channels, range)),
    );
  }

  async function onReverse(): Promise<void> {
    await runOp(
      t.value.shell.sampleEditor.ops.reverse,
      runBuiltinOp({ type: 'reverse' }, (channels, range) => reverse(channels, range)),
    );
  }

  async function onSilence(): Promise<void> {
    await runOp(
      t.value.shell.sampleEditor.ops.silence,
      runBuiltinOp({ type: 'silence' }, (channels, range) => silence(channels, range)),
    );
  }

  async function onTrim(): Promise<void> {
    const range = selRange();
    if (!range) return;
    if (
      await runOp(
        t.value.shell.sampleEditor.ops.trim,
        runBuiltinOp({ type: 'trim' }, (channels) => trimToRange(channels, range)),
      )
    ) {
      clearSelection();
    }
  }

  async function onDelete(): Promise<void> {
    const range = selRange();
    if (!range) return;
    const fadeFrames = cutCrossfadeFrames(sampleRate());
    if (
      await runOp(
        t.value.shell.sampleEditor.ops.delete,
        runBuiltinOp({ type: 'delete', fadeFrames }, (channels) =>
          deleteRange(channels, range, fadeFrames),
        ),
      )
    ) {
      clearSelection();
    }
  }

  async function onDuplicate(): Promise<void> {
    const fadeFrames = cutCrossfadeFrames(sampleRate());
    await runOp(
      t.value.shell.sampleEditor.ops.duplicate,
      runBuiltinOp({ type: 'duplicate', fadeFrames }, (channels, range) =>
        duplicateRange(channels, range, fadeFrames),
      ),
    );
  }

  async function onPitchShift(): Promise<void> {
    const ops = wasmOps.value;
    const semitones = parseNumber(pitchInput.value);
    if (!ops) return;
    if (semitones === null) {
      error.value = t.value.shell.sampleEditor.errors.pitch;
      return;
    }
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.pitch, {
        sign: semitones >= 0 ? '+' : '',
        semitones,
      }),
      (channels, range) => pitchShiftRange(ops, channels, sampleRate(), semitones, range),
    );
  }

  /** Parses the tune note, raising the localized input error when invalid. */
  function parseTuneTarget(): number | null {
    const targetMidi = parseMidiNote(tuneNoteInput.value, noteNames.system.value);
    if (targetMidi === null) error.value = t.value.shell.sampleEditor.errors.tune;
    return targetMidi;
  }

  async function onPitchCorrect(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const targetMidi = parseTuneTarget();
    if (targetMidi === null) return;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.tune, {
        note: formatMidiNote(targetMidi, noteNames.system.value),
      }),
      (channels, range) => pitchCorrectRange(ops, channels, sampleRate(), targetMidi, range),
    );
  }

  async function onPitchCorrectTimevarying(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const targetMidi = parseTuneTarget();
    if (targetMidi === null) return;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.tuneContour, {
        note: formatMidiNote(targetMidi, noteNames.system.value),
      }),
      (channels, range) =>
        pitchCorrectTimevaryingRange(ops, channels, sampleRate(), targetMidi, range),
    );
  }

  async function onTuneReference(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.tuneReference, (channels, range) =>
      tuneToReferenceRange(ops, channels, sampleRate(), range),
    );
  }

  async function onScaleCorrect(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const root = Number(scaleRootInput.value);
    const mode = Number(scaleModeInput.value);
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.tuneScale, {
        scale: scaleName(root, mode, noteNames.system.value),
      }),
      (channels, range) =>
        scaleCorrectRange(ops, channels, sampleRate(), root, modeMaskFor(mode), range),
    );
  }

  /** Auto-tunes the selection to the detected key or the scale picker's key. */
  async function onAutoTune(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const percent = parseNumber(autoTuneStrengthInput.value);
    if (percent === null || percent < 0 || percent > 100) {
      error.value = t.value.shell.sampleEditor.errors.autoTuneStrength;
      return;
    }
    const strength = percent / 100;
    const key: 'detect' | AutoTuneKey = autoTuneDetect.value
      ? 'detect'
      : {
          // The root picker only offers pitch classes 0-11.
          root: Number(scaleRootInput.value) as PitchClass,
          mode: keyModeFor(Number(scaleModeInput.value)),
        };
    let scale = '';
    const committed = await runOp(
      () => formatMessage(t.value.shell.sampleEditor.ops.autoTune, { scale }),
      (channels, range) => {
        const tuned = autoTuneRange(ops, channels, sampleRate(), key, strength, range);
        scale = scaleName(tuned.key.root, modeOrdinalOf(tuned.key.mode), noteNames.system.value);
        return tuned.channels;
      },
    );
    if (committed) {
      resultStatus.value = formatMessage(
        key === 'detect'
          ? t.value.shell.sampleEditor.autoTuneResultDetected
          : t.value.shell.sampleEditor.autoTuneResult,
        { scale },
      );
    }
  }

  async function onVoiceChange(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const pitchSemitones = parseNumber(voicePitchInput.value);
    const formantFactor = parseNumber(voiceFormantInput.value);
    if (pitchSemitones === null || formantFactor === null || formantFactor <= 0) {
      error.value = t.value.shell.sampleEditor.errors.voice;
      return;
    }
    const formantMode = voiceFormantAbsolute.value ? 'absolute' : 'relative';
    await runOp(
      formatMessage(
        formantMode === 'absolute'
          ? t.value.shell.sampleEditor.ops.voiceAbsolute
          : t.value.shell.sampleEditor.ops.voice,
        {
          sign: pitchSemitones >= 0 ? '+' : '',
          semitones: pitchSemitones,
          formant: formantFactor,
        },
      ),
      (channels, range) =>
        voiceChangeRange(
          ops,
          channels,
          sampleRate(),
          pitchSemitones,
          formantFactor,
          formantMode,
          range,
        ),
    );
  }

  /** Parses the stretch rate, raising the localized input error when invalid. */
  function parseStretchRate(): number | null {
    const rate = parseNumber(stretchInput.value);
    if (rate === null || rate <= 0) {
      error.value = t.value.shell.sampleEditor.errors.stretch;
      return null;
    }
    return rate;
  }

  async function onTimeStretch(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const rate = parseStretchRate();
    if (rate === null) return;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.stretch, { rate }),
      (channels, range) => timeStretchRange(ops, channels, sampleRate(), rate, range),
    );
  }

  async function onNoteStretch(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const rate = parseStretchRate();
    if (rate === null) return;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.noteStretch, { rate }),
      (channels, range) => noteStretchRange(ops, channels, sampleRate(), rate, range),
    );
  }

  async function onNoteMove(): Promise<void> {
    const ops = wasmOps.value;
    const shiftMs = parseNumber(noteShiftMsInput.value);
    if (!ops) return;
    if (shiftMs === null || shiftMs === 0) {
      error.value = t.value.shell.sampleEditor.errors.noteShift;
      return;
    }
    const shiftFrames = Math.round((shiftMs / 1000) * sampleRate());
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.noteMove, { ms: shiftMs }),
      (channels, range) => noteMoveRange(ops, channels, sampleRate(), shiftFrames, range),
    );
  }

  async function onDeclick(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.declick, (channels, range) =>
      declickRange(ops, channels, sampleRate(), range),
    );
  }

  async function onDenoise(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const depth = parseNumber(denoiseDepthInput.value);
    if (depth === null || depth < 0) {
      error.value = t.value.shell.sampleEditor.errors.denoiseDepth;
      return;
    }
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.denoise, { db: depth }),
      (channels, range) => denoiseRange(ops, channels, sampleRate(), range, depth),
    );
  }

  async function onRestore(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const preset = restorationPresets().find((entry) => entry === restorePresetId.value);
    if (!preset) return;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.restore, { preset: humanizePresetName(preset) }),
      (channels, range) => restoreRange(ops, channels, sampleRate(), preset, range),
    );
  }

  /** Selects a restoration preset from the picker. */
  function selectRestorePreset(value: string): void {
    const preset = restorationPresets().find((entry) => entry === value);
    if (preset) restorePresetId.value = preset;
  }

  /** Restoration preset picker options, in catalog order. */
  const restorePresetOptions = computed(() =>
    restorationPresets().map((preset) => ({ value: preset, label: humanizePresetName(preset) })),
  );

  async function onDeclip(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.declip, (channels, range) =>
      declipRange(ops, channels, sampleRate(), range),
    );
  }

  async function onDecrackle(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.decrackle, (channels, range) =>
      decrackleRange(ops, channels, sampleRate(), range),
    );
  }

  async function onDehum(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.dehum, (channels, range) =>
      dehumRange(ops, channels, sampleRate(), range),
    );
  }

  async function onDereverb(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.dereverb, (channels, range) =>
      dereverbRange(ops, channels, sampleRate(), range),
    );
  }

  async function onTrimSilenceRepair(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.trimSilence, (channels, range) =>
      trimSilenceRange(ops, channels, sampleRate(), range),
    );
  }

  /** Measures the selection's defects and pre-checks every recommended stage. */
  async function onAnalyzeRepair(): Promise<void> {
    const ops = wasmOps.value;
    const loaded = asset.value;
    if (!ops || !loaded || opsDisabled.value || analyzingRepair.value) return;
    error.value = null;
    analyzingRepair.value = true;
    try {
      const analysis = analyzeRepairRange(ops, loaded.channels, loaded.meta.sampleRate, selRange());
      repairStageChecked.value = Object.fromEntries(
        analysis.recommended.map((stage) => [stage.stage, true]),
      );
      repairAnalysis.value = analysis;
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      analyzingRepair.value = false;
    }
  }

  /** Flips one recommended stage on or off. */
  function setRepairStageChecked(stage: MasteringRepairStageName, checked: boolean): void {
    repairStageChecked.value = { ...repairStageChecked.value, [stage]: checked };
  }

  /** Applies the checked recommended stages as one new version. */
  async function onApplyRepair(): Promise<void> {
    const ops = wasmOps.value;
    const analysis = repairAnalysis.value;
    if (!ops || !analysis) return;
    const stages = checkedRepairStages(analysis, repairStageChecked.value);
    if (stages.length === 0) return;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.repair, {
        stages: stages.map((stage) => t.value.shell.sampleEditor[stage.stage]).join(', '),
      }),
      (channels, range) => repairStagesRange(ops, channels, sampleRate(), stages, range),
    );
  }

  async function onHarmonic(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.harmonic, (channels, range) =>
      harmonicRange(ops, channels, sampleRate(), range),
    );
  }

  async function onPercussive(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.percussive, (channels, range) =>
      percussiveRange(ops, channels, sampleRate(), range),
    );
  }

  async function onSpectralDenoise(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    await runOp(t.value.shell.sampleEditor.ops.spectralDenoise, (channels, range) =>
      spectralDenoiseRange(ops, channels, sampleRate(), range),
    );
  }

  async function onSpectralEdit(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const lowHz = parseNumber(spectralLowHzInput.value);
    const highHz = parseNumber(spectralHighHzInput.value);
    const gainDb = parseNumber(spectralGainDbInput.value);
    const mode = spectralModeInput.value;
    if (lowHz === null || highHz === null || gainDb === null) {
      error.value = t.value.shell.sampleEditor.errors.spectralEdit;
      return;
    }
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.spectralEdit, {
        mode: t.value.shell.sampleEditor.spectralModes[mode],
        lowHz,
        highHz: highHz === 0 ? t.value.shell.sampleEditor.nyquist : highHz,
      }),
      (channels, range) =>
        spectralEditRange(ops, channels, sampleRate(), range, { lowHz, highHz, gainDb, mode }),
    );
  }

  /**
   * Places the whole file in a synthesized room, extending it with the reverb
   * tail (room reverb is a whole-signal effect, so it ignores any selection).
   */
  async function onPlaceInRoom(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const entry = selectedRoomPreset();
    if (!entry) return;
    const wet = parsePercentFraction(roomWetInput.value, DEFAULT_ROOM_WET_PERCENT);
    let diagnostics: RirDiagnostic[] = [];
    const committed = await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.placeInRoom, { room: entry.label }),
      (channels) => {
        const rendered = roomMorphChannels(
          ops,
          channels,
          sampleRate(),
          entry.preset,
          wet,
          roomAirAbsorption.value,
        );
        diagnostics = rendered.diagnostics;
        return rendered.channels;
      },
    );
    if (committed) notices.value = diagnostics.map(roomNoticeText);
  }

  async function onSynthesizeRir(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const entry = selectedRoomPreset();
    if (!entry) return;
    let diagnostics: RirDiagnostic[] = [];
    const committed = await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.synthesizeRir, { room: entry.label }),
      () => {
        const rendered = synthesizeRirChannels(
          ops,
          sampleRate(),
          entry.preset,
          roomAirAbsorption.value,
        );
        diagnostics = rendered.diagnostics;
        return rendered.channels;
      },
    );
    if (committed) notices.value = diagnostics.map(roomNoticeText);
  }

  /** Localizes a room-synthesis diagnostic, falling back to the library text. */
  function roomNoticeText(diagnostic: RirDiagnostic): string {
    const text = t.value.shell.sampleEditor.roomNotices;
    switch (diagnostic.code) {
      case 'acoustic.ism_order_clamped':
        return text.ismOrderClamped;
      case 'acoustic.rir_length_clamped':
        return text.rirLengthClamped;
      case 'acoustic.rir_length_floored':
        return text.rirLengthFloored;
      case 'acoustic.rir_tail_truncated':
        return text.rirTailTruncated;
      case 'acoustic.no_late_tail':
        return text.noLateTail;
      default:
        return diagnostic.message;
    }
  }

  /** Re-lists the stored assets offered as Match EQ references. */
  async function refreshReferenceAssets(): Promise<void> {
    try {
      referenceAssets.value = await listAssets();
    } catch {
      referenceAssets.value = [];
    }
  }

  /** Loads a Match EQ reference while holding a lease so it cannot be collected mid-load. */
  async function loadReferenceAsset(refId: string): Promise<LoadedAudioAsset> {
    const referenceLease = leaseAudioAssets([refId]);
    try {
      return await loadAsset(refId);
    } finally {
      referenceLease.release();
    }
  }

  /**
   * EQ-matches the selection (or whole file) to a chosen reference asset's
   * tonal balance, producing a new version. The reference is loaded and
   * downmixed to mono before the synchronous range transform runs.
   */
  async function onMatchEq(): Promise<void> {
    const ops = wasmOps.value;
    const refId = referenceAssetId.value;
    if (!ops || refId === '' || opsDisabled.value) return;
    const loaded = asset.value;
    if (!loaded) return;
    const token = beginOperation(loaded, refId);
    error.value = null;
    busy.value = true;
    let referenceMono: Float32Array;
    let referenceSampleRate: number;
    try {
      const reference = await loadReferenceAsset(refId);
      if (!operationIsCurrent(token)) return;
      referenceMono = downmixToMono(reference.channels);
      referenceSampleRate = reference.meta.sampleRate;
    } catch (err) {
      if (operationIsCurrent(token)) error.value = errorMessage(err);
      return;
    } finally {
      busy.value = false;
    }
    const referenceName = referenceAssets.value.find((meta) => meta.id === refId)?.name ?? '';
    const amount = parsePercentFraction(matchEqAmountInput.value, DEFAULT_MATCH_EQ_AMOUNT_PERCENT);
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.matchEq, { reference: referenceName }),
      (channels, range) =>
        matchEqToReference(
          ops,
          channels,
          sampleRate(),
          referenceMono,
          range,
          amount,
          referenceSampleRate,
        ),
    );
    // The applied match changes the source, so the previous analysis is stale.
    matchEqAnalysis.value = null;
  }

  /**
   * Analyzes the selection (or whole file) against the chosen reference and shows
   * the match EQ curve, tonal balance and loudness comparison. Read-only: no new
   * version is created.
   */
  async function onAnalyzeMatchEq(): Promise<void> {
    const ops = wasmOps.value;
    const loaded = asset.value;
    const refId = referenceAssetId.value;
    if (!ops || !loaded || refId === '' || opsDisabled.value || analyzingMatchEq.value) return;
    const token = beginOperation(loaded, refId);
    error.value = null;
    analyzingMatchEq.value = true;
    try {
      const reference = await loadReferenceAsset(refId);
      if (!operationIsCurrent(token)) return;
      const referenceMono = downmixToMono(reference.channels);
      matchEqAnalysis.value = analyzeMatchEqToReference(
        ops,
        loaded.channels,
        loaded.meta.sampleRate,
        referenceMono,
        selRange(),
        reference.meta.sampleRate,
      );
    } catch (err) {
      if (operationIsCurrent(token)) error.value = errorMessage(err);
    } finally {
      analyzingMatchEq.value = false;
    }
  }

  /** Estimates room size/decay from the selection (or whole file). */
  async function onEstimateRoom(): Promise<void> {
    const ops = wasmOps.value;
    const loaded = asset.value;
    if (!ops || !loaded || opsDisabled.value || estimatingRoom.value) return;
    error.value = null;
    estimatingRoom.value = true;
    try {
      roomEstimate.value = estimateRoomRange(
        ops,
        loaded.channels,
        loaded.meta.sampleRate,
        selRange(),
      );
      if (roomEstimateHasGeometry(roomEstimate.value)) {
        roomPresetId.value = ESTIMATED_ROOM_PRESET_ID;
      }
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      estimatingRoom.value = false;
    }
  }

  /** Analyzes the selection as an impulse response and shows decay/clarity metrics. */
  async function onAnalyzeImpulseResponse(): Promise<void> {
    const ops = wasmOps.value;
    const loaded = asset.value;
    if (!ops || !loaded || opsDisabled.value || analyzingAcoustic.value) return;
    error.value = null;
    analyzingAcoustic.value = true;
    try {
      acousticAnalysis.value = analyzeImpulseResponseRange(
        ops,
        loaded.channels,
        loaded.meta.sampleRate,
        selRange(),
      );
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      analyzingAcoustic.value = false;
    }
  }

  /** Runs blind acoustic detection over the selection or whole file. */
  async function onDetectAcoustic(): Promise<void> {
    const ops = wasmOps.value;
    const loaded = asset.value;
    if (!ops || !loaded || opsDisabled.value || analyzingAcoustic.value) return;
    error.value = null;
    analyzingAcoustic.value = true;
    try {
      acousticAnalysis.value = detectAcousticRange(
        ops,
        loaded.channels,
        loaded.meta.sampleRate,
        selRange(),
      );
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      analyzingAcoustic.value = false;
    }
  }

  return {
    dispose: () => {
      runner.dispose();
    },
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
    denoiseDepthInput,
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
    referenceAssets,
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
    opsDisabled,
    referenceOptions,
    roomPresetOptions,
    spectralModeOptions,
    matchEqCurvePoints,
    refreshReferenceAssets,
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
  };
}
