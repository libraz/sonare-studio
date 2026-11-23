import { computed, onBeforeUnmount, type Ref, ref, watch } from 'vue';
import { describeError } from '@/lib/errors';
import { deleteSoundFontIfUnreferenced } from '@/persistence/gc';
import { readFileBytesBounded } from '@/persistence/local-file';
import { MAX_SOUNDFONT_FILE_BYTES } from '@/persistence/resource-limits';
import { setTrackInstrument } from '@/project/commands';
import { listFonts, loadFontMeta, type SoundFontMeta, saveFont } from '@/project/fonts';
import {
  effectiveTrackInstrument,
  type Sf2ChannelProgram,
  type TrackInstrument,
} from '@/project/instrument';
import {
  collectActiveSoundFontUsage,
  hasSoundFontSlotConflict,
} from '@/project/soundfont-conflicts';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { gm2ProgramName, gmFamilies, gmProgramName } from '@/ui/devices/gm-catalog';
import {
  buildSf2Instrument,
  clampBank,
  clampGain,
  clampPolyphony,
  clampProgram,
  createSf2Selection,
} from '@/ui/devices/sf2-model';
import {
  type Sf2ManifestPreset,
  useSoundFontManifestProbe,
} from '@/ui/devices/use-sound-font-manifest-probe';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { readInputNumber } from '@/ui/numeric-input';

/** Inputs the SoundFont picker reads from the rack. */
interface SoundFontPickerInputs {
  activeTrack: Readonly<Ref<EditorTrack | null>>;
  instrument: Readonly<Ref<TrackInstrument | null>>;
  run: (action: () => void) => void;
  error: Ref<string>;
  pickerOpen: Ref<boolean>;
  pickerTab: Readonly<Ref<string>>;
  audition: (candidate: TrackInstrument) => void;
}

/** Owns the SF2 tab: stored font list, selection, GM program browser, upload and applying it to the track. */
export function useSoundFontPicker({
  activeTrack,
  instrument,
  run,
  error,
  pickerOpen,
  pickerTab,
  audition,
}: SoundFontPickerInputs) {
  const store = useProjectStore();
  const { t } = useI18n();
  let disposed = false;

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
          if (disposed) return;
          fontNames.value = { ...fontNames.value, [fontId]: meta.name };
        })
        .catch(() => {
          // Missing fonts keep the shortened-id fallback label.
        });
    },
    { immediate: true },
  );

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

  /** Bumped per refresh; only the newest listing may write the list or clear the loading flag. */
  let fontsGeneration = 0;

  async function refreshFonts(): Promise<void> {
    const generation = ++fontsGeneration;
    fontsLoading.value = true;
    try {
      const listed = await listFonts();
      if (disposed || generation !== fontsGeneration) return;
      fonts.value = listed;
      error.value = '';
    } catch (err) {
      if (disposed || generation !== fontsGeneration) return;
      fonts.value = [];
      error.value = describeError(err, t.value.notices.errors);
    } finally {
      if (generation === fontsGeneration) fontsLoading.value = false;
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
    const raw = readInputNumber(event);
    if (raw === null) return;
    sf2Selection.value = { ...sf2Selection.value, bank: clampBank(raw) };
  }

  function onProgramInput(event: Event): void {
    const raw = readInputNumber(event);
    if (raw === null) return;
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
    const raw = readInputNumber(event);
    if (raw === null) return;
    sf2Selection.value = { ...sf2Selection.value, gain: clampGain(raw) };
  }

  function onPolyphonyInput(event: Event): void {
    const raw = readInputNumber(event);
    if (raw === null) return;
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
    return (
      fonts.value.find((font) => font.id === fontId)?.name ?? fontNames.value[fontId] ?? fontId
    );
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

  /** Seeds the SF2 selection from the current instrument when the picker opens. */
  function seedSf2Selection(): void {
    sf2Selection.value = createSf2Selection(instrument.value);
    sf2MultiTimbral.value = sf2Selection.value.channelMap.length > 0;
  }

  onBeforeUnmount(() => {
    disposed = true;
  });

  return {
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
  };
}
