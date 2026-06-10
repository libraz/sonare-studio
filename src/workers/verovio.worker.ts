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
 * it back. Failures are reported per-request as `{ id, type: 'error', error }`.
 */

// @ts-expect-error -- 'verovio/esm' has no type declarations
import { VerovioToolkit } from 'verovio/esm';
// Verovio ships no TypeScript declarations; the imports are suppressed and the
// toolkit surface is re-typed locally (see VerovioToolkit interface below).
// @ts-expect-error -- 'verovio/wasm' has no type declarations
import createVerovioModule from 'verovio/wasm';

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
  | { type: 'destroy' };

/** A request message: payload plus caller-generated correlation id. */
export type VerovioRequest = VerovioRequestBody & { id: number };

/** Response messages; `id` echoes the originating request. */
export type VerovioResponse =
  | { id: number; type: 'load'; pageCount: number }
  | { id: number; type: 'renderPage'; svg: string }
  | { id: number; type: 'timemap'; entries: VerovioTimemapEntry[] }
  | { id: number; type: 'options'; pageCount: number }
  | { id: number; type: 'destroy' }
  | { id: number; type: 'error'; error: string };

/** The subset of the Verovio toolkit API this worker uses (package has no .d.ts). */
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

/** Single shared toolkit instance; created once when the worker boots. */
const toolkitPromise: Promise<Toolkit> = createVerovioModule().then(
  (module: unknown) => new VerovioToolkit(module) as Toolkit,
);

/** Whether a document has been successfully loaded into the toolkit. */
let loaded = false;

function post(message: VerovioResponse): void {
  scope.postMessage(message);
}

async function handle(request: VerovioRequest): Promise<void> {
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

scope.onmessage = (event: MessageEvent<VerovioRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      await handle(request);
    } catch (error) {
      post({
        id: request.id,
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
