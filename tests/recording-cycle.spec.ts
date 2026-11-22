import type { SonareEngine } from '@libraz/libsonare/worklet';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { useMidiRecording } from '@/composables/useMidiRecording';
import { useRecording } from '@/composables/useRecording';
import { useTransport } from '@/composables/useTransport';
import { useTransportControls } from '@/composables/useTransportControls';
import type { EngineHandle } from '@/engine/engine';
import type { Recorder, RecordingResult, StartRecordingOptions } from '@/engine/recorder';
import type { AudioAssetMeta } from '@/persistence/assets';
import type { AddRecordedMidiClipInput } from '@/project/command/midi-recording';
import { addAudioTrack, clearHistory } from '@/project/commands';
import { createRecordingCycle } from '@/project/loop-recording';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Engine handle whose transport accepts every command. */
function fakeEngineHandle(): EngineHandle {
  const ok = () => undefined;
  return {
    engine: {
      transport: {
        play: ok,
        stop: ok,
        seekPpq: ok,
        seekSec: ok,
        setLoop: ok,
      } satisfies Partial<SonareEngine['transport']>,
      setMetronome: ok,
      pushMidiPanic: () => {},
      pollTelemetry: () => [],
      onTelemetry: () => () => {},
    },
    ctx: { sampleRate: 48000, baseLatency: 0, outputLatency: 0, state: 'running' },
  } as unknown as EngineHandle;
}

/** Recorder double that returns a preset capture. */
function fakeRecorder(result: () => RecordingResult): Recorder {
  let start: StartRecordingOptions | null = null;
  return {
    requestMicrophone: vi.fn(async () => {}),
    hasMicrophone: () => true,
    arm: vi.fn(),
    disarm: vi.fn(),
    armedTrackId: () => null,
    isRecording: () => start !== null,
    capturePunchOutPpq: () => null,
    setMonitor: vi.fn(),
    monitorEnabled: () => false,
    setVoiceChangerPreset: vi.fn(() => true),
    setStreamingRetuneSemitones: vi.fn(() => true),
    onLevel: vi.fn(() => () => {}),
    onInputProcessorError: vi.fn(() => () => {}),
    onMicrophoneLost: vi.fn(() => () => {}),
    start: vi.fn(async (options: StartRecordingOptions) => {
      start = options;
    }),
    stop: vi.fn(async () => ({ ...result(), startPpq: start?.startPpq ?? 0 })),
    dispose: vi.fn(),
  } as unknown as Recorder;
}

const ingest = vi.fn(
  async (channels: Float32Array[], sampleRate: number, name: string): Promise<AudioAssetMeta> => ({
    id: name,
    name,
    sampleRate,
    numChannels: channels.length,
    numFrames: channels[0]?.length ?? 0,
  }),
);

describe('createRecordingCycle', () => {
  const loop = () => ({ enabled: ref(true), startPpq: ref(0), endPpq: ref(4) });

  it('cycles any take punched in inside an enabled loop', () => {
    const cycle = createRecordingCycle(loop());
    expect(cycle.begin({ punchInPpq: 0, mode: 'normal' }).window()).toEqual({
      punchInPpq: 0,
      startPpq: 0,
      endPpq: 4,
    });
    expect(cycle.begin({ punchInPpq: 1, mode: 'normal' }).window()).toEqual({
      punchInPpq: 1,
      startPpq: 0,
      endPpq: 4,
    });
  });

  it('keeps auto-punch, out-of-loop and loop-off takes linear', () => {
    const state = loop();
    const cycle = createRecordingCycle(state);
    expect(cycle.begin({ punchInPpq: 1, mode: 'auto-punch' }).window()).toBeNull();
    expect(cycle.begin({ punchInPpq: 4, mode: 'normal' }).window()).toBeNull();
    state.enabled.value = false;
    expect(cycle.begin({ punchInPpq: 1, mode: 'normal' }).window()).toBeNull();
  });

  it('stays active until every take has ended', () => {
    const cycle = createRecordingCycle(loop());
    const audio = cycle.begin({ punchInPpq: 0, mode: 'normal' });
    const midi = cycle.begin({ punchInPpq: 0, mode: 'normal' });
    audio.end();
    audio.end();
    expect(cycle.active.value).toBe(true);
    midi.end();
    expect(cycle.active.value).toBe(false);
  });
});

describe('the loop a take records through', () => {
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    ingest.mockClear();
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  const realTransport = () => {
    const handle = fakeEngineHandle();
    const transport = useTransport(() => handle);
    disposers.push(transport.dispose);
    return transport;
  };

  it('refuses loop edits from every entry point while a take records', () => {
    const transport = realTransport();
    transport.setLoop(0, 4, true);
    const take = transport.recordingCycle.begin({ punchInPpq: 1, mode: 'normal' });

    expect(transport.setLoop(0, 4, false)).toBe(false);
    expect(transport.setLoop(0, 8, true)).toBe(false);
    expect(transport.loopEnabled.value).toBe(true);
    expect(transport.loopEndPpq.value).toBe(4);

    take.end();
    expect(transport.setLoop(0, 4, false)).toBe(true);
  });

  it('places a mid-loop audio take inside the loop even when the loop is toggled mid-take', async () => {
    const store = useProjectStore();
    const transport = realTransport();
    transport.setLoop(0, 4, true);
    transport.seekPpq(1);
    // The engine captures [1, 4) on every pass: 2.5 passes of 3 PPQ at 120 BPM.
    const passFrames = 72000;
    const capture = new Float32Array(passFrames * 2.5);
    const handle = fakeEngineHandle();
    const recording = useRecording(() => handle, transport, {
      createRecorder: () =>
        fakeRecorder(() => ({ channels: [capture], sampleRate: 48000, startPpq: 0 })),
      ingest,
    });
    disposers.push(recording.dispose);
    recording.setCaptureSource('output');
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);

    expect(await recording.record()).toBe(true);
    transport.setLoop(0, 4, false);
    await recording.stopRecord();

    const clips = store.clips.filter((clip) => clip.kind === 'audio');
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ startPpq: 1, lengthPpq: 3 });
    expect(clips[0].takes).toHaveLength(2);
    expect(transport.recordingCycle.active.value).toBe(false);
  });

  it('folds a mid-loop MIDI take into the loop even when the loop is toggled mid-take', () => {
    const store = useProjectStore();
    let nowMs = 0;
    const calls: AddRecordedMidiClipInput[] = [];
    const transport = realTransport();
    transport.setLoop(0, 4, true);
    transport.seekPpq(1);
    const recording = useMidiRecording(transport, {
      now: () => nowMs,
      addRecordedMidiClip: (input) => {
        calls.push(input);
        return 1;
      },
    });
    recording.arm(store.tracks[0].id);
    expect(recording.record()).toBe(true);

    // Pass 0 runs 1..4 PPQ (1.5 s); 2.0 s in is 1 PPQ into the second pass.
    recording.captureNoteOn({ pitch: 60, velocity: 96, channel: 0, timeStampMs: 2000 });
    expect(transport.setLoop(0, 4, false)).toBe(false);
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0, timeStampMs: 2500 });
    nowMs = 3000;
    recording.stopRecord();

    expect(calls[0]).toMatchObject({
      startPpq: 0,
      lengthPpq: 4,
      notes: [{ pitch: 60, startPpq: 1, durationPpq: 1 }],
    });
    expect(transport.recordingCycle.active.value).toBe(false);
  });

  it('keeps a linear MIDI take linear when the loop is switched on mid-take', () => {
    const store = useProjectStore();
    let nowMs = 0;
    const calls: AddRecordedMidiClipInput[] = [];
    const transport = realTransport();
    transport.setLoop(0, 4, false);
    transport.seekPpq(1);
    const recording = useMidiRecording(transport, {
      now: () => nowMs,
      addRecordedMidiClip: (input) => {
        calls.push(input);
        return 1;
      },
    });
    recording.arm(store.tracks[0].id);
    recording.record();
    expect(transport.setLoop(0, 4, true)).toBe(false);
    recording.captureNoteOn({ pitch: 60, velocity: 96, channel: 0, timeStampMs: 2000 });
    recording.captureNoteOff({ pitch: 60, velocity: 0, channel: 0, timeStampMs: 2500 });
    nowMs = 3000;
    recording.stopRecord();

    expect(calls[0]).toMatchObject({
      startPpq: 1,
      notes: [{ pitch: 60, startPpq: 4, durationPpq: 1 }],
    });
  });
});

describe('auto-punch with the transport loop on', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
  });

  it('closes the take at the wrap and does not punch in again on the next pass', async () => {
    const isPlaying = ref(true);
    const positionPpq = ref(0);
    const isRecording = ref(false);
    const record = vi.fn(async () => {
      isRecording.value = true;
      return true;
    });
    const stopRecord = vi.fn(async () => {
      isRecording.value = false;
      return null;
    });
    const scope = effectScope();
    const controls = scope.run(() =>
      useTransportControls({
        errorMessage: ref(''),
        handle: shallowRef(null),
        isPlaying,
        loopEnabled: ref(true),
        loopEndPpq: ref(8),
        loopStartPpq: ref(4),
        positionPpq,
        recording: {
          armedTrackId: ref<number | null>(1),
          isRecording,
          record,
          stopRecord,
          // The latency-extended boundary lies past the loop end, so the playhead never reaches it.
          capturePunchOutPpq: () => (isRecording.value ? 8.1 : null),
        } as unknown as Parameters<typeof useTransportControls>[0]['recording'],
        recordingActive: isRecording,
        tempo: ref(120),
        transport: {} as Parameters<typeof useTransportControls>[0]['transport'],
        ensureEngineStarted: async () => null,
        onStopped: () => {},
        scheduleApply: () => {},
        syncTransportState: () => {},
      }),
    );
    controls?.toggleAutoPunch();

    positionPpq.value = 3;
    await nextTick();
    await Promise.resolve();
    expect(record).toHaveBeenCalledTimes(1);
    positionPpq.value = 7.9;
    await nextTick();
    // The transport wraps at the right locator.
    positionPpq.value = 4.05;
    await nextTick();
    expect(stopRecord).toHaveBeenCalledTimes(1);
    positionPpq.value = 5;
    await nextTick();
    await Promise.resolve();
    expect(record).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});
