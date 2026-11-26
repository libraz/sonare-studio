import { afterEach, describe, expect, it, vi } from 'vitest';

class Box {
  #value: number;
  constructor(value: number) {
    this.#value = value;
  }
  static of(value: number): Box {
    return new Box(value);
  }
  read(): number {
    return this.#value;
  }
  plus(other: Box): number {
    return this.#value + other.#value;
  }
}

const fakeModule = () => ({
  Box,
  double: (value: number) => value * 2,
  later: async (value: number) => new Box(value),
  VERSION: '1',
});

async function loadRecorder(enabled: boolean) {
  vi.resetModules();
  vi.stubEnv('VITE_SONARE_E2E', enabled ? '1' : '');
  return import('@/lib/api-recorder');
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { __sonareApiSink?: unknown }).__sonareApiSink;
});

describe('api-recorder', () => {
  it('returns the module untouched when the build does not record', async () => {
    const { recordModule } = await loadRecorder(false);
    const module = fakeModule();
    expect(recordModule(module)).toBe(module);
  });

  it('reports functions, constructions, statics and instance methods by name', async () => {
    const { recordModule, apiCalls } = await loadRecorder(true);
    const sonare = recordModule(fakeModule());
    expect(sonare.double(2)).toBe(4);
    const box = new sonare.Box(3);
    expect(box.read()).toBe(3);
    expect(sonare.Box.of(4).read()).toBe(4);
    expect((await sonare.later(5)).read()).toBe(5);
    expect(sonare.VERSION).toBe('1');
    expect(apiCalls()).toEqual(['Box#read', 'Box.of', 'double', 'later', 'new Box']);
  });

  it('hands libsonare the real object, so private fields work across recorded arguments', async () => {
    const { recordModule } = await loadRecorder(true);
    const sonare = recordModule(fakeModule());
    const left = new sonare.Box(1);
    const right = new sonare.Box(2);
    expect(left).toBeInstanceOf(Box);
    expect(left.plus(right)).toBe(3);
  });

  it('reports each call to the harness once per page until reset', async () => {
    const { recordModule, resetApiCalls, apiCalls } = await loadRecorder(true);
    const sink = vi.fn();
    (globalThis as { __sonareApiSink?: unknown }).__sonareApiSink = sink;
    const sonare = recordModule(fakeModule());
    sonare.double(1);
    sonare.double(2);
    expect(sink.mock.calls).toEqual([['double']]);
    resetApiCalls();
    expect(apiCalls()).toEqual([]);
    sonare.double(3);
    expect(sink.mock.calls).toEqual([['double'], ['double']]);
  });

  it('records an instance created outside a recorded module under its class name', async () => {
    const { recordObject, apiCalls } = await loadRecorder(true);
    const box = recordObject(new Box(7), 'Engine');
    expect(box.read()).toBe(7);
    expect(apiCalls()).toEqual(['Engine#read']);
  });

  it('records the latest worklet capture payload even when the call name is already recorded', async () => {
    const { recordObject, lastCaptureOptions, resetApiCalls } = await loadRecorder(true);
    const configureCapture = vi.fn();
    const engine = recordObject({ configureCapture }, 'SonareEngine');
    engine.configureCapture({ capacityFrames: 512 });
    const take = { capacityFrames: 48_000, punch: { startPpq: 0, endPpq: 2 } };
    engine.configureCapture(take);
    expect(configureCapture).toHaveBeenLastCalledWith(take);
    expect(lastCaptureOptions()).toEqual(take);
    resetApiCalls();
    expect(lastCaptureOptions()).toBeUndefined();
  });
});
