import { describe, expect, it, vi } from 'vitest';
import { isEngineVersionMismatchError, waitForWorkletReady } from '@/engine/engine';

class FakeMessagePort {
  private readonly listeners = {
    message: new Set<(event: MessageEvent) => void>(),
    messageerror: new Set<(event: MessageEvent) => void>(),
  };

  addEventListener(
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent) => void,
  ): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent) => void,
  ): void {
    this.listeners[type].delete(listener);
  }

  listenerCount(): number {
    return this.listeners.message.size + this.listeners.messageerror.size;
  }

  emit(data: unknown): void {
    for (const listener of [...this.listeners.message]) listener({ data } as MessageEvent);
  }

  emitMessageError(): void {
    for (const listener of [...this.listeners.messageerror]) listener({} as MessageEvent);
  }
}

class FakeProcessor {
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'processorerror', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'processorerror', listener: () => void): void {
    this.listeners.delete(listener);
  }

  emitError(): void {
    for (const listener of [...this.listeners]) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

describe('waitForWorkletReady', () => {
  it('resolves on ready and removes its message listener', async () => {
    const port = new FakeMessagePort();
    const ready = waitForWorkletReady(port);

    expect(port.listenerCount()).toBe(2);
    port.emit({ type: 'ready' });

    await expect(ready).resolves.toBeUndefined();
    expect(port.listenerCount()).toBe(0);
  });

  it('rejects on worklet error and removes its message listener', async () => {
    const port = new FakeMessagePort();
    const ready = waitForWorkletReady(port);

    expect(port.listenerCount()).toBe(2);
    port.emit({ type: 'error', message: 'wasm init failed' });

    await expect(ready).rejects.toThrow('wasm init failed');
    expect(port.listenerCount()).toBe(0);
  });

  it('rejects on messageerror and removes every listener', async () => {
    const port = new FakeMessagePort();
    const processor = new FakeProcessor();
    const ready = waitForWorkletReady(port, { processor });

    port.emitMessageError();

    await expect(ready).rejects.toThrow('could not be decoded');
    expect(port.listenerCount()).toBe(0);
    expect(processor.listenerCount()).toBe(0);
  });

  it('rejects when the processor crashes before ready', async () => {
    const port = new FakeMessagePort();
    const processor = new FakeProcessor();
    const ready = waitForWorkletReady(port, { processor });

    processor.emitError();

    await expect(ready).rejects.toThrow('crashed before initialization');
    expect(port.listenerCount()).toBe(0);
    expect(processor.listenerCount()).toBe(0);
  });

  it('times out and removes every listener', async () => {
    vi.useFakeTimers();
    try {
      const port = new FakeMessagePort();
      const ready = waitForWorkletReady(port, { timeoutMs: 25 });
      const rejected = expect(ready).rejects.toThrow('after 25 ms');

      await vi.advanceTimersByTimeAsync(25);

      await rejected;
      expect(port.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts immediately without retaining listeners', async () => {
    const port = new FakeMessagePort();
    const controller = new AbortController();
    controller.abort(new DOMException('Unmounted', 'AbortError'));

    await expect(waitForWorkletReady(port, { signal: controller.signal })).rejects.toThrow(
      'Unmounted',
    );
    expect(port.listenerCount()).toBe(0);
  });
});

describe('isEngineVersionMismatchError', () => {
  it('recognizes worklet ABI failures without classifying unrelated startup errors', () => {
    expect(isEngineVersionMismatchError(new Error('engine worklet ABI mismatch'))).toBe(true);
    expect(isEngineVersionMismatchError(new Error('AudioContext permission denied'))).toBe(false);
  });
});
