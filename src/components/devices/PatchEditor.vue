<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { setTrackInstrument } from '@/project/commands';
import { trackInstrument } from '@/project/instrument';
import { getWasmModule, useProjectStore } from '@/project/store';
import { createPatchAudition, type PatchAudition } from '@/ui/devices/audition';
import { formatControlValue } from '@/ui/devices/knob-math';
import {
  adsrEnvelopePoints,
  clampPatchField,
  createModMatrixRow,
  createPatchDraft,
  MAX_MOD_ROUTINGS,
  MOD_DEPTH_MAX,
  MOD_DEPTH_MIN,
  type ModMatrixRow,
  modMatrixRows,
  modRowsToRoutings,
  type PatchFieldSpec,
  type PresetPatchResolver,
  patchFieldsForSection,
  sanitizePatchDraft,
} from '@/ui/devices/patch-draft';
import { resolveSynthEnums } from '@/ui/devices/synth-enums';
import { formatMessage, useI18n } from '@/ui/i18n';
import { useShortcutBlockingOverlay } from '@/ui/overlay-registry';
import { wrapTabFocus } from '@/ui/settings/focus-trap';
import { TOKENS } from '@/ui/theme/tokens';
import type { SynthEnumTables, SynthPatch } from '@/wasm/index.js';

/**
 * Modal NativeSynth patch editor. The dialog edits a local draft seeded from
 * the track's instrument (preset base values resolved through the wasm
 * catalog when available); Apply sanitizes the draft and commits one undoable
 * setTrackInstrument, Audition prerenders a single note and plays it on a
 * lazy local AudioContext — the realtime engine is never touched.
 */

const props = defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
  /** Track whose instrument is edited. */
  trackId: number;
}>();

const emit = defineEmits<{
  /** The dialog should be dismissed (Escape, overlay, Close button). */
  close: [];
  /** A patch was committed to the track. */
  applied: [];
}>();

const store = useProjectStore();
const { t } = useI18n();

const draft = ref<SynthPatch>({});
const modRows = ref<ModMatrixRow[]>([]);
const enums = ref<SynthEnumTables>(resolveSynthEnums(null));
const error = ref('');
const dialogRef = ref<HTMLElement | null>(null);
const envelopeCanvas = ref<HTMLCanvasElement | null>(null);
useShortcutBlockingOverlay(computed(() => props.open));

/** Preset resolver backed by the loaded wasm catalog (null before init). */
function resolvePresetPatch(): PresetPatchResolver {
  return (preset) => {
    try {
      const wasm = getWasmModule() as unknown as {
        synthPresetPatch?: (name: string) => SynthPatch;
      };
      return typeof wasm.synthPresetPatch === 'function' ? wasm.synthPresetPatch(preset) : null;
    } catch {
      return null;
    }
  };
}

/** Refreshes the enum select tables from the wasm catalog when available. */
function refreshEnums(): void {
  try {
    const wasm = getWasmModule() as unknown as { synthEnumTables?: () => SynthEnumTables };
    enums.value = resolveSynthEnums(
      typeof wasm.synthEnumTables === 'function' ? wasm.synthEnumTables() : null,
    );
  } catch {
    enums.value = resolveSynthEnums(null);
  }
}

/** Rebuilds the draft from the track's current instrument. */
function buildDraft(): void {
  const track = store.tracks.find((t) => t.id === props.trackId);
  const instrument = track ? trackInstrument(track) : null;
  const next = createPatchDraft(instrument, resolvePresetPatch());
  modRows.value = modMatrixRows(next);
  next.modRoutings = undefined;
  draft.value = next;
  error.value = '';
}

/** Element focused before the dialog opened, restored on close. */
let previousFocus: HTMLElement | null = null;

watch(
  () => [props.open, props.trackId] as const,
  ([open], previous) => {
    const wasOpen = previous?.[0] === true;
    if (!open) {
      if (wasOpen) {
        if (previousFocus?.isConnected) previousFocus.focus();
        previousFocus = null;
      }
      return;
    }
    if (!wasOpen) {
      const active = document.activeElement;
      previousFocus = active instanceof HTMLElement ? active : null;
    }
    refreshEnums();
    buildDraft();
    void nextTick(() => {
      dialogRef.value?.focus();
      drawEnvelope();
    });
  },
  { immediate: true },
);

// --- Field editing -----------------------------------------------------------

const oscFields = patchFieldsForSection('osc');
const filterFields = patchFieldsForSection('filter');
const ampFields = patchFieldsForSection('amp');
const filterEnvFields = patchFieldsForSection('filter-env');
const lfoFields = patchFieldsForSection('lfo');
const globalFields = patchFieldsForSection('global');

function fieldValue(spec: PatchFieldSpec): number {
  const value = (draft.value as Record<string, unknown>)[spec.id];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function onFieldInput(spec: PatchFieldSpec, event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(raw)) return;
  draft.value = { ...draft.value, [spec.id]: clampPatchField(spec.id, raw) };
}

/** Enum fields rendered as selects: id, label and the table they pick from. */
interface EnumFieldView {
  id: 'engineMode' | 'waveform' | 'filterModel' | 'filterOutput' | 'body';
  labelKey: keyof typeof t.value.shell.patchEditor.enumLabels;
  options: () => string[];
}

const OSC_ENUM_FIELDS: EnumFieldView[] = [
  { id: 'waveform', labelKey: 'waveform', options: () => enums.value.waveforms },
];
const FILTER_ENUM_FIELDS: EnumFieldView[] = [
  { id: 'filterModel', labelKey: 'model', options: () => enums.value.filterModels },
  { id: 'filterOutput', labelKey: 'output', options: () => enums.value.filterOutputs },
];
const GLOBAL_ENUM_FIELDS: EnumFieldView[] = [
  { id: 'engineMode', labelKey: 'engine', options: () => enums.value.engineModes },
  { id: 'body', labelKey: 'body', options: () => enums.value.bodyTypes },
];

function enumValue(field: EnumFieldView): string {
  const value = (draft.value as Record<string, unknown>)[field.id];
  return typeof value === 'string' && value.length > 0 ? value : 'default';
}

/** Maps a string enum table to SelectMenu options. */
function enumOptions(values: string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value }));
}

function onEnumChange(field: EnumFieldView, value: string): void {
  draft.value = { ...draft.value, [field.id]: value };
}

// --- Mod matrix --------------------------------------------------------------

/** Mod source options for the matrix selects. */
const modSourceOptions = computed(() => enumOptions(enums.value.modSources));
/** Mod destination options for the matrix selects. */
const modDestinationOptions = computed(() => enumOptions(enums.value.modDestinations));

function addModRow(): void {
  if (modRows.value.length >= MAX_MOD_ROUTINGS) return;
  modRows.value = [...modRows.value, createModMatrixRow()];
}

function removeModRow(index: number): void {
  modRows.value = modRows.value.filter((_, i) => i !== index);
}

function onModRowChange(index: number, patchRow: Partial<ModMatrixRow>): void {
  modRows.value = modRows.value.map((row, i) => (i === index ? { ...row, ...patchRow } : row));
}

function onModDepthInput(index: number, event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(raw)) return;
  onModRowChange(index, { depth: Math.min(MOD_DEPTH_MAX, Math.max(MOD_DEPTH_MIN, raw)) });
}

// --- Envelope display ----------------------------------------------------------

/** Documented engine defaults shown when a field carries the keep sentinel. */
const ENVELOPE_FALLBACKS = { attackMs: 5, decayMs: 60, sustain: 0.7, releaseMs: 120 };

function envelopeInputs(): {
  attackMs: number;
  decayMs: number;
  sustain: number;
  releaseMs: number;
} {
  const value = (id: 'ampAttackMs' | 'ampDecayMs' | 'ampSustain' | 'ampReleaseMs') => {
    const raw = (draft.value as Record<string, unknown>)[id];
    return typeof raw === 'number' && raw !== 0 ? raw : null;
  };
  return {
    attackMs: value('ampAttackMs') ?? ENVELOPE_FALLBACKS.attackMs,
    decayMs: value('ampDecayMs') ?? ENVELOPE_FALLBACKS.decayMs,
    sustain: value('ampSustain') ?? ENVELOPE_FALLBACKS.sustain,
    releaseMs: value('ampReleaseMs') ?? ENVELOPE_FALLBACKS.releaseMs,
  };
}

// Remembered across draws so environments without canvas 2D (jsdom) probe
// getContext only once instead of logging on every redraw.
let canvas2dAvailable = true;

/**
 * Reads a canvas palette token off the live element, falling back to the
 * tokens.ts mirror when computed styles are unavailable (jsdom). Keeps the
 * renderer in sync with the palette instead of baking in literals.
 */
function canvasToken(el: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/** Redraws the mini amp-envelope curve (no-op where canvas 2D is missing). */
function drawEnvelope(): void {
  const canvas = envelopeCanvas.value;
  if (!canvas || !canvas2dAvailable) return;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) {
    canvas2dAvailable = false;
    return;
  }
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = canvasToken(canvas, '--canvas-surface-2', TOKENS.surface2);
  ctx.fillRect(0, 0, width, height);
  const env = envelopeInputs();
  const points = adsrEnvelopePoints(
    env.attackMs,
    env.decayMs,
    env.sustain,
    env.releaseMs,
    width - 2,
    height - 4,
  );
  ctx.strokeStyle = canvasToken(canvas, '--canvas-accent', TOKENS.accent);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = point.x + 1;
    const y = point.y + 2;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

watch([draft, modRows], () => {
  if (props.open) void nextTick(drawEnvelope);
});

// --- Apply / audition ----------------------------------------------------------

/** Builds the sanitized patch the dialog would commit. */
function buildPatch(): SynthPatch {
  const merged: SynthPatch = { ...draft.value };
  const routings = modRowsToRoutings(modRows.value);
  if (routings.length > 0) merged.modRoutings = routings;
  else merged.modRoutings = undefined;
  return sanitizePatchDraft(merged);
}

function onApply(): void {
  try {
    setTrackInstrument(props.trackId, { kind: 'synth-patch', patch: buildPatch() });
    error.value = '';
    emit('applied');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

let audition: PatchAudition | null = null;
let disposed = false;
let auditionGeneration = 0;

function onAudition(): void {
  if (!audition) audition = createPatchAudition();
  const generation = ++auditionGeneration;
  audition
    .play({ kind: 'synth-patch', patch: buildPatch() })
    .then(() => {
      if (disposed || generation !== auditionGeneration) return;
      error.value = '';
    })
    .catch((err: unknown) => {
      if (disposed || generation !== auditionGeneration) return;
      error.value = err instanceof Error ? err.message : String(err);
    });
}

onBeforeUnmount(() => {
  disposed = true;
  auditionGeneration++;
  audition?.dispose();
  audition = null;
});

function onClose(): void {
  auditionGeneration++;
  audition?.stop();
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (dialogRef.value !== null && wrapTabFocus(event, dialogRef.value)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    onClose();
  }
}
</script>

<template>
  <div v-if="props.open" class="patch-overlay" @click.self="onClose">
    <div
      ref="dialogRef"
      class="patch-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t.shell.patchEditor.label"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="patch-header">
        <h2 class="patch-title">
          {{ t.shell.patchEditor.label }}
          <span v-if="draft.preset" class="patch-base">
            {{ formatMessage(t.shell.patchEditor.basedOn, { preset: draft.preset }) }}
          </span>
        </h2>
        <button type="button" class="patch-close" v-tooltip="t.shell.patchEditor.close" @click="onClose">
          ×
        </button>
      </header>
      <p v-if="error" class="patch-error" role="alert">{{ error }}</p>

      <div class="patch-sections">
        <section class="patch-section" :aria-label="t.shell.patchEditor.sections.oscillator">
          <h3 class="section-title">{{ t.shell.patchEditor.sections.osc }}</h3>
          <label v-for="field in OSC_ENUM_FIELDS" :key="field.id" class="enum-row">
            <span class="field-label">{{ t.shell.patchEditor.enumLabels[field.labelKey] }}</span>
            <SelectMenu
              :model-value="enumValue(field)"
              :options="enumOptions(field.options())"
              :aria-label="t.shell.patchEditor.enumLabels[field.labelKey]"
              size="sm"
              @change="onEnumChange(field, $event)"
            />
          </label>
          <label v-for="field in oscFields" :key="field.id" class="field-row">
            <span class="field-label">{{ field.label }}</span>
            <input
              type="range"
              :data-field="field.id"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              :value="fieldValue(field)"
              @input="onFieldInput(field, $event)"
            />
            <span class="field-value">{{ formatControlValue(fieldValue(field), field.unit) }}</span>
          </label>
        </section>

        <section class="patch-section" :aria-label="t.shell.patchEditor.sections.filter">
          <h3 class="section-title">{{ t.shell.patchEditor.sections.filterTitle }}</h3>
          <label v-for="field in FILTER_ENUM_FIELDS" :key="field.id" class="enum-row">
            <span class="field-label">{{ t.shell.patchEditor.enumLabels[field.labelKey] }}</span>
            <SelectMenu
              :model-value="enumValue(field)"
              :options="enumOptions(field.options())"
              :aria-label="t.shell.patchEditor.enumLabels[field.labelKey]"
              size="sm"
              @change="onEnumChange(field, $event)"
            />
          </label>
          <label v-for="field in filterFields" :key="field.id" class="field-row">
            <span class="field-label">{{ field.label }}</span>
            <input
              type="range"
              :data-field="field.id"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              :value="fieldValue(field)"
              @input="onFieldInput(field, $event)"
            />
            <span class="field-value">{{ formatControlValue(fieldValue(field), field.unit) }}</span>
          </label>
        </section>

        <section class="patch-section" :aria-label="t.shell.patchEditor.sections.ampEnvelope">
          <h3 class="section-title">{{ t.shell.patchEditor.sections.ampEnvelopeTitle }}</h3>
          <canvas
            ref="envelopeCanvas"
            class="envelope-canvas"
            width="168"
            height="48"
            role="img"
            :aria-label="t.shell.patchEditor.sections.ampEnvelopeCurve"
          />
          <label v-for="field in ampFields" :key="field.id" class="field-row">
            <span class="field-label">{{ field.label }}</span>
            <input
              type="range"
              :data-field="field.id"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              :value="fieldValue(field)"
              @input="onFieldInput(field, $event)"
            />
            <span class="field-value">{{ formatControlValue(fieldValue(field), field.unit) }}</span>
          </label>
        </section>

        <section class="patch-section" :aria-label="t.shell.patchEditor.sections.filterEnvelope">
          <h3 class="section-title">{{ t.shell.patchEditor.sections.filterEnvelopeTitle }}</h3>
          <label v-for="field in filterEnvFields" :key="field.id" class="field-row">
            <span class="field-label">{{ field.label }}</span>
            <input
              type="range"
              :data-field="field.id"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              :value="fieldValue(field)"
              @input="onFieldInput(field, $event)"
            />
            <span class="field-value">{{ formatControlValue(fieldValue(field), field.unit) }}</span>
          </label>
        </section>

        <section class="patch-section" :aria-label="t.shell.patchEditor.sections.lfo">
          <h3 class="section-title">{{ t.shell.patchEditor.sections.lfo }}</h3>
          <label v-for="field in lfoFields" :key="field.id" class="field-row">
            <span class="field-label">{{ field.label }}</span>
            <input
              type="range"
              :data-field="field.id"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              :value="fieldValue(field)"
              @input="onFieldInput(field, $event)"
            />
            <span class="field-value">{{ formatControlValue(fieldValue(field), field.unit) }}</span>
          </label>
        </section>

        <section class="patch-section" :aria-label="t.shell.patchEditor.sections.global">
          <h3 class="section-title">{{ t.shell.patchEditor.sections.globalTitle }}</h3>
          <label v-for="field in GLOBAL_ENUM_FIELDS" :key="field.id" class="enum-row">
            <span class="field-label">{{ t.shell.patchEditor.enumLabels[field.labelKey] }}</span>
            <SelectMenu
              :model-value="enumValue(field)"
              :options="enumOptions(field.options())"
              :aria-label="t.shell.patchEditor.enumLabels[field.labelKey]"
              size="sm"
              @change="onEnumChange(field, $event)"
            />
          </label>
          <label v-for="field in globalFields" :key="field.id" class="field-row">
            <span class="field-label">{{ field.label }}</span>
            <input
              type="range"
              :data-field="field.id"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              :value="fieldValue(field)"
              @input="onFieldInput(field, $event)"
            />
            <span class="field-value">{{ formatControlValue(fieldValue(field), field.unit) }}</span>
          </label>
        </section>

        <section class="patch-section mod-matrix" :aria-label="t.shell.patchEditor.sections.modMatrix">
          <h3 class="section-title">{{ t.shell.patchEditor.sections.modMatrixTitle }}</h3>
          <div v-for="(row, index) in modRows" :key="index" class="mod-row">
            <SelectMenu
              class="mod-source"
              :model-value="row.source"
              :options="modSourceOptions"
              :aria-label="formatMessage(t.shell.patchEditor.modSource, { row: index + 1 })"
              size="sm"
              @update:model-value="onModRowChange(index, { source: $event })"
            />
            <span class="mod-arrow">→</span>
            <SelectMenu
              class="mod-destination"
              :model-value="row.destination"
              :options="modDestinationOptions"
              :aria-label="formatMessage(t.shell.patchEditor.modDestination, { row: index + 1 })"
              size="sm"
              @update:model-value="onModRowChange(index, { destination: $event })"
            />
            <input
              class="mod-depth"
              type="number"
              :min="MOD_DEPTH_MIN"
              :max="MOD_DEPTH_MAX"
              step="0.01"
              :value="row.depth"
              :aria-label="formatMessage(t.shell.patchEditor.modDepth, { row: index + 1 })"
              @input="onModDepthInput(index, $event)"
            />
            <button
              type="button"
              class="mod-remove"
              v-tooltip="formatMessage(t.shell.patchEditor.removeRouting, { row: index + 1 })"
              @click="removeModRow(index)"
            >
              ×
            </button>
          </div>
          <button
            type="button"
            class="mod-add"
            :disabled="modRows.length >= MAX_MOD_ROUTINGS"
            @click="addModRow"
          >
            {{ t.shell.patchEditor.addRouting }}
          </button>
        </section>
      </div>

      <footer class="patch-actions">
        <button type="button" class="audition" @click="onAudition">
          {{ t.shell.patchEditor.audition }}
        </button>
        <span class="actions-spacer" />
        <button type="button" @click="onClose">{{ t.shell.patchEditor.close }}</button>
        <button type="button" class="primary" @click="onApply">{{ t.shell.patchEditor.apply }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.patch-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  -webkit-backdrop-filter: var(--scrim-blur);
  backdrop-filter: var(--scrim-blur);
}

.patch-dialog {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: min(46rem, calc(100vw - 2rem));
  max-height: calc(100vh - 3rem);
  padding: 1rem 1.25rem;
  background: var(--glass-3);
  -webkit-backdrop-filter: var(--glass-blur-strong);
  backdrop-filter: var(--glass-blur-strong);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--glass-hairline), var(--shadow-modal);
  color: var(--text-1);
  font-size: var(--fs-sm);
  overflow: hidden;
}

.patch-dialog:focus {
  outline: none;
}

.patch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.patch-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.patch-base {
  margin-left: 0.5rem;
  font-size: var(--fs-xs);
  font-weight: 400;
  color: var(--text-3);
}

.patch-close {
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  font-size: var(--fs-xl);
  line-height: 1;
  cursor: pointer;
}

.patch-close:hover {
  color: var(--text-1);
}

.patch-error {
  margin: 0;
  padding: var(--sp-1) var(--sp-3);
  background: var(--danger-surface);
  color: var(--danger-text);
  font: var(--fs-2xs)/1.4 var(--font-sans);
  border-radius: var(--radius-xs);
}

.patch-sections {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
  gap: 0.5rem;
  overflow: auto;
  min-height: 0;
}

.patch-section {
  box-shadow: var(--control-edge);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.section-title {
  margin: 0 0 0.15rem;
  font-size: var(--fs-2xs);
  font-weight: 700;
  color: var(--text-3);
  letter-spacing: 0.08em;
}

.field-row,
.enum-row {
  display: grid;
  grid-template-columns: 5.2rem 1fr 3.4rem;
  align-items: center;
  gap: 0.3rem;
}

.enum-row {
  grid-template-columns: 5.2rem 1fr;
}

.field-label {
  font-size: var(--fs-2xs);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.field-value {
  font-size: var(--fs-2xs);
  color: var(--text-2);
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.field-row input[type='range'] {
  width: 100%;
  height: 12px;
  accent-color: var(--accent);
  border-radius: var(--radius-xs);
}

.field-row input[type='range']:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}

.envelope-canvas {
  width: 100%;
  height: 48px;
  border-radius: var(--radius-xs);
  box-shadow: inset 0 0 0 1px var(--canvas-border), var(--inset-well);
}

.mod-matrix {
  grid-column: 1 / -1;
}

.mod-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr 4.2rem auto;
  gap: 0.3rem;
  align-items: center;
}

.mod-arrow {
  color: var(--text-4);
}

.mod-depth {
  background: var(--surface-2);
  color: var(--text-2);
  border: none;
  border-radius: var(--radius-xs);
  box-shadow: var(--control-edge), var(--inset-well);
  font-size: var(--fs-xs);
  padding: 1px var(--sp-2);
}

.mod-remove {
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  cursor: pointer;
  font-size: var(--fs-md);
  line-height: 1;
}

.mod-remove:hover {
  color: var(--danger-text);
}

.mod-add {
  align-self: flex-start;
  background: var(--surface-3);
  color: var(--text-2);
  border-radius: var(--radius-sm);
  box-shadow: var(--control-lift);
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  padding: var(--sp-1) var(--sp-4);
  cursor: pointer;
}

.mod-add:disabled {
  opacity: 0.4;
  cursor: default;
}

.patch-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.actions-spacer {
  flex: 1;
}

/* Secondary buttons (Close, Audition) inherit the :where(button) control face;
 * Apply uses the shared .primary accent pill. Only the audition accent ring is
 * declared locally. */
.patch-actions .audition {
  box-shadow: inset 0 0 0 1px var(--accent), var(--shadow-1);
}
</style>
