<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
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
import { wrapTabFocus } from '@/ui/settings/focus-trap';
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

const dialogRef = ref<HTMLElement | null>(null);
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

/** Element focused before the dialog opened, restored on close. */
let previousFocus: HTMLElement | null = null;

watch(
  () => props.open,
  (open) => {
    if (!open) {
      if (previousFocus?.isConnected) previousFocus.focus();
      previousFocus = null;
      return;
    }
    const active = document.activeElement;
    previousFocus = active instanceof HTMLElement ? active : null;
    // Fresh state per session: new defaults seeded from the project name.
    model.value = createDefaultExportOptions(props.projectName);
    encoderList.value = resolveEncoders();
    errorMessage.value = '';
    cancelled.value = false;
    report.value = null;
    progress.value = 0;
    stage.value = '';
    void nextTick(() => dialogRef.value?.focus());
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
        throw new Error('No stems were rendered (the project has no tracks)');
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

function onKeydown(event: KeyboardEvent): void {
  if (dialogRef.value !== null && wrapTabFocus(event, dialogRef.value)) return;
  if (event.key !== 'Escape') return;
  event.preventDefault();
  if (busy.value) {
    onCancelRender();
  } else {
    emit('close');
  }
}
</script>

<template>
  <div v-if="props.open" class="dialog-overlay" @click.self="onClose">
    <div
      ref="dialogRef"
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Export audio"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <h2 class="dialog-title">Export audio</h2>

      <div class="dialog-grid">
        <label class="field-label" for="export-format">Format</label>
        <div class="field">
          <SelectMenu
            v-model="model.encoderId"
            class="format-select"
            :options="encoderOptions"
            :disabled="busy"
            aria-label="Format"
          />
          <div v-if="model.encoderId === WAV_ENCODER_ID" class="format-options wav-options">
            <SelectMenu
              v-model="wavBitDepthProxy"
              class="wav-bit-depth"
              size="sm"
              :options="WAV_BIT_DEPTH_OPTIONS"
              :disabled="busy"
              aria-label="Bit depth"
            />
            <label class="check-label">
              <input
                v-model="model.wavDither"
                type="checkbox"
                class="wav-dither"
                :disabled="busy || model.wavBitDepth !== 16"
              />
              Dither
            </label>
          </div>
          <div v-if="model.encoderId === MP3_ENCODER_ID" class="format-options mp3-options">
            <SelectMenu
              v-model="model.mp3Bitrate"
              class="mp3-bitrate"
              size="sm"
              :options="mp3BitrateOptions"
              :disabled="busy"
              aria-label="Bitrate"
            />
          </div>
        </div>

        <label class="field-label" for="export-sample-rate">Sample rate</label>
        <div class="field">
          <SelectMenu
            v-model="model.sampleRate"
            class="sample-rate-select"
            :options="sampleRateOptions"
            :disabled="busy"
            aria-label="Sample rate"
          />
        </div>

        <span class="field-label">Range</span>
        <div class="field radio-row" role="radiogroup" aria-label="Range">
          <label class="check-label">
            <input v-model="model.range" type="radio" value="project" class="range-project" :disabled="busy" />
            Whole project
          </label>
          <label class="check-label" :class="{ disabled: !props.hasLoop }">
            <input
              v-model="model.range"
              type="radio"
              value="loop"
              class="range-loop"
              :disabled="busy || !props.hasLoop"
            />
            Loop region
          </label>
        </div>

        <span class="field-label">Mode</span>
        <div class="field radio-row" role="radiogroup" aria-label="Mode">
          <label class="check-label">
            <input v-model="model.mode" type="radio" value="mixdown" class="mode-mixdown" :disabled="busy" />
            Mixdown
          </label>
          <label class="check-label">
            <input v-model="model.mode" type="radio" value="stems" class="mode-stems" :disabled="busy" />
            Stems (one file per track)
          </label>
        </div>

        <span class="field-label">Master chain</span>
        <div class="field">
          <label class="check-label">
            <input
              v-model="model.includeMasterChain"
              type="checkbox"
              class="include-master-chain"
              :disabled="busy"
            />
            Apply master inserts, EQ and mastering chain
          </label>
        </div>

        <label class="field-label" for="export-filename">Filename</label>
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

      <div v-if="busy" class="export-progress">
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: `${Math.round(progress * 100)}%` }" />
        </div>
        <span class="progress-stage">{{ stage }}</span>
        <button type="button" class="cancel-render" @click="onCancelRender">Cancel</button>
      </div>

      <p v-if="cancelled" class="export-cancelled" role="status">Export cancelled.</p>

      <div v-if="report" class="export-report" role="status">
        <h3 class="report-title">Loudness report</h3>
        <dl class="report-grid">
          <dt>Peak</dt>
          <dd class="report-peak">{{ formatLevel(report.peakDb) }} dBFS</dd>
          <template v-if="report.truePeakDb !== undefined">
            <dt>True peak</dt>
            <dd class="report-true-peak">{{ formatLevel(report.truePeakDb) }} dBTP</dd>
          </template>
          <template v-if="report.lufs !== undefined">
            <dt>Loudness</dt>
            <dd class="report-lufs">{{ formatLevel(report.lufs) }} LUFS</dd>
          </template>
        </dl>
      </div>

      <p v-if="errorMessage" class="dialog-error" role="alert">{{ errorMessage }}</p>

      <div class="dialog-actions">
        <button type="button" class="close-button" :disabled="busy" @click="onClose">Close</button>
        <button type="button" class="primary export-button" :disabled="!canExport" @click="onExport">
          Export
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(17, 24, 39, 0.28);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: min(30rem, calc(100vw - 2rem));
  max-height: calc(100vh - 4rem);
  padding: 1.25rem 1.4rem;
  overflow: auto;
  background: var(--glass-3);
  -webkit-backdrop-filter: var(--glass-blur-strong);
  backdrop-filter: var(--glass-blur-strong);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--glass-hairline), var(--shadow-modal);
  color: var(--text-1);
  font-size: var(--fs-sm);
}

.dialog:focus {
  outline: none;
}

.dialog-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  letter-spacing: 0.04em;
}

.dialog-grid {
  display: grid;
  grid-template-columns: 7rem 1fr;
  row-gap: 0.55rem;
  column-gap: 0.6rem;
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
  gap: 0.6rem;
  flex-wrap: wrap;
  min-width: 0;
}

.format-options {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.radio-row {
  gap: 1rem;
}

.check-label {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
}

.check-label.disabled {
  color: var(--text-4);
  cursor: default;
}

select,
input[type='text'] {
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-1);
  font-size: var(--fs-sm);
  padding: 0.2rem 0.35rem;
  box-shadow: var(--control-edge), var(--inset-well);
}

select:focus,
select:focus-visible,
input[type='text']:focus,
input[type='text']:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
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
  padding: 0.4rem 0.6rem 0.4rem 1.5rem;
  background: var(--warning-surface);
  border: 1px solid var(--warning);
  border-radius: var(--radius-sm);
  color: var(--warning-text);
}

.export-progress {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.progress-track {
  flex: 1;
  height: 0.45rem;
  background: var(--surface-inset);
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 120ms linear;
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
  padding: 0.4rem 0.6rem;
}

.report-title {
  margin: 0 0 0.3rem;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.report-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.8rem;
  row-gap: 0.15rem;
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
  padding: 0.4rem 0.6rem;
  background: var(--danger-surface);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  color: var(--danger-text);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.dialog-actions .primary {
  background: var(--accent-strong);
  border: 1px solid var(--accent);
  color: var(--text-1);
  border-radius: var(--radius-sm);
  padding: 0.25rem 0.9rem;
  cursor: pointer;
}

.dialog-actions .primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.cancel-render {
  flex: none;
}
</style>
