<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import DeviceInsertChain from '@/components/devices/DeviceInsertChain.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SearchField from '@/components/shell/SearchField.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useWebMidiOutputs } from '@/composables/useWebMidiOutputs';
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
import { listFonts, loadFont, loadFontMeta, type SoundFontMeta, saveFont } from '@/project/fonts';
import { type ExternalMidiInstrument, effectiveTrackInstrument } from '@/project/instrument';
import type { QuickControlTarget } from '@/project/quick-controls';
import {
  collectActiveSoundFontUsage,
  hasSoundFontSlotConflict,
} from '@/project/soundfont-conflicts';
import { getWasmModule, useProjectStore } from '@/project/store';
import { instrumentLabel, patchBaseLabel } from '@/ui/devices/device-labels';
import { patchEditCount } from '@/ui/devices/patch-draft';
import { groupPresets, type PresetCategory } from '@/ui/devices/preset-filter';
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
import type { AutomationWriteScheduleEvent } from '@/ui/mixer/automation-mode';
import { type InsertProcessorEntry, loadInsertCatalogEntries } from '@/ui/mixer/insert-catalog';
import type { Sf2ProgramStatus } from '@/wasm/index.js';
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
const presetGroups = computed(() => groupPresets(presetCatalog.value, presetQuery.value));
const filteredPresetCount = computed(() =>
  presetGroups.value.reduce((sum, group) => sum + group.presets.length, 0),
);

function presetCategoryLabel(category: PresetCategory): string {
  return t.value.shell.devicesPanel.presetCategories[category];
}

function refreshPresetCatalog(): void {
  try {
    const wasm = getWasmModule() as unknown as { synthPresetNames?: () => string[] };
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
  sf2Selection.value = createSf2Selection(instrument.value);
  syncExternalSelection();
  if (instrument.value?.kind === 'sf2') pickerTab.value = 'sf2';
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
  disposed = true;
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

type Sf2ManifestProbe =
  | { state: 'idle'; text: '' }
  | { state: 'loading'; text: string }
  | { state: 'sf2' | 'synth' | 'empty' | 'error'; text: string };

interface Sf2ManifestPreset {
  bank: number;
  program: number;
  name: string;
}

const sf2ManifestProbe = ref<Sf2ManifestProbe>({ state: 'idle', text: '' });
const sf2ManifestPresets = ref<Sf2ManifestPreset[]>([]);
let sf2ManifestRequest = 0;

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

function selectSf2Program(program: number): void {
  sf2Selection.value = { ...sf2Selection.value, program: clampProgram(program) };
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

function sf2StatusText(status: Sf2ProgramStatus | null): Sf2ManifestProbe {
  if (!status) return { state: 'empty', text: t.value.shell.devicesPanel.soundFontProgramEmpty };
  const template =
    status.backend === 'sf2'
      ? t.value.shell.devicesPanel.soundFontProgramResolved
      : t.value.shell.devicesPanel.soundFontProgramFallback;
  return {
    state: status.backend,
    text: formatMessage(template, {
      name: status.presetName,
      bank: String(status.bank),
      program: String(status.program),
    }),
  };
}

async function refreshSf2ManifestProbe(): Promise<void> {
  const request = ++sf2ManifestRequest;
  const fontId = sf2Selection.value.fontId;
  if (!pickerOpen.value || pickerTab.value !== 'sf2' || fontId === null) {
    sf2ManifestProbe.value = { state: 'idle', text: '' };
    sf2ManifestPresets.value = [];
    return;
  }
  const bank = sf2Selection.value.bank;
  const program = sf2Selection.value.program;
  sf2ManifestProbe.value = {
    state: 'loading',
    text: t.value.shell.devicesPanel.soundFontProgramChecking,
  };
  try {
    const data = await loadFont(fontId);
    const wasm = getWasmModule();
    const project = new wasm.Project();
    try {
      const created = project.addMidiClip(0, 1);
      const events = Array.from({ length: 128 }, (_, candidateProgram) => {
        const tick = candidateProgram * 2;
        return [
          ...wasm.Project.midiBankProgram(
            tick,
            0,
            0,
            (bank >> 7) & 0x7f,
            bank & 0x7f,
            candidateProgram,
          ),
          wasm.Project.midiNoteOn(tick, 0, 0, 60, 96),
          wasm.Project.midiNoteOff(tick + 1, 0, 0, 60, 0),
        ];
      }).flat();
      project.setMidiEvents(created.clipId, events);
      project.loadSoundFont(data);
      const manifest = project.soundFontManifest();
      if (request !== sf2ManifestRequest) return;
      sf2ManifestPresets.value = manifest
        .filter((entry) => entry.channel === 0 && entry.bank === bank && entry.backend === 'sf2')
        .map((entry) => ({ bank: entry.bank, program: entry.program, name: entry.presetName }))
        .sort((a, b) => a.bank - b.bank || a.program - b.program);
      sf2ManifestProbe.value = sf2StatusText(
        manifest.find(
          (entry) => entry.channel === 0 && entry.bank === bank && entry.program === program,
        ) ??
          manifest[0] ??
          null,
      );
    } finally {
      project.delete();
    }
  } catch (err) {
    if (request !== sf2ManifestRequest) return;
    sf2ManifestPresets.value = [];
    const detail = err instanceof Error ? err.message : String(err);
    sf2ManifestProbe.value = {
      state: 'error',
      text: formatMessage(t.value.shell.devicesPanel.soundFontProgramError, { detail }),
    };
  }
}

watch(
  () => [
    pickerOpen.value,
    pickerTab.value,
    sf2Selection.value.fontId,
    sf2Selection.value.bank,
    sf2Selection.value.program,
  ],
  () => {
    void refreshSf2ManifestProbe();
  },
);

// --- SF2 GM / GM2 program browser ---------------------------------------------

interface GmFamilyView {
  index: number;
  name: string;
  firstProgram: number;
}

const gmFamilies = computed<GmFamilyView[]>(() => {
  try {
    const wasm = getWasmModule() as unknown as {
      Project?: {
        gmFamilyName?: (family: number) => string | null;
        gmFamilyFirstProgram?: (family: number) => number;
      };
    };
    const Project = wasm.Project;
    if (
      !Project ||
      typeof Project.gmFamilyName !== 'function' ||
      typeof Project.gmFamilyFirstProgram !== 'function'
    ) {
      return [];
    }
    return Array.from({ length: 16 }, (_, index) => ({
      index,
      name: Project.gmFamilyName?.(index) ?? `Family ${index + 1}`,
      firstProgram: Project.gmFamilyFirstProgram?.(index) ?? index * 8,
    }));
  } catch {
    return [];
  }
});

const selectedGmFamily = computed(() => Math.floor(sf2Selection.value.program / 8));

const gmFamilyOptions = computed(() =>
  gmFamilies.value.map((family) => ({
    value: String(family.index),
    label: `${family.index + 1}. ${family.name}`,
  })),
);

function onGmFamilyChange(value: string): void {
  const family = Number(value);
  if (!Number.isInteger(family)) return;
  const firstProgram = gmFamilies.value.find((entry) => entry.index === family)?.firstProgram;
  if (firstProgram !== undefined) selectSf2Program(firstProgram);
}

function gmInstrumentName(program: number): string {
  try {
    const wasm = getWasmModule() as unknown as {
      Project?: { gmInstrumentName?: (program: number) => string | null };
    };
    return wasm.Project?.gmInstrumentName?.(program) ?? `Program ${program}`;
  } catch {
    return `Program ${program}`;
  }
}

function gm2InstrumentName(bank: number, program: number): string | null {
  try {
    const wasm = getWasmModule() as unknown as {
      Project?: { gm2InstrumentName?: (bankLsb: number, program: number) => string | null };
    };
    return wasm.Project?.gm2InstrumentName?.(bank & 0x7f, program) ?? null;
  } catch {
    return null;
  }
}

const sf2ProgramName = computed(() => {
  const { bank, program } = sf2Selection.value;
  return gm2InstrumentName(bank, program) ?? gmInstrumentName(program);
});

const sf2ProgramOptions = computed(() => {
  const first = selectedGmFamily.value * 8;
  return Array.from({ length: 8 }, (_, offset) => {
    const program = first + offset;
    return {
      program,
      gmName: gmInstrumentName(program),
      gm2Name: gm2InstrumentName(sf2Selection.value.bank, program),
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
        <p class="instrument-source">{{ instrumentSourceCaption }}</p>
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
            <div class="sf2-program-browser">
              <p v-if="soundFontSlotWarning" class="sf2-slot-warning" role="alert">
                {{ soundFontSlotWarning }}
              </p>
              <div class="sf2-current-program">
                <span class="sf2-current-label">{{ t.shell.devicesPanel.selectedProgram }}</span>
                <strong>{{ sf2Selection.program }} · {{ sf2ProgramName }}</strong>
              </div>
              <p
                v-if="sf2ManifestProbe.text"
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
        @move-insert="onMoveInsert"
      />

      <div class="rack-quick-controls">
        <h4 class="chain-title">{{ t.shell.devicesPanel.quickControls }}</h4>
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
