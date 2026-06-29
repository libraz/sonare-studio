<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import DeviceInsertChain from '@/components/devices/DeviceInsertChain.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SearchField from '@/components/shell/SearchField.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useWebMidiOutputs } from '@/composables/useWebMidiOutputs';
import {
  addInsert,
  removeInsert,
  setInsertEnabled,
  setProjectExternalMidiDefault,
  setProjectExternalMidiDefaultForTracks,
  setTrackExternalMidiMode,
  setTrackInstrument,
} from '@/project/commands';
import { listFonts, loadFontMeta, type SoundFontMeta, saveFont } from '@/project/fonts';
import { type ExternalMidiInstrument, effectiveTrackInstrument } from '@/project/instrument';
import type { QuickControlTarget } from '@/project/quick-controls';
import { getWasmModule, useProjectStore } from '@/project/store';
import {
  insertCategory,
  insertLabel,
  instrumentLabel,
  patchBaseLabel,
} from '@/ui/devices/device-labels';
import { patchEditCount } from '@/ui/devices/patch-draft';
import { filterPresets } from '@/ui/devices/preset-filter';
import {
  buildSf2Instrument,
  clampBank,
  clampGain,
  clampPolyphony,
  clampProgram,
  createSf2Selection,
  MAX_SF2_GAIN,
  MAX_SF2_POLYPHONY,
  MIN_SF2_POLYPHONY,
} from '@/ui/devices/sf2-model';
import { formatMessage, useI18n } from '@/ui/i18n';
import PatchEditor from './PatchEditor.vue';
import QuickControls from './QuickControls.vue';

/**
 * Device rack for the active track: the instrument slot (with a picker
 * popover offering synth presets, stored SoundFonts and the patch editor)
 * above the track's insert chain, plus the Quick Controls of the selected
 * device. Self-contained: reads the active track from the store and routes
 * every edit through the undoable command layer.
 */

withDefaults(
  defineProps<{
    /**
     * True while the engine transport plays. Instrument swaps are stop-gated
     * by the engine (they apply when playback stops), so the rack shows a
     * hint instead of pretending the change is instant.
     */
    transportPlaying?: boolean;
  }>(),
  { transportPlaying: false },
);

const store = useProjectStore();
const { t } = useI18n();

/** Surfaced when a command or font operation rejects. */
const error = ref('');

const activeTrack = computed(() => {
  return store.tracks.find((track) => track.id === store.activeTrackId) ?? null;
});

const instrument = computed(() => {
  const track = activeTrack.value;
  return track && track.kind === 'midi'
    ? effectiveTrackInstrument(track, store.projectExternalMidi)
    : null;
});

const inserts = computed(() => activeTrack.value?.mixer?.inserts ?? []);

const activeTrackUsesProjectExternal = computed(
  () => activeTrack.value?.externalMidiMode === 'project' && store.projectExternalMidi !== null,
);

/** Runs an action surfacing thrown errors in the rack banner. */
function run(action: () => void): void {
  try {
    action();
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

// --- Instrument label / font name resolution ----------------------------------

/** Cached display names of stored fonts, by font id. */
const fontNames = ref<Record<string, string>>({});

watch(
  instrument,
  (current) => {
    if (current?.kind !== 'sf2') return;
    const fontId = current.fontId;
    if (fontNames.value[fontId] !== undefined) return;
    loadFontMeta(fontId)
      .then((meta) => {
        fontNames.value = { ...fontNames.value, [fontId]: meta.name };
      })
      .catch(() => {
        // Missing fonts keep the shortened-id fallback label.
      });
  },
  { immediate: true },
);

const instrumentCaption = computed(() => {
  const current = instrument.value;
  if (!current) return '';
  const fontName = current.kind === 'sf2' ? (fontNames.value[current.fontId] ?? null) : null;
  return instrumentLabel(current, fontName);
});

// --- Device selection (drives the Quick Controls target) -----------------------

/** 'instrument' or the index of the selected insert slot. */
const selectedDevice = ref<'instrument' | number>('instrument');

watch(
  () => store.activeTrackId,
  () => {
    selectedDevice.value = 'instrument';
    pickerOpen.value = false;
  },
);

const quickControlTarget = computed<QuickControlTarget | null>(() => {
  const track = activeTrack.value;
  if (!track) return null;
  const selected = selectedDevice.value;
  if (typeof selected === 'number') {
    if (selected < 0 || selected >= inserts.value.length) return null;
    return { type: 'insert', trackId: track.id, index: selected };
  }
  if (track.kind !== 'midi') return null;
  return { type: 'instrument', trackId: track.id };
});

const quickControlKey = computed(() => {
  const target = quickControlTarget.value;
  if (!target) return 'none';
  return target.type === 'instrument'
    ? `instrument:${target.trackId}`
    : `insert:${String(target.trackId)}:${target.index}`;
});

// --- Instrument picker popover --------------------------------------------------

type PickerTab = 'presets' | 'sf2' | 'patch' | 'external';

const pickerOpen = ref(false);
const pickerTab = ref<PickerTab>('presets');
const pickerRoot = ref<HTMLElement | null>(null);

const presetQuery = ref('');
const presetCatalog = ref<string[]>([]);
const filteredPresets = computed(() => filterPresets(presetCatalog.value, presetQuery.value));

function refreshPresetCatalog(): void {
  try {
    const wasm = getWasmModule() as unknown as { synthPresetNames?: () => string[] };
    presetCatalog.value =
      typeof wasm.synthPresetNames === 'function' ? wasm.synthPresetNames() : [];
  } catch {
    presetCatalog.value = [];
  }
}

function onInstrumentClick(): void {
  selectedDevice.value = 'instrument';
  pickerOpen.value = !pickerOpen.value;
  if (!pickerOpen.value) return;
  refreshPresetCatalog();
  sf2Selection.value = createSf2Selection(instrument.value);
  syncExternalSelection();
  if (instrument.value?.kind === 'sf2') pickerTab.value = 'sf2';
  else if (instrument.value?.kind === 'synth-patch') pickerTab.value = 'patch';
  else if (instrument.value?.kind === 'external-midi') pickerTab.value = 'external';
  else pickerTab.value = 'presets';
  if (pickerTab.value === 'sf2') void refreshFonts();
  if (pickerTab.value === 'external') void webMidiOutputs.refresh();
}

function openTab(tab: PickerTab): void {
  pickerTab.value = tab;
  if (tab === 'sf2') void refreshFonts();
  if (tab === 'external') void webMidiOutputs.refresh();
}

/** Closes the picker when the pointer goes down outside of it. */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node) || !pickerRoot.value?.contains(event.target)) {
    pickerOpen.value = false;
  }
}

watch(pickerOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown, true);
  else document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

function choosePreset(preset: string): void {
  const track = activeTrack.value;
  if (!track) return;
  run(() => setTrackInstrument(track.id, { kind: 'synth-preset', preset }));
  pickerOpen.value = false;
}

// --- SF2 tab ---------------------------------------------------------------------

const fonts = ref<SoundFontMeta[]>([]);
const fontsLoading = ref(false);
const sf2Selection = ref(createSf2Selection(null));
const sf2FileInput = ref<HTMLInputElement | null>(null);

async function refreshFonts(): Promise<void> {
  fontsLoading.value = true;
  try {
    fonts.value = await listFonts();
    error.value = '';
  } catch (err) {
    fonts.value = [];
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    fontsLoading.value = false;
  }
}

function selectFont(id: string): void {
  sf2Selection.value = { ...sf2Selection.value, fontId: id };
}

function onBankInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  sf2Selection.value = { ...sf2Selection.value, bank: clampBank(raw) };
}

function onProgramInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  sf2Selection.value = { ...sf2Selection.value, program: clampProgram(raw) };
}

function onGainInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  sf2Selection.value = { ...sf2Selection.value, gain: clampGain(raw) };
}

function onPolyphonyInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  sf2Selection.value = { ...sf2Selection.value, polyphony: clampPolyphony(raw) };
}

function useSf2(): void {
  const track = activeTrack.value;
  const next = buildSf2Instrument(sf2Selection.value);
  if (!track || !next) return;
  run(() => setTrackInstrument(track.id, next));
  pickerOpen.value = false;
}

async function onSf2FileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const meta = await saveFont({ name: file.name }, data);
    fontNames.value = { ...fontNames.value, [meta.id]: meta.name };
    await refreshFonts();
    selectFont(meta.id);
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

// --- External MIDI tab -------------------------------------------------------------

const webMidiOutputs = useWebMidiOutputs();

interface ExternalSelection {
  outputPortId: string;
  channel: number;
  sendClock: boolean;
}

const externalSelection = ref<ExternalSelection>({
  outputPortId: '',
  channel: 0,
  sendClock: false,
});

/** Output ports as SelectMenu options (empty placeholder while none chosen). */
const externalPortOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t.value.shell.devicesPanel.externalMidiPort },
  ...webMidiOutputs.outputs.value.map((port) => ({ value: port.id, label: port.name })),
]);

/** Seeds the external selection from the current instrument (or sane defaults). */
function syncExternalSelection(): void {
  const track = activeTrack.value;
  const current =
    track?.externalMidiMode === 'project'
      ? store.projectExternalMidi
      : track?.instrument?.kind === 'external-midi'
        ? track.instrument
        : store.projectExternalMidi;
  externalSelection.value =
    current?.kind === 'external-midi'
      ? {
          outputPortId: current.outputPortId,
          channel: current.channel,
          sendClock: current.sendClock === true,
        }
      : { outputPortId: '', channel: 0, sendClock: false };
}

function onExternalPortChange(portId: string): void {
  externalSelection.value = { ...externalSelection.value, outputPortId: portId };
}

function onExternalChannelInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  const channel = Number.isFinite(raw) ? Math.min(15, Math.max(0, Math.round(raw - 1))) : 0;
  externalSelection.value = { ...externalSelection.value, channel };
}

function onExternalClockToggle(event: Event): void {
  externalSelection.value = {
    ...externalSelection.value,
    sendClock: (event.target as HTMLInputElement).checked,
  };
}

function selectedExternalInstrument(): ExternalMidiInstrument | null {
  const sel = externalSelection.value;
  if (sel.outputPortId.length === 0) return null;
  return {
    kind: 'external-midi',
    outputPortId: sel.outputPortId,
    channel: sel.channel,
    ...(sel.sendClock ? { sendClock: true } : {}),
  };
}

function useExternalMidi(): void {
  const track = activeTrack.value;
  const next = selectedExternalInstrument();
  if (!track || !next) return;
  run(() => setTrackInstrument(track.id, next));
  pickerOpen.value = false;
}

function saveProjectExternalMidi(): void {
  const next = selectedExternalInstrument();
  if (!next) return;
  run(() => setProjectExternalMidiDefault(next));
}

function useProjectExternalMidi(): void {
  const track = activeTrack.value;
  const next = selectedExternalInstrument();
  if (!track || !next) return;
  run(() => setProjectExternalMidiDefaultForTracks(next, [track.id]));
  pickerOpen.value = false;
}

function useProjectExternalMidiForAll(): void {
  const next = selectedExternalInstrument();
  if (!next) return;
  const trackIds = store.tracks.filter((track) => track.kind === 'midi').map((track) => track.id);
  if (trackIds.length === 0) return;
  run(() => setProjectExternalMidiDefaultForTracks(next, trackIds));
  pickerOpen.value = false;
}

function leaveProjectExternalMidi(): void {
  const track = activeTrack.value;
  if (!track) return;
  run(() => setTrackExternalMidiMode(track.id, null));
}

// --- Patch tab / editor ------------------------------------------------------------

const patchEditorOpen = ref(false);

const patchSummary = computed(() => {
  const current = instrument.value;
  if (current?.kind === 'synth-patch') {
    const edits = patchEditCount(current.patch);
    const editText = formatMessage(
      edits === 1
        ? t.value.shell.devicesPanel.editCount
        : t.value.shell.devicesPanel.editCountPlural,
      { count: String(edits) },
    );
    return `${patchBaseLabel(current.patch)} · ${editText}`;
  }
  if (current?.kind === 'synth-preset') {
    return `${current.preset} · ${t.value.shell.devicesPanel.unedited}`;
  }
  return t.value.shell.devicesPanel.noSynthPatch;
});

function openPatchEditor(): void {
  pickerOpen.value = false;
  patchEditorOpen.value = true;
}

// --- Insert chain ------------------------------------------------------------------

/** Offered when the runtime insert catalog is unavailable. */
const FALLBACK_INSERT_CHOICES = [
  'dynamics.compressor',
  'dynamics.limiter',
  'eq.parametric',
  'eq.tilt',
  'saturation.tape',
  'saturation.softClipper',
  'stereo.imager',
  'spectral.airBand',
];

const insertCatalog = ref<string[]>([]);

function refreshInsertCatalog(): void {
  try {
    const wasm = getWasmModule() as unknown as { masteringInsertNames?: () => string[] };
    const names =
      typeof wasm.masteringInsertNames === 'function' ? wasm.masteringInsertNames() : [];
    insertCatalog.value = names.length > 0 ? names : [...FALLBACK_INSERT_CHOICES];
  } catch {
    insertCatalog.value = [...FALLBACK_INSERT_CHOICES];
  }
}

watch(
  activeTrack,
  (track) => {
    if (track) refreshInsertCatalog();
  },
  { immediate: true },
);

/** Sentinel value for the disabled "+ Add insert…" placeholder option. */
const ADD_INSERT_PLACEHOLDER = '';

/** Always holds the placeholder so the picker re-fires for repeated adds. */
const addInsertValue = ref(ADD_INSERT_PLACEHOLDER);

/** Add-insert picker options: placeholder prompt plus the runtime catalog. */
const addInsertOptions = computed<{ value: string; label: string; disabled?: boolean }[]>(() => [
  { value: ADD_INSERT_PLACEHOLDER, label: t.value.shell.devicesPanel.addInsert, disabled: true },
  ...insertCatalog.value.map((name) => ({
    value: name,
    label: `${insertLabel(name)} (${insertCategory(name) || name})`,
  })),
]);

function onAddInsert(processor: string): void {
  addInsertValue.value = ADD_INSERT_PLACEHOLDER;
  const track = activeTrack.value;
  if (!track || processor.length === 0) return;
  run(() => {
    const index = addInsert(track.id, processor);
    selectedDevice.value = index;
  });
}

function onToggleInsert(index: number): void {
  const track = activeTrack.value;
  const slot = inserts.value[index];
  if (!track || !slot) return;
  run(() => setInsertEnabled(track.id, index, !slot.enabled));
}

function onRemoveInsert(index: number): void {
  const track = activeTrack.value;
  if (!track) return;
  run(() => {
    removeInsert(track.id, index);
    if (selectedDevice.value === index) selectedDevice.value = 'instrument';
    else if (typeof selectedDevice.value === 'number' && selectedDevice.value > index) {
      selectedDevice.value -= 1;
    }
  });
}

function selectInsert(index: number): void {
  selectedDevice.value = index;
}

function displayInstrumentKind(): string {
  const current = instrument.value;
  if (current?.kind === 'synth-preset') return t.value.shell.devicesPanel.kindPreset;
  if (current?.kind === 'synth-patch') return t.value.shell.devicesPanel.kindPatch;
  if (current?.kind === 'sf2') return t.value.shell.devicesPanel.kindSf2;
  if (current?.kind === 'external-midi') return t.value.shell.devicesPanel.kindExternalMidi;
  return '';
}
</script>

<template>
  <section class="device-rack" :aria-label="t.shell.devicesPanel.rackLabel">
    <header class="rack-header">
      <h3 class="rack-title">{{ t.shell.devicesPanel.title }}</h3>
      <span class="rack-track">{{ activeTrack?.name ?? t.shell.devicesPanel.noTrack }}</span>
    </header>
    <p v-if="error" class="rack-error" role="alert">{{ error }}</p>

    <EmptyState v-if="!activeTrack" variant="inline" :message="t.shell.devicesPanel.empty" />
    <template v-else>
      <div v-if="instrument" ref="pickerRoot" class="instrument-slot">
        <button
          type="button"
          class="instrument-button"
          :class="{ selected: selectedDevice === 'instrument' }"
          v-tooltip="t.shell.devicesPanel.changeInstrument"
          aria-haspopup="dialog"
          :aria-expanded="pickerOpen"
          @click="onInstrumentClick"
        >
          <span class="instrument-kind">{{ displayInstrumentKind() }}</span>
          <span class="instrument-name">{{ instrumentCaption }}</span>
          <span class="instrument-caret" aria-hidden="true">▾</span>
        </button>
        <p v-if="transportPlaying" class="instrument-gate-hint">
          {{ t.shell.devicesPanel.instrumentGateHint }}
        </p>

        <Transition name="pop">
        <div
          v-if="pickerOpen"
          class="instrument-picker"
          role="dialog"
          :aria-label="t.shell.devicesPanel.instrumentPicker"
        >
          <div class="picker-tabs" role="tablist">
            <button
              type="button"
              class="picker-tab"
              role="tab"
              :aria-selected="pickerTab === 'presets'"
              :class="{ active: pickerTab === 'presets' }"
              @click="openTab('presets')"
            >
              {{ t.shell.devicesPanel.presets }}
            </button>
            <button
              type="button"
              class="picker-tab"
              role="tab"
              :aria-selected="pickerTab === 'sf2'"
              :class="{ active: pickerTab === 'sf2' }"
              @click="openTab('sf2')"
            >
              {{ t.shell.devicesPanel.sf2 }}
            </button>
            <button
              type="button"
              class="picker-tab"
              role="tab"
              :aria-selected="pickerTab === 'patch'"
              :class="{ active: pickerTab === 'patch' }"
              @click="openTab('patch')"
            >
              {{ t.shell.devicesPanel.patch }}
            </button>
            <button
              type="button"
              class="picker-tab"
              role="tab"
              :aria-selected="pickerTab === 'external'"
              :class="{ active: pickerTab === 'external' }"
              @click="openTab('external')"
            >
              {{ t.shell.devicesPanel.externalMidi }}
            </button>
          </div>

          <div v-if="pickerTab === 'presets'" class="picker-body">
            <SearchField
              v-model="presetQuery"
              class="preset-search"
              size="sm"
              :placeholder="t.shell.devicesPanel.searchPresets"
              :aria-label="t.shell.devicesPanel.searchPresets"
            />
            <EmptyState
              v-if="filteredPresets.length === 0"
              variant="inline"
              :message="t.shell.devicesPanel.noMatchingPresets"
            />
            <ul v-else class="preset-list" role="listbox" :aria-label="t.shell.devicesPanel.synthPresets">
              <li v-for="preset in filteredPresets" :key="preset">
                <button
                  type="button"
                  class="preset-option"
                  role="option"
                  :aria-selected="
                    instrument.kind === 'synth-preset' && instrument.preset === preset
                  "
                  @click="choosePreset(preset)"
                >
                  {{ preset }}
                </button>
              </li>
            </ul>
          </div>

          <div v-else-if="pickerTab === 'sf2'" class="picker-body">
            <EmptyState
              v-if="fontsLoading"
              variant="inline"
              :message="t.shell.devicesPanel.loadingFonts"
            />
            <EmptyState
              v-else-if="fonts.length === 0"
              variant="inline"
              :message="t.shell.devicesPanel.noStoredSoundFonts"
            />
            <ul
              v-else
              class="font-list"
              role="listbox"
              :aria-label="t.shell.devicesPanel.storedSoundFonts"
            >
              <li v-for="font in fonts" :key="font.id">
                <button
                  type="button"
                  class="font-option"
                  role="option"
                  :aria-selected="sf2Selection.fontId === font.id"
                  :class="{ selected: sf2Selection.fontId === font.id }"
                  @click="selectFont(font.id)"
                >
                  {{ font.name }}
                </button>
              </li>
            </ul>
            <div class="sf2-numbers">
              <label class="sf2-field">
                <span>{{ t.shell.devicesPanel.bank }}</span>
                <input
                  class="sf2-bank"
                  type="number"
                  min="0"
                  max="16383"
                  :value="sf2Selection.bank"
                  @input="onBankInput"
                />
              </label>
              <label class="sf2-field">
                <span>{{ t.shell.devicesPanel.program }}</span>
                <input
                  class="sf2-program"
                  type="number"
                  min="0"
                  max="127"
                  :value="sf2Selection.program"
                  @input="onProgramInput"
                />
              </label>
              <label class="sf2-field">
                <span>{{ t.shell.devicesPanel.gain }}</span>
                <input
                  class="sf2-gain"
                  type="number"
                  min="0"
                  :max="MAX_SF2_GAIN"
                  step="0.1"
                  :value="sf2Selection.gain"
                  @input="onGainInput"
                />
              </label>
              <label class="sf2-field">
                <span>{{ t.shell.devicesPanel.polyphony }}</span>
                <input
                  class="sf2-polyphony"
                  type="number"
                  :min="MIN_SF2_POLYPHONY"
                  :max="MAX_SF2_POLYPHONY"
                  step="1"
                  :value="sf2Selection.polyphony"
                  @input="onPolyphonyInput"
                />
              </label>
            </div>
            <div class="sf2-actions">
              <label class="load-sf2">
                {{ t.shell.devicesPanel.loadSf2 }}
                <input
                  ref="sf2FileInput"
                  class="load-sf2-input"
                  type="file"
                  accept=".sf2"
                  @change="onSf2FileChange"
                />
              </label>
              <button
                type="button"
                class="use-sf2 primary"
                :disabled="sf2Selection.fontId === null"
                @click="useSf2"
              >
                {{ t.shell.devicesPanel.useSoundFont }}
              </button>
            </div>
          </div>

          <div v-else-if="pickerTab === 'patch'" class="picker-body">
            <p class="patch-summary">{{ patchSummary }}</p>
            <button type="button" class="edit-patch primary" @click="openPatchEditor">
              {{ t.shell.devicesPanel.editPatch }}
            </button>
          </div>

          <div v-else class="picker-body">
            <EmptyState
              v-if="webMidiOutputs.available.value === false"
              variant="inline"
              :message="t.shell.devicesPanel.midiUnavailable"
            />
            <template v-else>
              <label class="external-field">
                <span>{{ t.shell.devicesPanel.externalMidiPort }}</span>
                <SelectMenu
                  :model-value="externalSelection.outputPortId"
                  :options="externalPortOptions"
                  size="sm"
                  :aria-label="t.shell.devicesPanel.externalMidiOutputs"
                  @update:model-value="onExternalPortChange"
                />
              </label>
              <p v-if="webMidiOutputs.outputs.value.length === 0" class="external-empty">
                {{ t.shell.devicesPanel.noMidiOutputs }}
              </p>
              <label class="external-field">
                <span>{{ t.shell.devicesPanel.channel }}</span>
                <input
                  class="external-channel"
                  type="number"
                  min="1"
                  max="16"
                  :value="externalSelection.channel + 1"
                  @input="onExternalChannelInput"
                />
              </label>
              <label class="external-clock">
                <input
                  type="checkbox"
                  :checked="externalSelection.sendClock"
                  @change="onExternalClockToggle"
                />
                <span>{{ t.shell.devicesPanel.sendClock }}</span>
              </label>
              <p v-if="activeTrackUsesProjectExternal" class="external-status">
                {{ t.shell.devicesPanel.externalMidiUsingProject }}
              </p>
              <p class="external-bounce-hint">{{ t.shell.devicesPanel.externalMidiBounceHint }}</p>
              <div class="external-actions">
                <button
                  type="button"
                  class="save-external-default"
                  :disabled="externalSelection.outputPortId.length === 0"
                  @click="saveProjectExternalMidi"
                >
                  {{ t.shell.devicesPanel.saveExternalMidiDefault }}
                </button>
                <button
                  type="button"
                  class="use-project-external primary"
                  :disabled="externalSelection.outputPortId.length === 0"
                  @click="useProjectExternalMidi"
                >
                  {{ t.shell.devicesPanel.useProjectExternalMidi }}
                </button>
                <button
                  type="button"
                  class="use-project-external-all"
                  :disabled="externalSelection.outputPortId.length === 0"
                  @click="useProjectExternalMidiForAll"
                >
                  {{ t.shell.devicesPanel.useProjectExternalMidiForAll }}
                </button>
                <button
                  type="button"
                  class="use-external"
                  :disabled="externalSelection.outputPortId.length === 0"
                  @click="useExternalMidi"
                >
                  {{ t.shell.devicesPanel.useExternalMidi }}
                </button>
                <button
                  v-if="activeTrack?.externalMidiMode === 'project'"
                  type="button"
                  class="leave-project-external"
                  @click="leaveProjectExternalMidi"
                >
                  {{ t.shell.devicesPanel.leaveProjectExternalMidi }}
                </button>
              </div>
            </template>
          </div>
        </div>
        </Transition>
      </div>

      <DeviceInsertChain
        v-model:add-insert-value="addInsertValue"
        :inserts="inserts"
        :selected-device="selectedDevice"
        :add-insert-options="addInsertOptions"
        @add-insert="onAddInsert"
        @toggle-insert="onToggleInsert"
        @remove-insert="onRemoveInsert"
        @select-insert="selectInsert"
      />

      <div class="rack-quick-controls">
        <h4 class="chain-title">{{ t.shell.devicesPanel.quickControls }}</h4>
        <QuickControls
          v-if="quickControlTarget"
          :key="quickControlKey"
          :target="quickControlTarget"
        />
        <p v-else class="chain-empty">{{ t.shell.devicesPanel.noDeviceSelected }}</p>
      </div>

      <PatchEditor
        :open="patchEditorOpen"
        :track-id="activeTrack.id"
        @close="patchEditorOpen = false"
        @applied="patchEditorOpen = false"
      />
    </template>
  </section>
</template>

<style scoped src="./device-rack.css"></style>
