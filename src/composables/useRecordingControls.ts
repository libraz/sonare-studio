import { computed, type Ref, ref, watch } from 'vue';
import type { useAppSettings } from '@/composables/useAppSettings';
import type { useRecording } from '@/composables/useRecording';

type AppSettings = ReturnType<typeof useAppSettings>;
type Recording = ReturnType<typeof useRecording>;

export interface RecordingControlsOptions {
  appSettings: AppSettings;
  errorMessage: Ref<string>;
  recording: Recording;
}

export function useRecordingControls(options: RecordingControlsOptions) {
  const { appSettings, errorMessage, recording } = options;
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

  const armedTrackIds = computed(() =>
    recording.armedTrackId.value === null ? [] : [recording.armedTrackId.value],
  );

  watch(recording.error, (message) => {
    if (message) errorMessage.value = message;
  });

  function onCountInChange(bars: number): void {
    appSettings.set('countInBars', bars);
  }

  function onArmTrack(trackId: number, armed: boolean): void {
    recording.arm(armed ? trackId : null);
  }

  function toggleRecord(): void {
    if (recording.isRecording.value) void recording.stopRecord();
    else void recording.record();
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
