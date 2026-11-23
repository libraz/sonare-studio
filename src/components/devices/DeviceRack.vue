<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import DeviceInsertChain from '@/components/devices/DeviceInsertChain.vue';
import Sf2ChannelMap from '@/components/devices/Sf2ChannelMap.vue';
import BusyIndicator from '@/components/shell/BusyIndicator.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SearchField from '@/components/shell/SearchField.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { describeError } from '@/lib/errors';
import type { AutomationParam, AutomationTarget } from '@/project/automation';
import {
  addInsert,
  removeInsert,
  reorderInsert,
  setInsertEnabled,
  setTrackInstrument,
} from '@/project/commands';
import { effectiveTrackInstrument } from '@/project/instrument';
import type { QuickControlTarget } from '@/project/quick-controls';
import { getWasmModule, useProjectStore } from '@/project/store';
import { createPatchAudition, type PatchAudition } from '@/ui/devices/audition';
import { instrumentLabel, patchBaseLabel } from '@/ui/devices/device-labels';
import { gm2ProgramName, gmCatalog, gmProgramName } from '@/ui/devices/gm-catalog';
import { patchEditCount } from '@/ui/devices/patch-draft';
import { groupPresets, type PresetCategory } from '@/ui/devices/preset-filter';
import { MAX_SF2_GAIN, MAX_SF2_POLYPHONY, MIN_SF2_POLYPHONY } from '@/ui/devices/sf2-model';
import { useExternalMidiPicker } from '@/ui/devices/use-external-midi-picker';
import { useGmProgramPicker } from '@/ui/devices/use-gm-program-picker';
import { useSoundFontPicker } from '@/ui/devices/use-sound-font-picker';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { AutomationWriteScheduleEvent } from '@/ui/mixer/automation-mode';
import { type InsertProcessorEntry, loadInsertCatalogEntries } from '@/ui/mixer/insert-catalog';
import { restoreUnreadableInput } from '@/ui/numeric-input';
import { formatSize } from '@/ui/shell/format';
import StripAutomationControls from '../mixer/StripAutomationControls.vue';
import AmpSimEditor from './AmpSimEditor.vue';
import PatchEditor from './PatchEditor.vue';
import QuickControls from './QuickControls.vue';

/**
 * Device rack for the active track: the instrument slot (with a picker
 * popover offering synth presets, stored SoundFonts and the patch editor)
 * above the track's insert chain, plus the Quick Controls of the selected
 * device. Self-contained: reads the active track from the store and routes
 * every edit through the undoable command layer.
 */

const props = withDefaults(
  defineProps<{
    /**
     * True while the engine transport plays. Instrument swaps are stop-gated
     * by the engine (they apply when playback stops), so the rack shows a
     * hint instead of pretending the change is instant.
     */
    transportPlaying?: boolean;
    /**
     * Playhead position getter in PPQ, forwarded to Quick Controls so an
     * insert knob can touch-record automation while its strip is in a write
     * mode. Omitted (tests, no transport) disables knob touch recording.
     */
    positionPpq?: () => number;
    /** Current playhead sample position, forwarded for sample-accurate automation scheduling. */
    positionSample?: () => number;
    /** Optional realtime automation scheduler for Quick Controls write drags. */
    scheduleAutomationWrite?: (
      target: AutomationTarget,
      param: AutomationParam,
      event: AutomationWriteScheduleEvent,
    ) => void;
    /**
     * Monotonic request counter from the shell. Incrementing it opens the
     * active MIDI track's instrument picker from outside the rack.
     */
    instrumentPickerRequest?: number;
  }>(),
  { transportPlaying: false, positionSample: undefined, instrumentPickerRequest: 0 },
);

const store = useProjectStore();
const { t } = useI18n();
const normalizeAudition = ref(true);

/** Surfaced when a command or font operation rejects. */
const error = ref('');
let rackAudition: PatchAudition | null = null;
let auditionGeneration = 0;

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

const ampSimInsertIndex = computed(() =>
  inserts.value.findIndex((insert) => insert.processor === 'saturation.ampSim'),
);

const isAudioTrack = computed(() => activeTrack.value?.kind === 'audio');

const activeTrackUsesProjectExternal = computed(
  () => activeTrack.value?.externalMidiMode === 'project' && store.projectExternalMidi !== null,
);

/** Runs an action surfacing thrown errors in the rack banner. */
function run(action: () => void): void {
  try {
    action();
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

function auditionInstrument(): void {
  const current = instrument.value;
  if (!current) return;
  audition(current);
}

/** Plays an instrument candidate without changing the active track. */
function audition(candidate: NonNullable<typeof instrument.value>): void {
  if (!rackAudition) rackAudition = createPatchAudition();
  const generation = ++auditionGeneration;
  rackAudition.play(candidate, undefined, undefined, { normalize: normalizeAudition.value }).then(
    () => {
      if (disposed || generation !== auditionGeneration) return;
      error.value = '';
    },
    (err: unknown) => {
      if (disposed || generation !== auditionGeneration) return;
      error.value = describeError(err, t.value.notices.errors);
    },
  );
}

// --- Instrument label / font name resolution ----------------------------------

let disposed = false;

const instrumentCaption = computed(() => {
  const current = instrument.value;
  if (!current) return '';
  if (current.kind === 'synth-preset' && current.useGmPrograms) {
    const program = current.gmProgram ?? 0;
    const catalog = gmCatalog();
    const bank = gmEffectiveBank(current.gmBank ?? 0);
    const base = gmProgramName(program);
    const variation = bank ? gm2ProgramName(bank, program) : null;
    const name = gmIsDrums.value
      ? catalog?.synthGsDrumKitName?.(program)
      : variation && variation !== base
        ? variation
        : base && bank
          ? `${base} · ${bank}`
          : base;
    return name ? `GM · ${name}` : `GM · ${program + 1}`;
  }
  const fontName = current.kind === 'sf2' ? (fontNames.value[current.fontId] ?? null) : null;
  return instrumentLabel(current, fontName);
});

// --- Device selection (drives the Quick Controls target) -----------------------

/** 'instrument' or the index of the selected insert slot. */
const selectedDevice = ref<'instrument' | number>('instrument');

/** The selected amp slot, when the active device is an AmpSim insert. */
const selectedAmpSimInsertIndex = computed(() => {
  const selected = selectedDevice.value;
  return typeof selected === 'number' && inserts.value[selected]?.processor === 'saturation.ampSim'
    ? selected
    : -1;
});

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

type PickerTab = 'presets' | 'gm' | 'sf2' | 'patch' | 'external';

const pickerOpen = ref(false);
const pickerTab = ref<PickerTab>('presets');
const pickerRoot = ref<HTMLElement | null>(null);

const presetQuery = ref('');
const presetCatalog = ref<string[]>([]);
const presetGroups = computed(() => groupPresets(presetCatalog.value, presetQuery.value));
const filteredPresetCount = computed(() =>
  presetGroups.value.reduce((sum, group) => sum + group.presets.length, 0),
);

const {
  gmProgram,
  gmBank,
  gmIsDrums,
  gmEffectiveBank,
  gmProgramOptions,
  gmUseBlocked,
  gmBankOptions,
  seedGmSelection,
  selectGmProgram,
  useGmInstrument,
} = useGmProgramPicker({ activeTrack, instrument, run, pickerOpen });

function presetCategoryLabel(category: PresetCategory): string {
  return t.value.shell.devicesPanel.presetCategories[category];
}

function refreshPresetCatalog(): void {
  try {
    const wasm: Partial<Pick<typeof import('@libraz/libsonare'), 'synthPresetNames'>> =
      getWasmModule();
    presetCatalog.value =
      typeof wasm.synthPresetNames === 'function' ? wasm.synthPresetNames() : [];
  } catch {
    presetCatalog.value = [];
  }
}

function openInstrumentPicker(): void {
  if (!instrument.value) return;
  selectedDevice.value = 'instrument';
  pickerOpen.value = true;
  refreshPresetCatalog();
  seedGmSelection();
  seedSf2Selection();
  syncExternalSelection();
  if (instrument.value?.kind === 'synth-preset' && instrument.value.useGmPrograms)
    pickerTab.value = 'gm';
  else if (instrument.value?.kind === 'sf2') pickerTab.value = 'sf2';
  else if (instrument.value?.kind === 'synth-patch') pickerTab.value = 'patch';
  else if (instrument.value?.kind === 'external-midi') pickerTab.value = 'external';
  else pickerTab.value = 'presets';
  if (pickerTab.value === 'sf2') void refreshFonts();
  if (pickerTab.value === 'external') void webMidiOutputs.refresh();
}

function onInstrumentClick(): void {
  if (pickerOpen.value) {
    pickerOpen.value = false;
    return;
  }
  openInstrumentPicker();
}

watch(
  () => props.instrumentPickerRequest,
  (request, previous) => {
    if (request > previous) openInstrumentPicker();
  },
);

function openTab(tab: PickerTab): void {
  pickerTab.value = tab;
  if (tab === 'sf2') void refreshFonts();
  if (tab === 'external') void webMidiOutputs.refresh();
}

/** Closes the picker when the pointer goes down outside of it. */
useOutsidePointerDown(
  pickerOpen,
  (target) => !!pickerRoot.value?.contains(target),
  () => {
    pickerOpen.value = false;
  },
);

onBeforeUnmount(() => {
  disposed = true;
  auditionGeneration++;
  rackAudition?.dispose();
  rackAudition = null;
});

function choosePreset(preset: string): void {
  const track = activeTrack.value;
  if (!track) return;
  run(() => setTrackInstrument(track.id, { kind: 'synth-preset', preset }));
  pickerOpen.value = false;
}

// --- SF2 tab ---------------------------------------------------------------------

// --- External MIDI tab -------------------------------------------------------------

// --- SF2 tab ---------------------------------------------------------------------

const {
  fonts,
  fontsLoading,
  sf2Selection,
  sf2MultiTimbral,
  fontNames,
  sf2ManifestProbe,
  sf2ManifestPresets,
  refreshFonts,
  selectFont,
  fontRemoveBlocked,
  useSf2Blocked,
  removeFont,
  onBankInput,
  onProgramInput,
  selectSf2Program,
  setMultiTimbral,
  onChannelMapUpdate,
  onGainInput,
  onPolyphonyInput,
  onPreferModelInput,
  onSf2EfxRealizationInput,
  useSf2,
  soundFontSlotWarning,
  selectedGmFamily,
  gmFamilyOptions,
  onGmFamilyChange,
  sf2ProgramName,
  sf2ProgramOptions,
  selectSf2ManifestPreset,
  onSf2FileChange,
  seedSf2Selection,
} = useSoundFontPicker({ activeTrack, instrument, run, error, pickerOpen, pickerTab, audition });

// --- External MIDI tab -------------------------------------------------------------

const {
  webMidiOutputs,
  externalSelection,
  externalBlocked,
  externalPortOptions,
  syncExternalSelection,
  onExternalPortChange,
  onExternalChannelInput,
  onExternalClockToggle,
  useExternalMidi,
  saveProjectExternalMidi,
  useProjectExternalMidi,
  useProjectExternalMidiForAll,
  leaveProjectExternalMidi,
} = useExternalMidiPicker({ activeTrack, run, pickerOpen });

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

const insertCatalog = ref<InsertProcessorEntry[]>([]);

function refreshInsertCatalog(): void {
  insertCatalog.value = loadInsertCatalogEntries('realtime');
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
  ...insertCatalog.value.map((entry) => ({
    value: entry.id,
    label: `${entry.label} (${entry.id.includes('.') ? entry.id.slice(0, entry.id.indexOf('.')) : entry.id})`,
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

/** Opens the existing amp or adds a clean amp to an audio/DI track. */
function openOrAddGuitarAmp(): void {
  const track = activeTrack.value;
  if (track?.kind !== 'audio') return;
  if (ampSimInsertIndex.value >= 0) {
    selectedDevice.value = ampSimInsertIndex.value;
    return;
  }
  run(() => {
    const index = addInsert(track.id, 'saturation.ampSim', { presetIndex: 0 });
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

/**
 * Reorders an insert and keeps the selection on the same slot by remapping the
 * selected index the same way the moved slot shifts the rows it crosses.
 */
function onMoveInsert(from: number, to: number): void {
  const track = activeTrack.value;
  if (!track || from === to) return;
  run(() => {
    reorderInsert(track.id, from, to);
    const selected = selectedDevice.value;
    if (typeof selected !== 'number') return;
    if (selected === from) selectedDevice.value = to;
    else if (from < to && selected > from && selected <= to) selectedDevice.value = selected - 1;
    else if (from > to && selected >= to && selected < from) selectedDevice.value = selected + 1;
  });
}

function displayInstrumentKind(): string {
  const current = instrument.value;
  if (current?.kind === 'synth-preset' && current.useGmPrograms)
    return t.value.shell.devicesPanel.gm;
  if (current?.kind === 'synth-preset') return t.value.shell.devicesPanel.kindPreset;
  if (current?.kind === 'synth-patch') return t.value.shell.devicesPanel.kindPatch;
  if (current?.kind === 'sf2') return t.value.shell.devicesPanel.kindSf2;
  if (current?.kind === 'external-midi') return t.value.shell.devicesPanel.kindExternalMidi;
  return '';
}

const instrumentSourceCaption = computed(() => {
  const current = instrument.value;
  if (current?.kind === 'sf2') return t.value.shell.devicesPanel.sourceSf2;
  if (current?.kind === 'external-midi') return t.value.shell.devicesPanel.sourceExternalMidi;
  if (current?.kind === 'synth-patch') return t.value.shell.devicesPanel.sourceBuiltinPatch;
  if (current?.kind === 'synth-preset' && current.useGmPrograms)
    return t.value.shell.devicesPanel.sourceGm;
  if (current?.kind === 'synth-preset') return t.value.shell.devicesPanel.sourceBuiltinPreset;
  return '';
});
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
        <div class="instrument-meta">
          <p class="instrument-source">{{ instrumentSourceCaption }}</p>
          <button
            type="button"
            class="instrument-audition"
            v-tooltip="t.shell.devicesPanel.auditionTitle"
            @click="auditionInstrument"
          >
            {{ t.shell.patchEditor.audition }}
          </button>
          <label class="audition-normalize" v-tooltip="t.shell.devicesPanel.normalizeAuditionHint">
            <input v-model="normalizeAudition" type="checkbox" />
            {{ t.shell.devicesPanel.normalizeAudition }}
          </label>
        </div>

        <Transition name="pop">
        <div
          v-if="pickerOpen"
          class="instrument-picker"
          role="dialog"
          :aria-label="t.shell.devicesPanel.instrumentPicker"
        >
          <div v-tablist class="picker-tabs" role="tablist">
            <button
              type="button"
              class="picker-tab"
              role="tab"
              :aria-selected="pickerTab === 'presets'"
              :class="{ active: pickerTab === 'presets' }"
              v-tooltip="t.shell.devicesPanel.sourceBuiltinPreset"
              @click="openTab('presets')"
            >
              {{ t.shell.devicesPanel.presets }}
            </button>
            <button
              type="button"
              class="picker-tab"
              role="tab"
              :aria-selected="pickerTab === 'gm'"
              :class="{ active: pickerTab === 'gm' }"
              v-tooltip="t.shell.devicesPanel.sourceGm"
              @click="openTab('gm')"
            >
              {{ t.shell.devicesPanel.gm }}
            </button>
            <button
              type="button"
              class="picker-tab"
              role="tab"
              :aria-selected="pickerTab === 'sf2'"
              :class="{ active: pickerTab === 'sf2' }"
              v-tooltip="t.shell.devicesPanel.sourceSf2"
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
              v-tooltip="t.shell.devicesPanel.sourceBuiltinPatch"
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
              v-tooltip="t.shell.devicesPanel.sourceExternalMidi"
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
              v-if="filteredPresetCount === 0"
              variant="inline"
              :message="t.shell.devicesPanel.noMatchingPresets"
            />
            <div v-else class="preset-groups" role="listbox" :aria-label="t.shell.devicesPanel.synthPresets">
              <section v-for="group in presetGroups" :key="group.category" class="preset-group">
                <h4 class="preset-group-title">{{ presetCategoryLabel(group.category) }}</h4>
                <ul class="preset-list">
                  <li v-for="preset in group.presets" :key="preset">
                    <button
                      type="button"
                      class="preset-option"
                      role="option"
                      :aria-selected="
                        instrument.kind === 'synth-preset' && instrument.preset === preset
                      "
                      @click="choosePreset(preset)"
                    >
                      <span class="preset-name">{{ preset }}</span>
                      <span class="preset-source">{{ t.shell.devicesPanel.builtinFallback }}</span>
                    </button>
                  </li>
                </ul>
              </section>
            </div>
          </div>

          <div v-else-if="pickerTab === 'gm'" class="picker-body gm-picker">
            <p class="gm-hint">{{ t.shell.devicesPanel.gmHint }}</p>
            <label class="gm-field">
              <span>{{ gmIsDrums ? t.shell.devicesPanel.drumKit : t.shell.devicesPanel.program }}</span>
              <SelectMenu
                :model-value="gmProgram"
                :options="gmProgramOptions"
                size="sm"
                :aria-label="gmIsDrums ? t.shell.devicesPanel.drumKit : t.shell.devicesPanel.program"
                @update:model-value="selectGmProgram"
              />
            </label>
            <label v-if="!gmIsDrums && gmBankOptions.length > 1" class="gm-field">
              <span>{{ t.shell.devicesPanel.gmVariation }}</span>
              <SelectMenu
                v-model="gmBank"
                :options="gmBankOptions"
                size="sm"
                :aria-label="t.shell.devicesPanel.gmVariation"
              />
            </label>
            <button
              type="button"
              class="gm-use primary"
              :disabled="!!gmUseBlocked"
              v-tooltip="{ reason: gmUseBlocked }"
              @click="useGmInstrument"
            >
              {{ t.shell.devicesPanel.useGm }}
            </button>
          </div>

          <div v-else-if="pickerTab === 'sf2'" class="picker-body">
            <BusyIndicator
              v-if="fontsLoading"
              class="fonts-loading"
              :label="t.shell.devicesPanel.loadingFonts"
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
                <span class="font-size">{{ formatSize(font.byteLength) }}</span>
                <button
                  type="button"
                  class="font-remove"
                  :disabled="!!fontRemoveBlocked(font.id)"
                  v-tooltip="{
                    text: formatMessage(t.shell.devicesPanel.removeFont, { name: font.name }),
                    reason: fontRemoveBlocked(font.id),
                  }"
                  :aria-label="formatMessage(t.shell.devicesPanel.removeFont, { name: font.name })"
                  @click="removeFont(font.id)"
                >
                  ×
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
                  @change="restoreUnreadableInput($event, sf2Selection.bank)"
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
                  @change="restoreUnreadableInput($event, sf2Selection.program)"
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
                  @change="restoreUnreadableInput($event, sf2Selection.gain)"
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
                  @change="restoreUnreadableInput($event, sf2Selection.polyphony)"
                />
              </label>
              <label class="sf2-field sf2-field-check">
                <input
                  class="sf2-prefer-model"
                  type="checkbox"
                  :checked="sf2Selection.preferModel"
                  @change="onPreferModelInput"
                />
                <span>{{ t.shell.devicesPanel.preferModel }}</span>
              </label>
            </div>
            <p class="sf2-prefer-model-hint">{{ t.shell.devicesPanel.preferModelHint }}</p>
            <div class="sf2-efx-field">
              <label for="sf2-efx-realization">{{ t.shell.devicesPanel.gsEfxRealization }}</label>
              <select
                id="sf2-efx-realization"
                class="sf2-efx-realization"
                :value="sf2Selection.gsEfxRealization"
                :aria-label="t.shell.devicesPanel.gsEfxRealization"
                @change="onSf2EfxRealizationInput"
              >
                <option value="modern">{{ t.shell.devicesPanel.gsEfxModern }}</option>
                <option value="classic">{{ t.shell.devicesPanel.gsEfxClassic }}</option>
              </select>
              <p class="sf2-efx-hint">{{ t.shell.devicesPanel.gsEfxRealizationHint }}</p>
            </div>
            <div class="sf2-program-browser">
              <p v-if="soundFontSlotWarning" class="sf2-slot-warning" role="alert">
                {{ soundFontSlotWarning }}
              </p>
              <div class="sf2-current-program">
                <span class="sf2-current-label">{{ t.shell.devicesPanel.selectedProgram }}</span>
                <strong>{{ sf2Selection.program }} · {{ sf2ProgramName }}</strong>
              </div>
              <BusyIndicator
                v-if="sf2ManifestProbe.state === 'loading'"
                class="sf2-manifest-status loading"
                :label="sf2ManifestProbe.text"
              />
              <p
                v-else-if="sf2ManifestProbe.text"
                class="sf2-manifest-status"
                :class="sf2ManifestProbe.state"
              >
                {{ sf2ManifestProbe.text }}
              </p>
              <div v-if="sf2ManifestPresets.length > 0" class="sf2-manifest-browser">
                <span class="sf2-current-label">{{ t.shell.devicesPanel.soundFontPresets }}</span>
                <div
                  class="sf2-manifest-grid"
                  role="listbox"
                  :aria-label="t.shell.devicesPanel.soundFontPresets"
                >
                  <button
                    v-for="preset in sf2ManifestPresets"
                    :key="`${preset.bank}:${preset.program}`"
                    type="button"
                    class="sf2-manifest-option"
                    :class="{
                      selected:
                        sf2Selection.bank === preset.bank && sf2Selection.program === preset.program,
                    }"
                    role="option"
                    :aria-selected="
                      sf2Selection.bank === preset.bank && sf2Selection.program === preset.program
                    "
                    @click="selectSf2ManifestPreset(preset)"
                  >
                    <span class="sf2-program-name">{{ preset.name }}</span>
                    <span class="sf2-program-number">{{ preset.bank }}:{{ preset.program }}</span>
                  </button>
                </div>
              </div>
              <label v-if="gmFamilyOptions.length > 0" class="sf2-family">
                <span>{{ t.shell.devicesPanel.programFamily }}</span>
                <SelectMenu
                  :model-value="String(selectedGmFamily)"
                  :options="gmFamilyOptions"
                  size="sm"
                  :aria-label="t.shell.devicesPanel.programFamily"
                  @update:model-value="onGmFamilyChange"
                />
              </label>
              <div class="sf2-program-grid" role="listbox" :aria-label="t.shell.devicesPanel.program">
                <button
                  v-for="option in sf2ProgramOptions"
                  :key="option.program"
                  type="button"
                  class="sf2-program-option"
                  :class="{ selected: sf2Selection.program === option.program }"
                  role="option"
                  :aria-selected="sf2Selection.program === option.program"
                  @click="selectSf2Program(option.program)"
                >
                  <span class="sf2-program-number">{{ option.program }}</span>
                  <span class="sf2-program-name">{{ option.gm2Name ?? option.gmName }}</span>
                </button>
              </div>
            </div>
            <div class="sf2-multitimbral">
              <label class="sf2-multitimbral-toggle">
                <input
                  type="checkbox"
                  :checked="sf2MultiTimbral"
                  @change="setMultiTimbral(($event.target as HTMLInputElement).checked)"
                />
                <span class="sf2-multitimbral-label">{{ t.shell.devicesPanel.multiTimbral }}</span>
                <span class="sf2-multitimbral-hint">{{
                  t.shell.devicesPanel.multiTimbralHint
                }}</span>
              </label>
              <Sf2ChannelMap
                v-if="sf2MultiTimbral"
                :model-value="sf2Selection.channelMap"
                :default-bank="sf2Selection.bank"
                @update:model-value="onChannelMapUpdate"
              />
            </div>
            <div class="sf2-actions">
              <label class="load-sf2">
                {{ t.shell.devicesPanel.loadSf2 }}
                <input
                  class="load-sf2-input"
                  type="file"
                  accept=".sf2"
                  @change="onSf2FileChange"
                />
              </label>
              <button
                type="button"
                class="use-sf2 primary"
                :disabled="!!useSf2Blocked"
                v-tooltip="{ reason: useSf2Blocked }"
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
                  @change="restoreUnreadableInput($event, externalSelection.channel + 1)"
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
                  :disabled="!!externalBlocked"
                  v-tooltip="{ reason: externalBlocked }"
                  @click="saveProjectExternalMidi"
                >
                  {{ t.shell.devicesPanel.saveExternalMidiDefault }}
                </button>
                <button
                  type="button"
                  class="use-project-external primary"
                  :disabled="!!externalBlocked"
                  v-tooltip="{ reason: externalBlocked }"
                  @click="useProjectExternalMidi"
                >
                  {{ t.shell.devicesPanel.useProjectExternalMidi }}
                </button>
                <button
                  type="button"
                  class="use-project-external-all"
                  :disabled="!!externalBlocked"
                  v-tooltip="{ reason: externalBlocked }"
                  @click="useProjectExternalMidiForAll"
                >
                  {{ t.shell.devicesPanel.useProjectExternalMidiForAll }}
                </button>
                <button
                  type="button"
                  class="use-external"
                  :disabled="!!externalBlocked"
                  v-tooltip="{ reason: externalBlocked }"
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

      <section v-if="isAudioTrack" class="guitar-amp-entry" :aria-label="t.shell.devicesPanel.guitarAmpTitle">
        <div class="guitar-amp-copy">
          <h4>{{ t.shell.devicesPanel.guitarAmpTitle }}</h4>
          <p>{{ t.shell.devicesPanel.guitarAmpHint }}</p>
        </div>
        <button type="button" class="guitar-amp-action" @click="openOrAddGuitarAmp">
          {{
            ampSimInsertIndex >= 0
              ? t.shell.devicesPanel.openGuitarAmp
              : t.shell.devicesPanel.addGuitarAmp
          }}
        </button>
      </section>

      <DeviceInsertChain
        v-model:add-insert-value="addInsertValue"
        :inserts="inserts"
        :selected-device="selectedDevice"
        :add-insert-options="addInsertOptions"
        @add-insert="onAddInsert"
        @toggle-insert="onToggleInsert"
        @remove-insert="onRemoveInsert"
        @select-insert="selectInsert"
        @move-insert="onMoveInsert"
      />

      <AmpSimEditor
        v-if="isAudioTrack && selectedAmpSimInsertIndex >= 0"
        :track-id="activeTrack.id"
        :insert-index="selectedAmpSimInsertIndex"
        :position-ppq="positionPpq"
        :position-sample="positionSample"
        :is-playing="transportPlaying"
        :schedule-automation-write="scheduleAutomationWrite"
      />

      <div class="rack-quick-controls">
        <div class="rack-quick-controls-header">
          <h4 class="chain-title">{{ t.shell.devicesPanel.quickControls }}</h4>
          <StripAutomationControls
            v-if="activeTrack && activeTrack.kind !== 'group' && quickControlTarget"
            :target="activeTrack.id"
            :name="activeTrack.name"
          />
        </div>
        <QuickControls
          v-if="quickControlTarget"
          :key="quickControlKey"
          :target="quickControlTarget"
          :position-ppq="positionPpq"
          :position-sample="positionSample"
          :is-playing="transportPlaying"
          :schedule-automation-write="scheduleAutomationWrite"
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
<style scoped src="./device-chain.css"></style>
