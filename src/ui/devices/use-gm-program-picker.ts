import { computed, type Ref, ref } from 'vue';
import { setTrackInstrument } from '@/project/commands';
import {
  DEFAULT_SYNTH_PRESET,
  GM2_DRUM_BANK,
  gmProgramForPreset,
  type TrackInstrument,
} from '@/project/instrument';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { gm2ProgramName, gmCatalog, gmProgramName, trackIsDrums } from '@/ui/devices/gm-catalog';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';

/** Inputs the GM program picker reads from the rack. */
interface GmProgramPickerInputs {
  activeTrack: Readonly<Ref<EditorTrack | null>>;
  instrument: Readonly<Ref<TrackInstrument | null>>;
  run: (action: () => void) => void;
  pickerOpen: Ref<boolean>;
}

/** Owns the GM tab's program/bank selection, its option lists and applying it to the track. */
export function useGmProgramPicker({
  activeTrack,
  instrument,
  run,
  pickerOpen,
}: GmProgramPickerInputs) {
  const store = useProjectStore();
  const { t } = useI18n();

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
      const name = gmIsDrums.value
        ? catalog?.synthGsDrumKitName?.(program)
        : gmProgramName(program);
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
    firstBlock([
      gmProgramOptions.value.length === 0,
      t.value.shell.devicesPanel.reasons.noGmCatalog,
    ]),
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

  return {
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
  };
}
