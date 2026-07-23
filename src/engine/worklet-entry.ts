import {
  init as initIndexModule,
  isInitialized as isIndexInitialized,
  StreamingRetune,
  type StreamingRetuneConfig,
} from '@/wasm/index.js';
import type {
  SonareEngineCaptureRequestMessage,
  SonareEngineCommandRecord,
  SonareEngineSyncMessage,
  SonareEngineTransportRequestMessage,
  SonareRealtimeEngineWorkletProcessorOptions,
  SonareRealtimeVoiceChangerMessage,
  SonareRealtimeVoiceChangerWorkletProcessorOptions,
} from '@/wasm/worklet.js';
import {
  init,
  isInitialized,
  SonareRealtimeEngineWorkletProcessor,
  SonareRealtimeVoiceChangerWorkletProcessor,
} from '@/wasm/worklet.js';

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

type VoiceChangerProcessorOptions = SonareRealtimeVoiceChangerWorkletProcessorOptions & {
  /** Sonare embind WASM bytes, supplied by the main thread (no fetch in worklets). */
  wasmBinary?: ArrayBuffer;
};

type StreamingRetuneProcessorOptions = StreamingRetuneConfig & {
  wasmBinary?: ArrayBuffer;
  sampleRate?: number;
  blockSize?: number;
  channelCount?: number;
};

type WorkletGlobal = typeof globalThis & {
  SonareEmbindInitPromise?: Promise<void>;
  SonareEmbindModuleFactory?: (opts?: object) => Promise<unknown>;
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
    const onMessage = (event: MessageEvent) => {
      if (this.bridge) {
        this.dispatch(event.data);
      } else {
        this.pending.push(event.data);
      }
    };
    if ('addEventListener' in port && typeof port.addEventListener === 'function') {
      port.addEventListener('message', onMessage);
      port.start?.();
    } else {
      port.onmessage = onMessage;
    }
    const { wasmBinary } = processorOptions;
    // The published init() type only declares locateFile, but options pass through
    // to the Emscripten factory, which accepts wasmBinary.
    const scope = globalThis as WorkletGlobal;
    const initOptions = {
      locateFile: (path: string) => path,
      ...(wasmBinary ? { wasmBinary } : {}),
      ...(scope.SonareEmbindModuleFactory
        ? { moduleFactory: scope.SonareEmbindModuleFactory }
        : {}),
    };
    const initPromise = (async () => {
      if (scope.SonareEmbindInitPromise) {
        await scope.SonareEmbindInitPromise;
      }
      if (!isInitialized()) {
        await (init as (opts?: object) => Promise<void>)(initOptions);
      }
    })();
    void initPromise
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
    } else if (type === 'captureRequest') {
      // Capture and transport RPCs have dedicated handlers that post the
      // matching response back over the port; routing them into receiveSync
      // would silently drop them and hang the caller's promise.
      this.bridge.receiveCaptureRequest(data as SonareEngineCaptureRequestMessage);
    } else if (type === 'transportRequest') {
      this.bridge.receiveTransportRequest(data as SonareEngineTransportRequestMessage);
    } else if (typeof type === 'string' && type.startsWith('sync')) {
      // The facade's control-plane contract: every `sync*` message must reach
      // the bridge (libsonare does not export a canonical list, so match the
      // documented prefix contract).
      this.bridge.receiveSync(data as SonareEngineSyncMessage);
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.bridge) {
      try {
        return this.bridge.process(inputs, outputs);
      } catch (error) {
        // A thrown AudioWorklet `process()` exception is otherwise reduced to
        // the browser's opaque `processorerror` event. Send the native/error
        // message across the port first so the host can surface it, then end
        // this processor; the host tears the engine down on that message.
        this.port.postMessage({
          type: 'runtimeError',
          message: error instanceof Error ? error.message : String(error),
        });
        for (const channel of outputs[0] ?? []) channel.fill(0);
        return false;
      }
    }
    for (const channel of outputs[0] ?? []) {
      channel.fill(0);
    }
    return true;
  }
}

registerProcessor('sonare-realtime-engine-processor', SonareEngineWorklet);

class SonareVoiceChangerWorklet extends AudioWorkletProcessor {
  private bridge: SonareRealtimeVoiceChangerWorkletProcessor | null = null;
  private readonly pending: unknown[] = [];

  constructor(options?: { processorOptions?: VoiceChangerProcessorOptions }) {
    super();
    const processorOptions = options?.processorOptions ?? {};
    const port = this.port;
    const onMessage = (event: MessageEvent) => {
      if (this.bridge) this.dispatch(event.data);
      else this.pending.push(event.data);
    };
    if ('addEventListener' in port && typeof port.addEventListener === 'function') {
      port.addEventListener('message', onMessage);
      port.start?.();
    } else {
      port.onmessage = onMessage;
    }
    const { wasmBinary } = processorOptions;
    const scope = globalThis as WorkletGlobal;
    const initOptions = {
      locateFile: (path: string) => path,
      ...(wasmBinary ? { wasmBinary } : {}),
      ...(scope.SonareEmbindModuleFactory
        ? { moduleFactory: scope.SonareEmbindModuleFactory }
        : {}),
    };
    const initPromise = (async () => {
      if (scope.SonareEmbindInitPromise) {
        await scope.SonareEmbindInitPromise;
      }
      if (!isInitialized()) {
        await (init as (opts?: object) => Promise<void>)(initOptions);
      }
    })();
    void initPromise
      .then(() => {
        this.bridge = new SonareRealtimeVoiceChangerWorkletProcessor(processorOptions);
        for (const message of this.pending) this.dispatch(message);
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
    if (!this.bridge || data === null || typeof data !== 'object') return;
    const type = (data as { type?: unknown }).type;
    if (type === 'setConfig' || type === 'reset' || type === 'destroy') {
      this.bridge.receiveMessage(data as SonareRealtimeVoiceChangerMessage);
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.bridge) return this.bridge.process(inputs, outputs);
    for (const channel of outputs[0] ?? []) channel.fill(0);
    return true;
  }
}

registerProcessor('sonare-realtime-voice-changer-processor', SonareVoiceChangerWorklet);

class SonareStreamingRetuneWorklet extends AudioWorkletProcessor {
  private retunes: StreamingRetune[] = [];
  private zero: Float32Array;
  private ready = false;
  private destroyed = false;
  private readonly pending: unknown[] = [];
  private readonly sampleRateValue: number;
  private readonly blockSize: number;
  private readonly channelCount: number;

  constructor(options?: { processorOptions?: StreamingRetuneProcessorOptions }) {
    super();
    const processorOptions = options?.processorOptions ?? {};
    this.sampleRateValue = processorOptions.sampleRate ?? 48_000;
    this.blockSize = Math.max(1, Math.floor(processorOptions.blockSize ?? 128));
    this.channelCount = Math.max(1, Math.floor(processorOptions.channelCount ?? 1));
    this.zero = new Float32Array(this.blockSize);
    const port = this.port;
    const onMessage = (event: MessageEvent) => {
      if (this.ready) this.dispatch(event.data);
      else this.pending.push(event.data);
    };
    if ('addEventListener' in port && typeof port.addEventListener === 'function') {
      port.addEventListener('message', onMessage);
      port.start?.();
    } else {
      port.onmessage = onMessage;
    }
    const {
      wasmBinary,
      sampleRate: _sampleRate,
      blockSize: _blockSize,
      channelCount: _channelCount,
      ...config
    } = processorOptions;
    const scope = globalThis as WorkletGlobal;
    const initOptions = {
      locateFile: (path: string) => path,
      ...(wasmBinary ? { wasmBinary } : {}),
      ...(scope.SonareEmbindModuleFactory
        ? { moduleFactory: scope.SonareEmbindModuleFactory }
        : {}),
    };
    void (async () => {
      if (scope.SonareEmbindInitPromise) await scope.SonareEmbindInitPromise;
      if (!isIndexInitialized()) {
        await (initIndexModule as (opts?: object) => Promise<void>)(initOptions);
      }
    })()
      .then(() => {
        this.retunes = Array.from({ length: this.channelCount }, () => {
          const retune = new StreamingRetune(config);
          retune.prepare(this.sampleRateValue, this.blockSize);
          return retune;
        });
        this.ready = true;
        for (const message of this.pending) this.dispatch(message);
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
    if (data === null || typeof data !== 'object') return;
    const type = (data as { type?: unknown }).type;
    if (type === 'setConfig') {
      const config = (data as { config?: StreamingRetuneConfig }).config ?? {};
      for (const retune of this.retunes) retune.setConfig(config);
    } else if (type === 'reset') {
      for (const retune of this.retunes) retune.reset();
    } else if (type === 'destroy') {
      this.destroy();
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (this.destroyed || !output) return !this.destroyed;
    if (!this.ready) {
      for (const channel of output) channel.fill(0);
      return true;
    }
    const input = inputs[0] ?? [];
    const channels = Math.min(output.length, this.retunes.length);
    for (let ch = 0; ch < channels; ch++) {
      const dst = output[ch];
      const src = input[ch] ?? this.zero;
      const processed = this.retunes[ch].processMono(src);
      const frames = Math.min(dst.length, processed.length);
      for (let frame = 0; frame < frames; frame++) dst[frame] = processed[frame];
      for (let frame = frames; frame < dst.length; frame++) dst[frame] = 0;
    }
    return true;
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const retune of this.retunes) retune.delete();
    this.retunes = [];
  }
}

registerProcessor('sonare-streaming-retune-processor', SonareStreamingRetuneWorklet);
