import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useRecording } from '@/composables/useRecording';
import type { UseTransportReturn } from '@/composables/useTransport';
import type { EngineHandle } from '@/engine/engine';
import type { Recorder, RecordingResult } from '@/engine/recorder';
import type { AudioAssetMeta } from '@/persistence/assets';
import { clearAudioAssetCache } from '@/persistence/assets';
import { addAudioTrack, clearHistory } from '@/project/commands';
import { createRecordingCycle } from '@/project/loop-recording';
import { useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

function makeTransport(): UseTransportReturn {
  const loopEnabled = ref(false);
  const loopStartPpq = ref(0);
  const loopEndPpq = ref(0);
  const isPlaying = ref(false);
  const positionPpq = ref(0);
  return {
    isPlaying,
    positionSeconds: ref(0),
    positionPpq,
    audiblePositionSeconds: ref(0),
    audiblePositionPpq: positionPpq,
    tempo: ref(120),
    loopEnabled,
    loopStartPpq,
    loopEndPpq,
    recordingCycle: createRecordingCycle({
      enabled: loopEnabled,
      startPpq: loopStartPpq,
      endPpq: loopEndPpq,
    }),
    metronomeEnabled: ref(false),
    playbackLatencySeconds: ref(0),
    play: vi.fn(() => {
      isPlaying.value = true;
      return true;
    }),
    stop: vi.fn(() => {
      isPlaying.value = false;
      return true;
    }),
    seek: vi.fn(() => true),
    seekPpq: vi.fn(() => true),
    setTempo: vi.fn(),
    setLoop: vi.fn(() => true),
    toggleMetronome: vi.fn(() => false),
    dispose: vi.fn(),
  };
}

function makeRecorder() {
  let mic = false;
  let recording = false;
  let micLost: (() => void) | null = null;
  const result: RecordingResult = {
    channels: [new Float32Array(24000)],
    sampleRate: 48000,
    startPpq: 0,
  };
  const rec: Recorder = {
    requestMicrophone: vi.fn(async () => {
      mic = true;
    }),
    hasMicrophone: () => mic,
    arm: vi.fn(),
    disarm: vi.fn(),
    armedTrackId: () => null,
    isRecording: () => recording,
    capturePunchOutPpq: () => null,
    setMonitor: vi.fn(),
    monitorEnabled: () => false,
    setVoiceChangerPreset: vi.fn(() => true),
    setStreamingRetuneSemitones: vi.fn(() => true),
    onLevel: vi.fn(() => () => {}),
    onInputProcessorError: vi.fn(() => () => {}),
    onMicrophoneLost: vi.fn((listener: () => void) => {
      micLost = listener;
      return () => {
        micLost = null;
      };
    }),
    start: vi.fn(async (options) => {
      recording = true;
      result.startPpq = options.startPpq;
    }),
    stop: vi.fn(async () => {
      recording = false;
      return result;
    }),
    dispose: vi.fn(),
  };
  return {
    rec,
    loseMic: () => {
      mic = false;
      recording = false;
      micLost?.();
    },
  };
}

const handle = { engine: {}, ctx: { sampleRate: 48000 } } as unknown as EngineHandle;

describe('audio recording guards', () => {
  let store: ReturnType<typeof useProjectStore>;
  const disposers: Array<() => void> = [];

  const setup = (
    ingest: (channels: Float32Array[], rate: number, name: string) => Promise<AudioAssetMeta>,
  ) => {
    const fake = makeRecorder();
    const recording = useRecording(() => handle, makeTransport(), {
      createRecorder: () => fake.rec,
      ingest,
    });
    disposers.push(recording.dispose);
    return { recording, fake };
  };

  const meta = (channels: Float32Array[], sampleRate: number, name: string): AudioAssetMeta => ({
    id: 'rec-asset',
    name,
    sampleRate,
    numChannels: channels.length,
    numFrames: channels[0]?.length ?? 0,
  });

  beforeEach(async () => {
    installMockOpfs();
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  it('refuses to record a frozen track before the microphone is requested', async () => {
    const ingest = vi.fn(async (c: Float32Array[], r: number, n: string) => meta(c, r, n));
    const { recording, fake } = setup(ingest);
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    store.tracks = store.tracks.map((track) =>
      track.id === trackId ? { ...track, frozen: { assetId: 'render' } } : track,
    );

    expect(await recording.record()).toBe(false);
    expect(recording.error.value).toMatch(/frozen/);
    expect(recording.state.value).toBe('idle');
    expect(fake.rec.requestMicrophone).not.toHaveBeenCalled();
    expect(fake.rec.start).not.toHaveBeenCalled();
  });

  it('keeps a stopped take when the microphone disconnects while it is being saved', async () => {
    let release!: () => void;
    const saving = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ingestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      ingestStarted = resolve;
    });
    const ingest = vi.fn(async (c: Float32Array[], r: number, n: string) => {
      ingestStarted();
      await saving;
      return meta(c, r, n);
    });
    const { recording, fake } = setup(ingest);
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    expect(await recording.record()).toBe(true);

    const stopped = recording.stopRecord();
    await started;
    expect(recording.state.value).toBe('ingesting');
    fake.loseMic();
    expect(recording.micReady.value).toBe(false);
    expect(recording.error.value).toMatch(/disconnected/i);
    release();

    const clipId = await stopped;
    expect(clipId).not.toBeNull();
    const clip = store.clips.find((entry) => entry.id === clipId);
    expect(clip).toMatchObject({ trackId, assetId: 'rec-asset' });
    expect(recording.state.value).toBe('idle');
    expect(recording.error.value).toMatch(/disconnected/i);
  });
});
