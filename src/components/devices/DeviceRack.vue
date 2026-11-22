<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import DeviceInsertChain from '@/components/devices/DeviceInsertChain.vue';
import Sf2ChannelMap from '@/components/devices/Sf2ChannelMap.vue';
import BusyIndicator from '@/components/shell/BusyIndicator.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SearchField from '@/components/shell/SearchField.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { useWebMidiOutputs } from '@/composables/useWebMidiOutputs';
import { describeError } from '@/lib/errors';
import { deleteSoundFontIfUnreferenced } from '@/persistence/gc';
import { readFileBytesBounded } from '@/persistence/local-file';
import { MAX_SOUNDFONT_FILE_BYTES } from '@/persistence/resource-limits';
import type { AutomationParam, AutomationTarget } from '@/project/automation';
import {
  addInsert,
  removeInsert,
  reorderInsert,
  setInsertEnabled,
  setProjectExternalMidiDefault,
  setProjectExternalMidiDefaultForTracks,
  setTrackExternalMidiMode,
  setTrackInstrument,
} from '@/project/commands';
import { listFonts, loadFontMeta, type SoundFontMeta, saveFont } from '@/project/fonts';
import {
  DEFAULT_SYNTH_PRESET,
  type ExternalMidiInstrument,
  effectiveTrackInstrument,
  GM2_DRUM_BANK,
  gmProgramForPreset,
  type Sf2ChannelProgram,
} from '@/project/instrument';
import type { QuickControlTarget } from '@/project/quick-controls';
import {
  collectActiveSoundFontUsage,
  hasSoundFontSlotConflict,
} from '@/project/soundfont-conflicts';
import { getWasmModule, useProjectStore } from '@/project/store';
import { createPatchAudition, type PatchAudition } from '@/ui/devices/audition';
import { instrumentLabel, patchBaseLabel } from '@/ui/devices/device-labels';
import {
  gm2ProgramName,
  gmCatalog,
  gmFamilies,
  gmProgramName,
  trackIsDrums,
} from '@/ui/devices/gm-catalog';
import { patchEditCount } from '@/ui/devices/patch-draft';
import { groupPresets, type PresetCategory } from '@/ui/devices/preset-filter';
import {
  buildSf2Instrument,
  clampBank,
  clampChannel,
  clampGain,
  clampPolyphony,
  clampProgram,
  createSf2Selection,
  MAX_SF2_GAIN,
  MAX_SF2_POLYPHONY,
  MIN_SF2_POLYPHONY,
} from '@/ui/devices/sf2-model';
import {
  type Sf2ManifestPreset,
  useSoundFontManifestProbe,
} from '@/ui/devices/use-sound-font-manifest-probe';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { AutomationWriteScheduleEvent } from '@/ui/mixer/automation-mode';
import { type InsertProcessorEntry, loadInsertCatalogEntries } from '@/ui/mixer/insert-catalog';
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

/** Cached display names of stored fonts, by font id. */
const fontNames = ref<Record<string, string>>({});
let disposed = false;

watch(
  instrument,
  (current) => {
    if (current?.kind !== 'sf2') return;
    const fontId = current.fontId;
    if (fontNames.value[fontId] !== undefined) return;
    loadFontMeta(fontId)
      .then((meta) => {
        if (disposed) return;
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

const gmProgram = ref(0);
const gmBank = ref(0);
const gmIsDrums = computed(() => {
  const track = activeTrack.value;
  return trackIsDrums(track, () =>
    track ? (store.clipsByTrack.get(track.id) ?? []).flatMap((clip) => clip.notes) : [],
  );
});

/** NativeSynth reads GS variations from CC0, or GM2 variations from CC32 with MSB 121. */
function gmEffectiveBank(bank: number): number {
  const msb = bank >> 7;
  return msb === 121 ? bank & 0x7f : msb;
}

function gmVariationLabel(bank: number, program: number): string {
  const name = gm2ProgramName(bank, program);
  const base = gmProgramName(program);
  return name && name !== base ? `${bank} · ${name}` : String(bank);
}
const gmProgramOptions = computed(() => {
  const catalog = gmCatalog();
  return Array.from({ length: 128 }, (_, program) => {
    const name = gmIsDrums.value ? catalog?.synthGsDrumKitName?.(program) : gmProgramName(program);
    if (name === null || name === undefined) return null;
    const sameAsStandard =
      gmIsDrums.value && program !== 0
        ? catalog?.synthGsDrumKitIsVoicedApart?.(program) === false
        : false;
    const option: { value: number; label: string; disabled: boolean; detail?: string } = {
      value: program,
      label: `${String(program + 1).padStart(3, '0')} · ${name}`,
      disabled: sameAsStandard,
    };
    if (sameAsStandard) option.detail = t.value.shell.devicesPanel.reasons.kitSameAsStandard;
    return option;
  }).filter(
    (option): option is { value: number; label: string; disabled: boolean; detail?: string } =>
      option !== null,
  );
});

const gmUseBlocked = computed(() =>
  firstBlock([gmProgramOptions.value.length === 0, t.value.shell.devicesPanel.reasons.noGmCatalog]),
);
const gmBankOptions = computed(() => {
  const catalog = gmCatalog();
  const options: { value: number; label: string }[] = [
    { value: 0, label: t.value.shell.devicesPanel.gmStandard },
  ];
  if (gmIsDrums.value) return options;
  if (catalog?.synthGsVariationIsVoicedApart) {
    for (let bank = 1; bank < 128; bank++) {
      if (catalog.synthGsVariationIsVoicedApart(bank, gmProgram.value) !== true) continue;
      options.push({ value: bank << 7, label: gmVariationLabel(bank, gmProgram.value) });
    }
  }
  // Keep an imported GM2 or GS bank selectable without rewriting its original CC bytes.
  const current = instrument.value;
  if (current?.kind === 'synth-preset' && current.useGmPrograms && current.gmBank) {
    const bank = gmEffectiveBank(current.gmBank);
    if (!options.some((option) => option.value === current.gmBank)) {
      options.push({ value: current.gmBank, label: gmVariationLabel(bank, gmProgram.value) });
    }
  }
  return options;
});

function seedGmSelection(): void {
  const current = instrument.value;
  gmBank.value =
    current?.kind === 'synth-preset' && current.useGmPrograms ? (current.gmBank ?? 0) : 0;
  if (current?.kind === 'synth-preset' && current.useGmPrograms) {
    gmProgram.value = current.gmProgram ?? 0;
  } else if (current?.kind === 'synth-preset') {
    gmProgram.value = gmIsDrums.value ? 0 : gmProgramForPreset(current.preset);
  } else {
    gmProgram.value = 0;
  }
  if (!gmBankOptions.value.some((option) => option.value === gmBank.value)) gmBank.value = 0;
}

function selectGmProgram(program: number): void {
  gmProgram.value = program;
  if (!gmBankOptions.value.some((option) => option.value === gmBank.value)) gmBank.value = 0;
}

function useGmInstrument(): void {
  const track = activeTrack.value;
  if (!track) return;
  const current = instrument.value;
  const preset = current?.kind === 'synth-preset' ? current.preset : DEFAULT_SYNTH_PRESET;
  run(() =>
    setTrackInstrument(track.id, {
      kind: 'synth-preset',
      preset,
      useGmPrograms: true,
      gmBank: gmIsDrums.value ? GM2_DRUM_BANK : gmBank.value,
      gmProgram: gmProgram.value,
    }),
  );
  pickerOpen.value = false;
}

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
  sf2Selection.value = createSf2Selection(instrument.value);
  sf2MultiTimbral.value = sf2Selection.value.channelMap.length > 0;
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

const fonts = ref<SoundFontMeta[]>([]);
const fontsLoading = ref(false);
const sf2Selection = ref(createSf2Selection(null));
// Whether the SF2 tab shows the multi-timbral channel map. Seeded from the
// loaded instrument so a saved channel map reopens expanded.
const sf2MultiTimbral = ref(false);

const { sf2ManifestProbe, sf2ManifestPresets } = useSoundFontManifestProbe({
  pickerOpen,
  pickerTab,
  sf2Selection,
});

async function refreshFonts(): Promise<void> {
  fontsLoading.value = true;
  try {
    fonts.value = await listFonts();
    error.value = '';
  } catch (err) {
    fonts.value = [];
    error.value = describeError(err, t.value.notices.errors);
  } finally {
    fontsLoading.value = false;
  }
}

function selectFont(id: string): void {
  sf2Selection.value = { ...sf2Selection.value, fontId: id };
}

function fontIsReferenced(fontId: string): boolean {
  return store.tracks.some(
    (track) => track.instrument?.kind === 'sf2' && track.instrument.fontId === fontId,
  );
}

/** A SoundFont a track plays from cannot be deleted from storage. */
function fontRemoveBlocked(fontId: string): string | null {
  return firstBlock([fontIsReferenced(fontId), t.value.shell.devicesPanel.reasons.fontInUse]);
}

const useSf2Blocked = computed(() =>
  firstBlock([sf2Selection.value.fontId === null, t.value.shell.devicesPanel.reasons.noFont]),
);

async function removeFont(fontId: string): Promise<void> {
  try {
    const removed = await deleteSoundFontIfUnreferenced(fontId, () => fontIsReferenced(fontId));
    if (!removed) {
      error.value = t.value.shell.devicesPanel.reasons.fontInUse;
      return;
    }
    if (sf2Selection.value.fontId === fontId) {
      sf2Selection.value = { ...sf2Selection.value, fontId: null };
    }
    await refreshFonts();
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

function onBankInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  sf2Selection.value = { ...sf2Selection.value, bank: clampBank(raw) };
}

function onProgramInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  sf2Selection.value = { ...sf2Selection.value, program: clampProgram(raw) };
}

function selectSf2Program(program: number): void {
  sf2Selection.value = { ...sf2Selection.value, program: clampProgram(program) };
  const candidate = buildSf2Instrument(sf2Selection.value);
  if (candidate) audition(candidate);
}

function setMultiTimbral(enabled: boolean): void {
  sf2MultiTimbral.value = enabled;
  // Turning the map off drops every per-channel override so the instrument
  // returns to single-timbral rendering.
  if (!enabled && sf2Selection.value.channelMap.length > 0) {
    sf2Selection.value = { ...sf2Selection.value, channelMap: [] };
  }
}

function onChannelMapUpdate(channelMap: Sf2ChannelProgram[]): void {
  sf2Selection.value = { ...sf2Selection.value, channelMap };
}

function onGainInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  sf2Selection.value = { ...sf2Selection.value, gain: clampGain(raw) };
}

function onPolyphonyInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  sf2Selection.value = { ...sf2Selection.value, polyphony: clampPolyphony(raw) };
}

function onPreferModelInput(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  sf2Selection.value = { ...sf2Selection.value, preferModel: checked };
}

function onSf2EfxRealizationInput(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  sf2Selection.value = {
    ...sf2Selection.value,
    gsEfxRealization: value === 'classic' ? 'classic' : 'modern',
  };
}

function useSf2(): void {
  const track = activeTrack.value;
  const next = buildSf2Instrument(sf2Selection.value);
  if (!track || !next) return;
  run(() => setTrackInstrument(track.id, next));
  pickerOpen.value = false;
}

function soundFontDisplayName(fontId: string): string {
  return fonts.value.find((font) => font.id === fontId)?.name ?? fontNames.value[fontId] ?? fontId;
}

const soundFontSlotWarning = computed(() => {
  const track = activeTrack.value;
  if (!track || pickerTab.value !== 'sf2') return '';
  const selected = buildSf2Instrument(sf2Selection.value);
  const tracks = selected
    ? store.tracks.map((candidate) =>
        candidate.id === track.id ? { ...candidate, instrument: selected } : candidate,
      )
    : store.tracks;
  const usage = collectActiveSoundFontUsage(tracks, (candidate) =>
    effectiveTrackInstrument(candidate, store.projectExternalMidi),
  );
  if (!hasSoundFontSlotConflict(usage) || usage.winningFontId === undefined) return '';
  return formatMessage(t.value.shell.devicesPanel.soundFontSlotWarning, {
    count: String(usage.fontIds.length),
    font: soundFontDisplayName(usage.winningFontId),
  });
});

// --- SF2 GM / GM2 program browser ---------------------------------------------

const gmFamilyList = computed(() => gmFamilies());

const selectedGmFamily = computed(() => Math.floor(sf2Selection.value.program / 8));

const gmFamilyOptions = computed(() =>
  gmFamilyList.value.map((family) => ({
    value: String(family.index),
    label: `${family.index + 1}. ${family.name}`,
  })),
);

function onGmFamilyChange(value: string): void {
  const family = Number(value);
  if (!Number.isInteger(family)) return;
  const firstProgram = gmFamilyList.value.find((entry) => entry.index === family)?.firstProgram;
  if (firstProgram !== undefined) selectSf2Program(firstProgram);
}

function gmInstrumentName(program: number): string {
  return gmProgramName(program) ?? `Program ${program}`;
}

const sf2ProgramName = computed(() => {
  const { bank, program } = sf2Selection.value;
  return gm2ProgramName(bank, program) ?? gmInstrumentName(program);
});

const sf2ProgramOptions = computed(() => {
  const first = selectedGmFamily.value * 8;
  return Array.from({ length: 8 }, (_, offset) => {
    const program = first + offset;
    return {
      program,
      gmName: gmInstrumentName(program),
      gm2Name: gm2ProgramName(sf2Selection.value.bank, program),
    };
  });
});

function selectSf2ManifestPreset(preset: Sf2ManifestPreset): void {
  sf2Selection.value = {
    ...sf2Selection.value,
    bank: preset.bank,
    program: preset.program,
  };
}

async function onSf2FileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const data = await readFileBytesBounded(file, MAX_SOUNDFONT_FILE_BYTES);
    const meta = await saveFont({ name: file.name }, data);
    fontNames.value = { ...fontNames.value, [meta.id]: meta.name };
    await refreshFonts();
    selectFont(meta.id);
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
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

const externalBlocked = computed(() =>
  firstBlock([
    externalSelection.value.outputPortId.length === 0,
    t.value.shell.devicesPanel.reasons.noMidiPort,
  ]),
);

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
  const channel = clampChannel(raw - 1);
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
