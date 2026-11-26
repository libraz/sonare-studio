import type { StreamingRetuneConfig } from '@libraz/libsonare/worklet';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreWasmBinary } from './core-package';

const realCoreWasmBinary = coreWasmBinary();

const {
  init,
  isInitialized,
  engineReceiveMessage,
  voiceReceiveMessage,
  retuneSetConfig,
  retuneReset,
  retuneDestroy,
  retuneProcessMono,
  bridgeProcess,
} = vi.hoisted(() => ({
  init: vi.fn<typeof import('@libraz/libsonare/worklet').init>(() => Promise.resolve()),
  isInitialized: vi.fn(() => false),
  engineReceiveMessage: vi.fn(),
  voiceReceiveMessage: vi.fn(),
  retuneSetConfig: vi.fn(),
  retuneReset: vi.fn(),
  retuneDestroy: vi.fn(),
  retuneProcessMono: vi.fn((samples: Float32Array) => samples),
  bridgeProcess: vi.fn(() => true),
}));

vi.mock('@libraz/libsonare/worklet', () => ({
  init,
  isInitialized,
  SonareRealtimeEngineWorkletProcessor: class {
    receiveMessage = engineReceiveMessage;
    process = bridgeProcess;
  },
  SonareRealtimeVoiceChangerWorkletProcessor: class {
    receiveMessage = voiceReceiveMessage;
    process(): boolean {
      return true;
    }
  },
  StreamingRetune: class
    implements Partial<InstanceType<typeof import('@libraz/libsonare/worklet').StreamingRetune>>
  {
    constructor(readonly initialConfig?: StreamingRetuneConfig) {}
    prepare = vi.fn();
    setConfig = retuneSetConfig;
    reset = retuneReset;
    destroy = retuneDestroy;
    processMono = retuneProcessMono;
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

const registered = new Map<string, RegisteredCtor>();

beforeAll(async () => {
  class FakeAudioWorkletProcessor {
    readonly port: FakePort = {
      onmessage: undefined,
      postMessage: vi.fn(),
    };
  }
  (globalThis as Record<string, unknown>).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as Record<string, unknown>).registerProcessor = (
    name: string,
    ctor: RegisteredCtor,
  ) => {
    registered.set(name, ctor);
  };
  await import('@/engine/worklet-entry');
});

beforeEach(() => {
  init.mockClear();
  isInitialized.mockClear();
  isInitialized.mockReturnValue(false);
  engineReceiveMessage.mockClear();
  voiceReceiveMessage.mockClear();
  retuneSetConfig.mockClear();
  retuneReset.mockClear();
  retuneDestroy.mockClear();
  retuneProcessMono.mockClear();
  retuneProcessMono.mockImplementation((samples: Float32Array) => samples);
  bridgeProcess.mockClear();
  bridgeProcess.mockReturnValue(true);
  delete (globalThis as Record<string, unknown>).SonareEmbindInitPromise;
});

/** Instantiates the registered processor and drains its async init chain. */
async function createReadyProcessor(name = 'sonare-realtime-engine-processor') {
  const ctor = registered.get(name);
  if (!ctor) throw new Error(`Processor was not registered: ${name}`);
  const instance = new ctor({ processorOptions: {} });
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
  return instance;
}

describe('worklet-entry dispatch', () => {
  it('registers the processor and posts ready after init', async () => {
    expect([...registered.keys()]).toEqual([
      'sonare-realtime-engine-processor',
      'sonare-realtime-voice-changer-processor',
      'sonare-streaming-retune-processor',
    ]);
    const instance = await createReadyProcessor();
    expect(instance.port.postMessage).toHaveBeenCalledWith({
      type: 'ready',
      runtimeTarget: 'embind',
    });
  });

  it('reports a runtime bridge exception before stopping the processor', async () => {
    bridgeProcess.mockImplementationOnce(() => {
      throw new Error('native process failed');
    });
    const instance = await createReadyProcessor();
    const output = new Float32Array(8).fill(1);

    expect(instance.process([[]], [[output]])).toBe(false);
    expect(output).toEqual(new Float32Array(8));
    expect(instance.port.postMessage).toHaveBeenCalledWith({
      type: 'runtimeError',
      message: 'native process failed',
    });
  });

  it('registers streaming retune and forwards config/reset/destroy controls', async () => {
    const instance = await createReadyProcessor('sonare-streaming-retune-processor');
    expect(instance.port.postMessage).toHaveBeenCalledWith({
      type: 'ready',
      runtimeTarget: 'embind',
    });
    const retuneConfig: StreamingRetuneConfig = { pitchSemitones: 7, mix: 0.5 };
    instance.port.onmessage?.({ data: { type: 'setConfig', config: retuneConfig } });
    instance.port.onmessage?.({ data: { type: 'reset' } });
    instance.port.onmessage?.({ data: { type: 'destroy' } });
    expect(retuneSetConfig).toHaveBeenCalledWith(retuneConfig);
    expect(retuneReset).toHaveBeenCalledTimes(1);
    expect(retuneDestroy).toHaveBeenCalledTimes(1);
  });

  it('keeps 16k realtime retune quanta free of transient TypedArray views', async () => {
    const instance = await createReadyProcessor('sonare-streaming-retune-processor');
    const input = new Float32Array(128).fill(0.25);
    const output = new Float32Array(128);
    const subarray = vi.spyOn(Float32Array.prototype, 'subarray');
    const slice = vi.spyOn(Float32Array.prototype, 'slice');

    try {
      for (let block = 0; block < 16_384; block += 1) {
        expect(instance.process([[input]], [[output]])).toBe(true);
      }
    } finally {
      subarray.mockRestore();
      slice.mockRestore();
    }

    expect(subarray).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
    expect(retuneProcessMono).toHaveBeenCalledTimes(16_384);
    expect(retuneProcessMono.mock.calls.every(([samples]) => samples === input)).toBe(true);
    expect(output[0]).toBe(0.25);
  });

  it('registers realtime voice changer and forwards control messages', async () => {
    const instance = await createReadyProcessor('sonare-realtime-voice-changer-processor');
    expect(instance.port.postMessage).toHaveBeenCalledWith({
      type: 'ready',
      runtimeTarget: 'embind',
    });
    const setConfig = { type: 'setConfig', preset: 'brightIdol' };
    const reset = { type: 'reset' };
    const destroy = { type: 'destroy' };
    instance.port.onmessage?.({ data: setConfig });
    instance.port.onmessage?.({ data: reset });
    instance.port.onmessage?.({ data: destroy });
    expect(voiceReceiveMessage).toHaveBeenCalledTimes(3);
    expect(voiceReceiveMessage).toHaveBeenNthCalledWith(1, setConfig);
    expect(voiceReceiveMessage).toHaveBeenNthCalledWith(2, reset);
    expect(voiceReceiveMessage).toHaveBeenNthCalledWith(3, destroy);
  });

  it('forwards every voice changer message to the bridge, which validates it', async () => {
    const instance = await createReadyProcessor('sonare-realtime-voice-changer-processor');
    const messages = [
      { type: 'noteOn', note: 60, velocity: 0.8 },
      { type: 'noteOff', note: 60 },
      { type: 'allNotesOff' },
      { type: 'status', requestId: 1 },
    ];
    for (const data of messages) instance.port.onmessage?.({ data });
    expect(voiceReceiveMessage.mock.calls.map(([message]) => message)).toEqual(messages);
  });

  it('initializes embind with supplied wasm bytes and the package module factory', async () => {
    const wasmBinary = new ArrayBuffer(8);
    const { default: moduleFactory } = await import('@libraz/libsonare/module');
    const ctor = registered.get('sonare-realtime-engine-processor');
    expect(ctor).toBeDefined();
    const instance = new (ctor as RegisteredCtor)({ processorOptions: { wasmBinary } });
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
    expect(init).toHaveBeenCalledWith({
      locateFile: expect.any(Function),
      wasmBinary,
      moduleFactory,
    });
    expect(init.mock.calls[0]?.[0]?.locateFile?.('sonare.wasm', '')).toBe('sonare.wasm');
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

  it('forwards commands, sync messages and RPCs through the public worklet dispatcher', async () => {
    const instance = await createReadyProcessor();
    const messages = [
      { type: 10, targetId: 0, renderFrame: -1, argInt: 1 },
      { type: 'syncCapture', source: 'input', bufferFrames: 512 },
      { type: 'syncInputMonitor', monitor: { enabled: true, gain: 0.5 } },
      { type: 'captureRequest', requestId: 7, op: 'status' },
      { type: 'transportRequest', requestId: 8 },
      { type: 'insertGainReductionRequest', requestId: 9, targetId: 0 },
      { type: 'engineReadRequest', requestId: 10, op: 'articulation' },
      { type: 'futureRequest', syncSequence: 9 },
      null,
    ];
    for (const data of messages) {
      instance.port.onmessage?.({ data });
    }
    expect(engineReceiveMessage.mock.calls).toEqual(messages.map((message) => [message]));
  });

  it('buffers messages that arrive before init completes and replays them in order', async () => {
    const ctor = registered.get('sonare-realtime-engine-processor');
    expect(ctor).toBeDefined();
    const instance = new (ctor as RegisteredCtor)({ processorOptions: {} });
    instance.port.onmessage?.({ data: { type: 'syncMixer' } });
    instance.port.onmessage?.({ data: { type: 11, targetId: 1, renderFrame: -1 } });
    expect(engineReceiveMessage).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
    expect(engineReceiveMessage.mock.calls).toEqual([
      [{ type: 'syncMixer' }],
      [{ type: 11, targetId: 1, renderFrame: -1 }],
    ]);
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
    registered.clear();
    (globalThis as Record<string, unknown>).registerProcessor = (
      name: string,
      ctor: RegisteredCtor,
    ) => {
      registered.set(name, ctor);
    };
    vi.resetModules();
    await import('@/engine/worklet-entry');
    const instance = await createReadyProcessor();
    listener?.({ data: { type: 'syncMixer' } });
    expect(instance.port.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(instance.port.start).toHaveBeenCalled();
    expect(engineReceiveMessage).toHaveBeenCalledWith({ type: 'syncMixer' });
    (globalThis as Record<string, unknown>).AudioWorkletProcessor = previousBase;
  });

  it('emits silence from process() until the bridge is ready', () => {
    const ctor = registered.get('sonare-realtime-engine-processor');
    expect(ctor).toBeDefined();
    const instance = new (ctor as RegisteredCtor)({ processorOptions: {} });
    const out = [new Float32Array([0.5, 0.5])];
    expect(instance.process([], [out])).toBe(true);
    expect(Array.from(out[0])).toEqual([0, 0]);
  });
});

describe('real engine worklet message admission', () => {
  it('reports malformed messages as coded sync errors without throwing', async () => {
    const actual = await vi.importActual<typeof import('@libraz/libsonare/worklet')>(
      '@libraz/libsonare/worklet',
    );
    await actual.init({ wasmBinary: realCoreWasmBinary });
    const postMessage = vi.fn();
    const processor = new actual.SonareRealtimeEngineWorkletProcessor({
      sampleRate: 48000,
      maxBlockSize: 128,
      numChannels: 2,
      transport: { postMessage },
    });

    try {
      for (const message of [42, 'sync', {}, null]) {
        expect(() => processor.receiveMessage(message)).not.toThrow();
      }

      const replies = postMessage.mock.calls.map(([message]) => message);
      expect(replies).toHaveLength(4);
      for (const reply of replies) {
        expect(reply).toMatchObject({
          type: 'syncError',
          message: 'Unrecognized worklet message: undefined',
          failure: { name: 'TypeError' },
        });
      }
    } finally {
      processor.destroy();
    }
  });
});

describe('streaming retune config against the real core', () => {
  it('applies the config the worklet forwards', async () => {
    const actual = await vi.importActual<typeof import('@libraz/libsonare/worklet')>(
      '@libraz/libsonare/worklet',
    );
    await actual.init({ wasmBinary: realCoreWasmBinary });
    const retune = new actual.StreamingRetune();
    try {
      retune.prepare(48000, 128);
      const config: StreamingRetuneConfig = { pitchSemitones: 7, mix: 0.5 };
      retune.setConfig(config);
      expect(retune.config()).toMatchObject(config);
    } finally {
      retune.destroy();
    }
  });
});
