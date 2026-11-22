import { beforeAll, describe, expect, it, vi } from 'vitest';

const { bridgeProcess, voiceProcess, retuneProcessMono } = vi.hoisted(() => ({
  bridgeProcess: vi.fn((): boolean => true),
  voiceProcess: vi.fn((): boolean => true),
  retuneProcessMono: vi.fn((samples: Float32Array) => samples),
}));

vi.mock('@libraz/libsonare/worklet', () => ({
  init: vi.fn(() => Promise.resolve()),
  isInitialized: vi.fn(() => false),
  SonareRealtimeEngineWorkletProcessor: class {
    process = bridgeProcess;
  },
  SonareRealtimeVoiceChangerWorkletProcessor: class {
    process = voiceProcess;
  },
}));

vi.mock('@libraz/libsonare', () => ({
  init: vi.fn(() => Promise.resolve()),
  isInitialized: vi.fn(() => false),
  StreamingRetune: class {
    prepare = vi.fn();
    processMono = retuneProcessMono;
  },
}));

type Processor = {
  port: { postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};
type ProcessorCtor = new (options?: { processorOptions?: Record<string, unknown> }) => Processor;

const registered = new Map<string, ProcessorCtor>();

beforeAll(async () => {
  (globalThis as Record<string, unknown>).AudioWorkletProcessor = class {
    readonly port = { postMessage: vi.fn() };
  };
  (globalThis as Record<string, unknown>).registerProcessor = (
    name: string,
    ctor: ProcessorCtor,
  ) => {
    registered.set(name, ctor);
  };
  await import('@/engine/worklet-entry');
});

async function readyProcessor(name: string): Promise<Processor> {
  const ctor = registered.get(name);
  if (!ctor) throw new Error(`Processor was not registered: ${name}`);
  const instance = new ctor({ processorOptions: { blockSize: 4, channelCount: 1 } });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  return instance;
}

describe('worklet process() failure', () => {
  const failing: Array<[string, () => void]> = [
    [
      'sonare-realtime-engine-processor',
      () =>
        bridgeProcess.mockImplementationOnce(() => {
          throw new Error('boom');
        }),
    ],
    [
      'sonare-realtime-voice-changer-processor',
      () =>
        voiceProcess.mockImplementationOnce(() => {
          throw new Error('boom');
        }),
    ],
    [
      'sonare-streaming-retune-processor',
      () =>
        retuneProcessMono.mockImplementationOnce(() => {
          throw new Error('boom');
        }),
    ],
  ];

  it.each(failing)('%s posts runtimeError, silences the block and stops', async (name, arm) => {
    const processor = await readyProcessor(name);
    arm();
    const output = new Float32Array([0.5, 0.5, 0.5, 0.5]);

    const keepAlive = processor.process([[new Float32Array(4)]], [[output]]);

    expect(keepAlive).toBe(false);
    expect([...output]).toEqual([0, 0, 0, 0]);
    expect(processor.port.postMessage).toHaveBeenCalledWith({
      type: 'runtimeError',
      message: 'boom',
    });
  });
});
