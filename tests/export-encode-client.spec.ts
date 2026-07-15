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
});
