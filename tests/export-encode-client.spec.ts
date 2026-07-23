import { describe, expect, it, vi } from 'vitest';
import { encodeAudioInWorker } from '@/export/encode-client';
import type {
  AudioEncodeWorkerRequest,
  AudioEncodeWorkerResponse,
} from '@/workers/audio-encode.worker';

class FakeWorker {
  posted: AudioEncodeWorkerRequest[] = [];
  transfers: Transferable[][] = [];
  terminate = vi.fn();
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: AudioEncodeWorkerRequest, transfer: Transferable[]): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }

  emit(response: AudioEncodeWorkerResponse): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: response } as MessageEvent);
    }
  }
}

describe('encodeAudioInWorker', () => {
  it('transfers PCM to the worker and resolves its encoded bytes', async () => {
    const worker = new FakeWorker();
    const source = new Float32Array([0.25, -0.25]);
    const result = encodeAudioInWorker(
      'wav',
      [source],
      48000,
      { bitDepth: 24 },
      undefined,
      () => worker as unknown as Worker,
    );
    expect(worker.posted[0]).toMatchObject({
      type: 'encode',
      encoderId: 'wav',
      sampleRate: 48000,
      options: { bitDepth: 24 },
    });
    expect(worker.transfers[0]).toHaveLength(1);
    worker.emit({ type: 'encoded', bytes: new Uint8Array([1, 2, 3]) });
    await expect(result).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('forwards worker progress ticks without settling the encode', async () => {
    const worker = new FakeWorker();
    const fractions: number[] = [];
    const result = encodeAudioInWorker(
      'flac',
      [new Float32Array(16)],
      48000,
      {},
      undefined,
      () => worker as unknown as Worker,
      (fraction) => fractions.push(fraction),
    );
    worker.emit({ type: 'progress', fraction: 0.5 });
    worker.emit({ type: 'progress', fraction: 1 });
    expect(fractions).toEqual([0.5, 1]);
    // Progress must not resolve or terminate the worker prematurely.
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit({ type: 'encoded', bytes: new Uint8Array([9]) });
    await expect(result).resolves.toEqual(new Uint8Array([9]));
    // A late progress tick after settle is ignored (no throw).
    worker.emit({ type: 'progress', fraction: 0.75 });
    expect(fractions).toEqual([0.5, 1]);
  });

  it('terminates synchronous codec work immediately when cancelled', async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const result = encodeAudioInWorker(
      'flac',
      [new Float32Array(16)],
      48000,
      {},
      controller.signal,
      () => worker as unknown as Worker,
    );
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('omits non-protocol options such as signals and callbacks from worker messages', async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const result = encodeAudioInWorker(
      'wav',
      [new Float32Array(1)],
      48_000,
      { bitDepth: 16, signal: controller.signal, random: () => 0.5 },
      undefined,
      () => worker as unknown as Worker,
    );

    expect(worker.posted[0]?.options).toEqual({ bitDepth: 16 });
    worker.emit({ type: 'encoded', bytes: new Uint8Array([1]) });
    await expect(result).resolves.toEqual(new Uint8Array([1]));
  });
});
