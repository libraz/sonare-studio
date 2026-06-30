import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  init,
  isInitialized,
  receiveSync,
  receiveCommand,
  receiveCaptureRequest,
  receiveTransportRequest,
} = vi.hoisted(() => ({
  init: vi.fn(() => Promise.resolve()),
  isInitialized: vi.fn(() => false),
  receiveSync: vi.fn(),
  receiveCommand: vi.fn(),
  receiveCaptureRequest: vi.fn(),
  receiveTransportRequest: vi.fn(),
}));

vi.mock('@/wasm/worklet.js', () => ({
  init,
  isInitialized,
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
  addEventListener?: (type: string, listener: (event: { data: unknown }) => void) => void;
  start?: ReturnType<typeof vi.fn>;
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
  init.mockClear();
  isInitialized.mockClear();
  isInitialized.mockReturnValue(false);
  receiveSync.mockClear();
  receiveCommand.mockClear();
  receiveCaptureRequest.mockClear();
  receiveTransportRequest.mockClear();
  delete (globalThis as Record<string, unknown>).SonareEmbindInitPromise;
  delete (globalThis as Record<string, unknown>).SonareEmbindModuleFactory;
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

  it('initializes embind with supplied wasm bytes and the bundled module factory', async () => {
    const wasmBinary = new ArrayBuffer(8);
    const moduleFactory = vi.fn();
    (globalThis as Record<string, unknown>).SonareEmbindModuleFactory = moduleFactory;
    const instance = new registered({ processorOptions: { wasmBinary } });
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
    expect(init).toHaveBeenCalledWith({
      locateFile: expect.any(Function),
      wasmBinary,
      moduleFactory,
    });
    const options = init.mock.calls[0]?.[0] as { locateFile: (path: string) => string };
    expect(options.locateFile('sonare.wasm')).toBe('sonare.wasm');
    expect(instance.port.postMessage).toHaveBeenCalledWith({
      type: 'ready',
      runtimeTarget: 'embind',
    });
  });

  it('waits for an existing embind init promise and skips init when already initialized', async () => {
    const order: string[] = [];
    (globalThis as Record<string, unknown>).SonareEmbindInitPromise = Promise.resolve().then(() => {
      order.push('global-init');
    });
    isInitialized.mockReturnValue(true);
    await createReadyProcessor();
    order.push('ready');
    expect(order).toEqual(['global-init', 'ready']);
    expect(init).not.toHaveBeenCalled();
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

  it('subscribes through addEventListener when the port exposes EventTarget APIs', async () => {
    let listener: ((event: { data: unknown }) => void) | undefined;
    class EventTargetAudioWorkletProcessor {
      readonly port: FakePort = {
        onmessage: undefined,
        addEventListener: vi.fn((_type, nextListener) => {
          listener = nextListener;
        }),
        start: vi.fn(),
        postMessage: vi.fn(),
      };
    }
    const previousBase = (globalThis as Record<string, unknown>).AudioWorkletProcessor;
    (globalThis as Record<string, unknown>).AudioWorkletProcessor =
      EventTargetAudioWorkletProcessor;
    (globalThis as Record<string, unknown>).registerProcessor = (
      _name: string,
      ctor: RegisteredCtor,
    ) => {
      registered = ctor;
    };
    vi.resetModules();
    await import('@/engine/worklet-entry');
    const instance = await createReadyProcessor();
    listener?.({ data: { type: 'syncMixer' } });
    expect(instance.port.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(instance.port.start).toHaveBeenCalled();
    expect(receiveSync).toHaveBeenCalledWith({ type: 'syncMixer' });
    (globalThis as Record<string, unknown>).AudioWorkletProcessor = previousBase;
  });

  it('emits silence from process() until the bridge is ready', () => {
    const instance = new registered({ processorOptions: {} });
    const out = [new Float32Array([0.5, 0.5])];
    expect(instance.process([], [out])).toBe(true);
    expect(Array.from(out[0])).toEqual([0, 0]);
  });
});
