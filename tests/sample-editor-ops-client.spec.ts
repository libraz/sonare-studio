import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runSampleOperationInWorker,
  SampleOperationTimeoutError,
} from '@/ui/sample-editor/ops-client';
import type { SampleOperationResponse } from '@/workers/sample-ops.worker';

class FakeWorker {
  readonly messages: Array<{ request: unknown; transfer: Transferable[] }> = [];
  terminated = false;
  private readonly listeners = new Map<string, EventListener>();

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  postMessage(
    request: { channels: Float32Array[]; owned?: boolean },
    transfer: Transferable[],
  ): void {
    this.messages.push({ request, transfer });
    queueMicrotask(() => {
      this.listeners.get('message')?.({
        data: { type: 'done', channels: request.channels } satisfies SampleOperationResponse,
      } as MessageEvent);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

class SilentWorker extends FakeWorker {
  override postMessage(request: { channels: Float32Array[] }, transfer: Transferable[]): void {
    this.messages.push({ request, transfer });
  }
}

describe('runSampleOperationInWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('transfers copied channel buffers to a disposable worker', async () => {
    const worker = new FakeWorker();
    const source = [Float32Array.from([0.25, -0.5])];

    const result = await runSampleOperationInWorker(
      { type: 'gain', db: 3 },
      source,
      { startFrame: 0, endFrame: 2 },
      () => worker as unknown as Worker,
    );

    const request = worker.messages[0].request as { channels: Float32Array[]; type: string };
    expect(request.type).toBe('gain');
    expect((worker.messages[0].request as { owned?: boolean }).owned).toBe(true);
    expect(request.channels[0]).not.toBe(source[0]);
    expect(request.channels[0].buffer).not.toBe(source[0].buffer);
    expect(result).toEqual(source);
    expect(worker.terminated).toBe(true);
  });

  it('rejects and terminates an unresponsive worker at the timeout', async () => {
    vi.useFakeTimers();
    const worker = new SilentWorker();
    const pending = runSampleOperationInWorker(
      { type: 'silence' },
      [Float32Array.from([1, 2])],
      { startFrame: 0, endFrame: 2 },
      { workerFactory: () => worker as unknown as Worker, timeoutMs: 25 },
    );

    const assertion = expect(pending).rejects.toBeInstanceOf(SampleOperationTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(worker.terminated).toBe(true);
  });

  it('rejects and terminates when the owning operation is aborted', async () => {
    const controller = new AbortController();
    const worker = new FakeWorker();
    const pending = runSampleOperationInWorker(
      { type: 'silence' },
      [Float32Array.from([1, 2])],
      { startFrame: 0, endFrame: 2 },
      controller.signal,
      () => worker as unknown as Worker,
    );

    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(worker.terminated).toBe(true);
  });

  it('turns worker construction and postMessage failures into rejections', async () => {
    await expect(
      runSampleOperationInWorker(
        { type: 'silence' },
        [Float32Array.from([1])],
        { startFrame: 0, endFrame: 1 },
        () => {
          throw new Error('worker construction failed');
        },
      ),
    ).rejects.toThrow('worker construction failed');

    class ThrowingWorker extends FakeWorker {
      override postMessage(): void {
        throw new Error('postMessage failed');
      }
    }
    const worker = new ThrowingWorker();
    await expect(
      runSampleOperationInWorker(
        { type: 'silence' },
        [Float32Array.from([1])],
        { startFrame: 0, endFrame: 1 },
        () => worker as unknown as Worker,
      ),
    ).rejects.toThrow('postMessage failed');
    expect(worker.terminated).toBe(true);
  });
});
