import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeBeatAccentsInWorker } from '@/project/audio-analysis-client';
import type { AudioAnalysisWorkerResponse } from '@/workers/audio-analysis.worker';

const ensureWasmMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/wasm', () => ({ ensureWasm: ensureWasmMock }));

/** A worker double that answers a request with one scripted message. */
function fakeWorker(reply: AudioAnalysisWorkerResponse | 'never') {
  const listeners: Array<(event: unknown) => void> = [];
  const worker = {
    posted: [] as unknown[],
    terminate: vi.fn(),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'message') listeners.push(listener);
    },
    removeEventListener: () => {},
    postMessage(message: unknown) {
      worker.posted.push(message);
      if (reply === 'never') return;
      queueMicrotask(() => {
        for (const listener of listeners) listener({ data: reply });
      });
    },
  };
  return worker;
}

describe('beat accent analysis in the worker client', () => {
  it('resolves the beat times and strengths and disposes the worker', async () => {
    const worker = fakeWorker({ type: 'meter', beatTimes: [0, 0.5], beatStrengths: [1, 0.4] });
    const result = await analyzeBeatAccentsInWorker(new Float32Array([0.1, 0.2]), 48000, {
      workerFactory: () => worker as unknown as Worker,
    });
    expect(result).toEqual({ beatTimes: [0, 0.5], beatStrengths: [1, 0.4] });
    expect(worker.posted[0]).toMatchObject({ kind: 'meter', sampleRate: 48000 });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending request and terminates the worker', async () => {
    const worker = fakeWorker('never');
    const controller = new AbortController();
    const pending = analyzeBeatAccentsInWorker(new Float32Array([0.1]), 48000, {
      signal: controller.signal,
      workerFactory: () => worker as unknown as Worker,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('analysis worker meter request', () => {
  afterEach(() => {
    vi.resetModules();
    ensureWasmMock.mockReset();
  });

  it('runs the full analysis in the worker and returns the beat accents', async () => {
    const analyze = vi.fn(() => ({
      beats: [{ timeSec: 0 }, { timeSec: 0.5 }],
      beatObservations: { onsetStrength: [0.9, 0.3] },
    }));
    ensureWasmMock.mockResolvedValue({ analyze });
    const posted: unknown[] = [];
    let handler: ((event: MessageEvent<unknown>) => void) | undefined;
    vi.stubGlobal('self', {
      addEventListener: (_type: string, fn: (event: MessageEvent<unknown>) => void) => {
        handler = fn;
      },
    });
    vi.stubGlobal('postMessage', (message: unknown) => posted.push(message));
    await import('@/workers/audio-analysis.worker');
    handler?.({
      data: { kind: 'meter', samples: new Float32Array(4), sampleRate: 44100 },
    } as MessageEvent<unknown>);
    await vi.waitFor(() => expect(posted.length).toBe(1));
    expect(analyze).toHaveBeenCalledWith(expect.any(Float32Array), 44100);
    expect(posted[0]).toEqual({
      type: 'meter',
      beatTimes: [0, 0.5],
      beatStrengths: [0.9, 0.3],
    });
    vi.unstubAllGlobals();
  });
});
