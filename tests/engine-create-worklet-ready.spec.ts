import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@libraz/libsonare/wasm?url', () => ({ default: '/sonare.wasm' }));
vi.mock('@/lib/wasm', () => ({
  ensureWasm: vi.fn(async () => ({})),
}));

import { SonareEngine } from '@libraz/libsonare/worklet';
import { createEngine } from '@/engine/engine';

describe('createEngine worklet readiness', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not leave the readiness promise unhandled when engine creation throws', async () => {
    process.on('unhandledRejection', onUnhandled);
    const listeners = new Set<(event: MessageEvent) => void>();
    const port = {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        if (_type === 'message') listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        listeners.delete(listener);
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })),
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        close = vi.fn(async () => undefined);
      },
    );
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        port = port;
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
      },
    );
    vi.spyOn(SonareEngine, 'create').mockImplementation(async (_ctx, options) => {
      options.nodeFactory?.(_ctx, 'sonare', {});
      throw new Error('create failed');
    });

    await expect(createEngine()).rejects.toThrow('create failed');
    for (const listener of [...listeners]) {
      listener({ data: { type: 'error', message: 'late worklet failure' } } as MessageEvent);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandled).toEqual([]);
  });
});
