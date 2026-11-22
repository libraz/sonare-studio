import type { Sf2ProgramStatus } from '@libraz/libsonare';
import { onBeforeUnmount, type Ref, ref, watch } from 'vue';
import { describeError } from '@/lib/errors';
import {
  cacheSoundFontManifest,
  getCachedSoundFontManifest,
  loadFont,
  type SoundFontManifestEntry,
} from '@/project/fonts';
import { getWasmModule } from '@/project/store';
import type { Sf2Selection } from '@/ui/devices/sf2-model';
import { formatMessage, useI18n } from '@/ui/i18n';

type Sf2ManifestProbe =
  | { state: 'idle'; text: '' }
  | { state: 'loading'; text: string }
  | { state: 'sf2' | 'synth' | 'empty' | 'error'; text: string };

export interface Sf2ManifestPreset {
  bank: number;
  program: number;
  name: string;
}

/** Picker state the probe follows: it runs only while the SF2 tab is open on a font. */
interface SoundFontManifestProbeInputs {
  pickerOpen: Readonly<Ref<boolean>>;
  pickerTab: Readonly<Ref<string>>;
  sf2Selection: Readonly<Ref<Pick<Sf2Selection, 'fontId' | 'bank' | 'program'>>>;
}

/**
 * Checks the selected SF2 bank/program against the font's preset manifest and
 * lists the presets it offers, debounced and de-duplicated per font and bank.
 */
export function useSoundFontManifestProbe({
  pickerOpen,
  pickerTab,
  sf2Selection,
}: SoundFontManifestProbeInputs) {
  const { t } = useI18n();
  const sf2ManifestProbe = ref<Sf2ManifestProbe>({ state: 'idle', text: '' });
  const sf2ManifestPresets = ref<Sf2ManifestPreset[]>([]);
  let sf2ManifestRequest = 0;
  let sf2ManifestTimer: ReturnType<typeof setTimeout> | undefined;
  const sf2ManifestLoads = new Map<string, Promise<SoundFontManifestEntry[]>>();
  const SF2_MANIFEST_PROBE_DEBOUNCE_MS = 75;

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

  function applySf2Manifest(entries: SoundFontManifestEntry[], program: number): void {
    sf2ManifestPresets.value = entries
      .filter((entry) => entry.backend === 'sf2')
      .map((entry) => ({ bank: entry.bank, program: entry.program, name: entry.presetName }))
      .sort((a, b) => a.bank - b.bank || a.program - b.program);
    sf2ManifestProbe.value = sf2StatusText(
      (entries.find((entry) => entry.program === program) ??
        entries[0] ??
        null) as Sf2ProgramStatus | null,
    );
  }

  function soundFontManifestKey(fontId: string, bank: number): string {
    return `${fontId}:${bank}`;
  }

  async function loadSf2Manifest(fontId: string, bank: number): Promise<SoundFontManifestEntry[]> {
    const cached = getCachedSoundFontManifest(fontId, bank);
    if (cached !== null) return cached;
    const key = soundFontManifestKey(fontId, bank);
    const inFlight = sf2ManifestLoads.get(key);
    if (inFlight) return inFlight;
    const task = (async () => {
      try {
        const data = await loadFont(fontId);
        const wasm = getWasmModule();
        const project = new wasm.Project();
        try {
          const created = project.addMidiClip(0, 1);
          const events = Array.from({ length: 128 }, (_, candidateProgram) => {
            const tick = candidateProgram * 2;
            return [
              ...wasm.midiBankProgram({
                ppq: tick,
                group: 0,
                channel: 0,
                bank: { msb: (bank >> 7) & 0x7f, lsb: bank & 0x7f },
                program: candidateProgram,
              }),
              wasm.midiNoteOn({ ppq: tick, group: 0, channel: 0, note: 60, velocity: 96 }),
              wasm.midiNoteOff({ ppq: tick + 1, group: 0, channel: 0, note: 60 }),
            ];
          }).flat();
          project.setMidiEvents(created.clipId, events);
          project.loadSoundFont(data);
          const entries = (project.soundFontManifest() as SoundFontManifestEntry[]).filter(
            (entry) => entry.channel === 0 && entry.bank === bank,
          );
          cacheSoundFontManifest(fontId, bank, entries);
          return entries;
        } finally {
          project.destroy();
        }
      } finally {
        sf2ManifestLoads.delete(key);
      }
    })();
    sf2ManifestLoads.set(key, task);
    return task;
  }

  function refreshSf2ManifestProbe(): void {
    const request = ++sf2ManifestRequest;
    if (sf2ManifestTimer !== undefined) {
      clearTimeout(sf2ManifestTimer);
      sf2ManifestTimer = undefined;
    }
    const fontId = sf2Selection.value.fontId;
    if (!pickerOpen.value || pickerTab.value !== 'sf2' || fontId === null) {
      sf2ManifestProbe.value = { state: 'idle', text: '' };
      sf2ManifestPresets.value = [];
      return;
    }
    const bank = sf2Selection.value.bank;
    const program = sf2Selection.value.program;
    const cached = getCachedSoundFontManifest(fontId, bank);
    if (cached !== null) {
      applySf2Manifest(cached, program);
      return;
    }
    sf2ManifestProbe.value = {
      state: 'loading',
      text: t.value.shell.devicesPanel.soundFontProgramChecking,
    };
    // A font or bank switch cancels the pending timer. In-flight parses are
    // de-duplicated by content id + bank and stale requests never publish.
    sf2ManifestTimer = setTimeout(() => {
      sf2ManifestTimer = undefined;
      void loadSf2Manifest(fontId, bank)
        .then((entries) => {
          if (request === sf2ManifestRequest) applySf2Manifest(entries, program);
        })
        .catch((err: unknown) => {
          if (request !== sf2ManifestRequest) return;
          sf2ManifestPresets.value = [];
          const detail = describeError(err, t.value.notices.errors);
          sf2ManifestProbe.value = {
            state: 'error',
            text: formatMessage(t.value.shell.devicesPanel.soundFontProgramError, { detail }),
          };
        });
    }, SF2_MANIFEST_PROBE_DEBOUNCE_MS);
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

  onBeforeUnmount(() => {
    sf2ManifestRequest += 1;
    if (sf2ManifestTimer !== undefined) clearTimeout(sf2ManifestTimer);
  });

  return { sf2ManifestProbe, sf2ManifestPresets };
}
