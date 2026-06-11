import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportClient } from '@/export/client';
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
    expect(result.stems).toHaveLength(1);
    expect(result.stems?.[0].name).toBe('Drums');
    expect(result.stems?.[0].channels[0][0]).toBeCloseTo(0.3, 6);
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

  it('rejects a cancelled render with MixdownCancelledError', async () => {
    const handle = client.renderMixdown(makeDoc());
    handle.cancel();
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
  });

  it('dispose terminates the worker and rejects pending and future renders', async () => {
    const pending = client.renderMixdown(makeDoc());
    client.dispose();
    await expect(pending.result).rejects.toThrow('disposed');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.posted.some((m) => m.type === 'destroy')).toBe(true);
    await expect(client.renderMixdown(makeDoc()).result).rejects.toThrow('disposed');
  });
});
