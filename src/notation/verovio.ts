/**
 * Main-thread async client for the Verovio worker.
 *
 * Wraps the worker message protocol in promise-returning methods with
 * request-id correlation: every call gets a unique id, responses are matched
 * back to the originating promise, and per-request errors reject only that
 * promise. The worker itself processes requests in order, so callers may fire
 * load/renderPage back-to-back without awaiting in between.
 */

import type {
  VerovioOptions,
  VerovioRequest,
  VerovioRequestBody,
  VerovioResponse,
  VerovioTimemapEntry,
} from '@/workers/verovio.worker';

export type { VerovioOptions, VerovioTimemapEntry };

/** Layout options exposed to the app, mapped 1:1 onto Verovio option names. */
export interface LayoutOptions {
  /** Page width in MEI units (1 unit = half a staff-space; Verovio default 2100). */
  pageWidth?: number;
  /** Page height in MEI units (Verovio default 2970). */
  pageHeight?: number;
  /** Top page margin in MEI units. */
  pageMarginTop?: number;
  /** Bottom page margin in MEI units. */
  pageMarginBottom?: number;
  /** Left page margin in MEI units. */
  pageMarginLeft?: number;
  /** Right page margin in MEI units. */
  pageMarginRight?: number;
  /** Rendering scale in percent (Verovio default 100). */
  scale?: number;
  /** Vertical space between staves in MEI units (Verovio default 12). */
  spacingStaff?: number;
  /** System/page breaking strategy. */
  breaks?: 'none' | 'auto' | 'line' | 'smart' | 'encoded';
  /** Shrink the page height to the rendered content. */
  adjustPageHeight?: boolean;
  /** Shrink the page width to the rendered content (used with `breaks: 'none'`). */
  adjustPageWidth?: boolean;
  /** Emit a viewBox on the SVG root for CSS-responsive scaling. */
  svgViewBox?: boolean;
  /** Page header rendering ('auto' shows title metadata; 'none' suppresses it). */
  header?: 'auto' | 'encoded' | 'none';
  /** Page footer rendering ('auto' shows page numbers; 'none' suppresses it). */
  footer?: 'auto' | 'encoded' | 'none';
}

/**
 * Converts LayoutOptions to a Verovio option bag, dropping undefined entries.
 * Property names intentionally match Verovio's, so this is a filtered copy.
 */
export function layoutToVerovioOptions(layout: LayoutOptions = {}): VerovioOptions {
  const options: VerovioOptions = {};
  for (const [key, value] of Object.entries(layout)) {
    if (value !== undefined) {
      options[key] = value;
    }
  }
  return options;
}

interface PendingRequest {
  sessionId: number;
  resolve: (response: VerovioResponse) => void;
  reject: (error: Error) => void;
}

/** Narrows a worker response to the expected variant or throws. */
function expectResponse<K extends VerovioResponse['type']>(
  response: VerovioResponse,
  type: K,
): Extract<VerovioResponse, { type: K }> {
  if (response.type !== type) {
    throw new Error(`Unexpected Verovio worker response '${response.type}', expected '${type}'`);
  }
  return response as Extract<VerovioResponse, { type: K }>;
}

/** Creates the default module worker hosting Verovio. */
function createVerovioWorker(): Worker {
  // Relative URL (not the '@' alias) so Vite can statically resolve the worker chunk.
  return new Worker(new URL('../workers/verovio.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/**
 * Async facade over the Verovio worker.
 *
 * Usage: `const client = new VerovioClient(); await client.load(xml, layout);`
 * then `renderPage` / `getTimemap` / `setLayout`, and `dispose()` when done.
 */
export class VerovioClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private sessionId = 0;
  private disposed = false;
  /** Set when the worker dies; later sends reject with this instead of hanging. */
  private fatalError: Error | null = null;

  /** @param worker Optional worker instance (injected in tests); defaults to the bundled one. */
  constructor(worker?: Worker) {
    this.worker = worker ?? createVerovioWorker();
    this.worker.addEventListener('message', this.handleMessage as EventListener);
    this.worker.addEventListener('error', this.handleWorkerError as EventListener);
  }

  /** True once the worker has died fatally; the client is unusable and must be replaced. */
  get failed(): boolean {
    return this.fatalError !== null;
  }

  /**
   * Loads a MusicXML document, optionally applying layout options first.
   * @returns The resulting page count.
   */
  async load(musicXml: string, layout?: LayoutOptions): Promise<number> {
    const sessionId = this.beginSession();
    const response = await this.send(
      {
        type: 'load',
        musicXml,
        options: layoutToVerovioOptions(layout),
      },
      sessionId,
    );
    return expectResponse(response, 'load').pageCount;
  }

  /**
   * Renders one page to SVG.
   * @param page 1-based page number (defaults to 1).
   */
  async renderPage(page = 1): Promise<string> {
    const response = await this.send({ type: 'renderPage', page });
    return expectResponse(response, 'renderPage').svg;
  }

  /**
   * Returns the timemap of the loaded score. Entry `on`/`off` ids match the
   * `id` attributes of `<g class="note">` elements in the SVG rendered from
   * the same load.
   */
  async getTimemap(): Promise<VerovioTimemapEntry[]> {
    const response = await this.send({ type: 'timemap' });
    return expectResponse(response, 'timemap').entries;
  }

  /**
   * Applies new layout options and re-lays out the loaded score.
   * @returns The new page count (0 when no score is loaded yet).
   */
  async setLayout(layout: LayoutOptions): Promise<number> {
    const response = await this.send({ type: 'options', options: layoutToVerovioOptions(layout) });
    return expectResponse(response, 'options').pageCount;
  }

  /**
   * Invalidates this client's current worker session and rejects every queued
   * request. The worker observes the new session before running older queued
   * work, while the client remains reusable for the replacement operation.
   */
  cancelPending(
    reason: Error = new DOMException('Verovio operation cancelled.', 'AbortError'),
  ): void {
    if (this.disposed || this.fatalError) return;
    const sessionId = ++this.sessionId;
    this.rejectBeforeSession(sessionId, reason);
    const request: VerovioRequest = {
      id: this.nextId++,
      sessionId,
      type: 'cancel',
    };
    this.worker.postMessage(request);
  }

  /**
   * Terminates the worker and rejects all in-flight requests. The client is
   * unusable afterwards; further calls reject.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const sessionId = ++this.sessionId;
    // Best-effort native teardown; terminate() reclaims the memory regardless.
    const destroy: VerovioRequest = { id: this.nextId++, sessionId, type: 'destroy' };
    this.worker.postMessage(destroy);
    this.teardownWorker();
    this.rejectAll(new Error('VerovioClient is disposed'));
  }

  private send(body: VerovioRequestBody, sessionId = this.sessionId): Promise<VerovioResponse> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    if (this.disposed) {
      return Promise.reject(new Error('VerovioClient is disposed'));
    }
    const id = this.nextId++;
    return new Promise<VerovioResponse>((resolve, reject) => {
      this.pending.set(id, { sessionId, resolve, reject });
      const request: VerovioRequest = { ...body, id, sessionId };
      this.worker.postMessage(request);
    });
  }

  private beginSession(): number {
    const sessionId = ++this.sessionId;
    this.rejectBeforeSession(
      sessionId,
      new DOMException('Verovio operation superseded.', 'AbortError'),
    );
    return sessionId;
  }

  private rejectBeforeSession(sessionId: number, error: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId >= sessionId) continue;
      this.pending.delete(id);
      entry.reject(error);
    }
  }

  private readonly handleMessage = (event: MessageEvent<VerovioResponse>): void => {
    const response = event.data;
    const entry = this.pending.get(response.id);
    if (!entry) {
      return;
    }
    this.pending.delete(response.id);
    if (response.type === 'error') {
      entry.reject(new Error(response.error));
    } else {
      entry.resolve(response);
    }
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    // A worker-level script error is fatal: the worker can no longer answer, so
    // mark the client dead and tear it down. Otherwise later sends would queue
    // pending requests that never resolve, hanging the score panel forever.
    if (this.disposed) {
      return;
    }
    const error = new Error(event.message || 'Verovio worker error');
    this.fatalError = error;
    this.disposed = true;
    this.teardownWorker();
    this.rejectAll(error);
  };

  private teardownWorker(): void {
    this.worker.removeEventListener('message', this.handleMessage as EventListener);
    this.worker.removeEventListener('error', this.handleWorkerError as EventListener);
    this.worker.terminate();
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}
