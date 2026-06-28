import { computed, type Ref, ref, watch } from 'vue';
import type { useAppSettings } from '@/composables/useAppSettings';
import type { useMidiRecording } from '@/composables/useMidiRecording';
import type { useRecording } from '@/composables/useRecording';
import { useProjectStore } from '@/project/store';

type AppSettings = ReturnType<typeof useAppSettings>;
type Recording = ReturnType<typeof useRecording>;
type MidiRecording = ReturnType<typeof useMidiRecording>;

export interface RecordingControlsOptions {
  appSettings: AppSettings;
  errorMessage: Ref<string>;
  recording: Recording;
  midiRecording: MidiRecording;
}

export function useRecordingControls(options: RecordingControlsOptions) {
  const { appSettings, errorMessage, recording, midiRecording } = options;
  const store = useProjectStore();
  const recordMenuOpen = ref(false);
  const recordMenuRoot = ref<HTMLElement | null>(null);

  recording.countInBars.value = appSettings.settings.countInBars;
  watch(
    () => appSettings.settings.countInBars,
    (bars) => {
      recording.countInBars.value = bars;
    },
  );
  if (appSettings.settings.monitorDefault) recording.setMonitor(true);

  // Both an audio and a MIDI track can be armed at once (they share one
  // transport); the meter highlights every armed destination.
  const armedTrackIds = computed(() => {
    const ids: number[] = [];
    if (recording.armedTrackId.value !== null) ids.push(recording.armedTrackId.value);
    if (midiRecording.armedTrackId.value !== null) ids.push(midiRecording.armedTrackId.value);
    return ids;
  });

  watch(recording.error, (message) => {
    if (message) errorMessage.value = message;
  });
  watch(midiRecording.error, (message) => {
    if (message) errorMessage.value = message;
  });

  function onCountInChange(bars: number): void {
    appSettings.set('countInBars', bars);
  }

  function onArmTrack(trackId: number, armed: boolean): void {
    // Route the arm to the recorder that matches the track kind: MIDI tracks
    // capture note events, audio tracks capture the microphone.
    const track = store.tracks.find((t) => t.id === trackId);
    if (track?.kind === 'midi') {
      midiRecording.arm(armed ? trackId : null);
    } else {
      recording.arm(armed ? trackId : null);
    }
  }

  function toggleRecord(): void {
    if (recording.isRecording.value || midiRecording.isRecording.value) {
      if (recording.isRecording.value) void recording.stopRecord();
      if (midiRecording.isRecording.value) midiRecording.stopRecord();
      return;
    }
    // MIDI starts first so it owns the transport punch-in; audio then records
    // from the rolling transport.
    if (midiRecording.armedTrackId.value !== null) midiRecording.record();
    if (recording.armedTrackId.value !== null) void recording.record();
  }

  return {
    armedTrackIds,
    recordMenuOpen,
    recordMenuRoot,
    onArmTrack,
    onCountInChange,
    toggleRecord,
  };
}
