import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive, ref } from 'vue';
import { useRecordingControls } from '@/composables/useRecordingControls';
import type { UseTransportReturn } from '@/composables/useTransport';
import { addAudioTrack, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

function makeTransport(): UseTransportReturn {
  return {
    isPlaying: ref(false),
    positionSeconds: ref(0),
    positionPpq: ref(8),
    tempo: ref(120),
    loopEnabled: ref(false),
    loopStartPpq: ref(0),
    loopEndPpq: ref(0),
    metronomeEnabled: ref(false),
    play: vi.fn(() => true),
    stop: vi.fn(() => true),
    seek: vi.fn(() => true),
    seekPpq: vi.fn(() => true),
    setTempo: vi.fn(),
    setLoop: vi.fn(() => true),
    toggleMetronome: vi.fn(() => false),
    dispose: vi.fn(),
  };
}

function makeAppSettings(countInBars = 0) {
  const settings = reactive({
    countInBars,
    midiInputQuantizeDenominator: 0,
    monitorDefault: false,
    recordingCaptureSource: 'input' as const,
    recordingInputDeviceId: '',
    recordingVoiceChangerPreset: 'off' as const,
    recordingRetuneSemitones: 0,
  });
  return {
    settings,
    set: vi.fn((key: keyof typeof settings, value: number | boolean | string) => {
      (settings[key] as never) = value as never;
    }),
  };
}

/** Creates a manually-resolved promise for async race tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useRecordingControls', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('syncs count-in bars to audio and MIDI recorders', () => {
    const appSettings = makeAppSettings(2);
    const recording = {
      armedTrackId: ref<number | null>(null),
      armedTrackIds: ref<readonly number[]>([]),
      isRecording: ref(false),
      countInBars: ref(0),
      voiceChangerPreset: ref('off'),
      streamingRetuneSemitones: ref(0),
      inputDeviceId: ref(''),
      error: ref<string | null>(null),
      setMonitor: vi.fn(),
      setCaptureSource: vi.fn(),
      setInputDeviceId: vi.fn(),
      setVoiceChangerPreset: vi.fn(),
      setStreamingRetuneSemitones: vi.fn(),
      setTrackArmed: vi.fn(),
      requestMic: vi.fn(async () => true),
      record: vi.fn(async () => true),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(null),
      isRecording: ref(false),
      countInBars: ref(0),
      inputQuantizeDenominator: ref(0),
      error: ref<string | null>(null),
      arm: vi.fn(),
      record: vi.fn(() => true),
      stopRecord: vi.fn(() => null),
    };

    useRecordingControls({
      appSettings: appSettings as never,
      errorMessage: ref(''),
      recording: recording as never,
      midiRecording: midiRecording as never,
      transport: makeTransport(),
    });

    expect(recording.countInBars.value).toBe(2);
    expect(midiRecording.countInBars.value).toBe(2);
    expect(midiRecording.inputQuantizeDenominator.value).toBe(0);
    expect(recording.setCaptureSource).toHaveBeenCalledWith('input');
    expect(recording.setInputDeviceId).toHaveBeenCalledWith('');
    expect(recording.setVoiceChangerPreset).toHaveBeenCalledWith('off');
    expect(recording.setStreamingRetuneSemitones).toHaveBeenCalledWith(0);
  });

  it('persists recording capture source changes through app settings', () => {
    const appSettings = makeAppSettings();
    const recording = {
      armedTrackId: ref<number | null>(null),
      armedTrackIds: ref<readonly number[]>([]),
      isRecording: ref(false),
      countInBars: ref(0),
      voiceChangerPreset: ref('off'),
      streamingRetuneSemitones: ref(0),
      inputDeviceId: ref(''),
      error: ref<string | null>(null),
      setMonitor: vi.fn(),
      setCaptureSource: vi.fn(),
      setInputDeviceId: vi.fn(),
      setVoiceChangerPreset: vi.fn(),
      setStreamingRetuneSemitones: vi.fn(),
      setTrackArmed: vi.fn(),
      requestMic: vi.fn(async () => true),
      record: vi.fn(async () => true),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(null),
      isRecording: ref(false),
      countInBars: ref(0),
      inputQuantizeDenominator: ref(0),
      error: ref<string | null>(null),
      arm: vi.fn(),
      record: vi.fn(() => true),
      stopRecord: vi.fn(() => null),
    };

    const controls = useRecordingControls({
      appSettings: appSettings as never,
      errorMessage: ref(''),
      recording: recording as never,
      midiRecording: midiRecording as never,
      transport: makeTransport(),
    });

    controls.onRecordSourceChange('output');

    expect(appSettings.set).toHaveBeenCalledWith('recordingCaptureSource', 'output');
    expect(appSettings.settings.recordingCaptureSource).toBe('output');

    controls.onRecordInputDeviceChange('usb-mic');

    expect(appSettings.set).toHaveBeenCalledWith('recordingInputDeviceId', 'usb-mic');
    expect(appSettings.settings.recordingInputDeviceId).toBe('usb-mic');

    controls.onMidiInputQuantizeChange(16);

    expect(appSettings.set).toHaveBeenCalledWith('midiInputQuantizeDenominator', 16);
    expect(appSettings.settings.midiInputQuantizeDenominator).toBe(16);
  });

  it('refreshes input devices through legacy ondevicechange handlers', async () => {
    const firstDevice = {
      kind: 'audioinput',
      deviceId: 'built-in',
      label: 'Built-in Mic',
    } as MediaDeviceInfo;
    const secondDevice = {
      kind: 'audioinput',
      deviceId: 'usb',
      label: 'USB Mic',
    } as MediaDeviceInfo;
    let devices = [firstDevice];
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => devices),
      ondevicechange: null as ((event: Event) => void) | null,
    };
    vi.stubGlobal('navigator', { mediaDevices });
    const recording = {
      armedTrackId: ref<number | null>(null),
      armedTrackIds: ref<readonly number[]>([]),
      isRecording: ref(false),
      countInBars: ref(0),
      voiceChangerPreset: ref('off'),
      streamingRetuneSemitones: ref(0),
      inputDeviceId: ref(''),
      error: ref<string | null>(null),
      setMonitor: vi.fn(),
      setCaptureSource: vi.fn(),
      setInputDeviceId: vi.fn(),
      setVoiceChangerPreset: vi.fn(),
      setStreamingRetuneSemitones: vi.fn(),
      setTrackArmed: vi.fn(),
      requestMic: vi.fn(async () => true),
      record: vi.fn(async () => true),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(null),
      isRecording: ref(false),
      countInBars: ref(0),
      inputQuantizeDenominator: ref(0),
      error: ref<string | null>(null),
      arm: vi.fn(),
      record: vi.fn(() => true),
      stopRecord: vi.fn(() => null),
    };

    const controls = useRecordingControls({
      appSettings: makeAppSettings() as never,
      errorMessage: ref(''),
      recording: recording as never,
      midiRecording: midiRecording as never,
      transport: makeTransport(),
    });

    await controls.refreshInputDevices();
    expect(controls.recordingInputDeviceOptions.value.map((option) => option.label)).toEqual([
      'Default input',
      'Built-in Mic',
    ]);

    devices = [secondDevice];
    mediaDevices.ondevicechange?.(new Event('devicechange'));
    await Promise.resolve();

    expect(controls.recordingInputDeviceOptions.value.map((option) => option.label)).toEqual([
      'Default input',
      'USB Mic',
    ]);
  });

  it('lets audio own the shared count-in and starts MIDI at the punch-in', async () => {
    const audioTrackId = addAudioTrack({ name: 'Vox' });
    const midiTrackId = store.tracks.find((track) => track.kind === 'midi')?.id;
    if (midiTrackId === undefined) throw new Error('missing MIDI track');
    const appSettings = makeAppSettings(1);
    const transport = makeTransport();
    const recording = {
      armedTrackId: ref<number | null>(audioTrackId),
      armedTrackIds: ref<readonly number[]>([audioTrackId]),
      isRecording: ref(false),
      countInBars: ref(1),
      voiceChangerPreset: ref('off'),
      streamingRetuneSemitones: ref(0),
      inputDeviceId: ref(''),
      error: ref<string | null>(null),
      setMonitor: vi.fn(),
      setCaptureSource: vi.fn(),
      setInputDeviceId: vi.fn(),
      setVoiceChangerPreset: vi.fn(),
      setStreamingRetuneSemitones: vi.fn(),
      setTrackArmed: vi.fn(),
      requestMic: vi.fn(async () => true),
      record: vi.fn(async () => true),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(midiTrackId),
      isRecording: ref(false),
      countInBars: ref(1),
      inputQuantizeDenominator: ref(0),
      error: ref<string | null>(null),
      arm: vi.fn(),
      record: vi.fn(() => true),
      stopRecord: vi.fn(() => null),
    };
    const controls = useRecordingControls({
      appSettings: appSettings as never,
      errorMessage: ref(''),
      recording: recording as never,
      midiRecording: midiRecording as never,
      transport,
    });

    controls.toggleRecord();
    await vi.waitFor(() => expect(recording.record).toHaveBeenCalledOnce());

    expect(recording.record).toHaveBeenCalledOnce();
    expect(midiRecording.record).toHaveBeenCalledWith(8);
  });

  it('waits for delayed audio prewarm and starts audio and MIDI at one no-count-in tick', async () => {
    const audioTrackId = addAudioTrack({ name: 'Vox' });
    const midiTrackId = store.tracks.find((track) => track.kind === 'midi')?.id;
    if (midiTrackId === undefined) throw new Error('missing MIDI track');
    const micReady = deferred<boolean>();
    const transport = makeTransport();
    const recording = {
      armedTrackId: ref<number | null>(audioTrackId),
      armedTrackIds: ref<readonly number[]>([audioTrackId]),
      isRecording: ref(false),
      countInBars: ref(0),
      voiceChangerPreset: ref('off'),
      streamingRetuneSemitones: ref(0),
      inputDeviceId: ref(''),
      error: ref<string | null>(null),
      setMonitor: vi.fn(),
      setCaptureSource: vi.fn(),
      setInputDeviceId: vi.fn(),
      setVoiceChangerPreset: vi.fn(),
      setStreamingRetuneSemitones: vi.fn(),
      setTrackArmed: vi.fn(),
      requestMic: vi.fn(() => micReady.promise),
      record: vi.fn(async () => true),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(midiTrackId),
      isRecording: ref(false),
      countInBars: ref(0),
      inputQuantizeDenominator: ref(0),
      error: ref<string | null>(null),
      arm: vi.fn(),
      record: vi.fn(() => true),
      stopRecord: vi.fn(() => null),
    };
    const controls = useRecordingControls({
      appSettings: makeAppSettings(0) as never,
      errorMessage: ref(''),
      recording: recording as never,
      midiRecording: midiRecording as never,
      transport,
    });

    controls.toggleRecord();
    expect(midiRecording.record).not.toHaveBeenCalled();
    micReady.resolve(true);
    await vi.waitFor(() => expect(recording.record).toHaveBeenCalledOnce());

    expect(recording.record).toHaveBeenCalledWith(8);
    expect(midiRecording.record).toHaveBeenCalledWith(8);
  });

  it('does not start MIDI recording when audio prewarm fails before shared count-in', async () => {
    const audioTrackId = addAudioTrack({ name: 'Vox' });
    const midiTrackId = store.tracks.find((track) => track.kind === 'midi')?.id;
    if (midiTrackId === undefined) throw new Error('missing MIDI track');
    const appSettings = makeAppSettings(1);
    const transport = makeTransport();
    const recording = {
      armedTrackId: ref<number | null>(audioTrackId),
      armedTrackIds: ref<readonly number[]>([audioTrackId]),
      isRecording: ref(false),
      countInBars: ref(1),
      voiceChangerPreset: ref('off'),
      streamingRetuneSemitones: ref(0),
      inputDeviceId: ref(''),
      error: ref<string | null>('Microphone permission denied.'),
      setMonitor: vi.fn(),
      setCaptureSource: vi.fn(),
      setInputDeviceId: vi.fn(),
      setVoiceChangerPreset: vi.fn(),
      setStreamingRetuneSemitones: vi.fn(),
      setTrackArmed: vi.fn(),
      requestMic: vi.fn(async () => false),
      record: vi.fn(async () => false),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(midiTrackId),
      isRecording: ref(false),
      countInBars: ref(1),
      inputQuantizeDenominator: ref(0),
      error: ref<string | null>(null),
      arm: vi.fn(),
      record: vi.fn(() => true),
      stopRecord: vi.fn(() => null),
    };
    const controls = useRecordingControls({
      appSettings: appSettings as never,
      errorMessage: ref(''),
      recording: recording as never,
      midiRecording: midiRecording as never,
      transport,
    });

    controls.toggleRecord();
    await Promise.resolve();

    expect(recording.record).not.toHaveBeenCalled();
    expect(midiRecording.record).not.toHaveBeenCalled();
  });

  it('does not start MIDI after shared count-in audio setup resolves post-dispose', async () => {
    const audioTrackId = addAudioTrack({ name: 'Vox' });
    const midiTrackId = store.tracks.find((track) => track.kind === 'midi')?.id;
    if (midiTrackId === undefined) throw new Error('missing MIDI track');
    const pendingRecord = deferred<boolean>();
    const recording = {
      armedTrackId: ref<number | null>(audioTrackId),
      armedTrackIds: ref<readonly number[]>([audioTrackId]),
      isRecording: ref(false),
      countInBars: ref(1),
      voiceChangerPreset: ref('off'),
      streamingRetuneSemitones: ref(0),
      inputDeviceId: ref(''),
      error: ref<string | null>(null),
      setMonitor: vi.fn(),
      setCaptureSource: vi.fn(),
      setInputDeviceId: vi.fn(),
      setVoiceChangerPreset: vi.fn(),
      setStreamingRetuneSemitones: vi.fn(),
      setTrackArmed: vi.fn(),
      requestMic: vi.fn(async () => true),
      record: vi.fn(() => pendingRecord.promise),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(midiTrackId),
      isRecording: ref(false),
      countInBars: ref(1),
      inputQuantizeDenominator: ref(0),
      error: ref<string | null>(null),
      arm: vi.fn(),
      record: vi.fn(() => true),
      stopRecord: vi.fn(() => null),
    };
    const scope = effectScope();
    const controls = scope.run(() =>
      useRecordingControls({
        appSettings: makeAppSettings(1) as never,
        errorMessage: ref(''),
        recording: recording as never,
        midiRecording: midiRecording as never,
        transport: makeTransport(),
      }),
    );
    if (!controls) throw new Error('effect scope did not run');

    controls.toggleRecord();
    await vi.waitFor(() => expect(recording.record).toHaveBeenCalledOnce());
    scope.stop();
    pendingRecord.resolve(true);
    await Promise.resolve();

    expect(recording.record).toHaveBeenCalledOnce();
    expect(midiRecording.record).not.toHaveBeenCalled();
  });

  it('keeps multiple audio arms visible and routes header toggles by track kind', () => {
    const firstAudioId = addAudioTrack({ name: 'Vox 1' });
    const secondAudioId = addAudioTrack({ name: 'Vox 2' });
    const midiTrackId = store.tracks.find((track) => track.kind === 'midi')?.id;
    if (midiTrackId === undefined) throw new Error('missing MIDI track');
    const recording = {
      armedTrackId: ref<number | null>(firstAudioId),
      armedTrackIds: ref<readonly number[]>([firstAudioId, secondAudioId]),
      isRecording: ref(false),
      countInBars: ref(0),
      voiceChangerPreset: ref('off'),
      streamingRetuneSemitones: ref(0),
      inputDeviceId: ref(''),
      error: ref<string | null>(null),
      setMonitor: vi.fn(),
      setCaptureSource: vi.fn(),
      setInputDeviceId: vi.fn(),
      setVoiceChangerPreset: vi.fn(),
      setStreamingRetuneSemitones: vi.fn(),
      setTrackArmed: vi.fn(),
      record: vi.fn(async () => true),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(midiTrackId),
      isRecording: ref(false),
      countInBars: ref(0),
      inputQuantizeDenominator: ref(0),
      error: ref<string | null>(null),
      arm: vi.fn(),
      record: vi.fn(() => true),
      stopRecord: vi.fn(() => null),
    };

    const controls = useRecordingControls({
      appSettings: makeAppSettings() as never,
      errorMessage: ref(''),
      recording: recording as never,
      midiRecording: midiRecording as never,
      transport: makeTransport(),
    });

    expect(controls.armedTrackIds.value).toEqual([firstAudioId, secondAudioId, midiTrackId]);

    controls.onArmTrack(secondAudioId, false);
    expect(recording.setTrackArmed).toHaveBeenCalledWith(secondAudioId, false);

    controls.onArmTrack(midiTrackId, false);
    expect(midiRecording.arm).toHaveBeenCalledWith(null);
  });
});
