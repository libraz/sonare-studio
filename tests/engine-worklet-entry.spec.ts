import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { receiveSync, receiveCommand, receiveCaptureRequest, receiveTransportRequest } = vi.hoisted(
  () => ({
    receiveSync: vi.fn(),
    receiveCommand: vi.fn(),
    receiveCaptureRequest: vi.fn(),
    receiveTransportRequest: vi.fn(),
  }),
);

vi.mock('@/wasm/worklet.js', () => ({
  init: vi.fn(() => Promise.resolve()),
  SonareRealtimeEngineWorkletProcessor: class {
    receiveSync = receiveSync;
    receiveCommand = receiveCommand;
    receiveCaptureRequest = receiveCaptureRequest;
    receiveTransportRequest = receiveTransportRequest;
    process(): boolean {
      return true;
    }
  },
}));

interface FakePort {
  onmessage?: (event: { data: unknown }) => void;
  postMessage: ReturnType<typeof vi.fn>;
}

type RegisteredCtor = new (options?: {
  processorOptions?: Record<string, unknown>;
}) => {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

let registered: RegisteredCtor;

beforeAll(async () => {
  class FakeAudioWorkletProcessor {
    readonly port: FakePort = {
      onmessage: undefined,
      postMessage: vi.fn(),
    };
  }
  (globalThis as Record<string, unknown>).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as Record<string, unknown>).registerProcessor = (
    _name: string,
    ctor: RegisteredCtor,
  ) => {
    registered = ctor;
  };
  await import('@/engine/worklet-entry');
});

beforeEach(() => {
  receiveSync.mockClear();
  receiveCommand.mockClear();
  receiveCaptureRequest.mockClear();
  receiveTransportRequest.mockClear();
});

/** Instantiates the registered processor and drains its async init chain. */
async function createReadyProcessor() {
  const instance = new registered({ processorOptions: {} });
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
  return instance;
}

describe('worklet-entry dispatch', () => {
  it('registers the processor and posts ready after init', async () => {
    const instance = await createReadyProcessor();
    expect(instance.port.postMessage).toHaveBeenCalledWith({
      type: 'ready',
      runtimeTarget: 'embind',
    });
  });

  it('forwards every sync-prefixed message to receiveSync', async () => {
    const instance = await createReadyProcessor();
    const types = [
      'syncClips',
      'syncClipsDelta',
      'syncMixer',
      'syncTempo',
      'syncMidiClips',
      'syncCapture',
      'syncBuiltinInstrument',
    ];
    for (const type of types) {
      instance.port.onmessage?.({ data: { type } });
    }
    expect(receiveSync).toHaveBeenCalledTimes(types.length);
    expect(receiveSync.mock.calls.map(([message]) => (message as { type: string }).type)).toEqual(
      types,
    );
    expect(receiveCommand).not.toHaveBeenCalled();
  });

  it('routes capture/transport request RPCs to their dedicated handlers', async () => {
    const instance = await createReadyProcessor();
    const capture = { type: 'captureRequest', requestId: 7, op: 'status' };
    const transport = { type: 'transportRequest', requestId: 8 };
    instance.port.onmessage?.({ data: capture });
    instance.port.onmessage?.({ data: transport });
    expect(receiveCaptureRequest).toHaveBeenCalledWith(capture);
    expect(receiveTransportRequest).toHaveBeenCalledWith(transport);
    expect(receiveSync).not.toHaveBeenCalled();
  });

  it('routes numeric message types to receiveCommand', async () => {
    const instance = await createReadyProcessor();
    const command = { type: 10, targetId: 0, sampleTime: -1, argInt: 1 };
    instance.port.onmessage?.({ data: command });
    expect(receiveCommand).toHaveBeenCalledWith(command);
    expect(receiveSync).not.toHaveBeenCalled();
  });

  it('ignores unknown string types, null, and non-object payloads without throwing', async () => {
    const instance = await createReadyProcessor();
    for (const data of [{ type: 'ready' }, { type: 'bogus' }, null, 42, 'sync', {}]) {
      expect(() => instance.port.onmessage?.({ data })).not.toThrow();
    }
    expect(receiveSync).not.toHaveBeenCalled();
    expect(receiveCommand).not.toHaveBeenCalled();
  });

  it('buffers messages that arrive before init completes and replays them in order', async () => {
    const instance = new registered({ processorOptions: {} });
    instance.port.onmessage?.({ data: { type: 'syncMixer' } });
    instance.port.onmessage?.({ data: { type: 11, targetId: 1, sampleTime: -1 } });
    expect(receiveSync).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
    expect(receiveSync).toHaveBeenCalledWith({ type: 'syncMixer' });
    expect(receiveCommand).toHaveBeenCalledWith({ type: 11, targetId: 1, sampleTime: -1 });
  });

  it('emits silence from process() until the bridge is ready', () => {
    const instance = new registered({ processorOptions: {} });
    const out = [new Float32Array([0.5, 0.5])];
    expect(instance.process([], [out])).toBe(true);
    expect(Array.from(out[0])).toEqual([0, 0]);
  });
});
