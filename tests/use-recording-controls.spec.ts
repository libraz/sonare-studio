import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
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
  const settings = reactive({ countInBars, monitorDefault: false });
  return {
    settings,
    set: vi.fn((key: keyof typeof settings, value: number | boolean) => {
      (settings[key] as never) = value as never;
    }),
  };
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

  it('syncs count-in bars to audio and MIDI recorders', () => {
    const appSettings = makeAppSettings(2);
    const recording = {
      armedTrackId: ref<number | null>(null),
      isRecording: ref(false),
      countInBars: ref(0),
      error: ref<string | null>(null),
      setMonitor: vi.fn(),
      record: vi.fn(async () => true),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(null),
      isRecording: ref(false),
      countInBars: ref(0),
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
  });

  it('lets audio own the shared count-in and starts MIDI at the punch-in', async () => {
    const audioTrackId = addAudioTrack({ name: 'Vox' });
    const midiTrackId = store.tracks.find((track) => track.kind === 'midi')?.id;
    if (midiTrackId === undefined) throw new Error('missing MIDI track');
    const appSettings = makeAppSettings(1);
    const transport = makeTransport();
    const recording = {
      armedTrackId: ref<number | null>(audioTrackId),
      isRecording: ref(false),
      countInBars: ref(1),
      error: ref<string | null>(null),
      setMonitor: vi.fn(),
      record: vi.fn(async () => true),
      stopRecord: vi.fn(async () => null),
    };
    const midiRecording = {
      armedTrackId: ref<number | null>(midiTrackId),
      isRecording: ref(false),
      countInBars: ref(1),
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

    expect(recording.record).toHaveBeenCalledOnce();
    expect(midiRecording.record).toHaveBeenCalledWith(8);
  });
});
