import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindRealtimeVoiceChangerInput,
  bindRealtimeVoiceChangerRetuneInput,
  REALTIME_VOICE_CHANGER_PROCESSOR,
} from '@/engine/realtime-voice-changer';
import { STREAMING_RETUNE_PROCESSOR } from '@/engine/streaming-retune';
import { ensureWasm } from '@/lib/wasm';

const { presetConfigs } = vi.hoisted(() => {
  const makePod = (overrides: Record<string, number | boolean>) => ({
    inputGainDb: 0,
    outputGainDb: 0,
    wetMix: 1,
    retuneSemitones: 0,
    retuneMix: 0,
    retuneGrainSize: 0,
    formantFactor: 1,
    formantAmount: 0,
    formantBody: 0,
    formantBrightness: 0,
    formantNasal: 0,
    eqHighpassHz: 75,
    eqBodyDb: 0,
    eqPresenceDb: 0,
    eqAirDb: 0,
    gateThresholdDb: -55,
    gateAttackMs: 2,
    gateReleaseMs: 100,
    gateRangeDb: 18,
    compressorThresholdDb: -24,
    compressorRatio: 1.8,
    compressorAttackMs: 8,
    compressorReleaseMs: 120,
    compressorMakeupGainDb: 0.5,
    deesserFrequencyHz: 7200,
    deesserThresholdDb: -28,
    deesserRatio: 4,
    deesserRangeDb: 8,
    reverbMix: 0,
    reverbTimeMs: 320,
    reverbDamping: 0.55,
    reverbSeed: 1,
    limiterCeilingDb: -1,
    limiterReleaseMs: 50,
    limiterEnableIspLimiter: true,
    limiterIspCeilingDbtp: -1,
    ...overrides,
  });
  return {
    presetConfigs: {
      'bright-idol': makePod({
        outputGainDb: 2.2,
        retuneSemitones: 4,
        retuneMix: 1,
        formantFactor: 1.18,
        formantAmount: 1,
        formantBrightness: 0.7,
        formantNasal: 0.05,
        eqHighpassHz: 160,
        eqBodyDb: -2.5,
        eqPresenceDb: 4.5,
        eqAirDb: 3.5,
        gateThresholdDb: -50,
        gateReleaseMs: 80,
        gateRangeDb: 22,
        compressorThresholdDb: -23,
        compressorRatio: 3.2,
        compressorAttackMs: 4.5,
        compressorReleaseMs: 75,
        compressorMakeupGainDb: 2,
        deesserFrequencyHz: 7600,
        deesserThresholdDb: -30,
        deesserRangeDb: 9,
        reverbMix: 0.11,
        reverbTimeMs: 380,
        reverbDamping: 0.35,
        reverbSeed: 7,
      }),
      'dark-villain': makePod({
        outputGainDb: 4.5,
        retuneSemitones: -9,
        retuneMix: 1,
        formantFactor: 0.72,
        formantAmount: 1,
        formantBody: 0.8,
        formantBrightness: -0.7,
        formantNasal: -0.2,
        eqHighpassHz: 80,
        eqBodyDb: 5.5,
        eqPresenceDb: -2,
        eqAirDb: -5,
        gateThresholdDb: -50,
        gateReleaseMs: 110,
        gateRangeDb: 26,
        compressorThresholdDb: -25,
        compressorRatio: 4.2,
        compressorReleaseMs: 120,
        compressorMakeupGainDb: 1,
        deesserFrequencyHz: 6100,
        deesserThresholdDb: -24,
        deesserRatio: 3,
        deesserRangeDb: 4,
        reverbMix: 0.13,
        reverbTimeMs: 820,
        reverbDamping: 0.9,
        reverbSeed: 19,
      }),
    },
  };
});

vi.mock('@/lib/wasm', () => ({
  ensureWasm: vi.fn(async () => ({
    realtimeVoiceChangerPresetConfig: (preset: string) =>
      presetConfigs[preset as keyof typeof presetConfigs],
  })),
}));

class FakeNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakePort extends EventTarget {
  readonly postMessage = vi.fn();
  readonly start = vi.fn();
}

class FakeAudioWorkletNode extends FakeNode {
  static instances: FakeAudioWorkletNode[] = [];
  static autoReady = true;
  readonly port = new FakePort();
  private readonly events = new EventTarget();
  readonly addEventListener = this.events.addEventListener.bind(this.events);
  readonly removeEventListener = this.events.removeEventListener.bind(this.events);
  constructor(
    readonly context: BaseAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    super();
    FakeAudioWorkletNode.instances.push(this);
    if (FakeAudioWorkletNode.autoReady) {
      queueMicrotask(() =>
        this.port.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } })),
      );
    }
  }
}

function makeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
    tracks,
  } as unknown as MediaStream & { tracks: Array<{ stop: ReturnType<typeof vi.fn> }> };
}

const WASM_BYTES = new ArrayBuffer(8);

beforeEach(() => {
  // The worklet's WASM bytes are fetched same-origin; give the fetch a body.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => WASM_BYTES })),
  );
});

afterEach(() => {
  FakeAudioWorkletNode.instances = [];
  FakeAudioWorkletNode.autoReady = true;
  vi.unstubAllGlobals();
});

describe('bindRealtimeVoiceChangerInput', () => {
  it('connects microphone through the realtime voice changer worklet', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const source = new FakeNode();
    const engineNode = new FakeNode() as unknown as AudioWorkletNode;
    const ctx = {
      sampleRate: 48_000,
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext;
    const stream = makeStream();
    const wasm = await ensureWasm();
    const brightConfig = wasm.realtimeVoiceChangerPresetConfig('bright-idol');
    const darkConfig = wasm.realtimeVoiceChangerPresetConfig('dark-villain');

    const binding = await bindRealtimeVoiceChangerInput(ctx, engineNode, {
      stream,
      stopTracksOnClose: true,
      preset: 'bright-idol',
      channelCount: 2,
      blockSize: 256,
    });

    const voiceNode = FakeAudioWorkletNode.instances[0];
    expect(ctx.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(voiceNode.name).toBe(REALTIME_VOICE_CHANGER_PROCESSOR);
    expect(voiceNode.options).toMatchObject({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      outputChannelCount: [2],
      processorOptions: {
        preset: brightConfig,
        sampleRate: 48_000,
        blockSize: 256,
        channelCount: 2,
      },
    });
    expect(source.connect).toHaveBeenCalledWith(voiceNode);
    expect(voiceNode.connect).toHaveBeenCalledWith(engineNode);
    expect(voiceNode.port.start).toHaveBeenCalledTimes(1);

    expect(binding.setVoiceChangerPreset?.('dark-villain')).toBe(true);
    expect(
      binding.setVoiceChangerPreset?.({
        schemaVersion: 1,
        name: 'custom',
        dsp: { formantFactor: 1.2 },
      }),
    ).toBe(false);
    binding.close();

    expect(voiceNode.port.postMessage).toHaveBeenCalledWith({
      type: 'setConfig',
      config: darkConfig,
    });
    expect(voiceNode.port.postMessage).toHaveBeenCalledWith({ type: 'destroy' });
    expect(voiceNode.port.postMessage).toHaveBeenCalledTimes(2);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(voiceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(stream.tracks.map((track) => track.stop.mock.calls.length)).toEqual([1, 1]);
  });

  it('keeps tracks alive when requested', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const ctx = {
      sampleRate: 44_100,
      createMediaStreamSource: vi.fn(() => new FakeNode()),
    } as unknown as AudioContext;
    const stream = makeStream();

    const binding = await bindRealtimeVoiceChangerInput(
      ctx,
      new FakeNode() as unknown as AudioWorkletNode,
      {
        stream,
        stopTracksOnClose: false,
      },
    );
    binding.close();

    expect(stream.tracks.map((track) => track.stop.mock.calls.length)).toEqual([0, 0]);
  });

  it('publishes no graph before ready and releases the full staged graph on init error', async () => {
    FakeAudioWorkletNode.autoReady = false;
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const source = new FakeNode();
    const engineNode = new FakeNode() as unknown as AudioWorkletNode;
    const ctx = {
      sampleRate: 48_000,
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext;
    const stream = makeStream();

    const pending = bindRealtimeVoiceChangerInput(ctx, engineNode, {
      stream,
      stopTracksOnClose: true,
    });
    // The node is built after the WASM bytes are fetched (a microtask), so wait
    // for it before asserting the graph is still unpublished.
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances[0]).toBeDefined());
    const voiceNode = FakeAudioWorkletNode.instances[0];
    expect(source.connect).not.toHaveBeenCalled();
    expect(voiceNode.connect).not.toHaveBeenCalled();

    voiceNode.port.dispatchEvent(
      new MessageEvent('message', { data: { type: 'error', message: 'WASM init failed' } }),
    );

    await expect(pending).rejects.toThrow('WASM init failed');
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(voiceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(engineNode.connect).not.toHaveBeenCalled();
    expect(stream.tracks.map((track) => track.stop.mock.calls.length)).toEqual([1, 1]);
  });

  it('chains realtime voice changer into StreamingRetune when both are requested', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const source = new FakeNode();
    const engineNode = new FakeNode() as unknown as AudioWorkletNode;
    const ctx = {
      sampleRate: 48_000,
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext;
    const stream = makeStream();
    const wasm = await ensureWasm();
    const brightConfig = wasm.realtimeVoiceChangerPresetConfig('bright-idol');
    const darkConfig = wasm.realtimeVoiceChangerPresetConfig('dark-villain');

    const binding = await bindRealtimeVoiceChangerRetuneInput(ctx, engineNode, {
      stream,
      stopTracksOnClose: true,
      preset: 'bright-idol',
      semitones: 99,
      channelCount: 1,
      blockSize: 256,
    });

    const [voiceNode, retuneNode] = FakeAudioWorkletNode.instances;
    expect(voiceNode.name).toBe(REALTIME_VOICE_CHANGER_PROCESSOR);
    expect(retuneNode.name).toBe(STREAMING_RETUNE_PROCESSOR);
    expect(voiceNode.options.processorOptions).toMatchObject({
      preset: brightConfig,
      sampleRate: 48_000,
      blockSize: 256,
      channelCount: 1,
    });
    expect(retuneNode.options.processorOptions).toMatchObject({
      semitones: 24,
      mix: 1,
      sampleRate: 48_000,
      blockSize: 256,
      channelCount: 1,
    });
    // Both worklets need the WASM bytes handed in; neither can fetch its own.
    expect(voiceNode.options.processorOptions?.wasmBinary).toBe(WASM_BYTES);
    expect(retuneNode.options.processorOptions?.wasmBinary).toBe(WASM_BYTES);
    expect(source.connect).toHaveBeenCalledWith(voiceNode);
    expect(voiceNode.connect).toHaveBeenCalledWith(retuneNode);
    expect(retuneNode.connect).toHaveBeenCalledWith(engineNode);
    expect(voiceNode.port.start).toHaveBeenCalledTimes(1);
    expect(retuneNode.port.start).toHaveBeenCalledTimes(1);

    expect(binding.setVoiceChangerPreset?.('dark-villain')).toBe(true);
    expect(
      binding.setVoiceChangerPreset?.({
        schemaVersion: 1,
        name: 'custom',
        dsp: { formantFactor: 1.2 },
      }),
    ).toBe(false);
    binding.setStreamingRetuneConfig?.({ semitones: -7, mix: 1 });
    binding.close();

    expect(voiceNode.port.postMessage).toHaveBeenCalledWith({
      type: 'setConfig',
      config: darkConfig,
    });
    expect(retuneNode.port.postMessage).toHaveBeenCalledWith({
      type: 'setConfig',
      config: { semitones: -7, mix: 1 },
    });
    expect(voiceNode.port.postMessage).toHaveBeenCalledWith({ type: 'destroy' });
    expect(retuneNode.port.postMessage).toHaveBeenCalledWith({ type: 'destroy' });
    expect(voiceNode.port.postMessage).toHaveBeenCalledTimes(2);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(voiceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(retuneNode.disconnect).toHaveBeenCalledTimes(1);
    expect(stream.tracks.map((track) => track.stop.mock.calls.length)).toEqual([1, 1]);
  });
});
