import type {
  SonareEngineCommandRecord,
  SonareEngineSyncMessage,
  SonareRealtimeEngineWorkletProcessorOptions,
} from '@/wasm/worklet.js';
import { init, SonareRealtimeEngineWorkletProcessor } from '@/wasm/worklet.js';

// AudioWorkletGlobalScope globals are not part of the TS DOM/WebWorker libs.
declare const AudioWorkletProcessor: new () => { readonly port: MessagePort };
declare function registerProcessor(
  name: string,
  ctor: new (options?: { processorOptions?: EngineProcessorOptions }) => unknown,
): void;

type EngineProcessorOptions = SonareRealtimeEngineWorkletProcessorOptions & {
  /** Sonare embind WASM bytes, supplied by the main thread (no fetch in worklets). */
  wasmBinary?: ArrayBuffer;
};

// The AudioWorkletGlobalScope has no URL constructor, but the bundled Emscripten
// glue computes a wasm path with `new URL(..., import.meta.url)` during init even
// though the bytes always arrive via processorOptions.wasmBinary and the resulting
// href is never fetched. A minimal href-carrying stub keeps that bookkeeping alive.
if (typeof (globalThis as { URL?: unknown }).URL === 'undefined') {
  class WorkletUrlStub {
    readonly href: string;
    constructor(path: unknown, base?: unknown) {
      const p = String(path);
      if (base === undefined || /^(?:[a-z]+:)?\/\//i.test(p) || /^(?:data|blob):/i.test(p)) {
        this.href = p;
      } else {
        this.href = `${String(base).replace(/[^/]*$/, '')}${p}`;
      }
    }
    toString(): string {
      return this.href;
    }
  }
  (globalThis as { URL?: unknown }).URL = WorkletUrlStub;
}

/**
 * AudioWorklet module entry, bundled into the self-contained
 * public/sonare-engine-worklet.js (the worklet scope cannot load external imports).
 *
 * The stock registerSonareRealtimeEngineWorkletProcessor() constructs the embind
 * bridge synchronously, but the embind runtime requires the sonare WASM module to
 * be initialized first — and the worklet scope has no fetch(), so the bytes must
 * arrive via processorOptions.wasmBinary. This processor initializes the module
 * asynchronously, buffers early port messages, and posts 'ready'/'error' so the
 * main thread can await a usable engine.
 */
class SonareEngineWorklet extends AudioWorkletProcessor {
  private bridge: SonareRealtimeEngineWorkletProcessor | null = null;
  private readonly pending: unknown[] = [];

  constructor(options?: { processorOptions?: EngineProcessorOptions }) {
    super();
    const processorOptions = options?.processorOptions ?? {};
    const port = this.port;
    port.onmessage = (event: MessageEvent) => {
      if (this.bridge) {
        this.dispatch(event.data);
      } else {
        this.pending.push(event.data);
      }
    };
    const { wasmBinary } = processorOptions;
    // The published init() type only declares locateFile, but options pass through
    // to the Emscripten factory, which accepts wasmBinary.
    void (init as (opts?: object) => Promise<void>)(wasmBinary ? { wasmBinary } : undefined)
      .then(() => {
        this.bridge = new SonareRealtimeEngineWorkletProcessor(processorOptions, {
          postMessage: (message) => port.postMessage(message),
          onMeter: (meter) => port.postMessage(meter),
        });
        for (const message of this.pending) {
          this.dispatch(message);
        }
        this.pending.length = 0;
        port.postMessage({ type: 'ready', runtimeTarget: 'embind' });
      })
      .catch((error: unknown) => {
        port.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private dispatch(data: unknown): void {
    if (!this.bridge || data === null || typeof data !== 'object') {
      return;
    }
    const type = (data as { type?: unknown }).type;
    if (typeof type === 'number') {
      this.bridge.receiveCommand(data as SonareEngineCommandRecord);
    } else if (
      typeof type === 'string' &&
      (type.startsWith('sync') || type === 'captureRequest' || type === 'transportRequest')
    ) {
      // The facade's control-plane contract: every `sync*` message plus the
      // capture/transport request RPCs must reach the bridge (libsonare does
      // not export a canonical list, so match the documented prefix contract).
      this.bridge.receiveSync(data as SonareEngineSyncMessage);
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.bridge) {
      return this.bridge.process(inputs, outputs);
    }
    for (const channel of outputs[0] ?? []) {
      channel.fill(0);
    }
    return true;
  }
}

registerProcessor('sonare-realtime-engine-processor', SonareEngineWorklet);
