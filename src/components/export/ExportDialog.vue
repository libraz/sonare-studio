<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { type ExportRenderHandle, renderMixdownInWorker } from '@/export/client';
import { type AudioEncoder, listEncoders, WAV_ENCODER_ID } from '@/export/codecs';
import {
  MixdownCancelledError,
  type MixdownProgressFn,
  type MixdownRangePpq,
  type MixdownReport,
} from '@/export/mixdown';
import { MP3_BITRATES, MP3_ENCODER_ID, registerMp3Encoder } from '@/export/mp3';
import {
  buildStemsZip,
  createDefaultExportOptions,
  EXPORT_SAMPLE_RATES,
  type ExportOptionsModel,
  encodeOptionsForModel,
  exportFileName,
  type StemsZipEntry,
  stemEntryNames,
  stemsZipFileName,
  toRenderOptions,
  validateExportOptions,
} from '@/export/options';
import type { WavBitDepth } from '@/export/wav';
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

// Make MP3 available in the registry; idempotent across mounts.
registerMp3Encoder();

const { t } = useI18n();
const model = ref<ExportOptionsModel>(createDefaultExportOptions(props.projectName));
const encoderList = ref<AudioEncoder[]>(resolveEncoders());
const busy = ref(false);
const progress = ref(0);
const stage = ref('');
const errorMessage = ref('');
const cancelled = ref(false);
const report = ref<MixdownReport | null>(null);
let cancelRender: (() => void) | null = null;

/** Encoder list: the injected override or the live codec registry. */
function resolveEncoders(): AudioEncoder[] {
  return props.encoders ? [...props.encoders] : listEncoders();
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    // Fresh state per session: new defaults seeded from the project name.
    // Focus, the trap and restoration are owned by AppModal.
    model.value = createDefaultExportOptions(props.projectName);
    encoderList.value = resolveEncoders();
    errorMessage.value = '';
    cancelled.value = false;
    report.value = null;
    progress.value = 0;
    stage.value = '';
  },
);

const selectedEncoder = computed<AudioEncoder | null>(
  () => encoderList.value.find((encoder) => encoder.id === model.value.encoderId) ?? null,
);

const errors = computed<string[]>(() =>
  validateExportOptions(model.value, {
    hasLoop: props.hasLoop,
    encoderIds: encoderList.value.map((encoder) => encoder.id),
  }),
);

const canExport = computed(() => !busy.value && errors.value.length === 0);

/** Full output filename shown next to the base-name field. */
const filenamePreview = computed(() => {
  if (model.value.mode === 'stems') return stemsZipFileName(model.value.baseName);
  return exportFileName(model.value.baseName, selectedEncoder.value?.extension ?? '');
});

/** String proxy because '32f' cannot ride a numeric select binding. */
const wavBitDepthProxy = computed({
  get: () => String(model.value.wavBitDepth),
  set: (value: string) => {
    model.value.wavBitDepth = value === '32f' ? '32f' : (Number(value) as WavBitDepth);
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

/** MP3 bitrate options. */
const mp3BitrateOptions = MP3_BITRATES.map((bitrate) => ({
  value: bitrate,
  label: `${bitrate} kbps`,
}));

/** Sample-rate options, labelled in kHz. */
const sampleRateOptions = EXPORT_SAMPLE_RATES.map((rate) => ({
  value: rate,
  label: `${(rate / 1000).toLocaleString('en-US')} kHz`,
}));

const progressStageLabel = computed(() => {
  if (stage.value === 'render') return t.value.dialogs.exportAudio.stage.render;
  if (stage.value === 'encode') return t.value.dialogs.exportAudio.stage.encode;
  return stage.value;
});

/** Formats a dB / LUFS value for the report ('-inf' for silence). */
function formatLevel(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '-inf';
}

/** Default download seam: transient anchor around an object URL. */
function downloadViaAnchor(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function onExport(): Promise<void> {
  if (!canExport.value) return;
  const encoder = selectedEncoder.value;
  if (!encoder) return;
  busy.value = true;
  errorMessage.value = '';
  cancelled.value = false;
  report.value = null;
  progress.value = 0;
  stage.value = 'render';
  const renderFn = props.render ?? renderMixdownInWorker;
  const downloadFn = props.download ?? downloadViaAnchor;
  try {
    const doc = props.getDocument();
    const handle = renderFn(doc, toRenderOptions(model.value, props.loopRegion), (p, s) => {
      progress.value = p;
      stage.value = s;
    });
    cancelRender = handle.cancel;
    const result = await handle.result;
    cancelRender = null;
    progress.value = 1;
    stage.value = 'encode';
    const encodeOptions = encodeOptionsForModel(model.value);
    let filename: string;
    if (model.value.mode === 'stems') {
      const stems = result.stems ?? [];
      if (stems.length === 0) {
        throw new Error(t.value.dialogs.exportAudio.noStems);
      }
      const names = stemEntryNames(
        stems.map((stem) => stem.name),
        encoder.extension,
      );
      const entries: StemsZipEntry[] = [];
      for (let i = 0; i < stems.length; i++) {
        entries.push({
          name: names[i],
          bytes: await encoder.encode(stems[i].channels, result.sampleRate, encodeOptions),
        });
      }
      const zip = buildStemsZip(entries);
      filename = stemsZipFileName(model.value.baseName);
      // Copy into a fresh Uint8Array so the BlobPart sees a plain ArrayBuffer.
      downloadFn(new Blob([new Uint8Array(zip)], { type: 'application/zip' }), filename);
    } else {
      const bytes = await encoder.encode(result.channels, result.sampleRate, encodeOptions);
      filename = exportFileName(model.value.baseName, encoder.extension);
      downloadFn(new Blob([new Uint8Array(bytes)], { type: encoder.mime }), filename);
    }
    report.value = result.report;
    emit('exported', { filename, report: result.report });
  } catch (error) {
    if (error instanceof MixdownCancelledError) {
      cancelled.value = true;
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
          <div v-if="model.encoderId === WAV_ENCODER_ID" class="format-options wav-options">
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
          <div v-if="model.encoderId === MP3_ENCODER_ID" class="format-options mp3-options">
            <SelectMenu
              v-model="model.mp3Bitrate"
              class="mp3-bitrate"
              size="sm"
              :options="mp3BitrateOptions"
              :disabled="busy"
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
            :disabled="busy"
            :aria-label="t.dialogs.exportAudio.sampleRate"
          />
        </div>

        <span class="field-label">{{ t.dialogs.exportAudio.range }}</span>
        <div class="field radio-row" role="radiogroup" :aria-label="t.dialogs.exportAudio.range">
          <label class="check-label">
            <input v-model="model.range" type="radio" value="project" class="range-project" :disabled="busy" />
            {{ t.dialogs.exportAudio.wholeProject }}
          </label>
          <label class="check-label" :class="{ disabled: !props.hasLoop }">
            <input
              v-model="model.range"
              type="radio"
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
            <input v-model="model.mode" type="radio" value="mixdown" class="mode-mixdown" :disabled="busy" />
            {{ t.dialogs.exportAudio.mixdown }}
          </label>
          <label class="check-label">
            <input v-model="model.mode" type="radio" value="stems" class="mode-stems" :disabled="busy" />
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
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--sp-3) var(--sp-3);
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
