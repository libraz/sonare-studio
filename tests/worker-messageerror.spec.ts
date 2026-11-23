import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportClient, ExportWorkerError } from '@/export/client';
import { encodeAudioInWorker } from '@/export/encode-client';
import { importMusicXmlInWorker } from '@/notation/musicxml-import-client';
import { VerovioClient, VerovioFatalError } from '@/notation/verovio';
import { analyzeAudioTagsInWorker } from '@/project/audio-analysis-client';
import { decomposeStemsInWorker } from '@/project/decompose-stems-client';
import type { ProjectDocument } from '@/project/serialization';
import { transcribeAudioInWorker } from '@/project/transcribe-client';
import { runSampleOperationInWorker } from '@/ui/sample-editor/ops-client';
import type { ExportResponse } from '@/workers/export.worker';

/** Worker double that never answers on its own; tests fire events by type. */
class EventWorker {
  terminated = false;
  readonly posted: unknown[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  fire(type: string, event: object = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event);
  }
}

/** Resolves to the settled state, or 'pending' when nothing settled within a macrotask. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  const pending = new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0));
  return Promise.race([
    promise.then(
      () => 'resolved',
      (error: unknown) => `rejected:${(error as Error).name}:${(error as Error).message}`,
    ),
    pending,
  ]);
}

const factoryFor = (worker: EventWorker) => () => worker as unknown as Worker;

describe('one-shot worker clients reject on messageerror', () => {
  const cases: Array<[string, (factory: () => Worker) => Promise<unknown>]> = [
    [
      'decompose',
      (f) => decomposeStemsInWorker([new Float32Array(4)], 48000, 2, { workerFactory: f }),
    ],
    [
      'transcribe',
      (f) => transcribeAudioInWorker(new Float32Array(4), 48000, false, { workerFactory: f }),
    ],
    [
      'sample operation',
      (f) =>
        runSampleOperationInWorker(
          { type: 'reverse' } as never,
          [new Float32Array(4)],
          { startFrame: 0, endFrame: 4 },
          f,
        ),
    ],
    [
      'audio analysis',
      (f) => analyzeAudioTagsInWorker(new Float32Array(4), 48000, { workerFactory: f }),
    ],
    ['musicxml import', (f) => importMusicXmlInWorker('<score-partwise/>', 'a.xml', undefined, f)],
    [
      'audio encode',
      (f) => encodeAudioInWorker('wav', [new Float32Array(4)], 48000, {}, undefined, f),
    ],
  ];

  it.each(cases)('%s', async (_name, run) => {
    const worker = new EventWorker();
    const promise = run(factoryFor(worker));
    await Promise.resolve();
    worker.fire('messageerror');
    expect(await outcome(promise)).toMatch(/^rejected:Error:.*could not be read/);
    expect(worker.terminated).toBe(true);
  });
});

describe('one-shot worker clients report start-up failures as rejections', () => {
  const starts: Array<[string, (factory: () => Worker, signal?: AbortSignal) => Promise<unknown>]> =
    [
      ['musicxml import', (f, s) => importMusicXmlInWorker('<score-partwise/>', 'a.xml', s, f)],
      [
        'audio encode',
        (f, s) => encodeAudioInWorker('wav', [new Float32Array(4)], 48000, {}, s, f),
      ],
    ];

  it.each(starts)(
    '%s rejects instead of throwing when the factory throws',
    async (_name, start) => {
      let promise: Promise<unknown> | undefined;
      expect(() => {
        promise = start(() => {
          throw new Error('no workers here');
        });
      }).not.toThrow();
      expect(await outcome(promise as Promise<unknown>)).toBe('rejected:Error:no workers here');
    },
  );

  it.each(starts)(
    '%s rejects without creating a worker when already aborted',
    async (_name, start) => {
      const controller = new AbortController();
      controller.abort();
      const factory = vi.fn(() => new EventWorker() as unknown as Worker);
      let promise: Promise<unknown> | undefined;
      expect(() => {
        promise = start(factory, controller.signal);
      }).not.toThrow();
      expect(await outcome(promise as Promise<unknown>)).toMatch(/^rejected:AbortError:/);
      expect(factory).not.toHaveBeenCalled();
    },
  );
});

describe('persistent worker clients treat messageerror as fatal', () => {
  it('ExportClient rejects in-flight renders and terminates', async () => {
    const worker = new EventWorker();
    const client = new ExportClient(worker as unknown as Worker);
    const handle = client.renderMixdown({ version: 5 } as unknown as ProjectDocument);
    worker.fire('messageerror');
    const result = await outcome(handle.result);
    expect(result).toMatch(/^rejected:ExportWorkerError:.*could not be read/);
    expect(worker.terminated).toBe(true);
  });

  it('ExportClient treats a fatal response as a dead worker', async () => {
    const worker = new EventWorker();
    const client = new ExportClient(worker as unknown as Worker);
    const handle = client.renderMixdown({ version: 5 } as unknown as ProjectDocument);
    const fatal: ExportResponse = { type: 'fatal', error: 'request could not be read' };
    worker.fire('message', { data: fatal });
    await expect(handle.result).rejects.toBeInstanceOf(ExportWorkerError);
    expect(worker.terminated).toBe(true);
  });

  it('VerovioClient rejects pending work and reports itself failed', async () => {
    const worker = new EventWorker();
    const client = new VerovioClient(worker as unknown as Worker);
    const load = client.load('<score-partwise/>');
    await Promise.resolve();
    worker.fire('messageerror');
    await expect(load).rejects.toBeInstanceOf(VerovioFatalError);
    expect(client.failed).toBe(true);
    expect(worker.terminated).toBe(true);
  });
});

describe('worker scopes answer a request they could not read', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('serveWorkerRequests replies with the handler error', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const postMessage = vi.fn();
    vi.stubGlobal('self', {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
    });
    vi.stubGlobal('postMessage', postMessage);
    const { serveWorkerRequests } = await import('@/workers/worker-request');
    serveWorkerRequests<never, { type: 'error'; error: string }>({
      validate: (value): value is never => false,
      invalidMessage: 'invalid',
      errorReply: (error) => ({ type: 'error', error: (error as Error).message }),
      handle: () => {},
    });
    listeners.get('messageerror')?.({});
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'error', error: expect.stringMatching(/could not be read/) },
      [],
    );
  });
});

describe('persistent worker scopes report an unreadable request as fatal', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  function stubScope(): {
    onmessageerror: (() => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  } {
    const scope = { onmessage: null, onmessageerror: null, postMessage: vi.fn(), close: vi.fn() };
    vi.stubGlobal('self', scope);
    return scope;
  }

  it('export worker', async () => {
    const scope = stubScope();
    await import('@/workers/export.worker');
    scope.onmessageerror?.();
    expect(scope.postMessage).toHaveBeenCalledWith(
      { type: 'fatal', error: 'Export worker could not read a request' },
      [],
    );
  });

  it('verovio worker', async () => {
    const scope = stubScope();
    await import('@/workers/verovio.worker');
    scope.onmessageerror?.();
    expect(scope.postMessage).toHaveBeenCalledWith({
      id: 0,
      type: 'fatal',
      error: 'Verovio worker could not read a request',
    });
  });
});
