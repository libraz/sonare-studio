import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindRealtimeVoiceChangerInput,
  bindRealtimeVoiceChangerRetuneInput,
} from '@/engine/realtime-voice-changer';
import { bindStreamingRetuneInput } from '@/engine/streaming-retune';

vi.mock('@/lib/wasm', () => ({ ensureWasm: vi.fn(async () => ({})) }));

class FakePort extends EventTarget {
  readonly postMessage = vi.fn();
  readonly start = vi.fn();
}

/** AudioWorkletNode stand-in that is its own event target, like the real node. */
class FakeAudioWorkletNode extends EventTarget {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port = new FakePort();
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  constructor() {
    super();
    FakeAudioWorkletNode.instances.push(this);
    queueMicrotask(() =>
      this.port.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } })),
    );
  }
}

const stream = { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
const ctx = {
  sampleRate: 48_000,
  createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
} as unknown as AudioContext;
const engineNode = { connect: vi.fn() } as unknown as AudioWorkletNode;

beforeEach(() => {
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  FakeAudioWorkletNode.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const binders = {
  'voice changer': () =>
    bindRealtimeVoiceChangerInput(ctx, engineNode, { stream, stopTracksOnDestroy: false }),
  'streaming retune': () =>
    bindStreamingRetuneInput(ctx, engineNode, { stream, stopTracksOnDestroy: false }),
  'voice changer into retune': () =>
    bindRealtimeVoiceChangerRetuneInput(ctx, engineNode, {
      stream,
      stopTracksOnDestroy: false,
      semitones: 3,
    }),
};

describe('input worklet hosts', () => {
  it.each(Object.entries(binders))(
    '%s re-dispatches a runtimeError as processorerror until destroyed',
    async (_name, bind) => {
      const binding = await bind();
      const errorEvent = (message: string) =>
        new MessageEvent('message', { data: { type: 'runtimeError', message } });
      const listeners = FakeAudioWorkletNode.instances.map((node) => {
        const onError = vi.fn();
        node.addEventListener('processorerror', onError);
        node.port.dispatchEvent(errorEvent('boom'));
        expect(onError).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining('boom'));
        return onError;
      });

      binding.destroy();
      for (const node of FakeAudioWorkletNode.instances)
        node.port.dispatchEvent(errorEvent('late'));
      for (const onError of listeners) expect(onError).toHaveBeenCalledTimes(1);
    },
  );
});
