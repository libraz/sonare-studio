import { describe, expect, it } from 'vitest';
import { runDisposableWorker } from '@/lib/disposable-worker';

class EventWorker {
  terminated = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(): void {}

  terminate(): void {
    this.terminated = true;
  }

  fire(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event);
  }
}

describe('runDisposableWorker', () => {
  it('rejects and terminates the worker when a reply handler throws', async () => {
    const worker = new EventWorker();
    const run = runDisposableWorker<unknown, number>({
      create: () => worker as unknown as Worker,
      abortMessage: 'aborted',
      failMessage: 'failed',
      post: () => {},
      receive: () => {
        throw new TypeError('malformed reply');
      },
    });
    worker.fire('message', { data: { bogus: true } });
    await expect(run).rejects.toThrow('malformed reply');
    expect(worker.terminated).toBe(true);
  });
});
