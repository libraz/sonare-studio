<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { setupCanvas } from '@/components/piano-roll/theme';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  type AudioAssetMeta,
  type LoadedAudioAsset,
  listAssets,
  loadAsset,
  saveAsset,
} from '@/persistence/assets';
import { setClipWarp } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { ClipWarp } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  type AssetVersion,
  createHistory,
  editedAssetName,
  pushVersion,
  selectVersion,
  type VersionHistoryState,
} from '@/ui/sample-editor/history';
import type { MatchEqAnalysis } from '@/ui/sample-editor/match-eq-analysis';
import { formatMidiNote, parseMidiNote } from '@/ui/sample-editor/note-names';
import { downmixToMono, sliceRangeAt, snapFrameToOnsets } from '@/ui/sample-editor/onsets';
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
} from '@/ui/sample-editor/ops';
import { MODE_OPTIONS, modeMaskFor, ROOT_OPTIONS, scaleName } from '@/ui/sample-editor/scales';
import {
  beginSelection,
  clampFrameIndex,
  dragSelection,
  extendSelection,
  type SelectionDraft,
  selectionRange,
  selectionReadout,
} from '@/ui/sample-editor/selection';
import { SampleViewport } from '@/ui/sample-editor/viewport';
import {
  defaultWarpAnchor,
  findWarpClip,
  mergedWarp,
  segmentStretchRatios,
} from '@/ui/sample-editor/warp-controls';
import {
  analyzeMatchEqToReference,
  declickRange,
  denoiseRange,
  detectOnsetFrames,
  harmonicRange,
  loadSampleEditorWasm,
  matchEqToReference,
  noteStretchRange,
  percussiveRange,
  pitchCorrectRange,
  pitchShiftRange,
  type RoomMorphPreset,
  roomMorphChannels,
  type SampleEditorWasmOps,
  scaleCorrectRange,
  splitSilenceFrames,
  timeStretchRange,
  tuneToReferenceRange,
  voiceChangeRange,
  wasmOpAvailability,
} from '@/ui/sample-editor/wasm-ops';
import { colorWithAlpha, TOKENS } from '@/ui/theme/tokens';
import { computePeaks } from '@/ui/waveform/peaks';

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

/** Height of one channel lane in CSS px. */
const LANE_HEIGHT_PX = 96;
/** Wheel-zoom sensitivity (factor exponent per wheel delta unit). */
const WHEEL_ZOOM_SENSITIVITY = 0.01;

/** Pointer distance (CSS px) within which a selection edge snaps to an onset. */
const ONSET_SNAP_PX = 6;

/** Canvas color tokens, derived from the dark palette mirror in tokens.ts. */
const COLORS = {
  background: TOKENS.surface2,
  waveform: TOKENS.accent,
  centerLine: colorWithAlpha(TOKENS.border, 0.7),
  laneSeparator: colorWithAlpha(TOKENS.border, 0.6),
  selectionFill: colorWithAlpha(TOKENS.accent, 0.16),
  selectionEdge: colorWithAlpha(TOKENS.accent, 0.85),
  onsetMarker: colorWithAlpha(TOKENS.warning, 0.7),
} as const;

const wrapRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const asset = shallowRef<LoadedAudioAsset | null>(null);
const currentAssetId = ref(props.assetId);
const historyState = ref<VersionHistoryState>(
  createHistory({ assetId: props.assetId, label: t.value.shell.sampleEditor.ops.original }),
);
const selection = ref<SelectionDraft | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

/** Detected transient onset positions in frames (overlay markers). */
const onsetFrames = ref<number[]>([]);

/** Non-reactive: redraws are scheduled explicitly after viewport changes. */
let viewport: SampleViewport | null = null;
let resizeObserver: ResizeObserver | null = null;
let dragging = false;
let drawQueued = false;

const wasmOps = shallowRef<SampleEditorWasmOps | null>(null);
const wasmAvail = computed(() => wasmOpAvailability(wasmOps.value));

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

/** Reference picker options: a placeholder plus every other stored asset. */
const referenceOptions = computed(() => [
  { value: '', label: t.value.shell.sampleEditor.selectReference },
  ...referenceAssets.value
    .filter((meta) => meta.id !== currentAssetId.value)
    .map((meta) => ({ value: meta.id, label: meta.name })),
]);

/** Room-shape picker options labelled from the localized preset names. */
const roomPresetOptions = computed(() =>
  ROOM_PRESETS.map((entry) => ({
    value: entry.id,
    label:
      t.value.shell.sampleEditor.roomPresets[
        entry.id as keyof typeof t.value.shell.sampleEditor.roomPresets
      ],
  })),
);

/** Viewport size for the inline match EQ curve preview, in SVG user units. */
const MATCH_EQ_CURVE_WIDTH = 240;
const MATCH_EQ_CURVE_HEIGHT = 64;
/** Half-range of the curve's symmetric dB axis (gains clamp to ±this). */
const MATCH_EQ_CURVE_DB_RANGE = 12;

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

/** Peak targets (in dB) offered by the normalize control. */
const NORMALIZE_TARGET_OPTIONS: { value: string; label: string }[] = [
  { value: '-1', label: '-1 dB' },
  { value: '-3', label: '-3 dB' },
  { value: '-6', label: '-6 dB' },
];

const selRange = computed(() => selectionRange(selection.value));
const opsDisabled = computed(
  () => busy.value || loading.value || !asset.value || asset.value.meta.numFrames === 0,
);
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

/** Clamps the selection to a new audio length (drops empty results). */
function clampSelectionTo(totalFrames: number): void {
  const draft = selection.value;
  if (!draft) return;
  const anchorFrame = clampFrameIndex(draft.anchorFrame, totalFrames);
  const headFrame = clampFrameIndex(draft.headFrame, totalFrames);
  selection.value = anchorFrame === headFrame ? null : { anchorFrame, headFrame };
}

async function loadCurrent(assetId: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const loaded = await loadAsset(assetId);
    asset.value = loaded;
    // Markers belong to the previous buffer; a new version invalidates them.
    onsetFrames.value = [];
    const widthPx = wrapRef.value?.clientWidth || 800;
    if (viewport && viewport.widthPx === widthPx) {
      viewport.setTotalFrames(loaded.meta.numFrames);
    } else {
      viewport = markRaw(new SampleViewport(loaded.meta.numFrames, widthPx));
    }
    clampSelectionTo(loaded.meta.numFrames);
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
    viewport = null;
    void loadCurrent(assetId);
  },
);

// The current asset cannot be its own reference; keep the picker list fresh
// (new edited versions become selectable references too).
watch(currentAssetId, (id) => {
  if (referenceAssetId.value === id) referenceAssetId.value = '';
  void refreshReferenceAssets();
});

// --- Drawing -----------------------------------------------------------------

function scheduleDraw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function draw(): void {
  const canvas = canvasRef.value;
  const view = viewport;
  if (!canvas || !view) return;
  const loaded = asset.value;
  const widthPx = Math.max(1, Math.round(view.widthPx));
  const lanes = Math.max(1, loaded?.channels.length ?? 1);
  const heightPx = lanes * LANE_HEIGHT_PX;
  canvas.style.height = `${heightPx}px`;
  const ctx = setupCanvas(canvas, widthPx, heightPx);
  if (!ctx) return;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, widthPx, heightPx);
  if (!loaded || loaded.meta.numFrames === 0) return;

  const startFrame = Math.max(0, Math.floor(view.startFrame));
  const endFrame = Math.min(loaded.meta.numFrames, Math.ceil(view.endFrame));
  if (endFrame > startFrame) {
    const windows = loaded.channels.map((channel) => channel.subarray(startFrame, endFrame));
    const peaks = computePeaks(windows, widthPx);
    for (let c = 0; c < peaks.length; c++) {
      const laneTop = c * LANE_HEIGHT_PX;
      const mid = laneTop + LANE_HEIGHT_PX / 2;
      const amp = (LANE_HEIGHT_PX / 2) * 0.9;
      if (c > 0) {
        ctx.fillStyle = COLORS.laneSeparator;
        ctx.fillRect(0, laneTop, widthPx, 1);
      }
      ctx.fillStyle = COLORS.centerLine;
      ctx.fillRect(0, mid, widthPx, 1);
      ctx.fillStyle = COLORS.waveform;
      const { min, max } = peaks[c];
      for (let x = 0; x < widthPx; x++) {
        const hi = Math.min(1, Math.max(-1, max[x]));
        const lo = Math.min(1, Math.max(-1, min[x]));
        const y = mid - hi * amp;
        ctx.fillRect(x, y, 1, Math.max(1, (hi - lo) * amp));
      }
    }
  }

  if (onsetFrames.value.length > 0) {
    ctx.fillStyle = COLORS.onsetMarker;
    for (const frame of onsetFrames.value) {
      const x = view.frameToX(frame);
      if (x < 0 || x > widthPx) continue;
      ctx.fillRect(Math.floor(x), 0, 1, heightPx);
    }
  }

  const range = selRange.value;
  if (range) {
    const x0 = Math.max(0, view.frameToX(range.startFrame));
    const x1 = Math.min(widthPx, view.frameToX(range.endFrame));
    if (x1 > x0) {
      ctx.fillStyle = COLORS.selectionFill;
      ctx.fillRect(x0, 0, x1 - x0, heightPx);
      ctx.fillStyle = COLORS.selectionEdge;
      ctx.fillRect(Math.floor(x0), 0, 1, heightPx);
      ctx.fillRect(Math.floor(x1) - 1, 0, 1, heightPx);
    }
  }
}

watch([selection, asset, onsetFrames], scheduleDraw);

// --- Pointer / wheel interaction --------------------------------------------

function localX(event: PointerEvent | WheelEvent): number {
  const rect = wrapRef.value?.getBoundingClientRect();
  return event.clientX - (rect?.left ?? 0);
}

/** Maps a pointer x to a frame, snapping to a nearby onset marker if one exists. */
function frameAtPointer(view: SampleViewport, x: number): number {
  const frame = view.xToFrame(x);
  if (onsetFrames.value.length === 0) return frame;
  return snapFrameToOnsets(frame, onsetFrames.value, ONSET_SNAP_PX * view.framesPerPx);
}

/** Shift state and raw down frame of the active gesture (for slice-on-click). */
let pointerDownShift = false;
let pointerDownRawFrame = 0;

function onPointerDown(event: PointerEvent): void {
  const view = viewport;
  const loaded = asset.value;
  if (event.button !== 0 || !view || !loaded) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  pointerDownShift = event.shiftKey;
  pointerDownRawFrame = view.xToFrame(localX(event));
  const frame = frameAtPointer(view, localX(event));
  selection.value = event.shiftKey
    ? extendSelection(selection.value, frame, loaded.meta.numFrames)
    : beginSelection(frame, loaded.meta.numFrames);
  dragging = true;
}

function onPointerMove(event: PointerEvent): void {
  const view = viewport;
  const loaded = asset.value;
  const draft = selection.value;
  if (!dragging || !view || !loaded || !draft) return;
  selection.value = dragSelection(
    draft,
    frameAtPointer(view, localX(event)),
    loaded.meta.numFrames,
  );
}

function onPointerUp(): void {
  const loaded = asset.value;
  // A click (no drag) on a transient-marked file selects the slice it lands in.
  if (
    dragging &&
    !pointerDownShift &&
    loaded &&
    onsetFrames.value.length > 0 &&
    selectionRange(selection.value) === null
  ) {
    const slice = sliceRangeAt(pointerDownRawFrame, onsetFrames.value, loaded.meta.numFrames);
    if (slice) selection.value = { anchorFrame: slice.startFrame, headFrame: slice.endFrame };
  }
  dragging = false;
}

function onWheel(event: WheelEvent): void {
  const view = viewport;
  if (!view) return;
  if (event.metaKey || event.ctrlKey) {
    view.zoomAt(localX(event), Math.exp(event.deltaY * WHEEL_ZOOM_SENSITIVITY));
  } else {
    view.scrollByPx(event.deltaX !== 0 ? event.deltaX : event.deltaY);
  }
  scheduleDraw();
}

function zoomToFit(): void {
  viewport?.zoomToFit();
  scheduleDraw();
}

// --- Operations --------------------------------------------------------------

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isFinite(parsed) ? parsed : null;
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
    const range = resolveRange(loaded.channels, selRange.value);
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
      emit('asset-created', meta.id, sourceAssetId);
      await loadCurrent(meta.id);
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
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
  const range = selRange.value;
  if (!range) return;
  await runOp(t.value.shell.sampleEditor.ops.trim, (channels) => trimToRange(channels, range));
  selection.value = null;
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
    (channels, range) =>
      pitchShiftRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, semitones, range),
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
    (channels, range) =>
      pitchCorrectRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, targetMidi, range),
  );
}

async function onTuneReference(): Promise<void> {
  const ops = wasmOps.value;
  if (!ops) return;
  await runOp(t.value.shell.sampleEditor.ops.tuneReference, (channels, range) =>
    tuneToReferenceRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, range),
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
      scaleCorrectRange(
        ops,
        channels,
        asset.value?.meta.sampleRate ?? 48000,
        root,
        modeMaskFor(mode),
        range,
      ),
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
      voiceChangeRange(
        ops,
        channels,
        asset.value?.meta.sampleRate ?? 48000,
        pitchSemitones,
        formantFactor,
        range,
      ),
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
  await runOp(formatMessage(t.value.shell.sampleEditor.ops.stretch, { rate }), (channels, range) =>
    timeStretchRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, rate, range),
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
    (channels, range) =>
      noteStretchRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, rate, range),
  );
}

async function onDeclick(): Promise<void> {
  const ops = wasmOps.value;
  if (!ops) return;
  await runOp(t.value.shell.sampleEditor.ops.declick, (channels, range) =>
    declickRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, range),
  );
}

async function onDenoise(): Promise<void> {
  const ops = wasmOps.value;
  if (!ops) return;
  await runOp(t.value.shell.sampleEditor.ops.denoise, (channels, range) =>
    denoiseRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, range),
  );
}

async function onHarmonic(): Promise<void> {
  const ops = wasmOps.value;
  if (!ops) return;
  await runOp(t.value.shell.sampleEditor.ops.harmonic, (channels, range) =>
    harmonicRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, range),
  );
}

async function onPercussive(): Promise<void> {
  const ops = wasmOps.value;
  if (!ops) return;
  await runOp(t.value.shell.sampleEditor.ops.percussive, (channels, range) =>
    percussiveRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, range),
  );
}

/**
 * Places the whole file in a synthesized room, extending it with the reverb
 * tail (room reverb is a whole-signal effect, so it ignores any selection).
 */
async function onPlaceInRoom(): Promise<void> {
  const ops = wasmOps.value;
  if (!ops) return;
  const entry = ROOM_PRESETS.find((candidate) => candidate.id === roomPresetId.value);
  if (!entry) return;
  // Clamp the user's percentage to [0, 100] before mapping to a [0, 1] wet mix.
  const wetPercent = parseNumber(roomWetInput.value) ?? 35;
  const wet = Math.min(Math.max(wetPercent, 0), 100) / 100;
  const roomName =
    t.value.shell.sampleEditor.roomPresets[
      entry.id as keyof typeof t.value.shell.sampleEditor.roomPresets
    ];
  await runOp(
    formatMessage(t.value.shell.sampleEditor.ops.placeInRoom, { room: roomName }),
    (channels) =>
      roomMorphChannels(ops, channels, asset.value?.meta.sampleRate ?? 48000, entry.preset, wet),
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
      matchEqToReference(
        ops,
        channels,
        asset.value?.meta.sampleRate ?? 48000,
        referenceMono,
        range,
        amount,
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
      selRange.value,
    );
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    analyzingMatchEq.value = false;
  }
}

/**
 * Detects transient onsets across the whole file and shows them as overlay
 * markers. The markers do not alter the audio; they snap selection edges and
 * let a click pick the slice between two transients (then any op can run on it).
 */
function onDetectTransients(): void {
  const ops = wasmOps.value;
  const loaded = asset.value;
  if (!ops || !loaded) return;
  error.value = null;
  try {
    onsetFrames.value = detectOnsetFrames(ops, loaded.channels, loaded.meta.sampleRate);
  } catch (err) {
    error.value = errorMessage(err);
  }
}

/**
 * Splits the whole file on silence and shows the cut boundaries as the same
 * overlay markers the transient detector uses (a click then selects the slice —
 * silent or not — between two cuts). The audio is untouched.
 */
function onSplitSilence(): void {
  const ops = wasmOps.value;
  const loaded = asset.value;
  if (!ops || !loaded) return;
  error.value = null;
  const topDb = parseNumber(silenceThresholdInput.value);
  try {
    onsetFrames.value = splitSilenceFrames(ops, loaded.channels, topDb ?? undefined);
  } catch (err) {
    error.value = errorMessage(err);
  }
}

/** Removes the transient markers (selection and audio are untouched). */
function onClearTransients(): void {
  onsetFrames.value = [];
}

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

/**
 * The clip whose tempo-follow state the warp controls edit: the active clip
 * when it is an audio clip without takes referencing this asset, else the
 * first such clip. Null hides the section (MIDI clips, clips with takes,
 * assets not placed in the arrangement).
 */
const warpClip = computed(() => findWarpClip(project.clips, project.clipId, props.assetId));
const warpEnabled = computed(() => warpClip.value?.warp?.enabled ?? false);
const warpAnchors = computed(() => warpClip.value?.warp?.anchors ?? []);
/** Per-segment stretch ratio hints at the current project tempo. */
const warpRatioHint = computed(() => {
  const clip = warpClip.value;
  if (!clip) return '';
  return segmentStretchRatios(clip, project.tempoBpm)
    .map((ratio) => `×${ratio.toFixed(2)}`)
    .join(' · ');
});

const warpBpmInput = ref('');
watch(
  () => [warpClip.value?.id, warpClip.value?.warp?.sourceBpm] as const,
  () => {
    warpBpmInput.value = String(warpClip.value?.warp?.sourceBpm ?? project.tempoBpm);
  },
  { immediate: true },
);

/** Applies a partial warp edit through the undoable setClipWarp command. */
function commitWarp(overrides: Partial<ClipWarp>): void {
  const clip = warpClip.value;
  if (!clip) return;
  try {
    setClipWarp(clip.id, mergedWarp(clip.warp, overrides, project.tempoBpm));
  } catch (err) {
    error.value = errorMessage(err);
  }
}

function onToggleWarp(): void {
  commitWarp({ enabled: !warpEnabled.value });
}

function onWarpBpmChange(): void {
  const bpm = parseNumber(warpBpmInput.value);
  if (bpm === null || bpm <= 0) {
    warpBpmInput.value = String(warpClip.value?.warp?.sourceBpm ?? project.tempoBpm);
    return;
  }
  commitWarp({ sourceBpm: bpm });
}

function onAnchorEdit(index: number, field: 'ppq' | 'sourceSeconds', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  commitWarp({
    anchors: warpAnchors.value.map((anchor, i) =>
      i === index ? { ...anchor, [field]: value } : anchor,
    ),
  });
}

function onRemoveAnchor(index: number): void {
  commitWarp({ anchors: warpAnchors.value.filter((_, i) => i !== index) });
}

function onAddAnchor(): void {
  const clip = warpClip.value;
  if (!clip) return;
  const sourceBpm = clip.warp?.sourceBpm ?? project.tempoBpm;
  const anchor = defaultWarpAnchor(warpAnchors.value, clip.lengthPpq, sourceBpm);
  if (!anchor) return;
  commitWarp({ anchors: [...warpAnchors.value, anchor] });
}

// --- Lifecycle -----------------------------------------------------------------

onMounted(() => {
  void loadCurrent(props.assetId);
  void refreshReferenceAssets();
  void loadSampleEditorWasm().then((ops) => {
    wasmOps.value = ops;
  });
  if (typeof ResizeObserver === 'function' && wrapRef.value) {
    resizeObserver = new ResizeObserver(() => {
      const widthPx = wrapRef.value?.clientWidth;
      if (widthPx && viewport) {
        viewport.resize(widthPx);
        scheduleDraw();
      }
    });
    resizeObserver.observe(wrapRef.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <div class="sample-editor">
    <div class="toolbar">
      <span class="asset-name" :title="currentAssetId">
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
        :title="t.shell.sampleEditor.useInProjectTitle"
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
        :title="t.shell.sampleEditor.trimTitle"
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
        :title="
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
        :title="
          wasmAvail.pitchCorrect ? t.shell.sampleEditor.tuneTitle : t.shell.sampleEditor.unavailable
        "
        @click="onPitchCorrect"
      >
        {{ t.shell.sampleEditor.apply }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.tuneReference"
        :title="
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
        :title="
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
        :title="
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
        :title="
          wasmAvail.timeStretch ? t.shell.sampleEditor.stretchTitle : t.shell.sampleEditor.unavailable
        "
        @click="onTimeStretch"
      >
        {{ t.shell.sampleEditor.apply }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.noteStretch"
        :title="
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
        :title="
          wasmAvail.declick ? t.shell.sampleEditor.declickTitle : t.shell.sampleEditor.unavailable
        "
        @click="onDeclick"
      >
        {{ t.shell.sampleEditor.declick }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.denoise"
        :title="
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
        :title="
          wasmAvail.harmonic ? t.shell.sampleEditor.harmonicTitle : t.shell.sampleEditor.unavailable
        "
        @click="onHarmonic"
      >
        {{ t.shell.sampleEditor.harmonic }}
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.percussive"
        :title="
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
        :title="
          wasmAvail.matchEq ? t.shell.sampleEditor.matchEqTitle : t.shell.sampleEditor.unavailable
        "
        @click="onMatchEq"
      >
        {{ t.shell.sampleEditor.matchEq }}
      </button>
      <label :title="t.shell.sampleEditor.matchEqAmountTitle">
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
        :title="
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
        :title="
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
        :title="
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
        :title="t.shell.sampleEditor.clearTransientsTitle"
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
      <label :title="t.shell.sampleEditor.roomWetTitle">
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
        :title="
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
        :title="versionTitle(version)"
        @click="onSelectVersion(index)"
      >
        {{ version.label }}
      </button>
    </div>
    <div v-if="warpClip" class="warp">
      <div class="toolbar">
        <span class="warp-title">{{ t.shell.sampleEditor.warp }}</span>
        <button
          type="button"
          class="warp-toggle"
          :class="{ on: warpEnabled }"
          :aria-pressed="warpEnabled"
          :title="t.shell.sampleEditor.warpTitle"
          @click="onToggleWarp"
        >
          {{ t.shell.sampleEditor.followTempo }}
        </button>
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
          :title="t.shell.sampleEditor.ratioTitle"
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
          :title="t.shell.sampleEditor.removeAnchorTitle"
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

.warp-toggle.on {
  background: var(--surface-selected);
  color: var(--text-1);
  box-shadow: inset 0 0 0 1px var(--accent), var(--control-edge);
}

.warp-toggle.on:not(:disabled):hover {
  background: var(--surface-selected);
  box-shadow: inset 0 0 0 1px var(--accent), var(--control-edge);
}

.warp-segments {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.warp-anchor {
  padding-left: 14px;
}
</style>
