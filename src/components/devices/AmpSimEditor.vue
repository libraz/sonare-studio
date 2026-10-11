<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { ensureWasm } from '@/lib/wasm';
import type { AutomationParam, AutomationTarget } from '@/project/automation';
import { insertAutomationParam } from '@/project/automation';
import { setAutomationLanePoints, setInsertEnabled, setInsertParam } from '@/project/commands';
import { getWasmModule, useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import {
  type AutomationWriteGesture,
  type AutomationWriteMode,
  type AutomationWriteScheduleEvent,
  automationStripMode,
  createAutomationWriteGesture,
  isAutomationWriteMode,
} from '@/ui/mixer/automation-mode';

/**
 * The order is the public order of libsonare's amp_preset_names(). Keep the
 * numeric index in the project document: it is the portable construction
 * parameter understood by realtime, offline, and every binding.
 */
const AMP_SIM_PRESETS = [
  'cleanCombo',
  'chimeEdge',
  'classicCrunch',
  'tweedGrind',
  'britStack',
  'modernLead',
  'rectifierChug',
  'coldBiasBuzz',
  'bassDi',
  'bassRig',
] as const;

type AmpPresetIndex = (typeof AMP_SIM_PRESETS)[number];

type AmpNumberKey =
  | 'drive'
  | 'bassDb'
  | 'midDb'
  | 'trebleDb'
  | 'presenceDb'
  | 'inputDb'
  | 'levelDb'
  | 'power'
  | 'sag'
  | 'nfb'
  | 'micAxis'
  | 'micDistanceCm';

type AmpModelKey = 'ampModel' | 'cabModel' | 'micModel';
type AmpParameterKey = AmpNumberKey | AmpModelKey | 'cab';
type AmpParameterValue = number | boolean;
type AmpParameterSource = 'explicit' | 'preset' | 'default' | 'unavailable';

interface AmpPresetCatalogEntry {
  index: number;
  name: string;
  params: Record<string, AmpParameterValue>;
}

interface AmpPresetCatalogModule {
  masteringAmpPresetCatalog?: () => unknown;
  masteringInsertParamInfo?: (name: string) => unknown;
}

const props = defineProps<{
  trackId: number;
  insertIndex: number;
  /** Playhead position used by touch/latch write gestures. */
  positionPpq?: () => number;
  /** Current playhead sample position for realtime scheduling. */
  positionSample?: () => number;
  /** Whether transport is running while an amp control is being dragged. */
  isPlaying?: boolean;
  /** Optional realtime scheduler for touch/latch amp writes. */
  scheduleAutomationWrite?: (
    target: AutomationTarget,
    param: AutomationParam,
    event: AutomationWriteScheduleEvent,
  ) => void;
}>();

const { t } = useI18n();
const store = useProjectStore();
const error = ref('');
const presetCatalog = ref<readonly AmpPresetCatalogEntry[]>([]);
const normalDefaults = ref<Readonly<Record<string, AmpParameterValue>>>({});
const catalogError = ref(false);
const pendingRangeValues = ref<Partial<Record<AmpNumberKey, number>>>({});
let disposed = false;

// libsonare marks this parameter as construction-only (id: null). Keep the
// slider responsive while dragging, then rebuild the insert once on change.
const CONSTRUCTION_ONLY_RANGE_PARAMS = new Set<AmpNumberKey>(['micDistanceCm']);
const NORMALIZED_NUMBER_PARAMS = new Set<AmpNumberKey>(['drive', 'power', 'sag', 'nfb', 'micAxis']);

const slot = computed(() => {
  const track = store.tracks.find((candidate) => candidate.id === props.trackId);
  const insert = track?.mixer?.inserts[props.insertIndex];
  return insert?.processor === 'saturation.ampSim' ? insert : null;
});

const params = computed(() => slot.value?.params ?? {});
const hasOverrides = computed(() => Object.keys(params.value).some((key) => key !== 'presetIndex'));
const isBypassed = computed(() => slot.value?.enabled === false);

const currentPresetIndex = computed<number | null>(() => {
  const value = params.value.presetIndex;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
});

/** Named preset values need the runtime catalog to be trustworthy. */
const showCatalogError = computed(() => catalogError.value && currentPresetIndex.value !== null);

function isAmpParameterValue(value: unknown): value is AmpParameterValue {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function normalizePresetCatalog(value: unknown): AmpPresetCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry): AmpPresetCatalogEntry[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const index = record.index;
      const name = record.name;
      const params = record.params;
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        typeof name !== 'string' ||
        name.length === 0 ||
        typeof params !== 'object' ||
        params === null
      ) {
        return [];
      }
      const cleanParams: Record<string, AmpParameterValue> = {};
      for (const [key, candidate] of Object.entries(params)) {
        if (isAmpParameterValue(candidate)) cleanParams[key] = candidate;
      }
      return [{ index, name, params: cleanParams }];
    })
    .sort((left, right) => left.index - right.index);
}

function readPresetCatalog(module: unknown): AmpPresetCatalogEntry[] {
  const fn = (module as AmpPresetCatalogModule | null)?.masteringAmpPresetCatalog;
  if (typeof fn !== 'function') return [];
  return normalizePresetCatalog(fn());
}

function readNormalDefaults(module: unknown): Record<string, AmpParameterValue> {
  const fn = (module as AmpPresetCatalogModule | null)?.masteringInsertParamInfo;
  if (typeof fn !== 'function') return {};
  const info = fn('saturation.ampSim');
  if (!Array.isArray(info)) return {};
  const defaults: Record<string, AmpParameterValue> = {};
  for (const entry of info) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name === 'string' && isAmpParameterValue(record.default)) {
      defaults[record.name] = record.default;
    }
  }
  return defaults;
}

function setPresetCatalog(module: unknown): void {
  try {
    try {
      normalDefaults.value = readNormalDefaults(module);
    } catch {
      normalDefaults.value = {};
    }
    const entries = readPresetCatalog(module);
    if (entries.length === 0) {
      catalogError.value = true;
      return;
    }
    presetCatalog.value = entries;
    catalogError.value = false;
  } catch {
    catalogError.value = true;
  }
}

// The store normally has an initialized module already, which lets the panel
// paint the actual values on its first render. The async path covers opening
// the panel during application startup and older builds without this API.
try {
  setPresetCatalog(getWasmModule());
} catch {
  void ensureWasm()
    .then((module) => {
      if (!disposed) setPresetCatalog(module);
    })
    .catch(() => {
      if (!disposed) {
        catalogError.value = true;
      }
    });
}

const catalogByIndex = computed(() => {
  const byIndex = new Map<number, AmpPresetCatalogEntry>();
  for (const entry of presetCatalog.value) byIndex.set(entry.index, entry);
  return byIndex;
});

const presetOptions = computed(() => {
  if (presetCatalog.value.length > 0) return presetCatalog.value;
  return AMP_SIM_PRESETS.map((name, index) => ({ index, name, params: {} }));
});

const currentPreset = computed(() =>
  currentPresetIndex.value === null
    ? undefined
    : catalogByIndex.value.get(currentPresetIndex.value),
);

function humanizePresetName(name: string): string {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function presetLabel(option: AmpPresetCatalogEntry): string {
  const key = option.name as AmpPresetIndex;
  const localized = (t.value.shell.devicesPanel.ampPresets as Record<string, string>)[key];
  return localized ?? humanizePresetName(option.name);
}

function explicitValue(param: AmpParameterKey): AmpParameterValue | undefined {
  const value = params.value[param];
  return isAmpParameterValue(value) ? value : undefined;
}

function resolvedParameter(param: AmpParameterKey): {
  value: AmpParameterValue | undefined;
  source: AmpParameterSource;
} {
  const explicit = explicitValue(param);
  if (explicit !== undefined) return { value: explicit, source: 'explicit' };

  const preset = currentPreset.value?.params[param];
  if (preset !== undefined) return { value: preset, source: 'preset' };

  const fallback = normalDefaults.value[param];
  // A slot without presetIndex is the core's ordinary AmpSim construction and
  // its param-info defaults remain authoritative even if the optional named
  // preset catalog is unavailable. A named or unknown preset needs the
  // catalog to distinguish its inherited values from those defaults.
  const hasNamedPreset = currentPresetIndex.value !== null;
  if ((!hasNamedPreset || presetCatalog.value.length > 0) && fallback !== undefined) {
    return { value: fallback, source: 'default' };
  }

  return { value: undefined, source: 'unavailable' };
}

function parameterSource(param: AmpParameterKey): AmpParameterSource {
  return resolvedParameter(param).source;
}

function parameterSourceLabel(param: AmpParameterKey): string {
  const source = parameterSource(param);
  if (source === 'preset') return t.value.shell.devicesPanel.ampInherited;
  if (source === 'default') return t.value.shell.devicesPanel.ampDefault;
  return '';
}

function parameterAvailable(param: AmpParameterKey): boolean {
  return resolvedParameter(param).value !== undefined;
}

/** An inherited control whose preset value never loaded has nothing to edit. */
function parameterBlocked(param: AmpParameterKey): string | null {
  return firstBlock([
    !parameterAvailable(param),
    t.value.shell.devicesPanel.reasons.ampValueUnavailable,
  ]);
}

function numberValue(param: AmpNumberKey): number | null {
  const value = resolvedParameter(param).value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pendingOrResolvedNumberValue(param: AmpNumberKey): number | null {
  const pending = pendingRangeValues.value[param];
  return pending ?? numberValue(param);
}

function numberInputValue(param: AmpNumberKey): number | '' {
  const write = writeValue.value;
  if (write?.id === param) return write.value;
  return pendingOrResolvedNumberValue(param) ?? '';
}

function numberDisplay(param: AmpNumberKey, suffix = ''): string {
  const value = numberInputValue(param);
  return value === ''
    ? '—'
    : `${value.toFixed(NORMALIZED_NUMBER_PARAMS.has(param) ? 2 : 1)}${suffix}`;
}

function run(action: () => void): void {
  try {
    action();
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function apply(param: string, value: number | boolean, commit = true): void {
  if (!slot.value) return;
  // A static edit (preset/model/cab or a manual range change) closes any
  // unfinished write draft before it changes the construction state.
  if (writeContext || writeGesture) endWrite();
  run(() => setInsertParam(props.trackId, props.insertIndex, param, value, { commit }));
}

function choosePreset(index: number): void {
  if (!presetOptions.value.some((preset) => preset.index === index)) return;
  // presetIndex is deliberately numeric. The string preset option only exists
  // in the C++ JSON side-channel and cannot travel through the realtime strip.
  pendingRangeValues.value = {};
  apply('presetIndex', index);
}

// --- Amp touch/latch recording ---------------------------------------------

/** A range control may enter a write gesture only for realtime amp params. */
interface AmpWriteContext {
  controlId: AmpNumberKey;
  mode: AutomationWriteMode;
  target: AutomationTarget;
  param: AutomationParam;
}

function automationParamFor(param: string): AutomationParam | null {
  if (!slot.value || CONSTRUCTION_ONLY_RANGE_PARAMS.has(param as AmpNumberKey)) return null;
  return insertAutomationParam(slot.value.id ?? props.insertIndex, param);
}

function writeContextFor(param: string): AmpWriteContext | null {
  if (props.positionPpq === undefined) return null;
  const controlId = param as AmpNumberKey;
  const automationParam = automationParamFor(param);
  if (automationParam === null) return null;
  const target: AutomationTarget = props.trackId;
  const mode = automationStripMode(target);
  if (!isAutomationWriteMode(mode)) return null;
  return { controlId, mode, target, param: automationParam };
}

let writeContext: AmpWriteContext | null = null;
let writeGesture: AutomationWriteGesture | null = null;
/** Live value shown by the range while its write gesture is in flight. */
const writeValue = ref<{ id: AmpNumberKey; value: number } | null>(null);

/** Starts write mode lazily so keyboard and test-driven input are covered too. */
function beginWrite(param: string): boolean {
  if (writeContext?.controlId !== undefined && writeContext.controlId !== param) {
    endWrite();
  }
  const context = writeContext ?? writeContextFor(param);
  if (!context) return false;
  writeContext = context;
  return true;
}

function recordWrite(value: number): void {
  const context = writeContext;
  if (!context) return;
  if (!writeGesture) {
    const lane = store.automationLanes.find(
      (entry) => entry.target === context.target && entry.param === context.param,
    );
    writeGesture = createAutomationWriteGesture({
      mode: context.mode,
      existingPoints: lane?.points ?? [],
      positionPpq: () => Math.max(0, props.positionPpq?.() ?? 0),
      positionSample: props.positionSample,
      isPlaying: () => props.isPlaying === true,
      schedule: (event) => props.scheduleAutomationWrite?.(context.target, context.param, event),
      commit: (points) => setAutomationLanePoints(context.target, context.param, points),
    });
  }
  writeGesture.update(value);
  writeValue.value = { id: context.controlId, value };
}

/** Ends a write gesture, committing one lane edit and clearing the draft. */
function endWrite(): void {
  writeGesture?.end();
  writeGesture = null;
  writeContext = null;
  writeValue.value = null;
}

function onRangeInput(param: string, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  if (CONSTRUCTION_ONLY_RANGE_PARAMS.has(param as AmpNumberKey)) {
    pendingRangeValues.value = { ...pendingRangeValues.value, [param]: value };
    return;
  }
  if (beginWrite(param)) {
    recordWrite(value);
    return;
  }
  apply(param, value, false);
}

function onRangeChange(param: string, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  if (CONSTRUCTION_ONLY_RANGE_PARAMS.has(param as AmpNumberKey)) {
    apply(param, value, true);
    clearPendingRangeValue(param);
    return;
  }
  if (writeContext?.controlId === param) {
    if (!writeGesture) recordWrite(value);
    endWrite();
    return;
  }
  if (beginWrite(param)) {
    recordWrite(value);
    endWrite();
    return;
  }
  apply(param, value, true);
  clearPendingRangeValue(param);
}

function clearPendingRangeValue(param: string): void {
  if (!CONSTRUCTION_ONLY_RANGE_PARAMS.has(param as AmpNumberKey)) return;
  const next = { ...pendingRangeValues.value };
  delete next[param as AmpNumberKey];
  pendingRangeValues.value = next;
}

function onRangeCancel(param: string): void {
  if (writeContext?.controlId === param) {
    endWrite();
    return;
  }
  clearPendingRangeValue(param);
}

function modelValue(param: AmpModelKey): number | '' {
  const value = resolvedParameter(param).value;
  return typeof value === 'number' && Number.isInteger(value) ? value : '';
}

function onModelChange(param: AmpModelKey, event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  if (raw !== '') apply(param, Number(raw));
}

const cabState = computed(() => resolvedParameter('cab'));
const cabIsInherited = computed(() => cabState.value.source !== 'explicit');
const cabEnabled = computed<boolean | null>(() =>
  typeof cabState.value.value === 'boolean' ? cabState.value.value : null,
);

function toggleBypass(): void {
  if (!slot.value) return;
  run(() => setInsertEnabled(props.trackId, props.insertIndex, isBypassed.value));
}

onBeforeUnmount(() => {
  endWrite();
  disposed = true;
});
</script>

<template>
  <section class="amp-sim-editor" :aria-label="t.shell.devicesPanel.guitarAmpEditor">
    <header class="amp-sim-header">
      <div>
        <p class="amp-sim-kicker">{{ t.shell.devicesPanel.guitarAmpKicker }}</p>
        <h4 class="amp-sim-title">{{ t.shell.devicesPanel.guitarAmpTitle }}</h4>
      </div>
      <div class="amp-sim-header-actions">
        <span class="amp-sim-led" :class="{ bypassed: isBypassed }" aria-hidden="true" />
        <button
          type="button"
          class="amp-bypass"
          :class="{ active: !isBypassed }"
          :aria-pressed="isBypassed"
          :aria-label="t.shell.inserts.bypass"
          v-tooltip="isBypassed ? t.shell.inserts.enable : t.shell.inserts.bypass"
          @click="toggleBypass"
        >
          {{ isBypassed ? t.shell.inserts.enable : t.shell.inserts.bypass }}
        </button>
      </div>
    </header>

    <p v-if="error" class="amp-sim-error" role="alert">{{ error }}</p>
    <p v-if="showCatalogError" class="amp-sim-catalog-error" role="status">
      {{ t.shell.devicesPanel.ampPresetValuesUnavailable }}
    </p>

    <fieldset class="amp-preset-fieldset">
      <legend>{{ t.shell.devicesPanel.ampPresetLabel }}</legend>
      <div class="amp-preset-grid">
        <button
          v-for="preset in presetOptions"
          :key="preset.index"
          type="button"
          class="amp-preset"
          :class="{ selected: currentPresetIndex === preset.index }"
          :aria-pressed="currentPresetIndex === preset.index"
          @click="choosePreset(preset.index)"
        >
          <span class="amp-preset-index">{{ String(preset.index + 1).padStart(2, '0') }}</span>
          <span>{{ presetLabel(preset) }}</span>
        </button>
      </div>
      <p v-if="currentPresetIndex === null" class="amp-custom-hint">
        {{ t.shell.devicesPanel.ampCustomPreset }}
      </p>
      <p v-else-if="hasOverrides" class="amp-custom-hint">
        {{ t.shell.devicesPanel.ampModifiedPreset }}
      </p>
    </fieldset>

    <fieldset class="amp-control-fieldset">
      <legend>{{ t.shell.devicesPanel.ampToneLabel }}</legend>
      <div class="amp-control-grid">
        <label class="amp-control">
          <span>
            {{ t.shell.devicesPanel.ampDrive }}
            <small v-if="parameterSourceLabel('drive')" class="amp-control-source">
              {{ parameterSourceLabel('drive') }}
            </small>
          </span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="numberInputValue('drive')"
            :disabled="!!parameterBlocked('drive')"
            v-tooltip="{ reason: parameterBlocked('drive') }"
            :aria-label="t.shell.devicesPanel.ampDrive"
            @input="onRangeInput('drive', $event)"
            @change="onRangeChange('drive', $event)"
            @pointercancel="onRangeCancel('drive')"
          />
          <output>{{ numberDisplay('drive') }}</output>
        </label>
        <label v-for="control in [
          { id: 'bassDb', label: t.shell.devicesPanel.ampBass },
          { id: 'midDb', label: t.shell.devicesPanel.ampMid },
          { id: 'trebleDb', label: t.shell.devicesPanel.ampTreble },
          { id: 'presenceDb', label: t.shell.devicesPanel.ampPresence },
        ]" :key="control.id" class="amp-control">
          <span>
            {{ control.label }}
            <small
              v-if="parameterSourceLabel(control.id as AmpNumberKey)"
              class="amp-control-source"
            >{{ parameterSourceLabel(control.id as AmpNumberKey) }}</small>
          </span>
          <input
            type="range"
            min="-12"
            max="12"
            step="0.5"
            :value="numberInputValue(control.id as AmpNumberKey)"
            :disabled="!!parameterBlocked(control.id as AmpNumberKey)"
            v-tooltip="{ reason: parameterBlocked(control.id as AmpNumberKey) }"
            :aria-label="control.label"
            @input="onRangeInput(control.id, $event)"
            @change="onRangeChange(control.id, $event)"
            @pointercancel="onRangeCancel(control.id)"
          />
          <output>{{ numberDisplay(control.id as AmpNumberKey, ' dB') }}</output>
        </label>
      </div>
    </fieldset>

    <div class="amp-output-row">
      <label class="amp-control amp-trim-control">
        <span>
          {{ t.shell.devicesPanel.ampInput }}
          <small v-if="parameterSourceLabel('inputDb')" class="amp-control-source">
            {{ parameterSourceLabel('inputDb') }}
          </small>
        </span>
        <input
          type="range"
          min="-24"
          max="24"
          step="0.5"
          :value="numberInputValue('inputDb')"
          :disabled="!!parameterBlocked('inputDb')"
          v-tooltip="{ reason: parameterBlocked('inputDb') }"
          :aria-label="t.shell.devicesPanel.ampInput"
          @input="onRangeInput('inputDb', $event)"
          @change="onRangeChange('inputDb', $event)"
          @pointercancel="onRangeCancel('inputDb')"
        />
        <output>{{ numberDisplay('inputDb', ' dB') }}</output>
      </label>
      <label class="amp-control amp-trim-control">
        <span>
          {{ t.shell.devicesPanel.ampLevel }}
          <small v-if="parameterSourceLabel('levelDb')" class="amp-control-source">
            {{ parameterSourceLabel('levelDb') }}
          </small>
        </span>
        <input
          type="range"
          min="-24"
          max="24"
          step="0.5"
          :value="numberInputValue('levelDb')"
          :disabled="!!parameterBlocked('levelDb')"
          v-tooltip="{ reason: parameterBlocked('levelDb') }"
          :aria-label="t.shell.devicesPanel.ampLevel"
          @input="onRangeInput('levelDb', $event)"
          @change="onRangeChange('levelDb', $event)"
          @pointercancel="onRangeCancel('levelDb')"
        />
        <output>{{ numberDisplay('levelDb', ' dB') }}</output>
      </label>
      <div class="amp-cab-control" role="group" :aria-label="t.shell.devicesPanel.ampCab">
        <span>{{ t.shell.devicesPanel.ampCab }}</span>
        <div class="amp-cab-actions">
          <button
            type="button"
            :aria-pressed="cabEnabled === true"
            :disabled="!!parameterBlocked('cab')"
            v-tooltip="{ reason: parameterBlocked('cab') }"
            @click="apply('cab', true)"
          >{{ t.shell.devicesPanel.ampCabOn }}</button>
          <button
            type="button"
            :aria-pressed="cabEnabled === false"
            :disabled="!!parameterBlocked('cab')"
            v-tooltip="{ reason: parameterBlocked('cab') }"
            @click="apply('cab', false)"
          >{{ t.shell.devicesPanel.ampCabOff }}</button>
        </div>
        <output v-if="cabIsInherited">
          {{ parameterAvailable('cab') ? parameterSourceLabel('cab') : '—' }}
        </output>
      </div>
    </div>
    <details class="amp-advanced">
      <summary>{{ t.shell.devicesPanel.advancedControls }}</summary>
      <div class="amp-advanced-grid">
        <label class="amp-control">
          <span>
            {{ t.shell.devicesPanel.ampModel }}
            <small v-if="parameterSourceLabel('ampModel')" class="amp-control-source">
              {{ parameterSourceLabel('ampModel') }}
            </small>
          </span>
          <select
            :value="modelValue('ampModel')"
            :disabled="!!parameterBlocked('ampModel')"
            v-tooltip="{ reason: parameterBlocked('ampModel') }"
            :aria-label="t.shell.devicesPanel.ampModel"
            @change="onModelChange('ampModel', $event)"
          >
            <option v-for="(name, index) in t.shell.devicesPanel.ampModels" :key="index" :value="Number(index)">{{ name }}</option>
          </select>
        </label>
        <label class="amp-control">
          <span>
            {{ t.shell.devicesPanel.ampCabModel }}
            <small v-if="parameterSourceLabel('cabModel')" class="amp-control-source">
              {{ parameterSourceLabel('cabModel') }}
            </small>
          </span>
          <select
            :value="modelValue('cabModel')"
            :disabled="!!parameterBlocked('cabModel')"
            v-tooltip="{ reason: parameterBlocked('cabModel') }"
            :aria-label="t.shell.devicesPanel.ampCabModel"
            @change="onModelChange('cabModel', $event)"
          >
            <option v-for="(name, index) in t.shell.devicesPanel.ampCabModels" :key="index" :value="Number(index)">{{ name }}</option>
          </select>
        </label>
        <label class="amp-control">
          <span>
            {{ t.shell.devicesPanel.ampMicModel }}
            <small v-if="parameterSourceLabel('micModel')" class="amp-control-source">
              {{ parameterSourceLabel('micModel') }}
            </small>
          </span>
          <select
            :value="modelValue('micModel')"
            :disabled="!!parameterBlocked('micModel')"
            v-tooltip="{ reason: parameterBlocked('micModel') }"
            :aria-label="t.shell.devicesPanel.ampMicModel"
            @change="onModelChange('micModel', $event)"
          >
            <option v-for="(name, index) in t.shell.devicesPanel.ampMicModels" :key="index" :value="Number(index)">{{ name }}</option>
          </select>
        </label>
        <label
          v-for="control in [
            { id: 'power', label: t.shell.devicesPanel.ampPower, min: 0, max: 1, step: 0.01 },
            { id: 'sag', label: t.shell.devicesPanel.ampSag, min: 0, max: 1, step: 0.01 },
            { id: 'nfb', label: t.shell.devicesPanel.ampFeedback, min: 0, max: 1, step: 0.01 },
            { id: 'micAxis', label: t.shell.devicesPanel.ampMicAxis, min: 0, max: 1, step: 0.01 },
            { id: 'micDistanceCm', label: t.shell.devicesPanel.ampMicDistance, min: 0, max: 100, step: 0.5 },
          ]"
          :key="control.id"
          class="amp-control"
        >
          <span>
            {{ control.label }}
            <small
              v-if="parameterSourceLabel(control.id as AmpNumberKey)"
              class="amp-control-source"
            >{{ parameterSourceLabel(control.id as AmpNumberKey) }}</small>
          </span>
          <input
            type="range"
            :min="control.min"
            :max="control.max"
            :step="control.step"
            :value="numberInputValue(control.id as AmpNumberKey)"
            :disabled="!!parameterBlocked(control.id as AmpNumberKey)"
            v-tooltip="{ reason: parameterBlocked(control.id as AmpNumberKey) }"
            :aria-label="control.label"
            @input="onRangeInput(control.id, $event)"
            @change="onRangeChange(control.id, $event)"
            @pointercancel="onRangeCancel(control.id)"
          />
          <output>{{ numberDisplay(control.id as AmpNumberKey) }}</output>
        </label>
      </div>
    </details>
  </section>
</template>

<style scoped src="./amp-sim-editor.css"></style>
