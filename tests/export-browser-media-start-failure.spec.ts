import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBrowserMedia } from '@/export/browser-media';

class CountingTarget extends EventTarget {
  readonly listeners = new Map<string, number>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    super.addEventListener(type, listener);
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    super.removeEventListener(type, listener);
    this.listeners.set(type, Math.max(0, (this.listeners.get(type) ?? 0) - 1));
  }

  get listenerTotal(): number {
    return [...this.listeners.values()].reduce((sum, count) => sum + count, 0);
  }
}

class ThrowingSource extends CountingTarget {
  static last: ThrowingSource | null = null;
  buffer: unknown = null;

  constructor() {
    super();
    ThrowingSource.last = this;
  }

  connect(): void {}

  start(): void {
    throw new Error('source refused to start');
  }

  stop(): void {}
}

class FakeContext {
  readonly sampleRate = 48000;
  state = 'running';
  currentTime = 0;
  closed = false;

  createMediaStreamDestination() {
    return { stream: {} };
  }

  createBuffer() {
    return { copyToChannel() {} };
  }

  createBufferSource() {
    return new ThrowingSource();
  }

  async resume(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeRecorder extends CountingTarget {
  static last: FakeRecorder | null = null;
  state = 'inactive';

  constructor() {
    super();
    FakeRecorder.last = this;
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
  }
}

describe('browser media start failure', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeRecorder.last = null;
    ThrowingSource.last = null;
  });

  it('releases listeners, timers and the recorder when the source cannot start', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('MediaRecorder', FakeRecorder);

    await expect(
      encodeBrowserMedia('audio/webm;codecs=opus', [new Float32Array(2048)], 48_000),
    ).rejects.toThrow('source refused to start');

    expect(vi.getTimerCount()).toBe(0);
    expect(FakeRecorder.last?.listenerTotal).toBe(0);
    expect(ThrowingSource.last?.listenerTotal).toBe(0);
    expect(FakeRecorder.last?.state).toBe('inactive');
  });
});
