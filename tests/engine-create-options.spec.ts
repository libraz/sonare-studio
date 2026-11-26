import { afterEach, describe, expect, it, vi } from 'vitest';

type EngineCreateOptions = NonNullable<
  Parameters<typeof import('@libraz/libsonare/worklet').SonareEngine.create>[1]
>;

const hoisted = vi.hoisted(() => ({
  captured: [] as EngineCreateOptions[],
}));

vi.mock('@/lib/wasm', () => ({
  ensureWasm: vi.fn(async () => ({})),
}));
vi.mock('@libraz/libsonare/wasm?url', () => ({ default: '/sonare.wasm' }));

import { SonareEngine, SonareRealtimeEngineNode } from '@libraz/libsonare/worklet';
import { createEngine } from '@/engine/engine';
import { fakeAudioContext } from './fakes/engine';

class NodeConstructionReached extends Error {}

describe('createEngine options', () => {
  afterEach(() => {
    hoisted.captured.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('builds options the real engine accepts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })),
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        sampleRate = 48000;
        close = vi.fn(async () => undefined);
      },
    );
    vi.spyOn(SonareEngine, 'create').mockImplementation(async (_ctx, options) => {
      hoisted.captured.push(options as EngineCreateOptions);
      throw new Error('captured');
    });
    await expect(createEngine()).rejects.toThrow('captured');
    const [options] = hoisted.captured;
    expect(options).toBeDefined();

    // The engine validates every option before it builds the worklet node, so
    // reaching the node factory proves the app's options passed validation.
    const create = SonareRealtimeEngineNode.create(fakeAudioContext({ sampleRate: 48000 }), {
      ...options,
      moduleUrl: undefined,
      engineAbiVersion: 1,
      nodeFactory: () => {
        throw new NodeConstructionReached();
      },
    });
    await expect(create).rejects.toBeInstanceOf(NodeConstructionReached);
  });
});
