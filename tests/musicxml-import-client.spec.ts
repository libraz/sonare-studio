import { describe, expect, it, vi } from 'vitest';
import { MusicXmlImportError } from '@/notation/musicxml-import';
import { importMusicXmlInWorker } from '@/notation/musicxml-import-client';
import { defaultNameTable } from '@/project/default-names';
import type {
  MusicXmlImportWorkerInit,
  MusicXmlImportWorkerRequest,
  MusicXmlImportWorkerResponse,
} from '@/workers/musicxml-import.worker';

class MockWorker {
  posted: (MusicXmlImportWorkerInit | MusicXmlImportWorkerRequest)[] = [];
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

  postMessage(request: MusicXmlImportWorkerInit | MusicXmlImportWorkerRequest): void {
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
      { type: 'init', defaultNames: defaultNameTable() },
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
        report: { entries: [{ kind: 'lyrics', count: 2, details: [] }] },
      },
    });
    await expect(promise).resolves.toMatchObject({ report: { entries: [{ count: 2 }] } });
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
      { type: 'init', defaultNames: defaultNameTable() },
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

  it('sends the init message before the import request', () => {
    const worker = new MockWorker();
    void importMusicXmlInWorker(
      '<score-partwise/>',
      undefined,
      undefined,
      () => worker as unknown as Worker,
    );
    expect(worker.posted.map((message) => message.type)).toEqual(['init', 'import']);
  });
});

describe('MusicXML import worker handler', () => {
  async function replyTo(...messages: unknown[]): Promise<unknown[]> {
    vi.resetModules();
    const replies: unknown[] = [];
    const listeners: EventListener[] = [];
    const add = self.addEventListener.bind(self);
    vi.spyOn(self, 'addEventListener').mockImplementation(((
      type: string,
      listener: EventListener,
    ) => {
      if (type === 'message') listeners.push(listener);
      add(type, listener);
    }) as typeof self.addEventListener);
    const post = vi.spyOn(globalThis, 'postMessage').mockImplementation((reply: unknown) => {
      replies.push(reply);
    });
    await import('@/workers/musicxml-import.worker');
    for (const data of messages) self.dispatchEvent(new MessageEvent('message', { data }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    post.mockRestore();
    vi.mocked(self.addEventListener).mockRestore();
    for (const listener of listeners) self.removeEventListener('message', listener);
    return replies;
  }

  const xml = `<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure number="1"/></part></score-partwise>`;

  it('replies with an error when an import arrives before init', async () => {
    const replies = await replyTo({ type: 'import', xml });
    expect(replies).toMatchObject([{ type: 'error', error: { kind: 'unknown' } }]);
  });

  it('names the import with the table received in init', async () => {
    const replies = await replyTo(
      { type: 'init', defaultNames: { ...defaultNameTable(), importedMusicXml: 'imported-here' } },
      { type: 'import', xml },
    );
    expect(replies).toMatchObject([
      { type: 'imported', result: { document: { name: 'imported-here' } } },
    ]);
  });
});
