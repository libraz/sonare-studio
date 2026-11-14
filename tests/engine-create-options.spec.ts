import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  captured: [] as Record<string, unknown>[],
}));

vi.mock('@/wasm/worklet.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/wasm/worklet.js')>();
  return {
    ...actual,
    init: vi.fn(async () => undefined),
    SonareEngine: {
      create: vi.fn(async (_ctx: unknown, options: Record<string, unknown>) => {
        hoisted.captured.push(options);
        throw new Error('captured');
      }),
    },
  };
});
vi.mock('@/wasm/sonare.wasm?url', () => ({ default: '/sonare.wasm' }));

import { createEngine } from '@/engine/engine';
import { SonareRealtimeEngineNode } from '@/wasm/worklet.js';

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
    const create = SonareRealtimeEngineNode.create(
      { sampleRate: 48000 } as unknown as BaseAudioContext,
      {
        ...options,
        moduleUrl: undefined,
        engineAbiVersion: 1,
        nodeFactory: () => {
          throw new NodeConstructionReached();
        },
      } as Parameters<typeof SonareRealtimeEngineNode.create>[1],
    );
    await expect(create).rejects.toBeInstanceOf(NodeConstructionReached);
  });
});
