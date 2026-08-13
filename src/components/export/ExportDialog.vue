<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { confirmDialog } from '@/composables/useDialogs';
import { audioFileMetadataForDocument } from '@/export/audio-file-metadata';
import { audioExportPreflight } from '@/export/audio-preflight';
import { isBrowserMediaEncoderId, registerBrowserMediaEncoders } from '@/export/browser-media';
import { type ExportRenderHandle, ExportWorkerError, renderMixdownInWorker } from '@/export/client';
import { type AudioEncoder, listEncoders, WAV_ENCODER_ID } from '@/export/codecs';
import { encodeAudioInWorker, isWorkerAudioEncoderId } from '@/export/encode-client';
import { offlineAutomationLimitations } from '@/export/engine-render';
import {
  formatExportLimitation,
  formatPreflightBlocker,
  formatPreflightWarning,
} from '@/export/export-issue-format';
import { formatExportStage } from '@/export/export-stage';
import { FLAC_ENCODER_ID, type FlacBitDepth, registerFlacEncoder } from '@/export/flac';
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
import type { ProjectDocument } from '@/project/serialization';
import { useI18n } from '@/ui/i18n';
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
const model = ref<ExportOptionsModel>(createDefaultExportOptions(props.projectName));
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
    model.value = createDefaultExportOptions(props.projectName);
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

const canExport = computed(() => !busy.value && errors.value.length === 0);

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
  label: `${(rate / 1000).toLocaleString('en-US')} kHz`,
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

function isIntegerPcmExport(encoderId: string, model: ExportOptionsModel): boolean {
  return (
    (encoderId === WAV_ENCODER_ID && model.wavBitDepth !== '32f') ||
    encoderId === FLAC_ENCODER_ID ||
    encoderId === MP3_ENCODER_ID
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
    const range =
      exportModel.range === 'loop' && props.loopRegion
        ? props.loopRegion
        : { startPpq: 0, endPpq: Number.POSITIVE_INFINITY };
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
    const consumeStem = async (
      stem: MixdownStem,
      index: number,
      total: number,
      target: (typeof targets)[number],
      writer: ReturnType<typeof createStemsZipWriter>,
      meter: PayloadMemoryMeter,
    ): Promise<void> => {
      controller.signal.throwIfAborted();
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
    const clippingPeak = Math.max(
      normalizedReport.peakDb,
      normalizedReport.truePeakDb ?? -Infinity,
    );
    if (
      exportModel.mode === 'mixdown' &&
      targets.some((target) => isIntegerPcmExport(target.encoder.id, exportModel)) &&
      clippingPeak > 0
    ) {
      const proceed = await confirmDialog({
        title: t.value.dialogs.exportAudio.clippingWarningTitle,
        message: t.value.dialogs.exportAudio.clippingWarningMessage.replace(
          '{peak}',
          formatLevel(clippingPeak),
        ),
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
            :disabled="busy"
            :aria-label="t.dialogs.exportAudio.format"
          />
          <div class="additional-format-list" :aria-label="t.dialogs.exportAudio.additionalFormats">
            <label
              v-for="encoder in encoderList"
              :key="encoder.id"
              class="check-label additional-format"
              :class="{ disabled: encoder.id === model.encoderId }"
            >
              <input
                class="additional-format-input"
                :data-encoder-id="encoder.id"
                type="checkbox"
                :checked="selectedEncoderIds.includes(encoder.id)"
                :disabled="busy || encoder.id === model.encoderId"
                @change="toggleAdditionalEncoder(encoder.id, ($event.target as HTMLInputElement).checked)"
              />
              {{ encoder.label }}
            </label>
          </div>
          <div
            v-if="selectedEncoderIds.includes(WAV_ENCODER_ID)"
            class="format-options wav-options"
          >
            <SelectMenu
              v-model="wavBitDepthProxy"
              class="wav-bit-depth"
              size="sm"
              :options="WAV_BIT_DEPTH_OPTIONS"
              :disabled="busy"
              :aria-label="t.dialogs.exportAudio.bitDepth"
            />
            <ToggleButton
              v-model="model.wavDither"
              class="wav-dither"
              size="sm"
              :label="t.dialogs.exportAudio.dither"
              :disabled="busy || model.wavBitDepth !== 16"
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
              :disabled="busy"
              :aria-label="t.dialogs.exportAudio.bitDepth"
            />
            <ToggleButton
              v-model="model.flacDither"
              class="flac-dither"
              size="sm"
              :label="t.dialogs.exportAudio.dither"
              :disabled="busy || model.flacBitDepth !== 16"
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
              :disabled="busy"
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
              :disabled="busy"
              :aria-label="t.dialogs.exportAudio.bitrate"
            />
          </div>
          <p
            v-if="selectedEncoders.some((encoder) => encoder.deterministic === false)"
            class="encoder-notice"
            role="note"
          >
            {{ t.dialogs.exportAudio.browserEncoderNotice }}
          </p>
        </div>

        <label class="field-label" for="export-sample-rate">
          {{ t.dialogs.exportAudio.sampleRate }}
        </label>
        <div class="field">
          <SelectMenu
            v-model="model.sampleRate"
            class="sample-rate-select"
            :options="sampleRateOptions"
            :disabled="busy"
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
            :disabled="busy"
            :aria-label="t.dialogs.exportAudio.memoryBudget"
          />
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.range }}</span>
        <div class="field radio-row" role="radiogroup" :aria-label="t.dialogs.exportAudio.range">
          <label class="check-label">
            <input
              v-model="model.range"
              type="radio"
              name="export-range"
              value="project"
              class="range-project"
              :disabled="busy"
            />
            {{ t.dialogs.exportAudio.wholeProject }}
          </label>
          <label class="check-label" :class="{ disabled: !props.hasLoop }">
            <input
              v-model="model.range"
              type="radio"
              name="export-range"
              value="loop"
              class="range-loop"
              :disabled="busy || !props.hasLoop"
            />
            {{ t.dialogs.exportAudio.loopRegion }}
          </label>
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.mode }}</span>
        <div class="field radio-row" role="radiogroup" :aria-label="t.dialogs.exportAudio.mode">
          <label class="check-label">
            <input
              v-model="model.mode"
              type="radio"
              name="export-mode"
              value="mixdown"
              class="mode-mixdown"
              :disabled="busy"
            />
            {{ t.dialogs.exportAudio.mixdown }}
          </label>
          <label class="check-label">
            <input
              v-model="model.mode"
              type="radio"
              name="export-mode"
              value="stems"
              class="mode-stems"
              :disabled="busy"
            />
            {{ t.dialogs.exportAudio.stems }}
          </label>
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.masterChain }}</span>
        <div class="field">
          <ToggleButton
            v-model="model.includeMasterChain"
            class="include-master-chain"
            size="sm"
            :label="t.dialogs.exportAudio.includeMasterChain"
            :disabled="busy"
          />
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.stemOptions }}</span>
        <div class="field stem-option-row">
          <ToggleButton
            v-model="model.includeMasterStem"
            class="include-master-stem"
            size="sm"
            :label="t.dialogs.exportAudio.includeMasterStem"
            :disabled="busy || model.mode !== 'stems'"
          />
          <ToggleButton
            v-model="model.includeBusStems"
            class="include-bus-stems"
            size="sm"
            :label="t.dialogs.exportAudio.includeBusStems"
            :disabled="busy || model.mode !== 'stems'"
          />
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.normalization }}</span>
        <div class="field">
          <ToggleButton
            v-model="model.normalizeLoudness"
            class="normalize-loudness"
            size="sm"
            :label="normalizeLoudnessLabel"
            :disabled="busy"
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
            :disabled="busy || model.range !== 'project'"
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
            :disabled="busy"
            spellcheck="false"
          />
          <span class="filename-preview">{{ filenamePreview }}</span>
        </div>
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
          <div class="progress-fill" :style="{ width: `${Math.round(progress * 100)}%` }" />
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
        <p v-if="reportClipping" class="report-clipping" role="alert">
          {{ t.dialogs.exportAudio.clippingReport }}
        </p>
      </div>

      <p v-if="errorMessage" class="dialog-error" role="alert">{{ errorMessage }}</p>
    </div>
    <template #actions>
      <button type="button" class="close-button" :disabled="busy" @click="onClose">
        {{ t.dialogs.exportAudio.close }}
      </button>
      <button type="button" class="primary export-button" :disabled="!canExport" @click="onExport">
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

.radio-row {
  gap: var(--sp-6);
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

.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-1) linear;
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
