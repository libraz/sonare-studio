<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { confirmDialog } from '@/composables/useDialogs';
import { confirmLossReport } from '@/composables/useLossConfirm';
import { audioFileMetadataForDocument } from '@/export/audio-file-metadata';
import { inspectAudioExportLoss } from '@/export/audio-metadata-loss';
import { audioExportPreflight } from '@/export/audio-preflight';
import { isBrowserMediaEncoderId, registerBrowserMediaEncoders } from '@/export/browser-media';
import {
  type ExportRenderHandle,
  ExportWorkerError,
  MasteringBufferLimitError,
  renderMixdownInWorker,
} from '@/export/client';
import { type AudioEncoder, listEncoders, WAV_ENCODER_ID } from '@/export/codecs';
import { encodeAudioInWorker, isWorkerAudioEncoderId } from '@/export/encode-client';
import { offlineAutomationLimitations } from '@/export/engine-render';
import {
  documentAudibleTrackIndices,
  documentBusStemsBlock,
  resolveRenderWindow,
} from '@/export/engine-render-context';
import {
  formatClippingCensus,
  formatExportLimitation,
  formatPreflightBlocker,
  formatPreflightWarning,
} from '@/export/export-issue-format';
import { formatExportStage } from '@/export/export-stage';
import { FLAC_ENCODER_ID, type FlacBitDepth, registerFlacEncoder } from '@/export/flac';
import {
  type MasteringCatalogEntry,
  masteringCapabilityFromCatalog,
  planMasteringStages,
} from '@/export/mastering-automation';
import {
  assertMasteringBufferWithinLimit,
  MASTERING_STEREO_FRAME_LIMIT,
} from '@/export/mastering-limit';
import {
  assertCodecPayloadMemory,
  DEFAULT_EXPORT_MEMORY_BUDGET_BYTES,
  estimateCodecPayloadMemory,
  MEBIBYTE,
} from '@/export/memory-budget';
import {
  MixdownCancelledError,
  type MixdownProgressFn,
  type MixdownRangePpq,
  type MixdownReport,
  type MixdownStem,
} from '@/export/mixdown';
import { MP3_BITRATES, MP3_ENCODER_ID, registerMp3Encoder } from '@/export/mp3';
import {
  COMPRESSED_EXPORT_BITRATES,
  createDefaultExportOptions,
  createStemsZipWriter,
  EXPORT_MEMORY_BUDGET_MIB,
  EXPORT_SAMPLE_RATES,
  type ExportOptionsModel,
  encodeOptionsForModel,
  exportFileName,
  normalizeMixdownLoudness,
  selectedEncoderIds as selectedModelEncoderIds,
  stemEntryName,
  stemsZipFileName,
  toRenderOptions,
  validateExportOptions,
} from '@/export/options';
import type { WavBitDepth } from '@/export/wav';
import { createWavStreamWriter, type WavStreamWriter } from '@/export/wav-stream';
import { downloadBlob } from '@/lib/download';
import { PayloadMemoryMeter } from '@/lib/payload-memory';
import { ensureWasm } from '@/lib/wasm';
import { masteringChainIsActive } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap } from '@/project/tempo-map';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { formatSampleRate } from '@/ui/media/asset-list';
import type { ExportRenderOptions } from '@/workers/export.worker';

/**
 * Modal audio export dialog. Renders the project document through the export
 * worker (progress + cancel), encodes the result with the chosen registry
 * codec (WAV built in, MP3 when registered) and hands the file(s) to the
 * download seam — stems mode zips one file per track. The dialog never
 * touches the store; the shell provides the document snapshot via
 * `getDocument` and may inject the render/download/encoder seams for tests.
 */

/** Render seam shape: the export worker client facade. */
type RenderFn = (
  doc: ProjectDocument,
  options: ExportRenderOptions,
  onProgress?: MixdownProgressFn,
  onStem?: (stem: MixdownStem, index: number, total: number) => Promise<void> | void,
  onMixdownChunk?: (
    channels: readonly [Float32Array, Float32Array],
    offsetFrames: number,
    totalFrames: number,
  ) => Promise<void> | void,
) => ExportRenderHandle;

const props = withDefaults(
  defineProps<{
    /** Whether the dialog is visible. */
    open: boolean;
    /** Snapshot provider for the document to render (serializeProject). */
    getDocument: () => ProjectDocument;
    /** Seed for the filename field (default 'project'). */
    projectName?: string;
    /** Project sample rate, the default output rate when it is selectable. */
    projectSampleRate?: number;
    /** Whether a transport loop region exists (enables the loop range). */
    hasLoop?: boolean;
    /** Transport loop window, required to export the loop range. */
    loopRegion?: MixdownRangePpq | null;
    /** Render seam; defaults to the shared export worker client. */
    render?: RenderFn | null;
    /** Download seam; defaults to a transient-anchor blob download. */
    download?: ((blob: Blob, filename: string) => void) | null;
    /** Encoder list override; defaults to the codec registry. */
    encoders?: ReadonlyArray<AudioEncoder> | null;
  }>(),
  {
    projectName: 'project',
    projectSampleRate: 48000,
    hasLoop: false,
    loopRegion: null,
    render: null,
    download: null,
    encoders: null,
  },
);

const emit = defineEmits<{
  /** The dialog was dismissed (Close button, Escape or overlay click). */
  close: [];
  /** A file was downloaded successfully. */
  exported: [payload: { filename: string; report: MixdownReport }];
}>();

// Make optional built-in encoders available in the registry; idempotent across mounts.
registerFlacEncoder();
registerMp3Encoder();
registerBrowserMediaEncoders();

const { t } = useI18n();
const appSettings = useAppSettings();
const model = ref<ExportOptionsModel>(
  createDefaultExportOptions(props.projectName, props.projectSampleRate),
);
const encoderList = ref<AudioEncoder[]>(resolveEncoders());
const busy = ref(false);
const progress = ref(0);
const stage = ref('');
const errorMessage = ref('');
const cancelled = ref(false);
const report = ref<MixdownReport | null>(null);
const reportLimitations = computed(() => {
  const strings = t.value.dialogs.exportAudio;
  return [
    ...(report.value?.limitations ?? []).map((limitation) =>
      formatExportLimitation(limitation, strings.issue),
    ),
    ...(report.value?.mediaIssues ?? []).map((issue) =>
      strings.mediaIssue
        .replace('{kind}', strings.mediaIssueKind[issue.kind] ?? issue.kind)
        .replace('{id}', issue.id),
    ),
  ];
});
const reportClipping = computed(
  () => Math.max(report.value?.peakDb ?? -Infinity, report.value?.truePeakDb ?? -Infinity) > 0,
);
/** Sample rate the shown report was measured at, for the clipping positions. */
const reportSampleRate = ref(0);
/** How much of the deliverable clipped and where it starts; empty when clean. */
const reportClippingCensus = computed(() =>
  formatClippingCensus(
    report.value?.clipping,
    reportSampleRate.value,
    t.value.dialogs.exportAudio.clippingCensus,
  ),
);
let cancelRender: (() => void) | null = null;

/** Encoder list: the injected override or the live codec registry. */
function resolveEncoders(): AudioEncoder[] {
  return props.encoders ? [...props.encoders] : listEncoders();
}

function normalizeSelectedEncoder(): void {
  if (encoderList.value.some((encoder) => encoder.id === model.value.encoderId)) return;
  const fallback = encoderList.value[0];
  if (fallback) model.value.encoderId = fallback.id;
}

normalizeSelectedEncoder();

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    // Fresh state per session: new defaults seeded from the project name.
    // Focus, the trap and restoration are owned by AppModal.
    model.value = createDefaultExportOptions(props.projectName, props.projectSampleRate);
    encoderList.value = resolveEncoders();
    normalizeSelectedEncoder();
    errorMessage.value = '';
    cancelled.value = false;
    report.value = null;
    progress.value = 0;
    stage.value = '';
  },
);

const selectedEncoderIds = computed(() => selectedModelEncoderIds(model.value));
const selectedEncoders = computed(() =>
  selectedEncoderIds.value.flatMap((id) => {
    const encoder = encoderList.value.find((candidate) => candidate.id === id);
    return encoder ? [encoder] : [];
  }),
);

const compressedEncoderIds = computed(() =>
  encoderList.value
    .filter((encoder) => encoder.deterministic === false)
    .map((encoder) => encoder.id),
);

const selectedEncoderUsesCompressedBitrate = computed(() =>
  selectedEncoderIds.value.some(
    (id) => isBrowserMediaEncoderId(id) || compressedEncoderIds.value.includes(id),
  ),
);

const errors = computed<string[]>(() =>
  validateExportOptions(model.value, {
    hasLoop: props.hasLoop,
    encoderIds: encoderList.value.map((encoder) => encoder.id),
    compressedEncoderIds: compressedEncoderIds.value,
  }),
);

const busyReason = computed(() =>
  firstBlock([busy.value, t.value.dialogs.exportAudio.reasons.rendering]),
);
const exportBlocked = computed(() => firstBlock(busyReason.value, errors.value[0]));
const canExport = computed(() => exportBlocked.value === null);
const loopRangeBlocked = computed(() =>
  firstBlock(busyReason.value, [!props.hasLoop, t.value.reasons.noLocators]),
);
const stemOptionBlocked = computed(() =>
  firstBlock(busyReason.value, [
    model.value.mode !== 'stems',
    t.value.dialogs.exportAudio.reasons.stemsOnly,
  ]),
);
const busStemsBlock = computed(() =>
  props.open && model.value.mode === 'stems' ? documentBusStemsBlock(props.getDocument()) : null,
);
const busStemsBlocked = computed(() => {
  const reasons = t.value.dialogs.exportAudio.reasons;
  return firstBlock(
    stemOptionBlocked.value,
    [busStemsBlock.value === 'bus-graph-full', reasons.busGraphFull],
    [busStemsBlock.value === 'nested-routing', reasons.nestedBusRouting],
  );
});
const releaseTailBlocked = computed(() =>
  firstBlock(busyReason.value, [
    model.value.range !== 'project',
    t.value.dialogs.exportAudio.reasons.wholeProjectOnly,
  ]),
);
const wavDitherBlocked = computed(() =>
  firstBlock(busyReason.value, [
    model.value.wavBitDepth !== 16,
    t.value.dialogs.exportAudio.reasons.ditherNeeds16Bit,
  ]),
);
const flacDitherBlocked = computed(() =>
  firstBlock(busyReason.value, [
    model.value.flacBitDepth !== 16,
    t.value.dialogs.exportAudio.reasons.ditherNeeds16Bit,
  ]),
);

/** Why an extra format checkbox is unavailable: the main format is always exported. */
function additionalFormatBlocked(encoderId: string): string | null {
  return firstBlock(busyReason.value, [
    encoderId === model.value.encoderId,
    t.value.dialogs.exportAudio.reasons.isMainFormat,
  ]);
}

/** Full output filename shown next to the base-name field. */
const filenamePreview = computed(() => {
  const filenames = selectedEncoders.value.map((encoder) =>
    model.value.mode === 'stems'
      ? stemsZipFileNameForEncoder(model.value.baseName, encoder, selectedEncoders.value.length)
      : exportFileName(model.value.baseName, encoder.extension),
  );
  return filenames.join(', ');
});

function stemsZipFileNameForEncoder(
  baseName: string,
  encoder: AudioEncoder,
  selectedCount: number,
): string {
  return selectedCount === 1
    ? stemsZipFileName(baseName)
    : `${stemsZipFileName(baseName).slice(0, -4)} ${encoder.id}.zip`;
}

function toggleAdditionalEncoder(encoderId: string, selected: boolean): void {
  const additional = new Set(model.value.additionalEncoderIds ?? []);
  if (selected) additional.add(encoderId);
  else additional.delete(encoderId);
  additional.delete(model.value.encoderId);
  model.value.additionalEncoderIds = [...additional];
}

watch(
  () => model.value.encoderId,
  (encoderId) => {
    const additional = new Set(model.value.additionalEncoderIds ?? []);
    additional.delete(encoderId);
    model.value.additionalEncoderIds = [...additional];
  },
);

/** String proxy because '32f' cannot ride a numeric select binding. */
const wavBitDepthProxy = computed({
  get: () => String(model.value.wavBitDepth),
  set: (value: string) => {
    const bitDepth = value === '32f' ? '32f' : (Number(value) as WavBitDepth);
    if (bitDepth === 16 && model.value.wavBitDepth !== 16) model.value.wavDither = true;
    model.value.wavBitDepth = bitDepth;
  },
});

/** Choosing a 16-bit FLAC starts with TPDF dither enabled. */
const flacBitDepthProxy = computed({
  get: () => model.value.flacBitDepth,
  set: (bitDepth: FlacBitDepth) => {
    if (bitDepth === 16 && model.value.flacBitDepth !== 16) model.value.flacDither = true;
    model.value.flacBitDepth = bitDepth;
  },
});

/** Format picker options, derived from the registered encoders. */
const encoderOptions = computed(() =>
  encoderList.value.map((encoder) => ({ value: encoder.id, label: encoder.label })),
);

/** WAV bit-depth options ('32f' rides as a string via wavBitDepthProxy). */
const WAV_BIT_DEPTH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '16', label: '16-bit PCM' },
  { value: '24', label: '24-bit PCM' },
  { value: '32f', label: '32-bit float' },
];

/** FLAC bit-depth options. FLAC encoder stores integer PCM only. */
const FLAC_BIT_DEPTH_OPTIONS: ReadonlyArray<{ value: FlacBitDepth; label: string }> = [
  { value: 16, label: '16-bit PCM' },
  { value: 24, label: '24-bit PCM' },
];

/** MP3 bitrate options. */
const mp3BitrateOptions = MP3_BITRATES.map((bitrate) => ({
  value: bitrate,
  label: `${bitrate} kbps`,
}));

/** Browser compressed encoder bitrate options. */
const compressedBitrateOptions = COMPRESSED_EXPORT_BITRATES.map((bitrate) => ({
  value: bitrate,
  label: `${bitrate} kbps`,
}));

/** Sample-rate options, labelled in kHz. */
const sampleRateOptions = EXPORT_SAMPLE_RATES.map((rate) => ({
  value: rate,
  label: formatSampleRate(rate),
}));

const memoryBudgetOptions = EXPORT_MEMORY_BUDGET_MIB.map((mib) => ({
  value: mib,
  label: `${(mib / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} GiB`,
}));

const progressStageLabel = computed(() =>
  formatExportStage(stage.value, t.value.dialogs.exportAudio.stage),
);

const normalizeLoudnessLabel = computed(() =>
  t.value.dialogs.exportAudio.normalizeLoudness.replace(
    '{target}',
    appSettings.settings.loudnessTargetLufs.toFixed(0),
  ),
);

/** Formats a dB / LUFS value for the report ('-inf' for silence). */
function formatLevel(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '-inf';
}

function formatMasteringDuration(frames: number, sampleRate: number): string {
  if (!Number.isFinite(frames) || sampleRate <= 0) return '—';
  return (frames / sampleRate).toFixed(1);
}

function isIntegerPcmExport(encoderId: string, model: ExportOptionsModel): boolean {
  return (
    (encoderId === WAV_ENCODER_ID && model.wavBitDepth !== '32f') ||
    encoderId === FLAC_ENCODER_ID ||
    encoderId === MP3_ENCODER_ID
  );
}

/** Sample peak of a rendered stem in dBFS, including its metered true peak. */
function stemPeakDb(stem: MixdownStem): number {
  let peak = 0;
  for (const channel of stem.channels) {
    for (const sample of channel) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return Math.max(
    peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    stem.report?.truePeakDb ?? -Infinity,
  );
}

/** Default download seam: transient anchor around an object URL. */
function downloadViaAnchor(blob: Blob, filename: string): void {
  downloadBlob(blob, filename);
}

async function encodeAudio(
  encoder: AudioEncoder,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: Record<string, unknown>,
  signal: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  if (
    props.encoders === null &&
    typeof Worker === 'function' &&
    isWorkerAudioEncoderId(encoder.id)
  ) {
    return encodeAudioInWorker(
      encoder.id,
      channels,
      sampleRate,
      options,
      signal,
      undefined,
      onProgress,
    );
  }
  return await encoder.encode(
    channels,
    sampleRate,
    isBrowserMediaEncoderId(encoder.id) ? { ...options, signal, onProgress } : options,
  );
}

/** Whether this target uses encodeAudioInWorker's protective PCM copy path. */
function workerBackedEncoding(encoder: AudioEncoder): boolean {
  return (
    props.encoders === null && typeof Worker === 'function' && isWorkerAudioEncoderId(encoder.id)
  );
}

/**
 * Checks the whole-buffer mastering limit before starting the export worker.
 * The inexpensive timeline estimate runs first; the WASM catalog is loaded
 * only when the selected window could exceed the stereo frame limit.
 */
async function preflightMasteringBuffer(
  doc: ProjectDocument,
  exportModel: ExportOptionsModel,
  loopRegion: MixdownRangePpq | null | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!exportModel.includeMasterChain) return;
  const chain = doc.mixer?.masteringChain;
  if (!chain || !masteringChainIsActive(chain)) return;

  const range =
    exportModel.range === 'loop' && loopRegion
      ? loopRegion
      : { startPpq: 0, endPpq: null as number | null };
  const renderWindow = resolveRenderWindow(
    doc,
    normalizeTempoMap(doc.tempoSegments),
    range,
    exportModel.sampleRate,
    exportModel.releaseTailSeconds,
    [],
    documentAudibleTrackIndices(doc),
  );
  if (renderWindow.totalFrames <= MASTERING_STEREO_FRAME_LIMIT) return;
  signal.throwIfAborted();

  const wasm = await ensureWasm();
  signal.throwIfAborted();
  const surface = wasm as unknown as {
    masteringProcessStereo?: unknown;
    masterAudioStereo?: unknown;
    masteringProcessorCatalog?: () => Array<MasteringCatalogEntry>;
  };
  // The renderer skips the rack when the process seam is unavailable. Keep
  // the UI preflight in lockstep with that behavior.
  if (typeof surface.masteringProcessStereo !== 'function') return;
  const catalog = surface.masteringProcessorCatalog?.();
  const plan = planMasteringStages(
    chain,
    doc.masterAutomation ?? [],
    range.startPpq,
    masteringCapabilityFromCatalog(catalog),
  );
  assertMasteringBufferWithinLimit({
    totalFrames: renderWindow.totalFrames,
    sampleRate: exportModel.sampleRate,
    includeMasterChain: true,
    usesPreset: chain.preset !== undefined && typeof surface.masterAudioStereo === 'function',
    wholeBufferProcessorCount: plan.stages.filter((stage) => stage.kind === 'whole-buffer').length,
  });
}

async function onExport(): Promise<void> {
  if (!canExport.value) return;
  const encoders = selectedEncoders.value;
  const primaryEncoder = encoders[0];
  if (!primaryEncoder) return;
  busy.value = true;
  errorMessage.value = '';
  cancelled.value = false;
  report.value = null;
  progress.value = 0;
  stage.value = 'render';
  const renderFn = props.render ?? renderMixdownInWorker;
  const downloadFn = props.download ?? downloadViaAnchor;
  const controller = new AbortController();
  let handle: ExportRenderHandle | null = null;
  let wavStream: WavStreamWriter | null = null;
  cancelRender = () => {
    controller.abort(new MixdownCancelledError());
    handle?.cancel();
  };
  try {
    const doc = structuredClone(props.getDocument()) as ProjectDocument;
    const exportModel: ExportOptionsModel = { ...model.value };
    if (documentBusStemsBlock(doc) !== null) exportModel.includeBusStems = false;
    const memoryBudgetBytes = exportModel.memoryBudgetMiB * MEBIBYTE;
    stage.value = 'preflight';
    const preflight = await audioExportPreflight(doc, {
      range: exportModel.range,
      loopRegion: props.loopRegion,
      releaseTailSeconds: exportModel.releaseTailSeconds,
      signal: controller.signal,
    });
    const issueStrings = t.value.dialogs.exportAudio.issue;
    if (preflight.blockers.length > 0) {
      const lines = preflight.blockers.map((blocker) =>
        formatPreflightBlocker(blocker, issueStrings),
      );
      throw new Error(`${t.value.dialogs.exportAudio.preflightBlocked}\n${lines.join('\n')}`);
    }
    await preflightMasteringBuffer(doc, exportModel, props.loopRegion, controller.signal);
    const acceptedLimitations = [
      ...offlineAutomationLimitations(doc).map((limitation) =>
        formatExportLimitation(limitation, issueStrings),
      ),
      ...preflight.warnings.map((warning) => formatPreflightWarning(warning, issueStrings)),
    ];
    if (acceptedLimitations.length > 0) {
      const proceed = await confirmDialog({
        title: t.value.dialogs.exportAudio.preflightWarningTitle,
        message: `${t.value.dialogs.exportAudio.preflightWarningMessage}\n\n${acceptedLimitations.join('\n')}`,
        confirmLabel: t.value.dialogs.exportAudio.automationWarningContinue,
      });
      if (!proceed) {
        cancelled.value = true;
        return;
      }
      controller.signal.throwIfAborted();
    }
    const range =
      exportModel.range === 'loop' && props.loopRegion
        ? props.loopRegion
        : { startPpq: 0, endPpq: Number.POSITIVE_INFINITY };
    const metadataLoss = inspectAudioExportLoss(
      audioFileMetadataForDocument(doc, {
        sampleRate: exportModel.sampleRate,
        startPpq: range.startPpq,
        endPpq: range.endPpq,
      }),
      encoders,
    );
    if (metadataLoss.entries.length > 0) {
      if (!(await confirmLossReport(metadataLoss, t.value.dialogs.exportAudio.metadataLoss))) {
        cancelled.value = true;
        return;
      }
      controller.signal.throwIfAborted();
    }
    if (memoryBudgetBytes > DEFAULT_EXPORT_MEMORY_BUDGET_BYTES) {
      const proceed = await confirmDialog({
        title: t.value.dialogs.exportAudio.memoryBudgetWarningTitle,
        message: t.value.dialogs.exportAudio.memoryBudgetWarningMessage.replace(
          '{amount}',
          `${exportModel.memoryBudgetMiB} MiB`,
        ),
        confirmLabel: t.value.dialogs.exportAudio.memoryBudgetWarningContinue,
      });
      if (!proceed) {
        cancelled.value = true;
        return;
      }
      controller.signal.throwIfAborted();
    }
    const targets = encoders.map((encoder) => {
      const targetModel = { ...exportModel, encoderId: encoder.id };
      const encodeOptions = encodeOptionsForModel(targetModel, {
        compressedEncoderIds: compressedEncoderIds.value,
      });
      if (
        encoder.id === WAV_ENCODER_ID ||
        encoder.id === FLAC_ENCODER_ID ||
        encoder.id === MP3_ENCODER_ID
      ) {
        encodeOptions.metadata = audioFileMetadataForDocument(doc, {
          sampleRate: exportModel.sampleRate,
          startPpq: range.startPpq,
          endPpq: range.endPpq,
        });
      }
      Object.defineProperty(encodeOptions, 'signal', {
        value: controller.signal,
        enumerable: false,
      });
      return { encoder, encodeOptions };
    });
    const targetLufs = appSettings.settings.loudnessTargetLufs;
    const primaryTarget = targets[0]!;
    const stemMemory = new PayloadMemoryMeter({
      label: 'Stem export',
      budgetBytes: memoryBudgetBytes,
    });
    const stemsWriter =
      exportModel.mode === 'stems' && targets.length === 1
        ? createStemsZipWriter(controller.signal, { meter: stemMemory })
        : null;
    const streamWav =
      exportModel.mode === 'mixdown' &&
      targets.length === 1 &&
      primaryEncoder.id === WAV_ENCODER_ID &&
      !exportModel.normalizeLoudness;
    if (streamWav) {
      wavStream = createWavStreamWriter({
        sampleRate: exportModel.sampleRate,
        bitDepth: exportModel.wavBitDepth,
        encodeOptions: {
          dither: exportModel.wavDither,
          metadata: primaryTarget.encodeOptions
            .metadata as import('@/export/audio-file-metadata').AudioFileMetadata,
        },
        meter: new PayloadMemoryMeter({
          label: 'Streaming WAV export',
          budgetBytes: memoryBudgetBytes,
        }),
      });
    }
    let consumedStemCount = 0;
    let stemsPeakDb = -Infinity;
    const consumeStem = async (
      stem: MixdownStem,
      index: number,
      total: number,
      target: (typeof targets)[number],
      writer: ReturnType<typeof createStemsZipWriter>,
      meter: PayloadMemoryMeter,
    ): Promise<void> => {
      controller.signal.throwIfAborted();
      stemsPeakDb = Math.max(stemsPeakDb, stemPeakDb(stem));
      const rawBytes = stem.channels[0].byteLength + stem.channels[1].byteLength;
      assertCodecPayloadMemory(
        estimateCodecPayloadMemory({
          encoderId: target.encoder.id,
          inputBytes: rawBytes,
          workerBacked: workerBackedEncoding(target.encoder),
          retainedBytes: meter.snapshot().activeBytes,
        }),
        memoryBudgetBytes,
      );
      const releaseRaw = meter.retain(rawBytes, `raw stem ${index + 1}/${total}`);
      try {
        stage.value = `encode:stem:${index + 1}/${total}`;
        // Stems are deliberately NOT loudness-normalized: normalizing each stem
        // to the same target applies a different gain per stem, which destroys
        // the relative balance so they no longer sum back to the mix. Loudness
        // normalization stays a mixdown-only operation; stems export at unity.
        const bytes = await encodeAudio(
          target.encoder,
          stem.channels,
          exportModel.sampleRate,
          target.encodeOptions,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        const releaseEncoded = meter.retain(bytes.byteLength, `encoded stem ${index + 1}/${total}`);
        try {
          await writer.add({
            name: stemEntryName(stem.name, index, total, target.encoder.extension),
            bytes,
          });
        } finally {
          releaseEncoded();
        }
        consumedStemCount += 1;
      } finally {
        releaseRaw();
      }
    };
    stage.value = 'render';
    handle = renderFn(
      doc,
      toRenderOptions(exportModel, props.loopRegion),
      (p, s) => {
        if (controller.signal.aborted) return;
        progress.value = p;
        stage.value = s;
      },
      exportModel.mode === 'stems' && stemsWriter
        ? (stem, index, total) =>
            consumeStem(stem, index, total, primaryTarget, stemsWriter, stemMemory)
        : undefined,
      wavStream
        ? async (channels, offsetFrames, totalFrames) => {
            controller.signal.throwIfAborted();
            wavStream!.add(channels, offsetFrames);
            stage.value = 'encode';
            progress.value = Math.max(progress.value, 0.9 + (offsetFrames / totalFrames) * 0.1);
          }
        : undefined,
    );
    const result = await handle.result;
    controller.signal.throwIfAborted();
    const mediaIssues = result.report.mediaIssues ?? [];
    if (mediaIssues.length > 0) {
      const exportStrings = t.value.dialogs.exportAudio;
      const problems = mediaIssues.map((issue) =>
        exportStrings.mediaIssue
          .replace('{kind}', exportStrings.mediaIssueKind[issue.kind] ?? issue.kind)
          .replace('{id}', issue.id),
      );
      throw new Error(`${exportStrings.preflightBlocked}\n${problems.join('\n')}`);
    }
    progress.value = 1;
    stage.value = 'encode';
    const normalizedReport =
      exportModel.mode === 'mixdown' && exportModel.normalizeLoudness
        ? normalizeMixdownLoudness(result.channels, result.report, targetLufs)
        : result.report;
    // Stems not consumed while rendering are measured here, before any is encoded.
    for (const stem of result.stems ?? []) stemsPeakDb = Math.max(stemsPeakDb, stemPeakDb(stem));
    const clippingPeak =
      exportModel.mode === 'mixdown'
        ? Math.max(normalizedReport.peakDb, normalizedReport.truePeakDb ?? -Infinity)
        : stemsPeakDb;
    if (
      targets.some((target) => isIntegerPcmExport(target.encoder.id, exportModel)) &&
      clippingPeak > 0
    ) {
      const peakMessage = t.value.dialogs.exportAudio.clippingWarningMessage.replace(
        '{peak}',
        formatLevel(clippingPeak),
      );
      // The census is what makes the choice answerable: continuing past one
      // stray overshoot is not the same decision as continuing past a passage.
      const census = formatClippingCensus(
        exportModel.mode === 'mixdown' ? normalizedReport.clipping : undefined,
        result.sampleRate,
        t.value.dialogs.exportAudio.clippingCensus,
      );
      const proceed = await confirmDialog({
        title: t.value.dialogs.exportAudio.clippingWarningTitle,
        message: census ? `${peakMessage}\n${census}` : peakMessage,
        confirmLabel: t.value.dialogs.exportAudio.clippingWarningContinue,
      });
      if (!proceed) {
        cancelled.value = true;
        return;
      }
      controller.signal.throwIfAborted();
    }
    const filenames: string[] = [];
    if (exportModel.mode === 'stems') {
      const stems: Array<MixdownStem | null> = result.stems ? [...result.stems] : [];
      result.stems = undefined;
      if (targets.length === 1 && stemsWriter) {
        if (consumedStemCount === 0) {
          for (let i = 0; i < stems.length; i++) {
            controller.signal.throwIfAborted();
            const stem = stems[i];
            if (!stem) continue;
            await consumeStem(stem, i, stems.length, primaryTarget, stemsWriter, stemMemory);
            stems[i] = null;
          }
        }
        if (consumedStemCount === 0) throw new Error(t.value.dialogs.exportAudio.noStems);
        const filename = stemsZipFileNameForEncoder(exportModel.baseName, primaryEncoder, 1);
        downloadFn(await stemsWriter.close(), filename);
        filenames.push(filename);
      } else {
        if (stems.length === 0) throw new Error(t.value.dialogs.exportAudio.noStems);
        for (const target of targets) {
          const meter = new PayloadMemoryMeter({
            label: `Stem export (${target.encoder.id})`,
            budgetBytes: memoryBudgetBytes,
          });
          const writer = createStemsZipWriter(controller.signal, { meter });
          for (let i = 0; i < stems.length; i++) {
            controller.signal.throwIfAborted();
            const stem = stems[i];
            if (!stem) continue;
            await consumeStem(stem, i, stems.length, target, writer, meter);
          }
          const filename = stemsZipFileNameForEncoder(
            exportModel.baseName,
            target.encoder,
            targets.length,
          );
          downloadFn(await writer.close(), filename);
          filenames.push(filename);
        }
      }
    } else {
      if (wavStream && result.channels[0].length === 0) {
        controller.signal.throwIfAborted();
        const filename = exportFileName(exportModel.baseName, primaryEncoder.extension);
        downloadFn(wavStream.close(result.totalFrames), filename);
        wavStream = null;
        filenames.push(filename);
      } else {
        wavStream?.abort();
        wavStream = null;
        for (let index = 0; index < targets.length; index++) {
          const target = targets[index]!;
          assertCodecPayloadMemory(
            estimateCodecPayloadMemory({
              encoderId: target.encoder.id,
              inputBytes: result.channels[0].byteLength + result.channels[1].byteLength,
              workerBacked: workerBackedEncoding(target.encoder),
            }),
            memoryBudgetBytes,
          );
          progress.value = 0;
          const bytes = await encodeAudio(
            target.encoder,
            result.channels,
            result.sampleRate,
            target.encodeOptions,
            controller.signal,
            (fraction) => {
              if (controller.signal.aborted) return;
              progress.value = (index + fraction) / targets.length;
            },
          );
          controller.signal.throwIfAborted();
          const filename = exportFileName(exportModel.baseName, target.encoder.extension);
          downloadFn(new Blob([new Uint8Array(bytes)], { type: target.encoder.mime }), filename);
          filenames.push(filename);
        }
      }
    }
    report.value = normalizedReport;
    reportSampleRate.value = result.sampleRate;
    for (const filename of filenames) emit('exported', { filename, report: normalizedReport });
  } catch (error) {
    wavStream?.abort();
    if (!controller.signal.aborted) controller.abort(error);
    if (
      error instanceof MixdownCancelledError ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      cancelled.value = true;
    } else if (error instanceof ExportWorkerError) {
      errorMessage.value = t.value.dialogs.exportAudio.workerError;
    } else if (error instanceof MasteringBufferLimitError) {
      const message = t.value.dialogs.exportAudio.masteringBufferLimit;
      errorMessage.value = message
        .replace('{duration}', formatMasteringDuration(error.totalFrames, error.sampleRate))
        .replace('{limit}', formatMasteringDuration(error.maxFrames, error.sampleRate));
    } else {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    busy.value = false;
    cancelRender = null;
  }
}

/** Cancels the in-flight render (no-op when idle). */
function onCancelRender(): void {
  cancelRender?.();
}

function onClose(): void {
  if (busy.value) return;
  emit('close');
}

/**
 * While a render is in flight the modal is non-dismissable, so AppModal stops
 * consuming Escape and forwards it here — let it cancel the render instead of
 * closing. When idle, AppModal handles Escape/overlay as a close itself.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  if (busy.value) onCancelRender();
}
</script>

<template>
  <AppModal
    :open="props.open"
    :aria-label="t.dialogs.exportAudio.title"
    :dismissable="!busy"
    :close-on-overlay="!busy"
    @close="onClose"
    @keydown="onKeydown"
  >
    <template #title>{{ t.dialogs.exportAudio.title }}</template>
    <div class="dialog-body">
      <div class="dialog-grid">
        <label class="field-label" for="export-format">{{ t.dialogs.exportAudio.format }}</label>
        <div class="field">
          <SelectMenu
            v-model="model.encoderId"
            class="format-select"
            :options="encoderOptions"
            :title="t.dialogs.exportAudio.formatTitle"
            :reason="busyReason"
            :aria-label="t.dialogs.exportAudio.format"
          />
          <div class="additional-format-list" :aria-label="t.dialogs.exportAudio.additionalFormats">
            <label
              v-for="encoder in encoderList"
              :key="encoder.id"
              class="check-label additional-format"
              :class="{ disabled: !!additionalFormatBlocked(encoder.id) }"
              v-tooltip="{
                text: t.dialogs.exportAudio.additionalFormatTitle,
                reason: additionalFormatBlocked(encoder.id),
              }"
            >
              <input
                class="additional-format-input"
                :data-encoder-id="encoder.id"
                type="checkbox"
                :checked="selectedEncoderIds.includes(encoder.id)"
                :disabled="!!additionalFormatBlocked(encoder.id)"
                @change="toggleAdditionalEncoder(encoder.id, ($event.target as HTMLInputElement).checked)"
              />
              {{ encoder.label }}
            </label>
          </div>
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.formatOptions }}</span>
        <div class="field format-option-rows">
          <div
            v-if="selectedEncoderIds.includes(WAV_ENCODER_ID)"
            class="format-options wav-options"
          >
            <SelectMenu
              v-model="wavBitDepthProxy"
              class="wav-bit-depth"
              size="sm"
              :options="WAV_BIT_DEPTH_OPTIONS"
              :title="t.dialogs.exportAudio.wavBitDepthTitle"
              :reason="busyReason"
              :aria-label="t.dialogs.exportAudio.bitDepth"
            />
            <ToggleButton
              v-model="model.wavDither"
              class="wav-dither"
              size="sm"
              :label="t.dialogs.exportAudio.dither"
              :title="t.dialogs.exportAudio.ditherTitle"
              :reason="wavDitherBlocked"
            />
          </div>
          <div
            v-if="selectedEncoderIds.includes(FLAC_ENCODER_ID)"
            class="format-options flac-options"
          >
            <SelectMenu
              v-model="flacBitDepthProxy"
              class="flac-bit-depth"
              size="sm"
              :options="FLAC_BIT_DEPTH_OPTIONS"
              :title="t.dialogs.exportAudio.flacBitDepthTitle"
              :reason="busyReason"
              :aria-label="t.dialogs.exportAudio.bitDepth"
            />
            <ToggleButton
              v-model="model.flacDither"
              class="flac-dither"
              size="sm"
              :label="t.dialogs.exportAudio.dither"
              :title="t.dialogs.exportAudio.ditherTitle"
              :reason="flacDitherBlocked"
            />
          </div>
          <div
            v-if="selectedEncoderIds.includes(MP3_ENCODER_ID)"
            class="format-options mp3-options"
          >
            <SelectMenu
              v-model="model.mp3Bitrate"
              class="mp3-bitrate"
              size="sm"
              :options="mp3BitrateOptions"
              :title="t.dialogs.exportAudio.mp3BitrateTitle"
              :reason="busyReason"
              :aria-label="t.dialogs.exportAudio.bitrate"
            />
          </div>
          <div
            v-if="selectedEncoderUsesCompressedBitrate"
            class="format-options browser-media-options"
          >
            <SelectMenu
              v-model="model.compressedBitrateKbps"
              class="compressed-bitrate"
              size="sm"
              :options="compressedBitrateOptions"
              :title="t.dialogs.exportAudio.compressedBitrateTitle"
              :reason="busyReason"
              :aria-label="t.dialogs.exportAudio.bitrate"
            />
          </div>
        </div>

        <label class="field-label" for="export-sample-rate">
          {{ t.dialogs.exportAudio.sampleRate }}
        </label>
        <div class="field">
          <SelectMenu
            v-model="model.sampleRate"
            class="sample-rate-select"
            :options="sampleRateOptions"
            :title="t.dialogs.exportAudio.sampleRateTitle"
            :reason="busyReason"
            :aria-label="t.dialogs.exportAudio.sampleRate"
          />
        </div>

        <label class="field-label" for="export-memory-budget">
          {{ t.dialogs.exportAudio.memoryBudget }}
        </label>
        <div class="field">
          <SelectMenu
            v-model="model.memoryBudgetMiB"
            class="memory-budget-select"
            :options="memoryBudgetOptions"
            :title="t.dialogs.exportAudio.memoryBudgetTitle"
            :reason="busyReason"
            :aria-label="t.dialogs.exportAudio.memoryBudget"
          />
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.range }}</span>
        <div
          class="field segmented"
          role="radiogroup"
          v-radiogroup
          :aria-label="t.dialogs.exportAudio.range"
        >
          <button
            type="button"
            class="segment range-project"
            :class="{ active: model.range === 'project' }"
            role="radio"
            :aria-checked="model.range === 'project'"
            :disabled="!!busyReason"
            v-tooltip="{ text: t.dialogs.exportAudio.wholeProjectTitle, reason: busyReason }"
            @click="model.range = 'project'"
          >
            {{ t.dialogs.exportAudio.wholeProject }}
          </button>
          <button
            type="button"
            class="segment range-loop"
            :class="{ active: model.range === 'loop' }"
            role="radio"
            :aria-checked="model.range === 'loop'"
            :disabled="!!loopRangeBlocked"
            v-tooltip="{ text: t.dialogs.exportAudio.loopRegionTitle, reason: loopRangeBlocked }"
            @click="model.range = 'loop'"
          >
            {{ t.dialogs.exportAudio.loopRegion }}
          </button>
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.mode }}</span>
        <div
          class="field segmented"
          role="radiogroup"
          v-radiogroup
          :aria-label="t.dialogs.exportAudio.mode"
        >
          <button
            type="button"
            class="segment mode-mixdown"
            :class="{ active: model.mode === 'mixdown' }"
            role="radio"
            :aria-checked="model.mode === 'mixdown'"
            :disabled="!!busyReason"
            v-tooltip="{ text: t.dialogs.exportAudio.mixdownTitle, reason: busyReason }"
            @click="model.mode = 'mixdown'"
          >
            {{ t.dialogs.exportAudio.mixdown }}
          </button>
          <button
            type="button"
            class="segment mode-stems"
            :class="{ active: model.mode === 'stems' }"
            role="radio"
            :aria-checked="model.mode === 'stems'"
            :disabled="!!busyReason"
            v-tooltip="{ text: t.dialogs.exportAudio.stemsTitle, reason: busyReason }"
            @click="model.mode = 'stems'"
          >
            {{ t.dialogs.exportAudio.stems }}
          </button>
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.masterChain }}</span>
        <div class="field">
          <ToggleButton
            v-model="model.includeMasterChain"
            class="include-master-chain"
            size="sm"
            :label="t.dialogs.exportAudio.includeMasterChain"
            :reason="busyReason"
          />
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.stemOptions }}</span>
        <div class="field stem-option-row">
          <ToggleButton
            v-model="model.includeMasterStem"
            class="include-master-stem"
            size="sm"
            :label="t.dialogs.exportAudio.includeMasterStem"
            :title="t.dialogs.exportAudio.includeMasterStemTitle"
            :reason="stemOptionBlocked"
          />
          <ToggleButton
            :model-value="model.includeBusStems && busStemsBlock === null"
            @update:model-value="model.includeBusStems = $event"
            class="include-bus-stems"
            size="sm"
            :label="t.dialogs.exportAudio.includeBusStems"
            :title="t.dialogs.exportAudio.includeBusStemsTitle"
            :reason="busStemsBlocked"
          />
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.normalization }}</span>
        <div class="field">
          <ToggleButton
            v-model="model.normalizeLoudness"
            class="normalize-loudness"
            size="sm"
            :label="normalizeLoudnessLabel"
            :title="t.dialogs.exportAudio.normalizeLoudnessTitle"
            :reason="busyReason"
          />
          <p
            v-if="model.mode === 'stems' && model.normalizeLoudness"
            class="stem-normalization-note encoder-notice"
          >
            {{ t.dialogs.exportAudio.stemNormalizationNote }}
          </p>
        </div>

        <label class="field-label" for="export-release-tail">
          {{ t.dialogs.exportAudio.releaseTail }}
        </label>
        <div class="field tail-field">
          <input
            id="export-release-tail"
            v-model.number="model.releaseTailSeconds"
            class="release-tail-input"
            type="number"
            min="0"
            max="120"
            step="0.5"
            :disabled="!!releaseTailBlocked"
            v-tooltip="{ text: t.dialogs.exportAudio.releaseTailTitle, reason: releaseTailBlocked }"
          />
          <span>{{ t.dialogs.exportAudio.seconds }}</span>
        </div>

        <label class="field-label" for="export-filename">
          {{ t.dialogs.exportAudio.filename }}
        </label>
        <div class="field">
          <input
            id="export-filename"
            v-model="model.baseName"
            type="text"
            class="filename-input"
            :disabled="!!busyReason"
            spellcheck="false"
          />
          <span class="filename-preview">{{ filenamePreview }}</span>
        </div>
      </div>

      <div class="dialog-notices">
        <p
          v-if="selectedEncoders.some((encoder) => encoder.deterministic === false)"
          class="encoder-notice"
          role="note"
        >
          {{ t.dialogs.exportAudio.browserEncoderNotice }}
        </p>
      </div>

      <ul v-if="errors.length > 0" class="dialog-errors" role="alert">
        <li v-for="error in errors" :key="error">{{ error }}</li>
      </ul>

      <div v-if="busy" class="export-progress" aria-live="polite">
        <div
          class="progress-track"
          role="progressbar"
          :aria-valuenow="Math.round(progress * 100)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="progressStageLabel"
        >
          <div class="progress-fill" :style="{ transform: `scaleX(${progress})` }" />
        </div>
        <span class="progress-stage">{{ progressStageLabel }}</span>
        <button type="button" class="cancel-render" @click="onCancelRender">
          {{ t.dialogs.exportAudio.cancel }}
        </button>
      </div>

      <p v-if="cancelled" class="export-cancelled" role="status">
        {{ t.dialogs.exportAudio.cancelled }}
      </p>

      <div v-if="report" class="export-report" role="status">
        <h3 class="report-title">{{ t.dialogs.exportAudio.loudnessReport }}</h3>
        <dl class="report-grid">
          <dt>{{ t.dialogs.exportAudio.peak }}</dt>
          <dd class="report-peak">{{ formatLevel(report.peakDb) }} dBFS</dd>
          <template v-if="report.truePeakDb !== undefined">
            <dt>{{ t.dialogs.exportAudio.truePeak }}</dt>
            <dd class="report-true-peak">{{ formatLevel(report.truePeakDb) }} dBTP</dd>
          </template>
          <template v-if="report.lufs !== undefined">
            <dt>{{ t.dialogs.exportAudio.loudness }}</dt>
            <dd class="report-lufs">{{ formatLevel(report.lufs) }} LUFS</dd>
          </template>
        </dl>
        <div v-if="reportLimitations.length > 0" class="report-limitations">
          <h4>{{ t.dialogs.exportAudio.limitations }}</h4>
          <ul>
            <li v-for="limitation in reportLimitations" :key="limitation">
              {{ limitation }}
            </li>
          </ul>
        </div>
        <div v-if="reportClipping || reportClippingCensus" role="alert">
          <p v-if="reportClipping" class="report-clipping">
            {{ t.dialogs.exportAudio.clippingReport }}
          </p>
          <p v-if="reportClippingCensus" class="report-clipping-census">
            {{ reportClippingCensus }}
          </p>
        </div>
      </div>

      <p v-if="errorMessage" class="dialog-error" role="alert">{{ errorMessage }}</p>
    </div>
    <template #actions>
      <button
        type="button"
        class="close-button"
        :disabled="!!busyReason"
        v-tooltip="{ reason: busyReason }"
        @click="onClose"
      >
        {{ t.dialogs.exportAudio.close }}
      </button>
      <button
        type="button"
        class="primary export-button"
        :disabled="!canExport"
        v-tooltip="{ reason: exportBlocked }"
        @click="onExport"
      >
        {{ t.dialogs.exportAudio.export }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

.dialog-grid {
  display: grid;
  grid-template-columns: 7rem 1fr;
  row-gap: var(--sp-4);
  column-gap: var(--sp-3);
  align-items: baseline;
}

.field-label {
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.field {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  min-width: 0;
}

.format-options {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.additional-format-list {
  display: flex;
  flex-basis: 100%;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-4);
}

.additional-format.disabled {
  color: var(--text-4);
  cursor: default;
}

.encoder-notice {
  flex-basis: 100%;
  margin: var(--sp-1) 0 0;
  color: var(--text-3);
  font-size: var(--fs-xs);
}

/* Format-dependent controls live in their own row and reserve one control's
 * worth of height. Switching format swaps one option group for another, and
 * the rest of the dialog must not slide under the pointer while it does. */
.format-option-rows {
  min-height: 1.75rem;
  align-items: center;
}

/* Notices come and go with the selected encoders. Keeping them in the band
 * below the form means only this strip changes height, never a form row. */
.dialog-notices:empty {
  display: none;
}

/* The .field grid cell is a flex row; a segmented control has to stretch
 * across it rather than sit at its intrinsic width like a checkbox does. */
.field.segmented {
  display: flex;
}

.check-label {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  cursor: pointer;
}

.check-label.disabled {
  color: var(--text-4);
  cursor: default;
}

.filename-input {
  flex: 1;
  min-width: 8rem;
}

.filename-preview {
  color: var(--text-3);
  font-size: var(--fs-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.dialog-errors {
  margin: 0;
  padding: var(--sp-3) var(--sp-3) var(--sp-3) 1.5rem;
  background: var(--warning-surface);
  border: 1px solid var(--warning);
  border-radius: var(--radius-sm);
  color: var(--warning-text);
}

.export-progress,
.export-cancelled,
.export-report,
.dialog-errors,
.dialog-error {
  animation: view-enter var(--dur-2) var(--ease-out);
}

.export-progress {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.progress-track {
  flex: 1;
  height: 0.45rem;
  background: var(--surface-inset);
  box-shadow: var(--control-edge), var(--inset-well);
  border-radius: 999px;
  overflow: hidden;
}

/* Scaled rather than sized so each progress tick composites without layout. */
.progress-fill {
  height: 100%;
  background: var(--accent);
  transform-origin: left center;
  transition: transform var(--dur-3) var(--ease-out);
}

.progress-stage {
  color: var(--text-3);
  font-size: var(--fs-xs);
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.export-cancelled {
  margin: 0;
  color: var(--warning);
}

.export-report {
  background: var(--surface-2);
  box-shadow: var(--control-edge), var(--shadow-1);
  border-radius: var(--radius-md);
  padding: var(--sp-4) var(--sp-5);
}

.report-title {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.report-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: var(--sp-5);
  row-gap: var(--sp-1);
  margin: 0;
}

.report-grid dt {
  color: var(--text-3);
}

.report-grid dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.report-limitations {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border-subtle);
}

.report-limitations h4 {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--warning);
}

.report-limitations ul {
  margin: 0;
  padding-left: var(--sp-4);
  color: var(--text-2);
}

.dialog-error {
  margin: 0;
  padding: var(--sp-3) var(--sp-3);
  background: var(--danger-surface);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  color: var(--danger-text);
}

.cancel-render {
  flex: none;
}
</style>
