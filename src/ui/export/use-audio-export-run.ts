import { type ComputedRef, computed, type Ref, ref } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { confirmDialog } from '@/composables/useDialogs';
import { confirmLossReport } from '@/composables/useLossConfirm';
import { audioFileMetadataForDocument } from '@/export/audio-file-metadata';
import { inspectAudioExportLoss } from '@/export/audio-metadata-loss';
import { audioExportPreflight } from '@/export/audio-preflight';
import { isBrowserMediaEncoderId } from '@/export/browser-media';
import {
  type ExportRenderHandle,
  ExportWorkerError,
  MasteringBufferLimitError,
  renderMixdownInWorker,
} from '@/export/client';
import { type AudioEncoder, WAV_ENCODER_ID } from '@/export/codecs';
import { encodeAudioInWorker, isWorkerAudioEncoderId } from '@/export/encode-client';
import { offlineAutomationLimitations } from '@/export/engine-render';
import { documentBusStemsBlock } from '@/export/engine-render-context';
import {
  formatClippingCensus,
  formatExportLimitation,
  formatPreflightBlocker,
  formatPreflightWarning,
} from '@/export/export-issue-format';
import { FLAC_ENCODER_ID } from '@/export/flac';
import { preflightMasteringBuffer } from '@/export/mastering-preflight';
import {
  assertCodecPayloadMemory,
  DEFAULT_EXPORT_MEMORY_BUDGET_BYTES,
  estimateCodecPayloadMemory,
} from '@/export/memory-budget';
import {
  type ExportMediaIssue,
  MixdownCancelledError,
  type MixdownProgressFn,
  type MixdownRangePpq,
  type MixdownReport,
  type MixdownStem,
} from '@/export/mixdown';
import { MP3_ENCODER_ID } from '@/export/mp3';
import {
  createStemsZipWriter,
  type ExportOptionsModel,
  encodeOptionsForModel,
  exportFileName,
  normalizeMixdownLoudness,
  stemEntryName,
  stemsZipFileNameForEncoder,
  toRenderOptions,
} from '@/export/options';
import { createWavStreamWriter, type WavStreamWriter } from '@/export/wav-stream';
import { MEBIBYTE } from '@/lib/bytes';
import { peakDb } from '@/lib/db';
import { downloadBlob } from '@/lib/download';
import { isAbortError, errorMessage as thrownMessage } from '@/lib/errors';
import { PayloadMemoryMeter } from '@/lib/payload-memory';
import type { ProjectDocument } from '@/project/serialization';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatLevel } from '@/ui/mastering/loudness';
import type { ExportRenderOptions } from '@/workers/export.worker';

/** Render seam shape: the export worker client facade. */
export type RenderFn = (
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

/** Props the export run reads from the dialog. */
interface AudioExportRunProps {
  readonly getDocument: () => ProjectDocument;
  readonly loopRegion: MixdownRangePpq | null;
  readonly render: RenderFn | null;
  readonly download: ((blob: Blob, filename: string) => void) | null;
  readonly encoders: ReadonlyArray<AudioEncoder> | null;
}

/** Emit signature the export run uses. */
type AudioExportRunEmit = (
  event: 'exported',
  payload: { filename: string; report: MixdownReport },
) => void;

/** Form state the export run reads from the dialog. */
interface AudioExportRunInputs {
  model: Ref<ExportOptionsModel>;
  busy: Ref<boolean>;
  canExport: ComputedRef<boolean>;
  selectedEncoders: ComputedRef<AudioEncoder[]>;
  compressedEncoderIds: ComputedRef<string[]>;
}

function formatMasteringDuration(frames: number, sampleRate: number): string {
  if (!Number.isFinite(frames) || sampleRate <= 0) return '—';
  return (frames / sampleRate).toFixed(1);
}

/** The built-in WAV, FLAC and MP3 encoders, which embed the project metadata. */
function isBuiltInEncoder(encoderId: string): boolean {
  return (
    encoderId === WAV_ENCODER_ID || encoderId === FLAC_ENCODER_ID || encoderId === MP3_ENCODER_ID
  );
}

function isIntegerPcmExport(encoderId: string, model: ExportOptionsModel): boolean {
  return (
    isBuiltInEncoder(encoderId) && !(encoderId === WAV_ENCODER_ID && model.wavBitDepth === '32f')
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
  return Math.max(peakDb(peak), stem.report?.truePeakDbtp ?? -Infinity);
}

/** Default download seam: transient anchor around an object URL. */
function downloadViaAnchor(blob: Blob, filename: string): void {
  downloadBlob(blob, filename);
}

/** Everything the export steps share once preflight has accepted the request. */
interface ExportPlan {
  doc: ProjectDocument;
  exportModel: ExportOptionsModel;
  memoryBudgetBytes: number;
  targets: ExportTarget[];
  targetLufs: number;
}

interface ExportTarget {
  encoder: AudioEncoder;
  encodeOptions: Record<string, unknown>;
}

type StemConsumer = (
  stem: MixdownStem,
  index: number,
  total: number,
  target: ExportTarget,
  writer: ReturnType<typeof createStemsZipWriter>,
  meter: PayloadMemoryMeter,
) => Promise<void>;

type ExportRenderResult = Awaited<ExportRenderHandle['result']>;

/**
 * Runs the audio export for the dialog: render, preflight confirmations,
 * encode and download, plus the progress/report state the dialog displays.
 */
export function useAudioExportRun(
  props: AudioExportRunProps,
  emit: AudioExportRunEmit,
  { model, busy, canExport, selectedEncoders, compressedEncoderIds }: AudioExportRunInputs,
) {
  const { t } = useI18n();
  const appSettings = useAppSettings();
  const progress = ref(0);
  const stage = ref('');
  const errorMessage = ref('');
  const cancelled = ref(false);
  const report = ref<MixdownReport | null>(null);
  /** Localized line for a media reference the render could not resolve. */
  function formatMediaIssue(issue: ExportMediaIssue): string {
    const strings = t.value.dialogs.exportAudio;
    return formatMessage(strings.mediaIssue, {
      kind: strings.mediaIssueKind[issue.kind] ?? issue.kind,
      id: issue.id,
    });
  }
  const reportLimitations = computed(() => {
    const strings = t.value.dialogs.exportAudio;
    return [
      ...(report.value?.limitations ?? []).map((limitation) =>
        formatExportLimitation(limitation, strings.issue),
      ),
      ...(report.value?.mediaIssues ?? []).map(formatMediaIssue),
    ];
  });
  const reportClipping = computed(
    () => Math.max(report.value?.peakDb ?? -Infinity, report.value?.truePeakDbtp ?? -Infinity) > 0,
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

  /** Clears the previous run's progress, error and report. */
  function reset(): void {
    errorMessage.value = '';
    cancelled.value = false;
    report.value = null;
    progress.value = 0;
    stage.value = '';
  }

  async function onExport(): Promise<void> {
    if (!canExport.value) return;
    const encoders = selectedEncoders.value;
    const primaryEncoder = encoders[0];
    if (!primaryEncoder) return;
    busy.value = true;
    reset();
    stage.value = 'render';
    const renderFn = props.render ?? renderMixdownInWorker;
    const downloadFn = props.download ?? downloadViaAnchor;
    const controller = new AbortController();
    let handle: ExportRenderHandle | null = null;
    // Assigned inside step functions; the cast keeps the catch block from narrowing it to null.
    let wavStream = null as WavStreamWriter | null;
    cancelRender = () => {
      controller.abort(new MixdownCancelledError());
      handle?.cancel();
    };
    let consumedStemCount = 0;
    let stemsPeakDb = -Infinity;

    /** Snapshots the document and options the export runs against. */
    function prepareRequest(): Pick<ExportPlan, 'doc' | 'exportModel' | 'memoryBudgetBytes'> {
      const doc = structuredClone(props.getDocument()) as ProjectDocument;
      const exportModel: ExportOptionsModel = { ...model.value };
      if (documentBusStemsBlock(doc) !== null) exportModel.includeBusStems = false;
      return { doc, exportModel, memoryBudgetBytes: exportModel.memoryBudgetMiB * MEBIBYTE };
    }

    /** Throws when the preflight found blockers. */
    function assertPreflightClear(
      preflight: Awaited<ReturnType<typeof audioExportPreflight>>,
    ): void {
      if (preflight.blockers.length === 0) return;
      const issueStrings = t.value.dialogs.exportAudio.issue;
      const lines = preflight.blockers.map((blocker) =>
        formatPreflightBlocker(blocker, issueStrings),
      );
      throw new Error(`${t.value.dialogs.exportAudio.preflightBlocked}\n${lines.join('\n')}`);
    }

    /** Limitations and warnings the user must accept before the export starts. */
    function collectAcceptedLimitations(
      doc: ProjectDocument,
      preflight: Awaited<ReturnType<typeof audioExportPreflight>>,
      masteringFrozenParams: string[],
    ): string[] {
      const issueStrings = t.value.dialogs.exportAudio.issue;
      return [
        ...offlineAutomationLimitations(doc, masteringFrozenParams).map((limitation) =>
          formatExportLimitation(limitation, issueStrings),
        ),
        ...preflight.warnings.map((warning) => formatPreflightWarning(warning, issueStrings)),
      ];
    }

    /** One encoder + encode-options pair per selected format. */
    function buildTargets(
      doc: ProjectDocument,
      exportModel: ExportOptionsModel,
      range: MixdownRangePpq,
    ): ExportTarget[] {
      return encoders.map((encoder) => {
        const targetModel = { ...exportModel, encoderId: encoder.id };
        const encodeOptions = encodeOptionsForModel(targetModel, {
          compressedEncoderIds: compressedEncoderIds.value,
        });
        if (isBuiltInEncoder(encoder.id)) {
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
    }

    /** Starts the worker render, streaming stems or WAV chunks as they arrive, and awaits the result. */
    async function render(plan: ExportPlan): Promise<{
      result: ExportRenderResult;
      stemsWriter: ReturnType<typeof createStemsZipWriter> | null;
      stemMemory: PayloadMemoryMeter;
      consumeStem: StemConsumer;
    }> {
      const { doc, exportModel, memoryBudgetBytes, targets } = plan;
      const primaryTarget = targets[0]!;
      const stemMemory = new PayloadMemoryMeter({
        operation: 'audio-export',
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
            operation: 'audio-export',
            label: 'Streaming WAV export',
            budgetBytes: memoryBudgetBytes,
          }),
        });
      }
      const consumeStem = async (
        stem: MixdownStem,
        index: number,
        total: number,
        target: ExportTarget,
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
          const releaseEncoded = meter.retain(
            bytes.byteLength,
            `encoded stem ${index + 1}/${total}`,
          );
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
        const problems = mediaIssues.map(formatMediaIssue);
        throw new Error(`${t.value.dialogs.exportAudio.preflightBlocked}\n${problems.join('\n')}`);
      }
      return { result, stemsWriter, stemMemory, consumeStem };
    }

    /** Normalizes loudness for mixdowns and confirms clipping; null when the user declines. */
    async function normalizeAndConfirmClipping(
      plan: ExportPlan,
      result: ExportRenderResult,
    ): Promise<MixdownReport | null> {
      const { exportModel, targets, targetLufs } = plan;
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
          ? Math.max(normalizedReport.peakDb, normalizedReport.truePeakDbtp ?? -Infinity)
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
          return null;
        }
        controller.signal.throwIfAborted();
      }
      return normalizedReport;
    }

    /** Encodes and downloads the result in the selected mode; returns the delivered filenames. */
    async function deliver(
      plan: ExportPlan,
      result: ExportRenderResult,
      stemsWriter: ReturnType<typeof createStemsZipWriter> | null,
      stemMemory: PayloadMemoryMeter,
      consumeStem: StemConsumer,
    ): Promise<string[]> {
      const { exportModel, memoryBudgetBytes, targets } = plan;
      const primaryTarget = targets[0]!;
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
              operation: 'audio-export',
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
      return filenames;
    }

    try {
      const { doc, exportModel, memoryBudgetBytes } = prepareRequest();
      stage.value = 'preflight';
      const preflight = await audioExportPreflight(doc, {
        range: exportModel.range,
        loopRegion: props.loopRegion,
        releaseTailSeconds: exportModel.releaseTailSeconds,
        includeMasterChain: exportModel.includeMasterChain,
        signal: controller.signal,
      });
      assertPreflightClear(preflight);
      const masteringFrozenParams = await preflightMasteringBuffer(
        doc,
        exportModel,
        props.loopRegion,
        controller.signal,
      );
      const acceptedLimitations = collectAcceptedLimitations(doc, preflight, masteringFrozenParams);
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
      const plan: ExportPlan = {
        doc,
        exportModel,
        memoryBudgetBytes,
        targets: buildTargets(doc, exportModel, range),
        targetLufs: appSettings.settings.loudnessTargetLufs,
      };
      const { result, stemsWriter, stemMemory, consumeStem } = await render(plan);
      const normalizedReport = await normalizeAndConfirmClipping(plan, result);
      if (!normalizedReport) return;
      const filenames = await deliver(plan, result, stemsWriter, stemMemory, consumeStem);
      report.value = normalizedReport;
      reportSampleRate.value = result.sampleRate;
      for (const filename of filenames) emit('exported', { filename, report: normalizedReport });
    } catch (error) {
      wavStream?.abort();
      if (!controller.signal.aborted) controller.abort(error);
      if (error instanceof MixdownCancelledError || isAbortError(error)) {
        cancelled.value = true;
      } else if (error instanceof ExportWorkerError) {
        errorMessage.value = t.value.dialogs.exportAudio.workerError;
      } else if (error instanceof MasteringBufferLimitError) {
        const message = t.value.dialogs.exportAudio.masteringBufferLimit;
        errorMessage.value = formatMessage(message, {
          duration: formatMasteringDuration(error.totalFrames, error.sampleRate),
          limit: formatMasteringDuration(error.maxFrames, error.sampleRate),
        });
      } else {
        errorMessage.value = thrownMessage(error);
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

  return {
    progress,
    stage,
    errorMessage,
    cancelled,
    report,
    reportLimitations,
    reportClipping,
    reportClippingCensus,
    onExport,
    onCancelRender,
    reset,
  };
}
