import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref, shallowRef } from 'vue';
import { useRecording } from '@/composables/useRecording';
import type { UseTransportReturn } from '@/composables/useTransport';
import type { Recorder } from '@/engine/recorder';
import { ensureWasm } from '@/lib/wasm';
import { addAudioTrack, clearHistory } from '@/project/commands';
import { createRecordingCycle } from '@/project/loop-recording';
import { useProjectStore } from '@/project/store';
import { fakeEngineHandle } from './fakes/engine';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

function makeTransport() {
  const tempo = ref(120);
  const positionSeconds = ref(4);
  const positionPpq = computed(() => (positionSeconds.value * tempo.value) / 60);
  const metronomeEnabled = ref(false);
  const loopEnabled = ref(false);
  const loopStartPpq = ref(0);
  const loopEndPpq = ref(0);
  return {
    isPlaying: ref(false),
    positionSeconds,
    positionPpq,
    audiblePositionSeconds: ref(0),
    audiblePositionPpq: positionPpq,
    tempo,
    loopEnabled,
    loopStartPpq,
    loopEndPpq,
    recordingCycle: createRecordingCycle({
      enabled: loopEnabled,
      startPpq: loopStartPpq,
      endPpq: loopEndPpq,
    }),
    metronomeEnabled,
    playbackLatencySeconds: ref(0),
    play: vi.fn(() => true),
    stop: vi.fn(() => true),
    seek: vi.fn(() => true),
    seekPpq: vi.fn(() => true),
    setTempo: vi.fn(),
    setLoop: vi.fn(() => true),
    toggleMetronome: vi.fn((enabled?: boolean) => {
      metronomeEnabled.value = enabled ?? !metronomeEnabled.value;
      return metronomeEnabled.value;
    }),
    tempoSegments: ref([]),
    resumeContext: vi.fn(),
    setTempoMap: vi.fn(),
    dispose: vi.fn(),
  } satisfies UseTransportReturn;
}

function makeRecorder(): Recorder {
  let mic = true;
  return {
    requestMicrophone: vi.fn(async () => {
      mic = true;
    }),
    hasMicrophone: () => mic,
    arm: vi.fn(),
    disarm: vi.fn(),
    armedTrackId: () => null,
    isRecording: () => false,
    capturePunchOutPpq: () => null,
    setMonitor: vi.fn(),
    monitorEnabled: () => false,
    setVoiceChangerPreset: vi.fn(() => true),
    setStreamingRetuneSemitones: vi.fn(() => true),
    onLevel: vi.fn(() => () => undefined),
    onInputProcessorError: vi.fn(() => () => undefined),
    onMicrophoneLost: vi.fn(() => () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => null),
    dispose: vi.fn(),
  };
}

describe('useRecording start failure cleanup', () => {
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  function setup() {
    const transport = makeTransport();
    const recorder = makeRecorder();
    const handle = shallowRef(fakeEngineHandle({ ctx: { sampleRate: 48000 } }));
    const recording = useRecording(() => handle.value, transport, {
      createRecorder: () => recorder,
      ingest: vi.fn(),
    });
    disposers.push(recording.dispose);
    recording.arm(addAudioTrack());
    recording.countInBars.value = 1;
    return { recording, recorder, transport, handle };
  }

  it('restores the forced count-in metronome when the engine changes during start', async () => {
    const { recording, recorder, transport, handle } = setup();
    vi.mocked(recorder.start).mockImplementationOnce(async () => {
      handle.value = fakeEngineHandle({ ctx: { sampleRate: 48000 } });
    });

    expect(await recording.record()).toBe(false);

    expect(recorder.stop).toHaveBeenCalled();
    expect(recording.state.value).toBe('idle');
    expect(transport.metronomeEnabled.value).toBe(false);
  });

  it('returns to idle when the input latency cannot be resolved', async () => {
    const { recording, recorder, transport } = setup();
    const wasm = await ensureWasm();
    vi.spyOn(wasm, 'masteringProcessorCatalog').mockImplementationOnce(() => {
      throw new Error('catalog unavailable');
    });

    expect(await recording.record()).toBe(false);

    expect(recording.error.value).toBe('catalog unavailable');
    expect(recording.state.value).toBe('idle');
    expect(recorder.start).not.toHaveBeenCalled();
    expect(transport.metronomeEnabled.value).toBe(false);
  });
});
