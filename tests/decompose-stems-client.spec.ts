import { describe, expect, it } from 'vitest';
import { decomposeStemsInWorker } from '@/project/decompose-stems-client';
import type { DecomposeStemsWorkerResponse } from '@/workers/decompose-stems.worker';

class FakeWorker {
  readonly messages: Array<{ request: unknown; transfer: Transferable[] }> = [];
  terminated = false;
  protected readonly listeners = new Map<string, EventListener>();

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  postMessage(
    request: { channels: Float32Array[]; nComponents: number },
    transfer: Transferable[],
  ): void {
    this.messages.push({ request, transfer });
    queueMicrotask(() => {
      const components = Array.from({ length: request.nComponents }, () => request.channels);
      this.listeners.get('message')?.({
        data: { type: 'done', components } satisfies DecomposeStemsWorkerResponse,
      } as MessageEvent);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

class SilentWorker extends FakeWorker {
  override postMessage(): void {
    // Never responds; used to exercise abort handling.
  }
}

describe('decomposeStemsInWorker', () => {
  it('transfers copied channel buffers and returns the round-tripped components', async () => {
    const worker = new FakeWorker();
    const source = [Float32Array.from([0.25, -0.5]), Float32Array.from([0.1, 0.2])];

    const result = await decomposeStemsInWorker(source, 48000, 2, {
      workerFactory: () => worker as unknown as Worker,
    });

    const request = worker.messages[0].request as {
      channels: Float32Array[];
      sampleRate: number;
      nComponents: number;
    };
    expect(request.sampleRate).toBe(48000);
    expect(request.nComponents).toBe(2);
    expect(request.channels[0]).not.toBe(source[0]);
    expect(request.channels[0].buffer).not.toBe(source[0].buffer);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(source);
    expect(worker.terminated).toBe(true);
  });

  it('rejects and terminates when the owning operation is aborted', async () => {
    const controller = new AbortController();
    const worker = new SilentWorker();
    const pending = decomposeStemsInWorker([Float32Array.from([1, 2])], 48000, 4, {
      signal: controller.signal,
      workerFactory: () => worker as unknown as Worker,
    });

    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(worker.terminated).toBe(true);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = new FakeWorker();

    await expect(
      decomposeStemsInWorker([Float32Array.from([1])], 48000, 2, {
        signal: controller.signal,
        workerFactory: () => worker as unknown as Worker,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.messages).toHaveLength(0);
  });

  it('turns worker construction and postMessage failures into rejections', async () => {
    await expect(
      decomposeStemsInWorker([Float32Array.from([1])], 48000, 2, {
        workerFactory: () => {
          throw new Error('worker construction failed');
        },
      }),
    ).rejects.toThrow('worker construction failed');

    class ThrowingWorker extends FakeWorker {
      override postMessage(): void {
        throw new Error('postMessage failed');
      }
    }
    const worker = new ThrowingWorker();
    await expect(
      decomposeStemsInWorker([Float32Array.from([1])], 48000, 2, {
        workerFactory: () => worker as unknown as Worker,
      }),
    ).rejects.toThrow('postMessage failed');
    expect(worker.terminated).toBe(true);
  });

  it('rejects on a worker error event', async () => {
    class ErroringWorker extends FakeWorker {
      override postMessage(): void {
        queueMicrotask(() => {
          this.listeners.get('error')?.({ message: 'worker crashed' } as ErrorEvent);
        });
      }
    }
    const worker = new ErroringWorker();
    await expect(
      decomposeStemsInWorker([Float32Array.from([1])], 48000, 2, {
        workerFactory: () => worker as unknown as Worker,
      }),
    ).rejects.toThrow('worker crashed');
  });
});
