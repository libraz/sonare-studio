import { describe, expect, it } from 'vitest';
import { transcribeAudioInWorker } from '@/project/transcribe-client';
import type { TranscribeWorkerResponse } from '@/workers/transcribe.worker';

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

  postMessage(request: unknown, transfer: Transferable[]): void {
    this.messages.push({ request, transfer });
    queueMicrotask(() => {
      this.listeners.get('message')?.({
        data: {
          type: 'done',
          events: [
            { ppq: 0, data0: 0x20903c64, data1: 0 },
            { ppq: 1, data0: 0x20803c00, data1: 0 },
          ],
          noteCount: 1,
          tempoBpm: 60,
        } satisfies TranscribeWorkerResponse,
      } as MessageEvent);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

class SilentWorker extends FakeWorker {
  override postMessage(request: unknown, transfer: Transferable[]): void {
    this.messages.push({ request, transfer });
  }
}

describe('transcribeAudioInWorker', () => {
  it('copies and transfers mono input, then validates the result', async () => {
    const worker = new FakeWorker();
    const source = Float32Array.from([0.25, -0.5]);
    const result = await transcribeAudioInWorker(source, 48_000, false, {
      workerFactory: () => worker as unknown as Worker,
    });

    const message = worker.messages[0];
    const request = message.request as {
      samples: Float32Array;
      sampleRate: number;
      polyphonic: boolean;
    };
    expect(request.samples).not.toBe(source);
    expect(request.samples.buffer).not.toBe(source.buffer);
    expect(message.transfer).toEqual([request.samples.buffer]);
    expect(request.sampleRate).toBe(48_000);
    expect(request.polyphonic).toBe(false);
    expect(result.noteCount).toBe(1);
    expect(worker.terminated).toBe(true);
  });

  it('passes an original high sample rate for worker-side WASM resampling', async () => {
    const worker = new FakeWorker();
    const result = await transcribeAudioInWorker(Float32Array.from([0.25, -0.5]), 48_000, true, {
      sourceSampleRate: 96_000,
      workerFactory: () => worker as unknown as Worker,
    });
    const request = worker.messages[0]?.request as {
      sampleRate: number;
      sourceSampleRate?: number;
      polyphonic: boolean;
    };
    expect(request.sampleRate).toBe(48_000);
    expect(request.sourceSampleRate).toBe(96_000);
    expect(request.polyphonic).toBe(true);
    expect(result.noteCount).toBe(1);
  });

  it('terminates and rejects when the request is aborted', async () => {
    const controller = new AbortController();
    const worker = new SilentWorker();
    const pending = transcribeAudioInWorker(Float32Array.from([1, 2]), 48_000, true, {
      signal: controller.signal,
      workerFactory: () => worker as unknown as Worker,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(worker.terminated).toBe(true);
  });

  it('does not construct a worker for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    let created = false;
    await expect(
      transcribeAudioInWorker(Float32Array.from([1]), 48_000, false, {
        signal: controller.signal,
        workerFactory: () => {
          created = true;
          return new FakeWorker() as unknown as Worker;
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(created).toBe(false);
  });

  it('rejects malformed worker messages and always disposes the worker', async () => {
    class InvalidWorker extends FakeWorker {
      override postMessage(): void {
        queueMicrotask(() => {
          this.listeners.get('message')?.({ data: { type: 'done', events: [] } } as MessageEvent);
        });
      }
    }
    const worker = new InvalidWorker();
    await expect(
      transcribeAudioInWorker(Float32Array.from([1]), 48_000, false, {
        workerFactory: () => worker as unknown as Worker,
      }),
    ).rejects.toThrow('invalid response');
    expect(worker.terminated).toBe(true);
  });
});
