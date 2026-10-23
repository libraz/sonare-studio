import { computed, getCurrentScope, onScopeDispose, type Ref, ref, watch } from 'vue';
import type { useAppSettings } from '@/composables/useAppSettings';
import type { useMidiRecording } from '@/composables/useMidiRecording';
import type { useRecording } from '@/composables/useRecording';
import type { UseTransportReturn } from '@/composables/useTransport';
import { resolveRecordingStartPlan } from '@/project/loop-recording';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';

type AppSettings = ReturnType<typeof useAppSettings>;
type Recording = ReturnType<typeof useRecording>;
type MidiRecording = ReturnType<typeof useMidiRecording>;

export interface RecordingInputDeviceOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface RecordingControlsOptions {
  appSettings: AppSettings;
  errorMessage: Ref<string>;
  recording: Recording;
  midiRecording: MidiRecording;
  transport: UseTransportReturn;
}

export function useRecordingControls(options: RecordingControlsOptions) {
  const { appSettings, errorMessage, recording, midiRecording, transport } = options;
  const { t } = useI18n();
  const store = useProjectStore();
  const recordMenuOpen = ref(false);
  const recordMenuRoot = ref<HTMLElement | null>(null);
  const inputDevices = ref<MediaDeviceInfo[]>([]);
  let disposed = false;
  let sharedRecordGeneration = 0;

  const recordingInputDeviceOptions = computed<RecordingInputDeviceOption[]>(() => {
    const selected = appSettings.settings.recordingInputDeviceId;
    const options: RecordingInputDeviceOption[] = [
      { value: '', label: t.value.shell.transport.recordingInputDefault },
      ...inputDevices.value.map((device, index) => ({
        value: device.deviceId,
        label:
          device.label ||
          formatMessage(t.value.shell.transport.recordingInputFallback, { index: index + 1 }),
      })),
    ];
    if (selected && !options.some((option) => option.value === selected)) {
      options.push({
        value: selected,
        label: t.value.shell.transport.recordingInputUnavailable,
        disabled: true,
      });
    }
    return options;
  });

  async function refreshInputDevices(): Promise<void> {
    const devices = globalThis.navigator?.mediaDevices;
    if (!devices || typeof devices.enumerateDevices !== 'function') {
      inputDevices.value = [];
      return;
    }
    try {
      const list = await devices.enumerateDevices();
      inputDevices.value = list.filter((device) => device.kind === 'audioinput');
    } catch {
      inputDevices.value = [];
    }
  }

  recording.countInBars.value = appSettings.settings.countInBars;
  midiRecording.countInBars.value = appSettings.settings.countInBars;
  midiRecording.inputQuantizeDenominator.value = appSettings.settings.midiInputQuantizeDenominator;
  watch(
    () => appSettings.settings.countInBars,
    (bars) => {
      recording.countInBars.value = bars;
      midiRecording.countInBars.value = bars;
    },
  );
  watch(
    () => appSettings.settings.midiInputQuantizeDenominator,
    (denominator) => {
      midiRecording.inputQuantizeDenominator.value = denominator;
    },
  );
  if (appSettings.settings.monitorDefault) recording.setMonitor(true);
  recording.setCaptureSource(appSettings.settings.recordingCaptureSource);
  recording.setInputDeviceId(appSettings.settings.recordingInputDeviceId);
  recording.setVoiceChangerPreset(appSettings.settings.recordingVoiceChangerPreset);
  recording.setStreamingRetuneSemitones(appSettings.settings.recordingRetuneSemitones);
  watch(
    () => appSettings.settings.recordingCaptureSource,
    (source) => {
      recording.setCaptureSource(source);
    },
  );
  watch(
    () => appSettings.settings.recordingInputDeviceId,
    (deviceId) => {
      recording.setInputDeviceId(deviceId);
    },
  );
  watch(
    () => appSettings.settings.recordingVoiceChangerPreset,
    (preset) => {
      recording.setVoiceChangerPreset(preset);
    },
  );
  watch(
    () => appSettings.settings.recordingRetuneSemitones,
    (semitones) => {
      recording.setStreamingRetuneSemitones(semitones);
    },
  );
  // Transport controls edit the live recorder directly. Mirror those changes
  // back into app settings so the advertised persistent input effects survive
  // the next session as well as settings-panel edits.
  watch(recording.voiceChangerPreset, (preset) => {
    if (preset !== appSettings.settings.recordingVoiceChangerPreset) {
      appSettings.set('recordingVoiceChangerPreset', preset);
    }
  });
  watch(recording.streamingRetuneSemitones, (semitones) => {
    if (semitones !== appSettings.settings.recordingRetuneSemitones) {
      appSettings.set('recordingRetuneSemitones', semitones);
    }
  });

  // Both an audio and a MIDI track can be armed at once (they share one
  // transport); the meter highlights every armed destination.
  const armedTrackIds = computed(() => {
    const ids = [...recording.armedTrackIds.value];
    if (midiRecording.armedTrackId.value !== null) ids.push(midiRecording.armedTrackId.value);
    return ids;
  });
  // This is the one recording-session state exposed to shell/UI consumers.
  // Audio and MIDI recorders share a transport, so using either recorder's
  // legacy primary armed ID makes MIDI-only recording unreachable from some
  // surfaces.
  const canRecord = computed(() => armedTrackIds.value.length > 0);
  const isRecording = computed(
    () => recording.isRecording.value || midiRecording.isRecording.value,
  );
  const isCountingIn = computed(
    () => recording.isCountingIn.value || midiRecording.isCountingIn.value,
  );

  watch(recording.error, (message) => {
    if (message) errorMessage.value = message;
  });
  watch(midiRecording.error, (message) => {
    if (message) errorMessage.value = message;
  });

  function onCountInChange(bars: number): void {
    appSettings.set('countInBars', bars);
  }

  function onMidiInputQuantizeChange(denominator: number): void {
    appSettings.set('midiInputQuantizeDenominator', denominator);
  }

  function onRecordSourceChange(source: 'input' | 'output'): void {
    appSettings.set('recordingCaptureSource', source);
  }

  function onRecordInputDeviceChange(deviceId: string): void {
    appSettings.set('recordingInputDeviceId', deviceId);
  }

  watch(recordMenuOpen, (open) => {
    if (open) void refreshInputDevices();
  });

  type LegacyDeviceChangeMediaDevices = MediaDevices & {
    ondevicechange?: ((event: Event) => void) | null;
  };
  const mediaDevices = globalThis.navigator?.mediaDevices as
    | LegacyDeviceChangeMediaDevices
    | undefined;
  if (mediaDevices && typeof mediaDevices.addEventListener === 'function') {
    mediaDevices.addEventListener('devicechange', refreshInputDevices);
    if (getCurrentScope()) {
      onScopeDispose(() => {
        mediaDevices.removeEventListener('devicechange', refreshInputDevices);
      });
    }
  } else if (mediaDevices && 'ondevicechange' in mediaDevices) {
    const previous = mediaDevices.ondevicechange ?? null;
    mediaDevices.ondevicechange = (event: Event) => {
      previous?.call(mediaDevices, event);
      void refreshInputDevices();
    };
    if (getCurrentScope()) {
      onScopeDispose(() => {
        mediaDevices.ondevicechange = previous;
      });
    }
  }
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      sharedRecordGeneration++;
    });
  }

  function onArmTrack(trackId: number, armed: boolean): void {
    // Route the arm to the recorder that matches the track kind: MIDI tracks
    // capture note events, audio tracks capture the microphone.
    const track = store.tracks.find((t) => t.id === trackId);
    if (track?.kind === 'midi') {
      midiRecording.arm(armed ? trackId : null);
    } else {
      recording.setTrackArmed(trackId, armed);
    }
  }

  function toggleRecord(): void {
    const audioState =
      recording.state?.value ?? (recording.isRecording.value ? 'recording' : 'idle');
    if (audioState !== 'idle' && audioState !== 'recording') return;
    if (audioState === 'recording' || midiRecording.isRecording.value) {
      sharedRecordGeneration++;
      if (audioState === 'recording') void recording.stopRecord();
      if (midiRecording.isRecording.value) midiRecording.stopRecord();
      return;
    }
    const midiArmed = midiRecording.armedTrackId.value !== null;
    const audioArmed = recording.armedTrackId.value !== null;
    if (!midiArmed && !audioArmed) return;
    // Recording starts the transport only after async setup, outside this gesture.
    transport.resumeContext();
    if (midiArmed && audioArmed) {
      const generation = ++sharedRecordGeneration;
      void (async () => {
        // Permission/device opening must finish before either recorder owns
        // transport time. This makes first-use microphone prompts harmless to
        // the MIDI onset and prevents a failed audio arm from starting MIDI
        // alone.
        if (!(await recording.requestMic())) return;
        if (disposed || generation !== sharedRecordGeneration) return;
        // Resolve every transport decision once after microphone prewarm. The
        // audio recorder owns the shared transport; MIDI consumes this exact
        // plan without re-reading isPlaying or the live playhead.
        const plan = resolveRecordingStartPlan({
          positionPpq: transport.positionPpq.value,
          audiblePositionPpq: transport.audiblePositionPpq.value,
          startedFromRest: !transport.isPlaying.value,
          loopEnabled: transport.loopEnabled.value,
          loopStartPpq: transport.loopStartPpq.value,
          loopEndPpq: transport.loopEndPpq.value,
          countInBars: appSettings.settings.countInBars,
          timeSignatures: store.timeSignatures,
          transportOwner: 'audio',
        });
        const started = await recording.record(plan);
        if (disposed || generation !== sharedRecordGeneration || !started) return;
        midiRecording.record(plan);
      })();
      return;
    }
    if (midiArmed) midiRecording.record();
    if (audioArmed) void recording.record();
  }

  return {
    armedTrackIds,
    canRecord,
    isRecording,
    isCountingIn,
    recordMenuOpen,
    recordMenuRoot,
    recordingInputDeviceOptions,
    onArmTrack,
    onCountInChange,
    onMidiInputQuantizeChange,
    onRecordInputDeviceChange,
    onRecordSourceChange,
    refreshInputDevices,
    toggleRecord,
  };
}
