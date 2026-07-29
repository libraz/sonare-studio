import { describe, expect, it } from 'vitest';
import { runSampleOperationInWorker } from '@/ui/sample-editor/ops-client';
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

  postMessage(request: { channels: Float32Array[] }, transfer: Transferable[]): void {
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

describe('runSampleOperationInWorker', () => {
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
    expect(request.channels[0]).not.toBe(source[0]);
    expect(request.channels[0].buffer).not.toBe(source[0].buffer);
    expect(result).toEqual(source);
    expect(worker.terminated).toBe(true);
  });
});
