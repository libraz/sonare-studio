import { describe, expect, it, vi } from 'vitest';
import { analyzeAudioTagsInWorker } from '@/project/audio-analysis-client';
import type { AudioAnalysisWorkerResponse } from '@/workers/audio-analysis.worker';

/** A worker double that answers each request with the scripted messages. */
function fakeWorker(replies: AudioAnalysisWorkerResponse[] | 'never') {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const worker = {
    posted: [] as Array<{ message: unknown; transfer: Transferable[] }>,
    terminate: vi.fn(),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, new Set([...(listeners.get(type) ?? []), listener]));
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
    postMessage(message: unknown, transfer: Transferable[]) {
      worker.posted.push({ message, transfer });
      if (replies === 'never') return;
      queueMicrotask(() => {
        for (const data of replies) {
          for (const listener of listeners.get('message') ?? []) listener({ data });
        }
      });
    },
  };
  return worker;
}

describe('analyzeAudioTagsInWorker', () => {
  it('relays progress, resolves the tags and disposes the worker', async () => {
    const worker = fakeWorker([
      { type: 'progress', fraction: 0.4 },
      { type: 'progress', fraction: 1 },
      { type: 'done', tags: { bpm: 128.4, key: 'F#' } },
    ]);
    const progress: number[] = [];
    const mono = new Float32Array([0.1, 0.2]);

    const tags = await analyzeAudioTagsInWorker(mono, 48_000, {
      onProgress: (fraction) => progress.push(fraction),
      workerFactory: () => worker as unknown as Worker,
    });

    expect(tags).toEqual({ bpm: 128.4, key: 'F#' });
    expect(progress).toEqual([0.4, 1]);
    expect(worker.posted[0].transfer).toEqual([mono.buffer]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects with the worker error', async () => {
    const worker = fakeWorker([{ type: 'error', error: 'wasm failed' }]);
    await expect(
      analyzeAudioTagsInWorker(new Float32Array([1]), 48_000, {
        workerFactory: () => worker as unknown as Worker,
      }),
    ).rejects.toThrow('wasm failed');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('answers empty audio without starting a worker', async () => {
    const workerFactory = vi.fn();
    await expect(
      analyzeAudioTagsInWorker(new Float32Array(0), 48_000, { workerFactory }),
    ).resolves.toEqual({});
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it('terminates the worker when aborted', async () => {
    const worker = fakeWorker('never');
    const controller = new AbortController();
    const pending = analyzeAudioTagsInWorker(new Float32Array([1]), 48_000, {
      signal: controller.signal,
      workerFactory: () => worker as unknown as Worker,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
