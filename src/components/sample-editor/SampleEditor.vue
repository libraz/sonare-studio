<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { setupCanvas } from '@/components/piano-roll/theme';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { type LoadedAudioAsset, loadAsset, saveAsset } from '@/persistence/assets';
import { setClipWarp } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { ClipWarp } from '@/project/types';
import {
  type AssetVersion,
  createHistory,
  editedAssetName,
  pushVersion,
  selectVersion,
  type VersionHistoryState,
} from '@/ui/sample-editor/history';
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
  declickRange,
  denoiseRange,
  loadSampleEditorWasm,
  pitchShiftRange,
  type SampleEditorWasmOps,
  timeStretchRange,
  wasmOpAvailability,
} from '@/ui/sample-editor/wasm-ops';
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

/** Height of one channel lane in CSS px. */
const LANE_HEIGHT_PX = 96;
/** Wheel-zoom sensitivity (factor exponent per wheel delta unit). */
const WHEEL_ZOOM_SENSITIVITY = 0.01;

/** Canvas color tokens (matches the app's dark theme). */
const COLORS = {
  background: '#15171c',
  waveform: '#4fa8e8',
  centerLine: 'rgba(255, 255, 255, 0.12)',
  laneSeparator: 'rgba(255, 255, 255, 0.1)',
  selectionFill: 'rgba(96, 165, 250, 0.16)',
  selectionEdge: 'rgba(96, 165, 250, 0.85)',
} as const;

const wrapRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const asset = shallowRef<LoadedAudioAsset | null>(null);
const currentAssetId = ref(props.assetId);
const historyState = ref<VersionHistoryState>(
  createHistory({ assetId: props.assetId, label: 'Original' }),
);
const selection = ref<SelectionDraft | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

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
const stretchInput = ref('1');

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
    historyState.value = createHistory({ assetId, label: 'Original' });
    selection.value = null;
    viewport = null;
    void loadCurrent(assetId);
  },
);

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

watch([selection, asset], scheduleDraw);

// --- Pointer / wheel interaction --------------------------------------------

function localX(event: PointerEvent | WheelEvent): number {
  const rect = wrapRef.value?.getBoundingClientRect();
  return event.clientX - (rect?.left ?? 0);
}

function onPointerDown(event: PointerEvent): void {
  const view = viewport;
  const loaded = asset.value;
  if (event.button !== 0 || !view || !loaded) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  const frame = view.xToFrame(localX(event));
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
  selection.value = dragSelection(draft, view.xToFrame(localX(event)), loaded.meta.numFrames);
}

function onPointerUp(): void {
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
    error.value = 'Enter a finite gain in dB';
    return;
  }
  await runOp(`Gain ${db} dB`, (channels, range) => applyGainDb(channels, db, range));
}

async function onNormalize(): Promise<void> {
  const target = parseNumber(normalizeTargetInput.value) ?? -1;
  await runOp(`Normalize ${target} dB`, (channels, range) =>
    normalizeToDb(channels, target, range),
  );
}

async function onFadeIn(): Promise<void> {
  await runOp('Fade in', (channels, range) => fadeInLinear(channels, range));
}

async function onFadeOut(): Promise<void> {
  await runOp('Fade out', (channels, range) => fadeOutLinear(channels, range));
}

async function onReverse(): Promise<void> {
  await runOp('Reverse', (channels, range) => reverse(channels, range));
}

async function onSilence(): Promise<void> {
  await runOp('Silence', (channels, range) => silence(channels, range));
}

async function onTrim(): Promise<void> {
  const range = selRange.value;
  if (!range) return;
  await runOp('Trim', (channels) => trimToRange(channels, range));
  selection.value = null;
}

async function onPitchShift(): Promise<void> {
  const ops = wasmOps.value;
  const semitones = parseNumber(pitchInput.value);
  if (!ops) return;
  if (semitones === null) {
    error.value = 'Enter a finite pitch offset in semitones';
    return;
  }
  await runOp(`Pitch ${semitones >= 0 ? '+' : ''}${semitones} st`, (channels, range) =>
    pitchShiftRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, semitones, range),
  );
}

async function onTimeStretch(): Promise<void> {
  const ops = wasmOps.value;
  const rate = parseNumber(stretchInput.value);
  if (!ops) return;
  if (rate === null || rate <= 0) {
    error.value = 'Enter a stretch rate > 0';
    return;
  }
  await runOp(`Stretch ×${rate}`, (channels, range) =>
    timeStretchRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, rate, range),
  );
}

async function onDeclick(): Promise<void> {
  const ops = wasmOps.value;
  if (!ops) return;
  await runOp('Declick', (channels, range) =>
    declickRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, range),
  );
}

async function onDenoise(): Promise<void> {
  const ops = wasmOps.value;
  if (!ops) return;
  await runOp('Denoise', (channels, range) =>
    denoiseRange(ops, channels, asset.value?.meta.sampleRate ?? 48000, range),
  );
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
      <span class="asset-name" :title="currentAssetId">{{ asset?.meta.name ?? 'Loading…' }}</span>
      <span v-if="assetInfo" class="asset-info">{{ assetInfo }}</span>
      <span class="readout">{{ readout }}</span>
      <span class="spacer" />
      <button type="button" :disabled="!asset" @click="zoomToFit">Fit</button>
      <button
        type="button"
        :disabled="!asset"
        title="Ask the shell to use this version in the project"
        @click="onApply"
      >
        Use in project
      </button>
    </div>
    <div class="toolbar ops">
      <label>
        Gain
        <input v-model="gainDbInput" class="num" type="number" step="0.5" /> dB
      </label>
      <button type="button" :disabled="opsDisabled" @click="onGain">Apply</button>
      <span class="sep" />
      <label>
        Normalize
        <SelectMenu
          v-model="normalizeTargetInput"
          :options="NORMALIZE_TARGET_OPTIONS"
          aria-label="Normalize target"
          size="sm"
        />
      </label>
      <button type="button" :disabled="opsDisabled" @click="onNormalize">Apply</button>
      <span class="sep" />
      <button type="button" :disabled="opsDisabled" @click="onFadeIn">Fade in</button>
      <button type="button" :disabled="opsDisabled" @click="onFadeOut">Fade out</button>
      <button type="button" :disabled="opsDisabled" @click="onReverse">Reverse</button>
      <button type="button" :disabled="opsDisabled" @click="onSilence">Silence</button>
      <button
        type="button"
        :disabled="opsDisabled || !selRange"
        title="Crop to the selection"
        @click="onTrim"
      >
        Trim
      </button>
      <span class="sep" />
      <label>
        Pitch
        <input v-model="pitchInput" class="num" type="number" step="1" /> st
      </label>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.pitchShift"
        :title="wasmAvail.pitchShift ? 'Pitch shift (duration preserved)' : 'Unavailable in this libsonare build'"
        @click="onPitchShift"
      >
        Apply
      </button>
      <label>
        Stretch
        <input v-model="stretchInput" class="num" type="number" step="0.05" min="0.1" /> ×
      </label>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.timeStretch"
        :title="wasmAvail.timeStretch ? 'Time stretch (0.5 = double duration, 2 = half)' : 'Unavailable in this libsonare build'"
        @click="onTimeStretch"
      >
        Apply
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.declick"
        :title="wasmAvail.declick ? 'Repair clicks and pops' : 'Unavailable in this libsonare build'"
        @click="onDeclick"
      >
        Declick
      </button>
      <button
        type="button"
        :disabled="opsDisabled || !wasmAvail.denoise"
        :title="wasmAvail.denoise ? 'Reduce broadband noise' : 'Unavailable in this libsonare build'"
        @click="onDenoise"
      >
        Denoise
      </button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <div
      ref="wrapRef"
      class="wave-wrap"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel.prevent="onWheel"
    >
      <canvas ref="canvasRef" class="wave-canvas" role="img" aria-label="Audio waveform" />
      <div v-if="busy || loading" class="busy">{{ busy ? 'Processing…' : 'Loading…' }}</div>
    </div>
    <div class="history">
      <span class="history-title">History</span>
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
        <span class="warp-title">Warp</span>
        <button
          type="button"
          class="warp-toggle"
          :class="{ on: warpEnabled }"
          :aria-pressed="warpEnabled"
          title="Stretch this clip's audio to follow the project tempo"
          @click="onToggleWarp"
        >
          Follow tempo
        </button>
        <label>
          Source BPM
          <input
            v-model="warpBpmInput"
            class="num warp-source-bpm"
            type="number"
            step="0.1"
            min="1"
            @change="onWarpBpmChange"
          />
        </label>
        <button type="button" class="warp-anchor-add" @click="onAddAnchor">Add anchor</button>
        <span
          v-if="warpRatioHint"
          class="warp-segments"
          title="Stretch ratio per segment at the project tempo (×1.00 = recorded rate)"
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
          Beat
          <input
            class="num"
            type="number"
            step="0.25"
            :value="anchor.ppq"
            @change="onAnchorEdit(index, 'ppq', $event)"
          />
        </label>
        <label>
          Source s
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
          title="Remove this warp anchor"
          @click="onRemoveAnchor(index)"
        >
          Remove
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
}

.toolbar input {
  background: var(--surface-inset);
  color: var(--text-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px 4px;
  font: inherit;
  box-shadow: var(--inset-well);
}

.toolbar button {
  background: var(--surface-3);
  color: var(--text-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font: inherit;
  cursor: pointer;
  box-shadow: var(--raise-hi);
  transition: filter var(--dur-1) var(--ease-out);
}

.toolbar button:disabled {
  opacity: 0.45;
  cursor: default;
}

.toolbar button:not(:disabled):hover {
  filter: brightness(1.2);
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
  background: rgba(11, 13, 17, 0.6);
  color: var(--text-1);
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
  background: var(--surface-3);
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 1px 8px;
  font: inherit;
  cursor: pointer;
  box-shadow: var(--raise-hi);
  transition: filter var(--dur-1) var(--ease-out);
}

.history-entry.current {
  border-color: var(--accent);
  color: var(--text-1);
}

.history-entry:disabled {
  opacity: 0.45;
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
  border-color: var(--accent);
  color: var(--text-1);
}

.warp-segments {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.warp-anchor {
  padding-left: 14px;
}
</style>
