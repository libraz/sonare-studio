import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindRealtimeVoiceChangerInput,
  bindRealtimeVoiceChangerRetuneInput,
  REALTIME_VOICE_CHANGER_PROCESSOR,
} from '@/engine/realtime-voice-changer';
import { STREAMING_RETUNE_PROCESSOR } from '@/engine/streaming-retune';

class FakeNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeAudioWorkletNode extends FakeNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port = { postMessage: vi.fn() };
  constructor(
    readonly context: BaseAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    super();
    FakeAudioWorkletNode.instances.push(this);
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

afterEach(() => {
  FakeAudioWorkletNode.instances = [];
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
        preset: 'bright-idol',
        sampleRate: 48_000,
        blockSize: 256,
        channelCount: 2,
      },
    });
    expect(source.connect).toHaveBeenCalledWith(voiceNode);
    expect(voiceNode.connect).toHaveBeenCalledWith(engineNode);

    binding.setVoiceChangerPreset?.('dark-villain');
    binding.close();

    expect(voiceNode.port.postMessage).toHaveBeenCalledWith({
      type: 'setConfig',
      preset: 'dark-villain',
    });
    expect(voiceNode.port.postMessage).toHaveBeenCalledWith({ type: 'destroy' });
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

  it('chains realtime voice changer into StreamingRetune when both are requested', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const source = new FakeNode();
    const engineNode = new FakeNode() as unknown as AudioWorkletNode;
    const ctx = {
      sampleRate: 48_000,
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext;
    const stream = makeStream();

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
      preset: 'bright-idol',
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
    expect(source.connect).toHaveBeenCalledWith(voiceNode);
    expect(voiceNode.connect).toHaveBeenCalledWith(retuneNode);
    expect(retuneNode.connect).toHaveBeenCalledWith(engineNode);

    binding.setVoiceChangerPreset?.('dark-villain');
    binding.setStreamingRetuneConfig?.({ semitones: -7, mix: 1 });
    binding.close();

    expect(voiceNode.port.postMessage).toHaveBeenCalledWith({
      type: 'setConfig',
      preset: 'dark-villain',
    });
    expect(retuneNode.port.postMessage).toHaveBeenCalledWith({
      type: 'setConfig',
      config: { semitones: -7, mix: 1 },
    });
    expect(voiceNode.port.postMessage).toHaveBeenCalledWith({ type: 'destroy' });
    expect(retuneNode.port.postMessage).toHaveBeenCalledWith({ type: 'destroy' });
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(voiceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(retuneNode.disconnect).toHaveBeenCalledTimes(1);
    expect(stream.tracks.map((track) => track.stop.mock.calls.length)).toEqual([1, 1]);
  });
});
