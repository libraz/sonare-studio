import { describe, expect, it } from 'vitest';
import { MusicXmlImportError } from '@/notation/musicxml-import';
import { importMusicXmlInWorker } from '@/notation/musicxml-import-client';
import type {
  MusicXmlImportWorkerRequest,
  MusicXmlImportWorkerResponse,
} from '@/workers/musicxml-import.worker';

class MockWorker {
  posted: MusicXmlImportWorkerRequest[] = [];
  terminated = false;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(request: MusicXmlImportWorkerRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: MusicXmlImportWorkerResponse): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: response });
  }
}

describe('importMusicXmlInWorker', () => {
  it('returns the structured worker result and terminates the one-shot worker', async () => {
    const worker = new MockWorker();
    const promise = importMusicXmlInWorker(
      '<score-partwise/>',
      'score.musicxml',
      undefined,
      () => worker as unknown as Worker,
    );
    expect(worker.posted).toEqual([
      { type: 'import', xml: '<score-partwise/>', fileName: 'score.musicxml' },
    ]);
    worker.respond({
      type: 'imported',
      result: {
        document: {
          schemaVersion: 3,
          name: 'Imported',
          sampleRate: 48_000,
          tempoSegments: [{ startPpq: 0, bpm: 120 }],
          timeSignatures: [],
          tracks: [],
          markers: [],
          sections: [],
        },
        report: { issues: [{ feature: 'lyrics', count: 2 }] },
      },
    });
    await expect(promise).resolves.toMatchObject({ report: { issues: [{ count: 2 }] } });
    expect(worker.terminated).toBe(true);
  });

  it('terminates parsing immediately when aborted', async () => {
    const worker = new MockWorker();
    const controller = new AbortController();
    const promise = importMusicXmlInWorker(
      '<score-partwise/>',
      undefined,
      controller.signal,
      () => worker as unknown as Worker,
    );
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });

  it('forwards caller-supplied parsing limits to the worker', () => {
    const worker = new MockWorker();
    void importMusicXmlInWorker(
      '<score-partwise/>',
      undefined,
      undefined,
      () => worker as unknown as Worker,
      { maxElements: 8_000_000 },
    );

    expect(worker.posted).toEqual([
      {
        type: 'import',
        xml: '<score-partwise/>',
        fileName: undefined,
        limits: { maxElements: 8_000_000 },
      },
    ]);
  });

  it('restores MusicXmlImportError across the worker boundary', async () => {
    const worker = new MockWorker();
    const promise = importMusicXmlInWorker(
      '<score-partwise>',
      undefined,
      undefined,
      () => worker as unknown as Worker,
    );
    worker.respond({
      type: 'error',
      error: { kind: 'musicxml-import', message: 'MusicXML is not well-formed XML' },
    });

    await expect(promise).rejects.toBeInstanceOf(MusicXmlImportError);
    expect(worker.terminated).toBe(true);
  });
});
