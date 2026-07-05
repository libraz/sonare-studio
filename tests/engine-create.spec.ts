import { describe, expect, it } from 'vitest';
import { waitForWorkletReady } from '@/engine/engine';

class FakeMessagePort {
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  emit(data: unknown): void {
    for (const listener of [...this.listeners]) listener({ data } as MessageEvent);
  }
}

describe('waitForWorkletReady', () => {
  it('resolves on ready and removes its message listener', async () => {
    const port = new FakeMessagePort();
    const ready = waitForWorkletReady(port);

    expect(port.listenerCount()).toBe(1);
    port.emit({ type: 'ready' });

    await expect(ready).resolves.toBeUndefined();
    expect(port.listenerCount()).toBe(0);
  });

  it('rejects on worklet error and removes its message listener', async () => {
    const port = new FakeMessagePort();
    const ready = waitForWorkletReady(port);

    expect(port.listenerCount()).toBe(1);
    port.emit({ type: 'error', message: 'wasm init failed' });

    await expect(ready).rejects.toThrow('wasm init failed');
    expect(port.listenerCount()).toBe(0);
  });
});
