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
import {
  type AudioAssetMeta,
  type LoadedAudioAsset,
  listAssets,
  loadAsset,
  saveAsset,
} from '@/persistence/assets';
import { formatMessage, useI18n } from '@/ui/i18n';
import { editedAssetName, pushVersion, type VersionHistoryState } from './history';
import type { MatchEqAnalysis } from './match-eq-analysis';
import { formatMidiNote, parseMidiNote } from './note-names';
import { downmixToMono } from './onsets';
import {
  applyGainDb,
  fadeInLinear,
  fadeOutLinear,
  normalizeToDb,
  resolveRange,
  reverse,
  type SampleRange,
  silence,
  trimToRange,
} from './ops';
import { modeMaskFor, scaleName } from './scales';
import {
  type AcousticAnalysisSummary,
  analyzeImpulseResponseRange,
  analyzeMatchEqToReference,
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
  noteStretchRange,
  percussiveRange,
  pitchCorrectRange,
  pitchCorrectTimevaryingRange,
  pitchShiftRange,
  type RoomEstimateSummary,
  type RoomMorphPreset,
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
  { id: 'smallRoom', preset: { lengthM: 4, widthM: 3, heightM: 2.6, materialPreset: 2 } },
  { id: 'largeRoom', preset: { lengthM: 9, widthM: 7, heightM: 3.5, materialPreset: 4 } },
  { id: 'concertHall', preset: { lengthM: 24, widthM: 16, heightM: 10, materialPreset: 1 } },
];
const ESTIMATED_ROOM_PRESET_ID = 'estimatedRoom';

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
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isFinite(parsed) ? parsed : null;
}

/** Builds the operation models, the runOp wrapper and every operation action. */
export function useSampleOperations(options: UseSampleOperationsOptions) {
  const {
    asset,
    currentAssetId,
    historyState,
    busy,
    loading,
    error,
    wasmOps,
    selRange,
    loadCurrent,
    emitAssetCreated,
    clearSelection,
  } = options;

  const { t } = useI18n();

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
  const stretchInput = ref('1');
  /** Silence-split threshold in dB below the peak. */
  const silenceThresholdInput = ref('40');
  /** Rectangular spectral edit controls: frequency band, gain and edit mode. */
  const spectralLowHzInput = ref('4000');
  const spectralHighHzInput = ref('0');
  const spectralGainDbInput = ref('-18');
  const spectralModeInput = ref<SpectralEditMode>('attenuate');

  /** Selected room shape id (see {@link ROOM_PRESETS}). */
  const roomPresetId = ref(ROOM_PRESETS[0].id);
  /** Room reverb wet/dry mix as a percentage string (0 = dry, 100 = fully wet). */
  const roomWetInput = ref('35');

  /** Stored audio assets offered as the Match EQ reference. */
  const referenceAssets = ref<AudioAssetMeta[]>([]);
  /** Selected reference asset id ('' = none picked). */
  const referenceAssetId = ref('');
  /** Parallel match strength as a percentage string (100 = fully matched). */
  const matchEqAmountInput = ref('100');
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
    const estimated = roomEstimate.value
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
    matchEqAnalysis.value = null;
  });

  watch(asset, () => {
    roomEstimate.value = null;
    if (roomPresetId.value === ESTIMATED_ROOM_PRESET_ID) {
      roomPresetId.value = ROOM_PRESETS[0].id;
    }
  });

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

  /**
   * Runs one offline operation: produces new channel buffers, stores them as a
   * new asset version, records it in the history and switches to it. When the
   * result is byte-identical to the current version (same content hash) the
   * editor stays put.
   */
  async function runOp(
    label: string,
    produce: (channels: Float32Array[], range: SampleRange) => Float32Array[],
  ): Promise<void> {
    const loaded = asset.value;
    if (!loaded || busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      const range = resolveRange(loaded.channels, selRange());
      // Asset channels are cached and shared: operations copy, never mutate.
      const channels = produce(loaded.channels, range);
      const meta = await saveAsset(
        { name: editedAssetName(loaded.meta.name), sampleRate: loaded.meta.sampleRate },
        channels,
      );
      if (meta.id !== currentAssetId.value) {
        const sourceAssetId = currentAssetId.value;
        historyState.value = pushVersion(historyState.value, { assetId: meta.id, label });
        currentAssetId.value = meta.id;
        emitAssetCreated(meta.id, sourceAssetId);
        await loadCurrent(meta.id);
      }
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      busy.value = false;
    }
  }

  function sampleRate(): number {
    return asset.value?.meta.sampleRate ?? 48000;
  }

  async function onGain(): Promise<void> {
    const db = parseNumber(gainDbInput.value);
    if (db === null) {
      error.value = t.value.shell.sampleEditor.errors.gain;
      return;
    }
    await runOp(formatMessage(t.value.shell.sampleEditor.ops.gain, { db }), (channels, range) =>
      applyGainDb(channels, db, range),
    );
  }

  async function onNormalize(): Promise<void> {
    const target = parseNumber(normalizeTargetInput.value) ?? -1;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.normalize, { target }),
      (channels, range) => normalizeToDb(channels, target, range),
    );
  }

  async function onFadeIn(): Promise<void> {
    await runOp(t.value.shell.sampleEditor.ops.fadeIn, (channels, range) =>
      fadeInLinear(channels, range),
    );
  }

  async function onFadeOut(): Promise<void> {
    await runOp(t.value.shell.sampleEditor.ops.fadeOut, (channels, range) =>
      fadeOutLinear(channels, range),
    );
  }

  async function onReverse(): Promise<void> {
    await runOp(t.value.shell.sampleEditor.ops.reverse, (channels, range) =>
      reverse(channels, range),
    );
  }

  async function onSilence(): Promise<void> {
    await runOp(t.value.shell.sampleEditor.ops.silence, (channels, range) =>
      silence(channels, range),
    );
  }

  async function onTrim(): Promise<void> {
    const range = selRange();
    if (!range) return;
    await runOp(t.value.shell.sampleEditor.ops.trim, (channels) => trimToRange(channels, range));
    clearSelection();
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

  async function onPitchCorrect(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const targetMidi = parseMidiNote(tuneNoteInput.value);
    if (targetMidi === null) {
      error.value = t.value.shell.sampleEditor.errors.tune;
      return;
    }
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.tune, { note: formatMidiNote(targetMidi) }),
      (channels, range) => pitchCorrectRange(ops, channels, sampleRate(), targetMidi, range),
    );
  }

  async function onPitchCorrectTimevarying(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const targetMidi = parseMidiNote(tuneNoteInput.value);
    if (targetMidi === null) {
      error.value = t.value.shell.sampleEditor.errors.tune;
      return;
    }
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.tuneContour, {
        note: formatMidiNote(targetMidi),
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
      formatMessage(t.value.shell.sampleEditor.ops.tuneScale, { scale: scaleName(root, mode) }),
      (channels, range) =>
        scaleCorrectRange(ops, channels, sampleRate(), root, modeMaskFor(mode), range),
    );
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
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.voice, {
        sign: pitchSemitones >= 0 ? '+' : '',
        semitones: pitchSemitones,
        formant: formantFactor,
      }),
      (channels, range) =>
        voiceChangeRange(ops, channels, sampleRate(), pitchSemitones, formantFactor, range),
    );
  }

  async function onTimeStretch(): Promise<void> {
    const ops = wasmOps.value;
    const rate = parseNumber(stretchInput.value);
    if (!ops) return;
    if (rate === null || rate <= 0) {
      error.value = t.value.shell.sampleEditor.errors.stretch;
      return;
    }
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.stretch, { rate }),
      (channels, range) => timeStretchRange(ops, channels, sampleRate(), rate, range),
    );
  }

  async function onNoteStretch(): Promise<void> {
    const ops = wasmOps.value;
    const rate = parseNumber(stretchInput.value);
    if (!ops) return;
    if (rate === null || rate <= 0) {
      error.value = t.value.shell.sampleEditor.errors.stretch;
      return;
    }
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.noteStretch, { rate }),
      (channels, range) => noteStretchRange(ops, channels, sampleRate(), rate, range),
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
    await runOp(t.value.shell.sampleEditor.ops.denoise, (channels, range) =>
      denoiseRange(ops, channels, sampleRate(), range),
    );
  }

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
    // Clamp the user's percentage to [0, 100] before mapping to a [0, 1] wet mix.
    const wetPercent = parseNumber(roomWetInput.value) ?? 35;
    const wet = Math.min(Math.max(wetPercent, 0), 100) / 100;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.placeInRoom, { room: entry.label }),
      (channels) => roomMorphChannels(ops, channels, sampleRate(), entry.preset, wet),
    );
  }

  async function onSynthesizeRir(): Promise<void> {
    const ops = wasmOps.value;
    if (!ops) return;
    const entry = selectedRoomPreset();
    if (!entry) return;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.synthesizeRir, { room: entry.label }),
      () => synthesizeRirChannels(ops, sampleRate(), entry.preset),
    );
  }

  /** Re-lists the stored assets offered as Match EQ references. */
  async function refreshReferenceAssets(): Promise<void> {
    try {
      referenceAssets.value = await listAssets();
    } catch {
      referenceAssets.value = [];
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
    error.value = null;
    let referenceMono: Float32Array;
    try {
      const reference = await loadAsset(refId);
      referenceMono = downmixToMono(reference.channels);
    } catch (err) {
      error.value = errorMessage(err);
      return;
    }
    const referenceName = referenceAssets.value.find((meta) => meta.id === refId)?.name ?? '';
    // Clamp the user's percentage to [0, 100] before mapping to a [0, 1] mix.
    const amountPercent = parseNumber(matchEqAmountInput.value) ?? 100;
    const amount = Math.min(Math.max(amountPercent, 0), 100) / 100;
    await runOp(
      formatMessage(t.value.shell.sampleEditor.ops.matchEq, { reference: referenceName }),
      (channels, range) =>
        matchEqToReference(ops, channels, sampleRate(), referenceMono, range, amount),
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
    error.value = null;
    analyzingMatchEq.value = true;
    try {
      const reference = await loadAsset(refId);
      const referenceMono = downmixToMono(reference.channels);
      matchEqAnalysis.value = analyzeMatchEqToReference(
        ops,
        loaded.channels,
        loaded.meta.sampleRate,
        referenceMono,
        selRange(),
      );
    } catch (err) {
      error.value = errorMessage(err);
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
      roomPresetId.value = ESTIMATED_ROOM_PRESET_ID;
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
    spectralLowHzInput,
    spectralHighHzInput,
    spectralGainDbInput,
    spectralModeInput,
    roomPresetId,
    roomWetInput,
    referenceAssets,
    referenceAssetId,
    matchEqAmountInput,
    matchEqAnalysis,
    analyzingMatchEq,
    roomEstimate,
    estimatingRoom,
    acousticAnalysis,
    analyzingAcoustic,
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
    onPitchShift,
    onPitchCorrect,
    onPitchCorrectTimevarying,
    onTuneReference,
    onScaleCorrect,
    onVoiceChange,
    onTimeStretch,
    onNoteStretch,
    onDeclick,
    onDenoise,
    onDeclip,
    onDecrackle,
    onDehum,
    onDereverb,
    onTrimSilenceRepair,
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
