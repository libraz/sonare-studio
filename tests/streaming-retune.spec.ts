import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindStreamingRetuneInput,
  clampStreamingRetuneSemitones,
  STREAMING_RETUNE_PROCESSOR,
  streamingRetuneSemitonesForMidiTarget,
  streamingRetuneSemitonesForScaleTarget,
} from '@/engine/streaming-retune';

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
  const tracks = [{ stop: vi.fn() }];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
    tracks,
  } as unknown as MediaStream & { tracks: Array<{ stop: ReturnType<typeof vi.fn> }> };
}

afterEach(() => {
  FakeAudioWorkletNode.instances = [];
  FakeAudioWorkletNode.autoReady = true;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bindStreamingRetuneInput', () => {
  it('derives bounded retune semitones from MIDI targets and scale targets', () => {
    expect(clampStreamingRetuneSemitones(7.4)).toBe(7);
    expect(clampStreamingRetuneSemitones(99)).toBe(24);
    expect(clampStreamingRetuneSemitones(Number.NaN)).toBe(0);
    expect(streamingRetuneSemitonesForMidiTarget({ currentMidi: 60, targetMidi: 67 })).toBe(7);
    expect(streamingRetuneSemitonesForMidiTarget({ currentMidi: 36, targetMidi: 72 })).toBe(24);

    const major = 0b101010110101;
    expect(streamingRetuneSemitonesForScaleTarget(61, { rootPc: 0, modeMask: major })).toBe(-1);
    expect(streamingRetuneSemitonesForScaleTarget(66, { rootPc: 0, modeMask: major })).toBe(-1);
    expect(streamingRetuneSemitonesForScaleTarget(64, { rootPc: 0, modeMask: major })).toBe(0);
    expect(streamingRetuneSemitonesForScaleTarget(61, { rootPc: 0, modeMask: 0 })).toBe(0);
  });

  it('connects microphone through the StreamingRetune worklet', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const source = new FakeNode();
    const engineNode = new FakeNode() as unknown as AudioWorkletNode;
    const ctx = {
      sampleRate: 48_000,
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext;
    const stream = makeStream();

    const binding = await bindStreamingRetuneInput(ctx, engineNode, {
      stream,
      stopTracksOnClose: true,
      semitones: 7,
      mix: 0.75,
      channelCount: 1,
      blockSize: 256,
    });

    const retuneNode = FakeAudioWorkletNode.instances[0];
    expect(retuneNode.name).toBe(STREAMING_RETUNE_PROCESSOR);
    expect(retuneNode.options).toMatchObject({
      channelCount: 1,
      processorOptions: {
        semitones: 7,
        mix: 0.75,
        sampleRate: 48_000,
        blockSize: 256,
        channelCount: 1,
      },
    });
    expect(source.connect).toHaveBeenCalledWith(retuneNode);
    expect(retuneNode.connect).toHaveBeenCalledWith(engineNode);

    binding.setStreamingRetuneConfig?.({ semitones: -5, mix: 1 });
    binding.close();

    expect(retuneNode.port.postMessage).toHaveBeenCalledWith({
      type: 'setConfig',
      config: { semitones: -5, mix: 1 },
    });
    expect(retuneNode.port.postMessage).toHaveBeenCalledWith({ type: 'destroy' });
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(retuneNode.disconnect).toHaveBeenCalledTimes(1);
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('clamps initial processor semitones', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const source = new FakeNode();
    const engineNode = new FakeNode() as unknown as AudioWorkletNode;
    const ctx = {
      sampleRate: 48_000,
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext;

    await bindStreamingRetuneInput(ctx, engineNode, {
      stream: makeStream(),
      stopTracksOnClose: false,
      semitones: 99,
    });

    expect(FakeAudioWorkletNode.instances[0].options.processorOptions).toMatchObject({
      semitones: 24,
    });
  });

  it('times out without publishing the binding and stops the acquired stream', async () => {
    vi.useFakeTimers();
    FakeAudioWorkletNode.autoReady = false;
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const source = new FakeNode();
    const engineNode = new FakeNode() as unknown as AudioWorkletNode;
    const ctx = {
      sampleRate: 48_000,
      createMediaStreamSource: vi.fn(() => source),
    } as unknown as AudioContext;
    const stream = makeStream();

    const pending = bindStreamingRetuneInput(ctx, engineNode, {
      stream,
      stopTracksOnClose: true,
      readyTimeoutMs: 25,
    });
    const rejection = expect(pending).rejects.toThrow('Timed out waiting for Streaming retune');
    expect(source.connect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(FakeAudioWorkletNode.instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1);
  });
});
