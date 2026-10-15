import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeExportClient,
  ExportClient,
  ExportWorkerError,
  getExportClient,
  MasteringBufferLimitError,
} from '@/export/client';
import { MixdownCancelledError } from '@/export/mixdown';
import type { ProjectDocument } from '@/project/serialization';
import type { ExportRequest, ExportResponse } from '@/workers/export.worker';

/** Minimal Worker double capturing posted messages and replaying responses. */
class FakeWorker {
  posted: ExportRequest[] = [];
  terminate = vi.fn();
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  postMessage(message: ExportRequest): void {
    this.posted.push(message);
  }

  emit(response: ExportResponse): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: response } as MessageEvent);
    }
  }

  emitError(message: string): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener({ message } as ErrorEvent);
    }
  }
}

function makeDoc(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Client test',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    tracks: [],
    markers: [],
    sections: [],
  };
}

describe('ExportClient', () => {
  let worker: FakeWorker;
  let client: ExportClient;

  beforeEach(() => {
    worker = new FakeWorker();
    client = new ExportClient(worker as unknown as Worker);
  });

  afterEach(() => {
    disposeExportClient();
    vi.unstubAllGlobals();
  });

  it('posts a render request with a correlation id and options', () => {
    client.renderMixdown(makeDoc(), { sampleRate: 44100, stems: true });
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({
      id: 1,
      type: 'render',
      options: { sampleRate: 44100, stems: true },
    });
  });

  it('resolves the render with reassembled channels and stems', async () => {
    const handle = client.renderMixdown(makeDoc(), { stems: true });
    worker.emit({
      id: 1,
      type: 'render',
      result: {
        left: new Float32Array([0.1]),
        right: new Float32Array([0.2]),
        sampleRate: 48000,
        totalFrames: 1,
        report: { peakDb: -6 },
        stems: [
          {
            trackIndex: 0,
            name: 'Drums',
            left: new Float32Array([0.3]),
            right: new Float32Array([0.4]),
            report: { peakDb: -10, lufs: -18 },
          },
          {
            source: 'bus',
            trackIndex: -1,
            busId: 'bus-a',
            busIndex: 0,
            name: 'A Return',
            left: new Float32Array([0.5]),
            right: new Float32Array([0.6]),
            report: { peakDb: -8, lufs: -16 },
          },
          {
            source: 'master',
            trackIndex: Number.MIN_SAFE_INTEGER,
            name: 'Master',
            left: new Float32Array([0.7]),
            right: new Float32Array([0.8]),
            report: { peakDb: -6, lufs: -14 },
          },
        ],
      },
    });
    const result = await handle.result;
    expect(result.sampleRate).toBe(48000);
    expect(result.totalFrames).toBe(1);
    expect(result.report.peakDb).toBe(-6);
    expect(result.channels[0][0]).toBeCloseTo(0.1, 6);
    expect(result.channels[1][0]).toBeCloseTo(0.2, 6);
    expect(result.stems).toHaveLength(3);
    expect(result.stems?.[0].name).toBe('Drums');
    expect(result.stems?.[0].report).toEqual({ peakDb: -10, lufs: -18 });
    expect(result.stems?.[0].channels[0][0]).toBeCloseTo(0.3, 6);
    expect(result.stems?.[1]).toMatchObject({
      source: 'bus',
      trackIndex: -1,
      busId: 'bus-a',
      busIndex: 0,
      name: 'A Return',
    });
    expect(result.stems?.[1].channels[0][0]).toBeCloseTo(0.5, 6);
    expect(result.stems?.[2]).toMatchObject({
      source: 'master',
      trackIndex: Number.MIN_SAFE_INTEGER,
      name: 'Master',
      report: { peakDb: -6, lufs: -14 },
    });
    expect(result.stems?.[2].channels[0][0]).toBeCloseTo(0.7, 6);
  });

  it('acknowledges each streamed stem only after its async consumer completes', async () => {
    let releaseConsumer!: () => void;
    const consumerGate = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const onStem = vi.fn(async () => consumerGate);
    const handle = client.renderMixdown(makeDoc(), { stems: true }, undefined, onStem);
    expect(worker.posted[0]).toMatchObject({ type: 'render', streamStems: true });

    worker.emit({
      id: 1,
      type: 'stem',
      index: 0,
      total: 1,
      stem: {
        trackIndex: 0,
        name: 'Drums',
        left: new Float32Array([0.25]),
        right: new Float32Array([0.5]),
      },
    });
    await Promise.resolve();
    expect(worker.posted).toHaveLength(1);
    releaseConsumer();
    await vi.waitFor(() => {
      expect(worker.posted[1]).toMatchObject({
        type: 'stem-consumed',
        targetId: 1,
        index: 0,
      });
    });
    expect(onStem).toHaveBeenCalledWith(expect.objectContaining({ name: 'Drums' }), 0, 1);

    worker.emit({
      id: 1,
      type: 'render',
      result: {
        left: new Float32Array([0]),
        right: new Float32Array([0]),
        sampleRate: 48000,
        totalFrames: 1,
        report: { peakDb: Number.NEGATIVE_INFINITY },
      },
    });
    const result = await handle.result;
    expect(result.stems).toBeUndefined();
  });

  it('acknowledges streamed mixdown PCM only after its consumer completes', async () => {
    let releaseConsumer!: () => void;
    const consumerGate = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const onChunk = vi.fn(async () => consumerGate);
    const handle = client.renderMixdown(makeDoc(), {}, undefined, undefined, onChunk);
    expect(worker.posted[0]).toMatchObject({ type: 'render', streamMixdown: true });

    worker.emit({
      id: 1,
      type: 'mixdown-chunk',
      left: new Float32Array([0.25]),
      right: new Float32Array([0.5]),
      offsetFrames: 0,
      totalFrames: 1,
    });
    await Promise.resolve();
    expect(worker.posted).toHaveLength(1);
    releaseConsumer();
    await vi.waitFor(() => {
      expect(worker.posted[1]).toMatchObject({
        type: 'mixdown-consumed',
        targetId: 1,
        offsetFrames: 0,
      });
    });
    expect(onChunk).toHaveBeenCalledWith(
      [expect.any(Float32Array), expect.any(Float32Array)],
      0,
      1,
    );
    worker.emit({
      id: 1,
      type: 'render',
      result: {
        left: new Float32Array(0),
        right: new Float32Array(0),
        sampleRate: 48000,
        totalFrames: 1,
        report: { peakDb: -6 },
      },
    });
    await expect(handle.result).resolves.toMatchObject({ totalFrames: 1 });
  });

  it('cancels the worker when a streamed stem consumer fails', async () => {
    const handle = client.renderMixdown(makeDoc(), { stems: true }, undefined, async () => {
      throw new Error('encoder out of memory');
    });
    worker.emit({
      id: 1,
      type: 'stem',
      index: 0,
      total: 2,
      stem: {
        trackIndex: 0,
        name: 'Drums',
        left: new Float32Array(1),
        right: new Float32Array(1),
      },
    });
    await expect(handle.result).rejects.toThrow('encoder out of memory');
    expect(worker.posted[1]).toMatchObject({ type: 'cancel', targetId: 1 });
  });

  it('routes progress responses to the callback without settling the promise', async () => {
    const onProgress = vi.fn();
    const handle = client.renderMixdown(makeDoc(), {}, onProgress);
    worker.emit({ id: 1, type: 'progress', progress: 0.25, stage: 'clip:0:0' });
    worker.emit({ id: 1, type: 'progress', progress: 0.5, stage: 'master.strip' });
    expect(onProgress).toHaveBeenNthCalledWith(1, 0.25, 'clip:0:0');
    expect(onProgress).toHaveBeenNthCalledWith(2, 0.5, 'master.strip');
    worker.emit({
      id: 1,
      type: 'render',
      result: {
        left: new Float32Array(0),
        right: new Float32Array(0),
        sampleRate: 48000,
        totalFrames: 0,
        report: { peakDb: Number.NEGATIVE_INFINITY },
      },
    });
    await expect(handle.result).resolves.toMatchObject({ totalFrames: 0 });
  });

  it('rejects a cancelled render without waiting for a worker echo', async () => {
    const handle = client.renderMixdown(makeDoc());
    const rejected = expect(handle.result).rejects.toBeInstanceOf(MixdownCancelledError);
    handle.cancel();
    expect(worker.posted[1]).toMatchObject({ type: 'cancel', targetId: 1 });
    await rejected;
  });

  it('posts at most one cancel request per in-flight render', async () => {
    const handle = client.renderMixdown(makeDoc());
    handle.cancel();
    handle.cancel();
    handle.cancel();

    expect(worker.posted.filter((message) => message.type === 'cancel')).toHaveLength(1);
    expect(worker.posted[1]).toMatchObject({ type: 'cancel', targetId: 1 });
    worker.emit({ id: 1, type: 'cancelled' });
    await expect(handle.result).rejects.toBeInstanceOf(MixdownCancelledError);
  });

  it('makes cancel a no-op after the render settled', async () => {
    const handle = client.renderMixdown(makeDoc());
    worker.emit({
      id: 1,
      type: 'render',
      result: {
        left: new Float32Array(0),
        right: new Float32Array(0),
        sampleRate: 48000,
        totalFrames: 0,
        report: { peakDb: Number.NEGATIVE_INFINITY },
      },
    });
    await handle.result;
    handle.cancel();
    expect(worker.posted).toHaveLength(1); // no cancel message went out
  });

  it('rejects only the failing render on a per-request error', async () => {
    const first = client.renderMixdown(makeDoc());
    const second = client.renderMixdown(makeDoc());
    worker.emit({ id: 1, type: 'error', error: 'asset missing' });
    await expect(first.result).rejects.toThrow('asset missing');
    worker.emit({
      id: 2,
      type: 'render',
      result: {
        left: new Float32Array(0),
        right: new Float32Array(0),
        sampleRate: 48000,
        totalFrames: 0,
        report: { peakDb: Number.NEGATIVE_INFINITY },
      },
    });
    await expect(second.result).resolves.toBeDefined();
  });

  it('maps a typed whole-buffer limit response without exposing a raw wasm error', async () => {
    const handle = client.renderMixdown(makeDoc());
    worker.emit({
      id: 1,
      type: 'error',
      error: 'internal wasm detail',
      code: 'mastering-buffer-limit',
      totalFrames: 33_554_433,
      maxFrames: 33_554_432,
      sampleRate: 48_000,
    });
    await expect(handle.result).rejects.toMatchObject({
      name: 'MasteringBufferLimitError',
      code: 'mastering-buffer-limit',
      totalFrames: 33_554_433,
      maxFrames: 33_554_432,
      sampleRate: 48_000,
    });
    await expect(handle.result).rejects.toBeInstanceOf(MasteringBufferLimitError);
    await expect(handle.result).rejects.not.toThrow('internal wasm detail');
  });

  it('ignores responses with unknown ids', async () => {
    const handle = client.renderMixdown(makeDoc());
    worker.emit({ id: 99, type: 'error', error: 'stray' });
    worker.emit({
      id: 1,
      type: 'render',
      result: {
        left: new Float32Array(0),
        right: new Float32Array(0),
        sampleRate: 48000,
        totalFrames: 0,
        report: { peakDb: Number.NEGATIVE_INFINITY },
      },
    });
    await expect(handle.result).resolves.toBeDefined();
  });

  it('rejects all in-flight renders on a worker-level error', async () => {
    const first = client.renderMixdown(makeDoc());
    const second = client.renderMixdown(makeDoc());
    worker.emitError('worker crashed');
    await expect(first.result).rejects.toThrow('worker crashed');
    await expect(second.result).rejects.toThrow('worker crashed');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    await expect(client.renderMixdown(makeDoc()).result).rejects.toThrow('disposed');
  });

  it('recreates the shared client after a worker-level failure', async () => {
    const createdWorkers: FakeWorker[] = [];
    vi.stubGlobal(
      'Worker',
      // biome-ignore lint/complexity/useArrowFunction: Worker is called with `new`.
      vi.fn(function () {
        const created = new FakeWorker();
        createdWorkers.push(created);
        return created as unknown as Worker;
      }),
    );

    const first = getExportClient();
    const pending = first.renderMixdown(makeDoc());
    createdWorkers[0].emitError('worker crashed');

    await expect(pending.result).rejects.toBeInstanceOf(ExportWorkerError);
    const replacement = getExportClient();
    expect(replacement).not.toBe(first);
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  it('dispose terminates the worker and rejects pending and future renders', async () => {
    const pending = client.renderMixdown(makeDoc());
    client.dispose();
    await expect(pending.result).rejects.toThrow('disposed');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    expect(worker.posted.some((m) => m.type === 'destroy')).toBe(true);
    await expect(client.renderMixdown(makeDoc()).result).rejects.toThrow('disposed');
  });
});

describe('ExportClient streamed payloads without a consumer', () => {
  afterEach(() => disposeExportClient());

  it('rejects and cancels the worker when a stem arrives without a consumer', async () => {
    const worker = new FakeWorker();
    const client = new ExportClient(worker as unknown as Worker);
    const handle = client.renderMixdown(makeDoc());
    worker.emit({
      id: 1,
      type: 'stem',
      index: 0,
      total: 1,
      stem: {
        trackIndex: 0,
        name: 'Drums',
        left: new Float32Array(1),
        right: new Float32Array(1),
      },
    });
    await expect(handle.result).rejects.toThrow('without a consumer');
    expect(worker.posted[1]).toMatchObject({ type: 'cancel', targetId: 1 });
    client.dispose();
  });

  it('rejects and cancels the worker when mixdown PCM arrives without a consumer', async () => {
    const worker = new FakeWorker();
    const client = new ExportClient(worker as unknown as Worker);
    const handle = client.renderMixdown(makeDoc());
    worker.emit({
      id: 1,
      type: 'mixdown-chunk',
      left: new Float32Array(1),
      right: new Float32Array(1),
      offsetFrames: 0,
      totalFrames: 1,
    });
    await expect(handle.result).rejects.toThrow('without a consumer');
    expect(worker.posted[1]).toMatchObject({ type: 'cancel', targetId: 1 });
    client.dispose();
  });
});
