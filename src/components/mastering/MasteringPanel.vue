<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import AssistantPanel from '@/components/mastering/AssistantPanel.vue';
import PresetSelector from '@/components/mastering/PresetSelector.vue';
import PreviewPane from '@/components/mastering/PreviewPane.vue';
import ProcessorRack from '@/components/mastering/ProcessorRack.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { renderMixdownInWorker } from '@/export/client';
import { formatClippingCensus } from '@/export/export-issue-format';
import type { MixdownResult } from '@/export/mixdown';
import { dbToLinear } from '@/lib/db';
import { ensureWasm } from '@/lib/wasm';
import {
  addMasteringProcessor,
  applyMasteringPresetWithOverrides,
  type CommandGestureOptions,
  removeMasteringProcessor,
  reorderMasteringProcessor,
  setMasteringEnabled,
  setMasteringParam,
  setMasteringPreset,
  setMasteringPresetOverride,
} from '@/project/commands';
import { createDefaultMasteringChain, type MasteringChainState } from '@/project/mixer';
import { getWasmModule } from '@/project/runtime';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  type MasteringSuggestion,
  parseMasteringSuggestion,
  suggestedPreset,
  suggestedPresetOverrides,
} from '@/ui/mastering/assistant';
import {
  clampControlValue,
  type MasteringControl,
  masteringProcessorControls,
} from '@/ui/mastering/chain-controls';
import { isClippingRisk, type LoudnessRow } from '@/ui/mastering/loudness';
import {
  filterPresetCatalog,
  humanizePresetName,
  loadMasteringPresetCatalog,
} from '@/ui/mastering/preset-catalog';
import {
  getPresetControlDescriptor,
  hasPresetControlOverride,
  isKnownPresetOverrideKey,
  PRESET_CONTROL_DESCRIPTORS,
  type PresetControlDescriptor,
  type PresetControlKey,
  parsePresetControlValue,
  presetControlOverridesForEdit,
  presetControlOverridesForReset,
  resolvePresetControlValue,
} from '@/ui/mastering/preset-controls';
import {
  createMasteringPreviewController,
  type MasteringPreviewState,
  type PreviewRenderFn,
} from '@/ui/mastering/preview';
import { DEFAULT_PREVIEW_BARS, derivePreviewRange } from '@/ui/mastering/preview-range';
import {
  decodeMasteringReference,
  type MasteringReferenceAudio,
} from '@/ui/mastering/reference-audio';
import {
  type MonoCompatibilityReport,
  parseMonoCompatibility,
} from '@/ui/mastering/stereo-analysis';
import {
  createDefaultStreamingPlatforms,
  invalidStreamingPlatformCount,
  normalizeStreamingPlatforms,
  parseStreamingPreview,
  type StreamingPlatformConfig,
  type StreamingTarget,
  streamingTargetsFromReport,
} from '@/ui/mastering/streaming';
import {
  calculatePreviewLevelMatch,
  createABAudioPreview,
  DEFAULT_PREVIEW_GAIN,
  type PreviewContextFactory,
  type PreviewLevelMatch,
} from '@/ui/media/preview';
import {
  groupInsertCatalogEntries,
  type InsertCatalogGroup,
  loadInsertCatalogEntries,
} from '@/ui/mixer/insert-catalog';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';
import type { MatchEqAnalysis } from '@/ui/sample-editor/match-eq-analysis';
import { analyzeMatchEqToReference, type SampleEditorWasmOps } from '@/ui/sample-editor/wasm-ops';
import type { MasteringPreset } from '@/wasm/index.js';

/**
 * Mastering panel for the editor dock: the project mastering chain as an
 * ordered processor rack (preset stage plus drag-reorderable processor
 * slots, each with inline parameter knobs), a short A/B mixdown preview
 * rendered by the export worker, and a loudness readout for the previewed
 * audio. All chain edits go through the undoable mastering commands; preview
 * playback uses a panel-local AudioContext and never touches the engine.
 *
 * The panel owns all orchestration — the preview controller, the panel-local
 * playback, the wasm analyses and the popover dismissal — and delegates the
 * presentation to the preset selector, assistant, processor rack and preview
 * pane child components.
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
const appSettings = useAppSettings();
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

const presetSelectorRef = ref<InstanceType<typeof PresetSelector> | null>(null);
const presetMenuOpen = ref(false);
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

// --- Preset overrides ---------------------------------------------------------

/** Runtime parameters from the selected preset, with a safe empty fallback. */
const presetParams = computed<Readonly<Record<string, unknown>>>(() => {
  const preset = chain.value.preset;
  if (!preset) return {};
  try {
    return getWasmModule().masteringPresetParams(preset as MasteringPreset);
  } catch {
    return {};
  }
});

const presetControlSections = computed(() => ({
  output: PRESET_CONTROL_DESCRIPTORS.filter((descriptor) => descriptor.section === 'output'),
  restoration: PRESET_CONTROL_DESCRIPTORS.filter(
    (descriptor) => descriptor.section === 'restoration',
  ),
}));

const presetOverrideEntries = computed(() =>
  Object.entries(chain.value.presetOverrides ?? {})
    .filter(([key]) => !isKnownPresetOverrideKey(key))
    .sort(([a], [b]) => a.localeCompare(b)),
);

function presetControlValue(descriptor: PresetControlDescriptor) {
  return resolvePresetControlValue(
    descriptor,
    presetParams.value,
    chain.value.presetOverrides ?? {},
  );
}

function presetControlLabel(key: PresetControlKey): string {
  const labels = t.value.shell.mastering.presetOverrides.controls;
  switch (key) {
    case 'loudness.enabled':
      return labels.loudnessEnabled;
    case 'loudness.targetLufs':
      return labels.targetLufs;
    case 'loudness.ceilingDb':
      return labels.ceilingDb;
    case 'loudness.truePeakOversample':
      return labels.truePeakOversample;
    case 'loudness.releaseMs':
      return labels.releaseMs;
    case 'loudness.maxLimiterGainReductionDb':
      return labels.maxLimiterGainReductionDb;
    case 'repair.denoise.enabled':
      return labels.denoiseEnabled;
    case 'repair.denoise.reductionDb':
      return labels.denoiseReductionDb;
  }
  return key;
}

function presetControlUnit(descriptor: PresetControlDescriptor): string {
  if (descriptor.key === 'loudness.truePeakOversample') {
    return t.value.shell.mastering.presetOverrides.units.times;
  }
  if (descriptor.key === 'loudness.targetLufs') {
    return t.value.shell.mastering.presetOverrides.units.lufs;
  }
  if (descriptor.key === 'loudness.ceilingDb') {
    return t.value.shell.mastering.presetOverrides.units.dbtp;
  }
  if (descriptor.key === 'loudness.releaseMs') {
    return t.value.shell.mastering.presetOverrides.units.ms;
  }
  if (descriptor.kind === 'number') return t.value.shell.mastering.presetOverrides.units.db;
  return '';
}

function presetControlMin(descriptor: PresetControlDescriptor): number | undefined {
  return descriptor.min;
}

function presetControlMax(descriptor: PresetControlDescriptor): number | undefined {
  return descriptor.max;
}

function presetControlStep(descriptor: PresetControlDescriptor): number | undefined {
  return descriptor.step;
}

function applyPresetControl(key: string, input: unknown): void {
  const descriptor = getPresetControlDescriptor(key);
  if (!descriptor || !chain.value.preset) return;
  try {
    const value = parsePresetControlValue(descriptor, input);
    const overrides = chain.value.presetOverrides ?? {};
    const next = presetControlOverridesForEdit(descriptor, value, presetParams.value, overrides);
    runCommand(() => {
      applyMasteringPresetWithOverrides(chain.value.preset as string, next);
    });
  } catch {
    error.value = t.value.shell.mastering.presetOverrides.invalidValue;
  }
}

function onPresetControlInput(key: string, event: Event): void {
  const descriptor = getPresetControlDescriptor(key);
  const target = event.target as HTMLInputElement | HTMLSelectElement | null;
  if (!descriptor || !target) return;
  applyPresetControl(
    key,
    descriptor.kind === 'boolean' ? (target as HTMLInputElement).checked : target.value,
  );
}

function onResetPresetControl(key: PresetControlKey): void {
  const overrides = chain.value.presetOverrides ?? {};
  if (!hasPresetControlOverride(key, overrides)) return;
  const descriptor = getPresetControlDescriptor(key);
  if (!descriptor) return;
  const next = presetControlOverridesForReset(descriptor, presetParams.value, overrides);
  runCommand(() => {
    applyMasteringPresetWithOverrides(chain.value.preset as string, next);
  });
}

function onClearPresetOverride(key: string): void {
  runCommand(() => setMasteringPresetOverride(key, null));
}

// --- Mastering assistant --------------------------------------------------------

const suggestion = ref<MasteringSuggestion | null>(null);
const suggesting = ref(false);
/** Preset values the last suggestion tuned, applied as that preset's overrides. */
const suggestionTuning = ref<{
  preset: string;
  entries: Array<{ key: string; from: number | boolean | undefined; to: number | boolean }>;
} | null>(null);
const suggestionAdjustments = computed(() =>
  suggestionTuning.value && suggestionTuning.value.preset === chain.value.preset
    ? suggestionTuning.value.entries
    : [],
);

/**
 * The rendered channels as a left/right pair, or null when the render is not
 * stereo. A `0.5 * (left + right)` downmix cancels on decorrelated material and
 * measures the program several dB low, so a stereo render is analyzed through
 * the channel-summing entry points instead of {@link downmixMono}.
 */
function stereoPair(
  channels: ReadonlyArray<Float32Array>,
): { left: Float32Array; right: Float32Array } | null {
  if (channels.length !== 2) return null;
  const [left, right] = channels;
  return left && right ? { left, right } : null;
}

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
    const analyzedRevision = previewRevision.value;
    if (!source || previewStale.value || analyzedRevision === null) {
      if (!error.value) error.value = t.value.shell.mastering.assistant.needsPreview;
      return;
    }
    const wasm = await ensureWasm();
    const pair = stereoPair(source.channels);
    const suggestStereo = wasm.masteringAssistantSuggestStereo;
    const suggest = wasm.masteringAssistantSuggest;
    let json: string;
    if (pair && typeof suggestStereo === 'function') {
      json = suggestStereo({ ...pair, sampleRate: source.sampleRate });
    } else if (typeof suggest === 'function') {
      json = suggest(downmixMono(source.channels), source.sampleRate);
    } else {
      error.value = t.value.shell.mastering.assistant.unavailable;
      return;
    }
    const parsed = parseMasteringSuggestion(json);
    if (
      previewState.value?.bypassed !== source ||
      previewRevision.value !== analyzedRevision ||
      projectRevision.value !== analyzedRevision
    ) {
      error.value = t.value.shell.mastering.assistant.needsPreview;
      return;
    }
    suggestion.value = parsed;
    if (presetCatalog.value.length === 0) presetCatalog.value = loadMasteringPresetCatalog();
    const preset = suggestedPreset(parsed, presetCatalog.value);
    if (!preset) return;
    // The tuned chain describes the top candidate, so it only refines that preset.
    const presetParams =
      preset === parsed.genreCandidates[0]?.name && parsed.chainParams
        ? wasm.masteringPresetParams(preset as MasteringPreset)
        : null;
    const overrides =
      presetParams && parsed.chainParams
        ? suggestedPresetOverrides(parsed.chainParams, presetParams)
        : {};
    suggestionTuning.value = {
      preset,
      entries: Object.entries(overrides).map(([key, to]) => ({
        key,
        from: presetParams?.[key],
        to,
      })),
    };
    runCommand(() => applyMasteringPresetWithOverrides(preset, overrides));
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    suggesting.value = false;
  }
}

// --- Streaming targets ----------------------------------------------------------

const streamingTargets = ref<StreamingTarget[] | null>(null);
const streamingPlatforms = ref<StreamingPlatformConfig[]>([
  ...appSettings.settings.streamingPlatforms,
]);
watch(
  streamingPlatforms,
  (platforms) => {
    // Keep invalid rows editable so the panel can show its validation message;
    // only durable, valid configurations replace the last saved preference.
    if (invalidStreamingPlatformCount(platforms) === 0) {
      appSettings.set('streamingPlatforms', normalizeStreamingPlatforms(platforms));
    }
  },
  { deep: true },
);
const checkingTargets = ref(false);

/**
 * Measures the chain-applied (processed) render against the editable
 * streaming-platform loudness targets and shows, per platform, the
 * normalization gain each would apply and whether that gain risks clipping the
 * ceiling. Renders a preview first when none is ready.
 */
async function onCheckTargets(): Promise<void> {
  if (checkingTargets.value) return;
  checkingTargets.value = true;
  error.value = '';
  try {
    const platforms = normalizeStreamingPlatforms(streamingPlatforms.value);
    if (invalidStreamingPlatformCount(streamingPlatforms.value) > 0) {
      error.value = t.value.shell.mastering.streaming.invalidTargets;
      return;
    }
    if (platforms.length === 0) {
      error.value = t.value.shell.mastering.streaming.noTargets;
      return;
    }
    if (!previewState.value?.processed || previewStale.value) await onPreview();
    const source = previewState.value?.processed;
    if (!source) {
      if (!error.value) error.value = t.value.shell.mastering.assistant.needsPreview;
      return;
    }
    const reportTargets = streamingTargetsFromReport(source.report, platforms);
    if (reportTargets) {
      streamingTargets.value = reportTargets;
      return;
    }
    const wasm = await ensureWasm();
    const pair = stereoPair(source.channels);
    const previewStereo = wasm.masteringStreamingPreviewStereo;
    const preview = wasm.masteringStreamingPreview;
    let json: string;
    if (pair && typeof previewStereo === 'function') {
      json = previewStereo({ ...pair, sampleRate: source.sampleRate, platforms });
    } else if (typeof preview === 'function') {
      json = preview(downmixMono(source.channels), source.sampleRate, platforms);
    } else {
      error.value = t.value.shell.mastering.streaming.unavailable;
      return;
    }
    streamingTargets.value = parseStreamingPreview(json);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    checkingTargets.value = false;
  }
}

function onAddStreamingPlatform(): void {
  streamingPlatforms.value = [
    ...streamingPlatforms.value,
    { name: t.value.shell.mastering.streaming.customTarget, targetLufs: -14, ceilingDb: -1 },
  ];
  streamingTargets.value = null;
}

function onRemoveStreamingPlatform(index: number): void {
  if (streamingPlatforms.value.length <= 1) return;
  streamingPlatforms.value = streamingPlatforms.value.filter((_, i) => i !== index);
  streamingTargets.value = null;
}

function onUpdateStreamingPlatform(
  index: number,
  field: keyof StreamingPlatformConfig,
  value: string,
): void {
  const current = streamingPlatforms.value[index];
  if (!current) return;
  const next: StreamingPlatformConfig = { ...current };
  if (field === 'name') next.name = value;
  else next[field] = Number(value);
  streamingPlatforms.value = streamingPlatforms.value.map((entry, i) =>
    i === index ? next : entry,
  );
  streamingTargets.value = null;
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
  if (control.kind === 'boolean' || control.kind === 'enum') {
    try {
      const next =
        control.kind === 'boolean'
          ? value >= 0.5
          : control.options.find((option) => option.value === value)?.value;
      if (next === undefined || typeof next === 'string') {
        throw new RangeError(`Invalid value for ${control.kind} control "${control.id}"`);
      }
      setMasteringParam(index, control.id, next, { commit: true });
      error.value = '';
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
    return;
  }
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
    reorderMasteringProcessor(from, index);
  });
  expandedIndex.value = null;
}

function onDragEnd(): void {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

function onMoveProcessor(from: number, to: number): void {
  runCommand(() => reorderMasteringProcessor(from, to));
  expandedIndex.value = null;
}

// --- Add processor popover -------------------------------------------------------

const processorRackRef = ref<InstanceType<typeof ProcessorRack> | null>(null);
const addMenuOpen = ref(false);
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
  const addMenuEl = processorRackRef.value?.addMenuEl;
  const presetMenuEl = presetSelectorRef.value?.root;
  if (!addMenuEl?.contains(event.target)) addMenuOpen.value = false;
  if (!presetMenuEl?.contains(event.target)) presetMenuOpen.value = false;
}

const anyMenuOpen = computed(() => addMenuOpen.value || presetMenuOpen.value);

watch(anyMenuOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown, true);
  else document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

// --- Preview ---------------------------------------------------------------------

const previewState = shallowRef<MasteringPreviewState>();
const monoCompatibility = ref<MonoCompatibilityReport | null>(null);

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
/** Monitor-only A/B level matching; enabled by default for fair comparisons. */
const levelMatchEnabled = ref(true);

const activeResult = computed<MixdownResult | null>(() => {
  const state = previewState.value;
  if (!state) return null;
  return variant.value === 'processed' ? state.processed : state.bypassed;
});

const canPlayPreview = computed(
  () => !!previewState.value?.processed && !!previewState.value?.bypassed,
);

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

const levelMatch = computed<PreviewLevelMatch>(() => {
  if (previewStale.value) {
    return { available: false, processedGainDb: 0, bypassedGainDb: 0 };
  }
  return calculatePreviewLevelMatch(
    previewState.value?.processed?.report.lufs,
    previewState.value?.bypassed?.report.lufs,
  );
});

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
  monoCompatibility.value = null;
  const applied = await controller.request(doc, range);
  if (applied) {
    previewRevision.value = revision;
    await analyzeMonoCompatibility();
  }
}

function onCancelPreview(): void {
  controller.cancel();
}

// --- Preview playback (panel-local AudioContext, never the engine) ----------------

const playingId = ref<string | null>(null);

const audioPreview = createABAudioPreview({
  ...(props.previewContextFactory ? { contextFactory: props.previewContextFactory } : {}),
  onChange: (id) => {
    playingId.value = id;
  },
});

const isPlaying = computed(() => playingId.value !== null);

function monitorPreviewGains(): { processed: number; bypassed: number } {
  if (!levelMatchEnabled.value || !levelMatch.value.available) {
    return { processed: DEFAULT_PREVIEW_GAIN, bypassed: DEFAULT_PREVIEW_GAIN };
  }
  return {
    processed: DEFAULT_PREVIEW_GAIN * dbToLinear(levelMatch.value.processedGainDb),
    bypassed: DEFAULT_PREVIEW_GAIN * dbToLinear(levelMatch.value.bypassedGainDb),
  };
}

function playActiveResult(offsetSeconds = 0): void {
  const processed = previewState.value?.processed;
  const bypassed = previewState.value?.bypassed;
  if (!processed || !bypassed) return;
  audioPreview.play(
    'mastering-preview',
    {
      processed: { channels: processed.channels, sampleRate: processed.sampleRate },
      bypassed: { channels: bypassed.channels, sampleRate: bypassed.sampleRate },
    },
    variant.value,
    monitorPreviewGains(),
    offsetSeconds,
  );
}

function onTogglePlay(): void {
  if (isPlaying.value) audioPreview.stop();
  else playActiveResult();
}

function onSelectVariant(next: 'processed' | 'bypassed'): void {
  if (variant.value === next) return;
  variant.value = next;
  // Both variants are already running at the same audio time. Switching only
  // ramps their separate monitor gains, so playback position never jumps.
  if (isPlaying.value) audioPreview.selectVariant(next);
}

function onToggleLevelMatch(enabled: boolean): void {
  levelMatchEnabled.value = enabled;
  if (isPlaying.value) audioPreview.setGains(monitorPreviewGains());
}

watch([levelMatch, levelMatchEnabled], () => {
  // A project edit can make the rendered report stale while playback is
  // active. Keep the monitor target in sync with the visible Unavailable state.
  if (isPlaying.value) audioPreview.setGains(monitorPreviewGains());
});

// --- Loudness readout --------------------------------------------------------------

const loudnessRows = computed<LoudnessRow[]>(() => {
  const state = previewState.value;
  const a = state?.processed?.report;
  const b = state?.bypassed?.report;
  if (!a && !b) return [];
  return [
    {
      label: t.value.shell.mastering.loudness.peak,
      unit: 'dBFS',
      a: a?.peakDb,
      b: b?.peakDb,
      barScale: 'level',
    },
    {
      label: t.value.shell.mastering.loudness.truePeak,
      unit: 'dBTP',
      a: a?.truePeakDb,
      b: b?.truePeakDb,
      barScale: 'level',
    },
    {
      label: t.value.shell.mastering.loudness.loudness,
      unit: 'LUFS',
      a: a?.lufs,
      b: b?.lufs,
      barScale: 'level',
    },
    {
      label: t.value.shell.mastering.loudness.momentary,
      unit: 'LUFS',
      a: a?.momentaryLufs,
      b: b?.momentaryLufs,
      barScale: 'level',
    },
    {
      label: t.value.shell.mastering.loudness.shortTerm,
      unit: 'LUFS',
      a: a?.shortTermLufs,
      b: b?.shortTermLufs,
      barScale: 'level',
    },
    {
      label: t.value.shell.mastering.loudness.lra,
      unit: 'LU',
      a: a?.loudnessRange,
      b: b?.loudnessRange,
      barScale: 'range' as const,
    },
    {
      label: t.value.shell.mastering.loudness.dynamicRange,
      unit: 'dB',
      a: a?.dynamicRangeDb,
      b: b?.dynamicRangeDb,
      barScale: 'range' as const,
    },
  ];
});

const clipWarning = computed(() =>
  isClippingRisk(previewState.value?.processed?.report.truePeakDb),
);

/**
 * Extent of the clipping the processed preview actually produced. The
 * true-peak warning above flags the risk of clipping downstream; this reports
 * samples the chain already drove past full scale, and how many.
 */
const clipCensus = computed(() => {
  const processed = previewState.value?.processed;
  return formatClippingCensus(
    processed?.report.clipping,
    processed?.sampleRate ?? 0,
    t.value.shell.mastering.loudness.clipCensus,
  );
});

/** The processed preview's note when the preset stopped short of its loudness target. */
const targetLimited = computed(() => {
  const limit = previewState.value?.processed?.report.limitations?.find(
    (entry) => entry.kind === 'mastering-loudness-target-limited',
  );
  if (limit?.kind !== 'mastering-loudness-target-limited') return '';
  return formatMessage(t.value.shell.mastering.loudness.targetLimited, {
    lufs: limit.outputLufs.toFixed(1),
  });
});

// --- Reference comparison -------------------------------------------------------

const referenceAudio = shallowRef<MasteringReferenceAudio | null>(null);
const referenceAnalysis = ref<MatchEqAnalysis | null>(null);
const analyzingReference = ref(false);

async function onReferenceFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    referenceAudio.value = await (props.decodeReference ?? decodeMasteringReference)(file);
    referenceAnalysis.value = null;
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function onCompareReference(): Promise<void> {
  const reference = referenceAudio.value;
  if (!reference || analyzingReference.value) return;
  analyzingReference.value = true;
  error.value = '';
  try {
    if (!previewState.value?.processed || previewStale.value) await onPreview();
    const source = previewState.value?.processed;
    if (!source || previewStale.value) {
      if (!error.value) error.value = t.value.shell.mastering.reference.needsPreview;
      return;
    }
    const wasm = await ensureWasm();
    referenceAnalysis.value = analyzeMatchEqToReference(
      wasm as unknown as Pick<SampleEditorWasmOps, 'masteringPairAnalyze'>,
      source.channels,
      source.sampleRate,
      downmixMono(reference.channels),
      null,
      reference.sampleRate,
    );
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    analyzingReference.value = false;
  }
}

watch(
  () => previewState.value?.processed,
  () => {
    referenceAnalysis.value = null;
  },
);

async function analyzeMonoCompatibility(): Promise<void> {
  const source = previewState.value?.processed;
  if (!source || source.channels.length < 2) return;
  try {
    const wasm = await ensureWasm();
    const analyze = wasm.masteringStereoAnalyze;
    if (typeof analyze !== 'function') return;
    monoCompatibility.value = parseMonoCompatibility(
      analyze('stereo.monoCompatCheck', source.channels[0], source.channels[1], source.sampleRate),
    );
  } catch {
    monoCompatibility.value = null;
  }
}

/** Render failure message, surfaced only while the controller is in error. */
const renderError = computed(() =>
  previewState.value?.status === 'error' ? (previewState.value?.error ?? null) : null,
);

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  for (const gesture of gestures.values()) gesture.end();
  gestures.clear();
  controller.dispose();
  audioPreview.dispose();
});
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
      <button
        type="button"
        class="assist-button"
        :disabled="suggesting"
        v-tooltip="t.shell.mastering.assistant.title"
        @click="onAutoSuggest"
      >
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
          @select="onSelectPreset"
        />
        <section class="preset-overrides" :class="{ disabled: !chain.preset }">
          <div class="preset-overrides-head">
            <span class="preset-overrides-title">
              {{ t.shell.mastering.presetOverrides.title }}
            </span>
            <span class="preset-overrides-note">
              {{
                chain.preset
                  ? t.shell.mastering.presetOverrides.note
                  : t.shell.mastering.presetOverrides.needsPreset
              }}
            </span>
          </div>
          <p v-if="chain.preset" class="preset-overrides-preview-note">
            {{ t.shell.mastering.presetOverrides.previewOnly }}
          </p>
          <div class="preset-control-section">
            <h3 class="preset-control-section-title">
              {{ t.shell.mastering.presetOverrides.output }}
            </h3>
            <div class="preset-control-grid">
              <div
                v-for="descriptor in presetControlSections.output"
                :key="descriptor.key"
                class="preset-control"
                :class="{
                  overridden: hasPresetControlOverride(descriptor.key, chain.presetOverrides ?? {}),
                }"
                :data-preset-control="descriptor.key"
              >
                <span class="preset-control-label">{{ presetControlLabel(descriptor.key) }}</span>
                <span class="preset-control-input">
                  <input
                    v-if="descriptor.kind === 'boolean'"
                    type="checkbox"
                    :checked="Boolean(presetControlValue(descriptor))"
                    :disabled="!chain.preset"
                    :aria-label="presetControlLabel(descriptor.key)"
                    @change="onPresetControlInput(descriptor.key, $event)"
                  />
                  <select
                    v-else-if="descriptor.kind === 'enum'"
                    :value="presetControlValue(descriptor)"
                    :disabled="!chain.preset"
                    :aria-label="presetControlLabel(descriptor.key)"
                    @change="onPresetControlInput(descriptor.key, $event)"
                  >
                    <option v-for="option in descriptor.options" :key="option" :value="option">
                      {{ option }}{{ presetControlUnit(descriptor) }}
                    </option>
                  </select>
                  <input
                    v-else
                    type="number"
                    :value="presetControlValue(descriptor)"
                    :min="presetControlMin(descriptor)"
                    :max="presetControlMax(descriptor)"
                    :step="presetControlStep(descriptor)"
                    :disabled="!chain.preset"
                    :aria-label="presetControlLabel(descriptor.key)"
                    @change="onPresetControlInput(descriptor.key, $event)"
                  />
                  <span v-if="presetControlUnit(descriptor)" class="preset-control-unit">
                    {{ presetControlUnit(descriptor) }}
                  </span>
                </span>
                <button
                  v-if="hasPresetControlOverride(descriptor.key, chain.presetOverrides ?? {})"
                  type="button"
                  class="preset-control-reset"
                  :aria-label="
                    formatMessage(t.shell.mastering.presetOverrides.reset, {
                      label: presetControlLabel(descriptor.key),
                    })
                  "
                  :disabled="!chain.preset"
                  @click="onResetPresetControl(descriptor.key)"
                >
                  ↺
                </button>
              </div>
            </div>
          </div>
          <div class="preset-control-section">
            <h3 class="preset-control-section-title">
              {{ t.shell.mastering.presetOverrides.restoration }}
            </h3>
            <div class="preset-control-grid">
              <div
                v-for="descriptor in presetControlSections.restoration"
                :key="descriptor.key"
                class="preset-control"
                :class="{
                  overridden: hasPresetControlOverride(descriptor.key, chain.presetOverrides ?? {}),
                }"
                :data-preset-control="descriptor.key"
                >
                  <span class="preset-control-label">{{ presetControlLabel(descriptor.key) }}</span>
                  <span class="preset-control-input">
                    <input
                      v-if="descriptor.kind === 'boolean'"
                      type="checkbox"
                      :checked="Boolean(presetControlValue(descriptor))"
                      :disabled="!chain.preset"
                      :aria-label="presetControlLabel(descriptor.key)"
                      @change="onPresetControlInput(descriptor.key, $event)"
                    />
                    <input
                      v-else
                      type="number"
                      :value="presetControlValue(descriptor)"
                      :min="presetControlMin(descriptor)"
                      :max="presetControlMax(descriptor)"
                      :step="presetControlStep(descriptor)"
                      :disabled="!chain.preset"
                      :aria-label="presetControlLabel(descriptor.key)"
                      @change="onPresetControlInput(descriptor.key, $event)"
                    />
                    <span class="preset-control-unit">{{ presetControlUnit(descriptor) }}</span>
                  </span>
                <button
                  v-if="hasPresetControlOverride(descriptor.key, chain.presetOverrides ?? {})"
                  type="button"
                  class="preset-control-reset"
                  :aria-label="
                    formatMessage(t.shell.mastering.presetOverrides.reset, {
                      label: presetControlLabel(descriptor.key),
                    })
                  "
                  :disabled="!chain.preset"
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
                <span class="preset-override-current">{{ String(value) }}</span>
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
            <label class="mastering-reference-file">
              <span>{{ referenceAudio?.name ?? t.shell.mastering.reference.choose }}</span>
              <input type="file" accept="audio/*" @change="onReferenceFile" />
            </label>
            <button
              type="button"
              class="mastering-reference-compare"
              :disabled="!referenceAudio || analyzingReference"
              @click="onCompareReference"
            >
              {{ analyzingReference ? t.shell.mastering.reference.analyzing : t.shell.mastering.reference.compare }}
            </button>
          </div>
          <div v-if="referenceAnalysis" class="mastering-reference-results" role="status">
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
