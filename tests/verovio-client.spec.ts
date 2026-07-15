import { describe, expect, it } from 'vitest';
import { layoutToVerovioOptions, VerovioClient } from '@/notation/verovio';
import type { VerovioRequest, VerovioResponse } from '@/workers/verovio.worker';

/**
 * Minimal Worker double: records posted requests and lets tests emit
 * message/error events back to the client. No real Worker exists in jsdom and
 * the Verovio wasm module is never touched here — this suite only covers the
 * client protocol (correlation, error propagation, dispose).
 */
class MockWorker {
  readonly posted: VerovioRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  postMessage(message: VerovioRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Emits a worker -> main 'message' event carrying a protocol response. */
  respond(response: VerovioResponse): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: response });
    }
  }

  /** Emits a worker-level 'error' event. */
  fail(message: string): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener({ message });
    }
  }
}

function createClient(): { client: VerovioClient; worker: MockWorker } {
  const worker = new MockWorker();
  return { client: new VerovioClient(worker as unknown as Worker), worker };
}

describe('layoutToVerovioOptions', () => {
  it('copies defined options 1:1 onto verovio names', () => {
    expect(
      layoutToVerovioOptions({
        pageWidth: 1800,
        scale: 40,
        breaks: 'auto',
        adjustPageHeight: true,
      }),
    ).toEqual({ pageWidth: 1800, scale: 40, breaks: 'auto', adjustPageHeight: true });
  });

  it('drops undefined entries and handles the empty case', () => {
    expect(layoutToVerovioOptions({ pageWidth: undefined, spacingStaff: 12 })).toEqual({
      spacingStaff: 12,
    });
    expect(layoutToVerovioOptions()).toEqual({});
  });
});

describe('VerovioClient', () => {
  it('sends a load request with mapped options and resolves the page count', async () => {
    const { client, worker } = createClient();
    const promise = client.load('<score-partwise/>', { pageWidth: 1800, scale: 40 });

    expect(worker.posted).toHaveLength(1);
    const request = worker.posted[0];
    expect(request).toMatchObject({
      type: 'load',
      sessionId: 1,
      musicXml: '<score-partwise/>',
      options: { pageWidth: 1800, scale: 40 },
    });

    worker.respond({ id: request.id, type: 'load', pageCount: 3 });
    await expect(promise).resolves.toBe(3);
  });

  it('supersedes the prior session on rapid load and rejects its queued work', async () => {
    const { client, worker } = createClient();
    const first = client.load('<score-partwise id="old"/>');
    const firstRequest = worker.posted[0];
    const oldRender = client.renderPage(1);
    const second = client.load('<score-partwise id="new"/>');
    const secondRequest = worker.posted.at(-1)!;

    expect(secondRequest.sessionId).toBeGreaterThan(firstRequest.sessionId);
    await expect(first).rejects.toThrow(/superseded/);
    await expect(oldRender).rejects.toThrow(/superseded/);

    worker.respond({ id: secondRequest.id, type: 'load', pageCount: 2 });
    await expect(second).resolves.toBe(2);
  });

  it('cancels queued requests without disposing the reusable client', async () => {
    const { client, worker } = createClient();
    const pending = client.renderPage(1);
    client.cancelPending();

    await expect(pending).rejects.toThrow(/cancelled/);
    expect(worker.posted.at(-1)).toMatchObject({ type: 'cancel', sessionId: 1 });

    const replacement = client.renderPage(2);
    const request = worker.posted.at(-1)!;
    worker.respond({ id: request.id, type: 'renderPage', svg: '<svg>new</svg>' });
    await expect(replacement).resolves.toBe('<svg>new</svg>');
  });

  it('correlates out-of-order responses by request id', async () => {
    const { client, worker } = createClient();
    const first = client.renderPage(1);
    const second = client.renderPage(2);
    const [a, b] = worker.posted;
    expect(a.id).not.toBe(b.id);

    // Respond to the second request first.
    worker.respond({ id: b.id, type: 'renderPage', svg: '<svg>two</svg>' });
    worker.respond({ id: a.id, type: 'renderPage', svg: '<svg>one</svg>' });

    await expect(first).resolves.toBe('<svg>one</svg>');
    await expect(second).resolves.toBe('<svg>two</svg>');
  });

  it('resolves timemap entries and setLayout page count', async () => {
    const { client, worker } = createClient();
    const timemap = client.getTimemap();
    const layout = client.setLayout({ pageHeight: 1200 });
    const [t, l] = worker.posted;
    expect(t.type).toBe('timemap');
    expect(l).toMatchObject({ type: 'options', options: { pageHeight: 1200 } });

    const entries = [{ tstamp: 0, qstamp: 0, on: ['n1'], tempo: 120 }];
    worker.respond({ id: t.id, type: 'timemap', entries });
    worker.respond({ id: l.id, type: 'options', pageCount: 2 });

    await expect(timemap).resolves.toEqual(entries);
    await expect(layout).resolves.toBe(2);
  });

  it('rejects only the request matching an error response', async () => {
    const { client, worker } = createClient();
    const failing = client.load('not xml');
    const surviving = client.renderPage(1);
    const [loadRequest, renderRequest] = worker.posted;

    worker.respond({ id: loadRequest.id, type: 'error', error: 'Verovio failed to load MusicXML' });
    await expect(failing).rejects.toThrow('Verovio failed to load MusicXML');

    worker.respond({ id: renderRequest.id, type: 'renderPage', svg: '<svg/>' });
    await expect(surviving).resolves.toBe('<svg/>');
  });

  it('rejects a request answered with a mismatched response type', async () => {
    const { client, worker } = createClient();
    const promise = client.renderPage(1);
    worker.respond({ id: worker.posted[0].id, type: 'options', pageCount: 1 });
    await expect(promise).rejects.toThrow(
      "Unexpected Verovio worker response 'options', expected 'renderPage'",
    );
  });

  it('ignores responses with unknown ids', async () => {
    const { client, worker } = createClient();
    const promise = client.renderPage(1);
    const request = worker.posted[0];

    worker.respond({ id: request.id + 999, type: 'renderPage', svg: '<svg>wrong</svg>' });
    worker.respond({ id: request.id, type: 'renderPage', svg: '<svg>right</svg>' });
    await expect(promise).resolves.toBe('<svg>right</svg>');
  });

  it('dispose posts destroy, terminates the worker, and rejects pending requests', async () => {
    const { client, worker } = createClient();
    const pending = client.renderPage(1);

    client.dispose();

    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    expect(worker.posted.at(-1)?.type).toBe('destroy');
    await expect(pending).rejects.toThrow('VerovioClient is disposed');

    // Subsequent calls reject immediately; dispose is idempotent.
    await expect(client.load('<score-partwise/>')).rejects.toThrow('VerovioClient is disposed');
    const postedCount = worker.posted.length;
    client.dispose();
    expect(worker.posted).toHaveLength(postedCount);
  });

  it('rejects all in-flight requests on a worker-level error event', async () => {
    const { client, worker } = createClient();
    const first = client.renderPage(1);
    const second = client.getTimemap();

    worker.fail('worker exploded');

    await expect(first).rejects.toThrow('worker exploded');
    await expect(second).rejects.toThrow('worker exploded');
  });

  it('self-disables after a fatal worker error so later calls reject instead of hanging', async () => {
    const { client, worker } = createClient();
    const inFlight = client.load('<score-partwise/>');

    worker.fail('worker exploded');
    await expect(inFlight).rejects.toThrow('worker exploded');

    // The dead worker is torn down, and new requests reject immediately with the
    // original error rather than queuing a pending promise that never resolves.
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    const postedBefore = worker.posted.length;
    await expect(client.renderPage(1)).rejects.toThrow('worker exploded');
    expect(worker.posted).toHaveLength(postedBefore);
  });
});
