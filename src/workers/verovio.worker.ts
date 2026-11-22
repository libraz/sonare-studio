/**
 * Module worker hosting the Verovio engraving toolkit.
 *
 * The Verovio wasm module (~7.7 MB, single-file Emscripten build with the wasm
 * binary and fonts inlined as base64) is instantiated exactly once at worker
 * startup and reused for every request. Requests are processed strictly in
 * order through a promise queue, so a 'renderPage' posted right after 'load'
 * always sees the loaded document.
 *
 * Protocol: each request carries a caller-generated `id`; every response echoes
 * it back. Request failures are reported as `{ id, type: 'error', error }`;
 * toolkit bootstrap failures are reported as `{ id, type: 'fatal', error }`
 * because the worker cannot recover without a replacement instance.
 */

import { VerovioToolkit } from 'verovio/esm';
import createVerovioModule from 'verovio/wasm';
import { errorMessage } from '@/lib/errors';

/** Raw Verovio option bag passed straight to `toolkit.setOptions()`. */
export type VerovioOptions = Record<string, string | number | boolean>;

/**
 * One entry of Verovio's `renderToTimemap()` output.
 *
 * The ids in `on`/`off` are the same `id` attributes found on the rendered
 * SVG `<g class="note">` elements of the same `loadData()` call, so they link
 * the timemap directly to rendered noteheads.
 */
export interface VerovioTimemapEntry {
  /** Milliseconds from score start, tempo-aware. */
  tstamp: number;
  /** Position in quarter notes from score start. */
  qstamp: number;
  /** xml:ids of notes starting at this time (absent when none). */
  on?: string[];
  /** xml:ids of notes ending at this time (absent when none). */
  off?: string[];
  /** Tempo in BPM; present only on entries where the tempo is (re)stated. */
  tempo?: number;
  /** xml:id of the measure starting here (timemap is built with measures included). */
  measureOn?: string;
}

/** Request payloads, without the correlation id. */
export type VerovioRequestBody =
  | { type: 'load'; musicXml: string; options?: VerovioOptions }
  | { type: 'renderPage'; page: number }
  | { type: 'timemap' }
  | { type: 'options'; options: VerovioOptions }
  | { type: 'cancel' }
  | { type: 'destroy' };

/** A request message: payload plus correlation and replaceable-session ids. */
export type VerovioRequest = VerovioRequestBody & { id: number; sessionId: number };

/** Response messages; `id` echoes the originating request. */
export type VerovioResponse =
  | { id: number; type: 'load'; pageCount: number }
  | { id: number; type: 'renderPage'; svg: string }
  | { id: number; type: 'timemap'; entries: VerovioTimemapEntry[] }
  | { id: number; type: 'options'; pageCount: number }
  | { id: number; type: 'cancel' }
  | { id: number; type: 'destroy' }
  | { id: number; type: 'error'; error: string }
  | { id: number; type: 'fatal'; error: string };

/**
 * The subset of the Verovio toolkit API this worker uses, as it behaves at
 * runtime: `loadData` returns 1 or 0 (the package declares a boolean), and the
 * timemap carries `qstamp` because this worker never requests fractions.
 */
interface Toolkit {
  loadData(data: string): number;
  setOptions(options: VerovioOptions): void;
  getPageCount(): number;
  renderToSVG(pageNo?: number, xmlDeclaration?: boolean): string;
  renderToTimemap(options?: {
    includeMeasures?: boolean;
    includeRests?: boolean;
  }): VerovioTimemapEntry[];
  redoLayout(): void;
  getLog(): string;
  destroy(): void;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** Marks a failure that leaves this worker unable to process any request. */
class ToolkitInitializationError extends Error {
  constructor(cause: unknown) {
    super(`Verovio toolkit initialization failed: ${errorMessage(cause)}`);
    this.name = 'ToolkitInitializationError';
  }
}

/** Single shared toolkit instance; created once when the worker boots. */
const toolkitPromise: Promise<Toolkit> = createVerovioModule()
  .then((module) => new VerovioToolkit(module) as unknown as Toolkit)
  .catch((error: unknown) => {
    throw new ToolkitInitializationError(error);
  });
// Keep a bootstrap rejection from becoming an unhandled worker rejection while
// retaining the rejected promise for the first request to report as `fatal`.
void toolkitPromise.catch(() => undefined);

/** Whether a document has been successfully loaded into the toolkit. */
let loaded = false;

function post(message: VerovioResponse): void {
  scope.postMessage(message);
}

async function handle(request: VerovioRequest): Promise<void> {
  if (request.type === 'cancel') {
    post({ id: request.id, type: 'cancel' });
    return;
  }
  const toolkit = await toolkitPromise;
  switch (request.type) {
    case 'load': {
      // inputFrom is pinned to MusicXML; auto-detection is only reliable on a
      // brand-new toolkit and resetOptions() would silently flip it back to MEI.
      toolkit.setOptions({ ...(request.options ?? {}), inputFrom: 'xml' });
      if (toolkit.loadData(request.musicXml) !== 1) {
        loaded = false;
        throw new Error(`Verovio failed to load MusicXML: ${toolkit.getLog()}`);
      }
      loaded = true;
      post({ id: request.id, type: 'load', pageCount: toolkit.getPageCount() });
      return;
    }
    case 'renderPage': {
      assertLoaded();
      post({ id: request.id, type: 'renderPage', svg: toolkit.renderToSVG(request.page) });
      return;
    }
    case 'timemap': {
      assertLoaded();
      post({
        id: request.id,
        type: 'timemap',
        entries: toolkit.renderToTimemap({ includeMeasures: true }),
      });
      return;
    }
    case 'options': {
      toolkit.setOptions(request.options);
      if (loaded) {
        // Re-layout the already-parsed document instead of reloading it.
        toolkit.redoLayout();
      }
      post({ id: request.id, type: 'options', pageCount: loaded ? toolkit.getPageCount() : 0 });
      return;
    }
    case 'destroy': {
      toolkit.destroy();
      post({ id: request.id, type: 'destroy' });
      scope.close();
      return;
    }
  }
}

function assertLoaded(): void {
  if (!loaded) {
    throw new Error('No score loaded: send a load request first');
  }
}

/** Serializes request handling so responses follow request order. */
let queue: Promise<void> = Promise.resolve();
/** Highest session observed, updated before queued work is allowed to start. */
let newestSessionId = 0;

scope.onmessage = (event: MessageEvent<VerovioRequest>) => {
  const request = event.data;
  newestSessionId = Math.max(newestSessionId, request.sessionId);
  queue = queue.then(async () => {
    try {
      if (request.sessionId < newestSessionId && request.type !== 'destroy') {
        throw new DOMException('Verovio request superseded.', 'AbortError');
      }
      await handle(request);
    } catch (error) {
      post({
        id: request.id,
        type: error instanceof ToolkitInitializationError ? 'fatal' : 'error',
        error: errorMessage(error),
      });
    }
  });
};
