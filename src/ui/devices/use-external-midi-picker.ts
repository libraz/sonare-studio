import { computed, type Ref, ref } from 'vue';
import { useWebMidiOutputs } from '@/composables/useWebMidiOutputs';
import {
  setProjectExternalMidiDefault,
  setProjectExternalMidiDefaultForTracks,
  setTrackExternalMidiMode,
  setTrackInstrument,
} from '@/project/commands';
import type { ExternalMidiInstrument } from '@/project/instrument';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { clampChannel } from '@/ui/devices/sf2-model';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { readInputNumber } from '@/ui/numeric-input';

/** Inputs the external MIDI picker reads from the rack. */
interface ExternalMidiPickerInputs {
  activeTrack: Readonly<Ref<EditorTrack | null>>;
  run: (action: () => void) => void;
  pickerOpen: Ref<boolean>;
}

/** Owns the External MIDI tab: port/channel/clock selection and applying it to the track or project. */
export function useExternalMidiPicker({ activeTrack, run, pickerOpen }: ExternalMidiPickerInputs) {
  const store = useProjectStore();
  const { t } = useI18n();

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
    const raw = readInputNumber(event);
    if (raw === null) return;
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

  return {
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
  };
}
