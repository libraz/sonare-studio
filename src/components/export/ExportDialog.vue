<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { isBrowserMediaEncoderId, registerBrowserMediaEncoders } from '@/export/browser-media';
import { type AudioEncoder, listEncoders, WAV_ENCODER_ID } from '@/export/codecs';
import { documentBusStemsBlock } from '@/export/engine-render-context';
import { formatExportStage } from '@/export/export-stage';
import { FLAC_ENCODER_ID, type FlacBitDepth, registerFlacEncoder } from '@/export/flac';
import type { MixdownRangePpq, MixdownReport } from '@/export/mixdown';
import { MP3_BITRATES, MP3_ENCODER_ID, registerMp3Encoder } from '@/export/mp3';
import {
  COMPRESSED_EXPORT_BITRATES,
  createDefaultExportOptions,
  EXPORT_MEMORY_BUDGET_MIB,
  EXPORT_SAMPLE_RATES,
  type ExportOptionsModel,
  exportFileName,
  selectedEncoderIds as selectedModelEncoderIds,
  stemsZipFileNameForEncoder,
  validateExportOptions,
} from '@/export/options';
import type { WavBitDepth } from '@/export/wav';
import type { ProjectDocument } from '@/project/serialization';
import { firstBlock } from '@/ui/disabled-reason';
import { type RenderFn, useAudioExportRun } from '@/ui/export/use-audio-export-run';
import { useI18n } from '@/ui/i18n';
import { formatLevel } from '@/ui/mastering/loudness';
import { formatSampleRate } from '@/ui/media/asset-list';

/**
 * Modal audio export dialog. Renders the project document through the export
 * worker (progress + cancel), encodes the result with the chosen registry
 * codec (WAV built in, MP3 when registered) and hands the file(s) to the
 * download seam — stems mode zips one file per track. The dialog never
 * touches the store; the shell provides the document snapshot via
 * `getDocument` and may inject the render/download/encoder seams for tests.
 */

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
/** Encoder list: the injected override or the live codec registry. */
function resolveEncoders(): AudioEncoder[] {
  return props.encoders ? [...props.encoders] : listEncoders();
}

function normalizeSelectedEncoder(): void {
  if (encoderList.value.some((encoder) => encoder.id === model.value.encoderId)) return;
  const fallback = encoderList.value[0];
  if (fallback) model.value.encoderId = fallback.id;
}

/** New defaults seeded from the project, against the current encoder list. */
function resetForm(): void {
  model.value = createDefaultExportOptions(props.projectName, props.projectSampleRate);
  encoderList.value = resolveEncoders();
  normalizeSelectedEncoder();
}

normalizeSelectedEncoder();

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    // Fresh state per session; focus, the trap and restoration are owned by AppModal.
    resetForm();
    resetRun();
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
const {
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
  reset: resetRun,
} = useAudioExportRun(props, emit, {
  model,
  busy,
  canExport,
  selectedEncoders,
  compressedEncoderIds,
});
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
          {{ t.common.cancel }}
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
          <template v-if="report.truePeakDbtp !== undefined">
            <dt>{{ t.dialogs.exportAudio.truePeak }}</dt>
            <dd class="report-true-peak">{{ formatLevel(report.truePeakDbtp) }} dBTP</dd>
          </template>
          <template v-if="report.lufs !== undefined">
            <dt>{{ t.dialogs.exportAudio.loudness }}</dt>
            <dd class="report-lufs">{{ formatLevel(report.lufs) }} LUFS</dd>
          </template>
          <template v-if="report.masteringPreset !== undefined">
            <dt>{{ t.dialogs.exportAudio.masteringPresetLoudness }}</dt>
            <dd
              class="report-mastering-lufs"
              :data-lufs="report.masteringPreset.outputLufs"
              :data-target-limited="report.masteringPreset.loudnessTargetLimited"
            >
              {{ formatLevel(report.masteringPreset.outputLufs) }} LUFS
            </dd>
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
        {{ t.common.close }}
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
