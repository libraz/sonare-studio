import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive, ref, shallowRef } from 'vue';
import { useRecordingControls } from '@/composables/useRecordingControls';
import { useTransport } from '@/composables/useTransport';
import { useTransportControls } from '@/composables/useTransportControls';
import type { EngineHandle } from '@/engine/engine';
import { useProjectStore } from '@/project/store';
import type { SonareEngineTransportFacade } from '@/wasm/worklet.js';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Records every engine transport call in order so tests can assert sequencing. */
function createEngine(state: AudioContextState = 'running') {
  const calls: string[] = [];
  const record =
    (name: string, result: unknown = true) =>
    (...args: unknown[]) => {
      calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(',')})`);
      return result;
    };
  const ctx = {
    sampleRate: 48000,
    baseLatency: 0,
    outputLatency: 0,
    state,
    resume: vi.fn(async () => {
      calls.push('resume()');
    }),
  };
  const engine = {
    transport: {
      play: record('play'),
      stop: record('stop'),
      seekPpq: record('seekPpq'),
      seekSec: record('seekSec'),
      setLoop: record('setLoop'),
    } satisfies Partial<SonareEngineTransportFacade>,
    setMetronome: record('setMetronome'),
    pushMidiPanic: record('pushMidiPanic', undefined),
    pollTelemetry: () => [],
    onTelemetry: () => () => {},
  };
  const handle = { engine, ctx } as unknown as EngineHandle;
  return { handle, calls, ctx };
}

describe('transport state held before and across engine attach', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  const setup = () => {
    const handleRef = shallowRef<EngineHandle | null>(null);
    const transport = useTransport(() => handleRef.value);
    disposers.push(transport.dispose);
    return { transport, handleRef };
  };

  it('keeps seek, loop and metronome edits made without an engine and applies them on first play', () => {
    const { transport, handleRef } = setup();
    expect(transport.seekPpq(8)).toBe(true);
    expect(transport.setLoop(4, 12, true)).toBe(true);
    expect(transport.toggleMetronome(true, 0.3)).toBe(true);
    expect(transport.positionPpq.value).toBe(8);
    expect(transport.positionSeconds.value).toBe(4);
    expect(transport.loopEnabled.value).toBe(true);
    expect(transport.metronomeEnabled.value).toBe(true);

    const first = createEngine();
    handleRef.value = first.handle;
    expect(transport.play()).toBe(true);
    expect(first.calls).toEqual([
      'setLoop({"startPpq":4,"endPpq":12,"enabled":true})',
      'setMetronome({"enabled":true,"beatGain":0.3,"accentGain":0.6})',
      // 8 PPQ at the default 120 BPM.
      'seekSec(4)',
      'play()',
    ]);
  });

  it('seeks a replacement engine to the last shown position before it plays', () => {
    const { transport, handleRef } = setup();
    const first = createEngine();
    handleRef.value = first.handle;
    transport.seekPpq(6);
    transport.play();
    transport.stop();

    const second = createEngine();
    handleRef.value = second.handle;
    transport.play();
    expect(second.calls).toContain('seekSec(3)');
    expect(second.calls.indexOf('seekSec(3)')).toBeLessThan(second.calls.indexOf('play()'));
  });

  it('re-seeks a stopped engine to the shown bar when the tempo map changes', () => {
    const { transport, handleRef } = setup();
    const engine = createEngine();
    handleRef.value = engine.handle;
    // Bar 9 in 4/4 at 120 BPM.
    transport.seekPpq(32);
    engine.calls.length = 0;

    transport.setTempoMap([{ startPpq: 0, bpm: 60 }]);
    expect(transport.positionPpq.value).toBe(32);
    // At 60 BPM, PPQ 32 is 32 s; the engine must move there, not stay at 16 s.
    expect(engine.calls).toEqual(['seekSec(32)']);
  });
});

describe('gesture entry points resume a suspended context before sound starts', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
  });

  it('startPlayback resumes before issuing play', () => {
    const engine = createEngine('suspended');
    const scope = effectScope();
    const controls = scope.run(() => {
      const handle = shallowRef<EngineHandle | null>(engine.handle);
      const transport = useTransport(() => handle.value);
      return useTransportControls({
        errorMessage: ref(''),
        handle,
        isPlaying: transport.isPlaying,
        loopEnabled: transport.loopEnabled,
        loopEndPpq: transport.loopEndPpq,
        loopStartPpq: transport.loopStartPpq,
        positionPpq: transport.positionPpq,
        recording: {
          armedTrackId: ref<number | null>(null),
          isRecording: ref(false),
        } as unknown as Parameters<typeof useTransportControls>[0]['recording'],
        recordingActive: ref(false),
        tempo: transport.tempo,
        transport,
        ensureEngineStarted: async () => engine.handle,
        onStopped: () => {},
        scheduleApply: () => {},
        syncTransportState: () => {},
      });
    });
    controls?.startPlayback();
    expect(engine.calls[0]).toBe('resume()');
    expect(engine.calls.at(-1)).toBe('play()');
    scope.stop();
  });

  it('the record click resumes synchronously, before the recorder starts the transport', () => {
    const engine = createEngine('suspended');
    const scope = effectScope();
    const record = vi.fn(async () => true);
    scope.run(() => {
      const transport = useTransport(() => engine.handle);
      const controls = useRecordingControls({
        appSettings: {
          settings: reactive({
            countInBars: 0,
            midiInputQuantizeDenominator: 0,
            monitorDefault: false,
            recordingCaptureSource: 'input' as const,
            recordingInputDeviceId: '',
            recordingVoiceChangerPreset: 'off' as const,
            recordingRetuneSemitones: 0,
          }),
          set: vi.fn(),
        } as never,
        errorMessage: ref(''),
        recording: {
          state: ref('idle'),
          armedTrackId: ref<number | null>(1),
          armedTrackIds: ref<readonly number[]>([1]),
          isRecording: ref(false),
          countInBars: ref(0),
          setMonitor: vi.fn(),
          setCaptureSource: vi.fn(),
          setInputDeviceId: vi.fn(),
          setVoiceChangerPreset: vi.fn(),
          setStreamingRetuneSemitones: vi.fn(),
          record,
        } as never,
        midiRecording: {
          armedTrackId: ref<number | null>(null),
          isRecording: ref(false),
          countInBars: ref(0),
          inputQuantizeDenominator: ref(0),
          record: vi.fn(() => true),
        } as never,
        transport,
      });
      controls.toggleRecord();
    });
    expect(engine.ctx.resume).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});
