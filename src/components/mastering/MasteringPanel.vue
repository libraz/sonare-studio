<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import AssistantPanel from '@/components/mastering/AssistantPanel.vue';
import PresetSelector from '@/components/mastering/PresetSelector.vue';
import PreviewPane from '@/components/mastering/PreviewPane.vue';
import ProcessorRack from '@/components/mastering/ProcessorRack.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { renderMixdownInWorker } from '@/export/client';
import type { MixdownResult } from '@/export/mixdown';
import { ensureWasm } from '@/lib/wasm';
import {
  addMasteringProcessor,
  type CommandGestureOptions,
  removeMasteringProcessor,
  reorderMasteringProcessor,
  setMasteringEnabled,
  setMasteringParam,
  setMasteringPreset,
  setMasteringPresetOverride,
} from '@/project/commands';
import { createDefaultMasteringChain, type MasteringChainState } from '@/project/mixer';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';
import {
  type MasteringSuggestion,
  parseMasteringSuggestion,
  suggestedPreset,
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
import { createAudioPreview } from '@/ui/media/preview';
import {
  groupInsertCatalogEntries,
  type InsertCatalogGroup,
  loadInsertCatalogEntries,
} from '@/ui/mixer/insert-catalog';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';
import type { MatchEqAnalysis } from '@/ui/sample-editor/match-eq-analysis';
import { analyzeMatchEqToReference, type SampleEditorWasmOps } from '@/ui/sample-editor/wasm-ops';

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
  }>(),
  {
    loopEnabled: false,
    loopStartPpq: 0,
    loopEndPpq: 0,
    previewBars: DEFAULT_PREVIEW_BARS,
    renderMixdown: null,
    decodeReference: null,
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

const presetOverrideKey = ref('');
const presetOverrideValue = ref('');

/** Public, cross-preset override paths exposed by the mastering API. */
const KNOWN_PRESET_OVERRIDE_KEYS = [
  'loudness.enabled',
  'loudness.targetLufs',
  'loudness.ceilingDb',
  'loudness.truePeakOversample',
  'loudness.releaseMs',
] as const;
const presetOverrideKeyIsKnown = computed(() =>
  KNOWN_PRESET_OVERRIDE_KEYS.includes(
    presetOverrideKey.value.trim() as (typeof KNOWN_PRESET_OVERRIDE_KEYS)[number],
  ),
);

const presetOverrideEntries = computed(() =>
  Object.entries(chain.value.presetOverrides ?? {}).sort(([a], [b]) => a.localeCompare(b)),
);

function parsePresetOverrideValue(input: string): number | boolean {
  const value = input.trim();
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new RangeError(t.value.shell.mastering.presetOverrides.invalidValue);
  }
  return numeric;
}

function onAddPresetOverride(): void {
  try {
    const key = presetOverrideKey.value.trim();
    const value = parsePresetOverrideValue(presetOverrideValue.value);
    setMasteringPresetOverride(key, value);
    presetOverrideKey.value = '';
    presetOverrideValue.value = '';
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function onClearPresetOverride(key: string): void {
  runCommand(() => setMasteringPresetOverride(key, null));
}

// --- Mastering assistant --------------------------------------------------------

const suggestion = ref<MasteringSuggestion | null>(null);
const suggesting = ref(false);

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
    if (preset) runCommand(() => setMasteringPreset(preset));
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

const activeResult = computed<MixdownResult | null>(() => {
  const state = previewState.value;
  if (!state) return null;
  return variant.value === 'processed' ? state.processed : state.bypassed;
});

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

const audioPreview = createAudioPreview({
  onChange: (id) => {
    playingId.value = id;
  },
});

const isPlaying = computed(() => playingId.value !== null);

function playActiveResult(): void {
  const result = activeResult.value;
  if (!result) return;
  audioPreview.play(`mastering-preview:${variant.value}`, {
    channels: result.channels,
    sampleRate: result.sampleRate,
  });
}

function onTogglePlay(): void {
  if (isPlaying.value) audioPreview.stop();
  else playActiveResult();
}

function onSelectVariant(next: 'processed' | 'bypassed'): void {
  if (variant.value === next) return;
  variant.value = next;
  // Keep the A/B comparison seamless: restart playback on the other render.
  if (isPlaying.value) playActiveResult();
}

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
          <div class="preset-override-form">
            <input
              v-model="presetOverrideKey"
              class="preset-override-key"
              type="text"
              list="preset-override-key-suggestions"
              :disabled="!chain.preset"
              :placeholder="t.shell.mastering.presetOverrides.keyPlaceholder"
              :aria-label="t.shell.mastering.presetOverrides.key"
              @keydown.enter.prevent="onAddPresetOverride"
            />
            <datalist id="preset-override-key-suggestions">
              <option v-for="key in KNOWN_PRESET_OVERRIDE_KEYS" :key="key" :value="key" />
            </datalist>
            <input
              v-model="presetOverrideValue"
              class="preset-override-value"
              type="text"
              :disabled="!chain.preset"
              :placeholder="t.shell.mastering.presetOverrides.valuePlaceholder"
              :aria-label="t.shell.mastering.presetOverrides.value"
              @keydown.enter.prevent="onAddPresetOverride"
            />
            <button
              type="button"
              class="preset-override-add"
              :disabled="!chain.preset"
              @click="onAddPresetOverride"
            >
              {{ t.shell.mastering.presetOverrides.add }}
            </button>
          </div>
          <p
            v-if="presetOverrideKey.trim() && !presetOverrideKeyIsKnown"
            class="preset-override-warning"
            role="status"
          >
            {{ t.shell.mastering.presetOverrides.unknownKey }}
          </p>
          <ul v-if="presetOverrideEntries.length > 0" class="preset-override-list">
            <li v-for="[key, value] in presetOverrideEntries" :key="key">
              <span class="preset-override-param">{{ key }}</span>
              <span class="preset-override-equals">=</span>
              <span class="preset-override-current">{{ String(value) }}</span>
              <button
                type="button"
                class="preset-override-remove"
                :aria-label="t.shell.mastering.presetOverrides.remove"
                @click="onClearPresetOverride(key)"
              >
                x
              </button>
            </li>
          </ul>
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
          :can-play="!!activeResult"
          :is-playing="isPlaying"
          :stale="previewStale"
          :checking-targets="checkingTargets"
          :streaming-platforms="streamingPlatforms"
          :loudness-rows="loudnessRows"
          :clip-warning="clipWarning"
          :mono-compatibility="monoCompatibility"
          :streaming-targets="streamingTargets"
          @preview="onPreview"
          @cancel="onCancelPreview"
          @select-variant="onSelectVariant"
          @toggle-play="onTogglePlay"
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
