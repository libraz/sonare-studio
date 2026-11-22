import { afterEach, describe, expect, it, vi } from 'vitest';

type EngineCreateOptions = NonNullable<
  Parameters<typeof import('@/wasm/worklet.js').SonareEngine.create>[1]
>;

const hoisted = vi.hoisted(() => ({
  captured: [] as EngineCreateOptions[],
}));

vi.mock('@/wasm/worklet.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/wasm/worklet.js')>();
  return {
    ...actual,
    init: vi.fn(async () => undefined),
    SonareEngine: {
      create: vi.fn(async (_ctx: unknown, options: EngineCreateOptions) => {
        hoisted.captured.push(options);
        throw new Error('captured');
      }),
    },
  };
});
vi.mock('@/wasm/sonare.wasm?url', () => ({ default: '/sonare.wasm' }));

import { createEngine } from '@/engine/engine';
import { SonareRealtimeEngineNode } from '@/wasm/worklet.js';
import { fakeAudioContext } from './fakes/engine';

class NodeConstructionReached extends Error {}

describe('createEngine options', () => {
  afterEach(() => {
    hoisted.captured.length = 0;
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
