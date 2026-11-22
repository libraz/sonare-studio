import {
  init as initIndexModule,
  isInitialized as isIndexInitialized,
  StreamingRetune,
  type StreamingRetuneConfig,
} from '@libraz/libsonare';
import type {
  SonareRealtimeEngineWorkletProcessorOptions,
  SonareRealtimeVoiceChangerWorkletProcessorOptions,
} from '@libraz/libsonare/worklet';
import {
  init,
  isInitialized,
  SonareRealtimeEngineWorkletProcessor,
  SonareRealtimeVoiceChangerWorkletProcessor,
} from '@libraz/libsonare/worklet';
import { errorMessage } from '@/lib/errors';

// AudioWorkletGlobalScope globals are not part of the TS DOM/WebWorker libs.
declare const AudioWorkletProcessor: new () => { readonly port: MessagePort };
declare function registerProcessor<Options>(
  name: string,
  ctor: new (options?: { processorOptions?: Options }) => unknown,
): void;

type EngineProcessorOptions = SonareRealtimeEngineWorkletProcessorOptions;

type VoiceChangerProcessorOptions = SonareRealtimeVoiceChangerWorkletProcessorOptions;

type StreamingRetuneProcessorOptions = StreamingRetuneConfig & {
  /** Sonare embind WASM bytes, supplied by the main thread (no fetch in worklets). */
  wasmBinary?: ArrayBuffer;
  sampleRate?: number;
  maxBlockSize?: number;
  numChannels?: number;
};

type EngineProcessor = InstanceType<typeof SonareRealtimeEngineWorkletProcessor>;

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
 * public/assets/sonare-engine-worklet-<hash>.js (the worklet scope cannot load
 * external imports).
 *
 * The stock registerSonareRealtimeEngineWorkletProcessor() constructs the embind
 * bridge synchronously, but the embind runtime requires the sonare WASM module to
 * be initialized first — and the worklet scope has no fetch(), so the bytes must
 * arrive via processorOptions.wasmBinary. This processor initializes the module
 * asynchronously, buffers early port messages, and posts 'ready'/'error' so the
 * main thread can await a usable engine.
 */
/**
 * Ends a processor whose `process()` threw. The browser would otherwise reduce
 * the exception to an opaque `processorerror` event, so the message crosses the
 * port first for the host to surface, and the failing block is silenced.
 *
 * @returns false, so the processor is not called again.
 */
function failProcess(port: MessagePort, outputs: Float32Array[][], error: unknown): boolean {
  port.postMessage({ type: 'runtimeError', message: errorMessage(error) });
  for (const channel of outputs[0] ?? []) channel.fill(0);
  return false;
}

class SonareEngineWorklet extends AudioWorkletProcessor {
  private bridge: SonareRealtimeEngineWorkletProcessor | null = null;
  private readonly pending: unknown[] = [];

  constructor(options?: { processorOptions?: EngineProcessorOptions }) {
    super();
    const processorOptions = (options?.processorOptions ?? {}) as EngineProcessorOptions;
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
        this.bridge = new SonareRealtimeEngineWorkletProcessor({
          ...processorOptions,
          transport: {
            postMessage: (message) => port.postMessage(message),
            onMeter: (meter) => port.postMessage(meter),
          },
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
          message: errorMessage(error),
        });
      });
  }

  private dispatch(data: unknown): void {
    if (!this.bridge || data === null || typeof data !== 'object') {
      return;
    }
    const type = (data as { type?: unknown }).type;
    if (typeof type === 'number') {
      this.bridge.receiveCommand(data as Parameters<EngineProcessor['receiveCommand']>[0]);
    } else if (type === 'captureRequest') {
      // Capture and transport RPCs have dedicated handlers that post the
      // matching response back over the port; routing them into receiveSync
      // would silently drop them and hang the caller's promise.
      this.bridge.receiveCaptureRequest(
        data as Parameters<EngineProcessor['receiveCaptureRequest']>[0],
      );
    } else if (type === 'transportRequest') {
      this.bridge.receiveTransportRequest(
        data as Parameters<EngineProcessor['receiveTransportRequest']>[0],
      );
    } else if (typeof type === 'string' && type.startsWith('sync')) {
      // The facade's control-plane contract: every `sync*` message must reach
      // the bridge (libsonare does not export a canonical list, so match the
      // documented prefix contract).
      this.bridge.receiveSync(data as Parameters<EngineProcessor['receiveSync']>[0]);
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.bridge) {
      try {
        return this.bridge.process(inputs, outputs);
      } catch (error) {
        return failProcess(this.port, outputs, error);
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
    const processorOptions = (options?.processorOptions ?? {}) as VoiceChangerProcessorOptions;
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
          message: errorMessage(error),
        });
      });
  }

  private dispatch(data: unknown): void {
    if (!this.bridge || data === null || typeof data !== 'object') return;
    const type = (data as { type?: unknown }).type;
    if (type === 'setConfig' || type === 'reset' || type === 'destroy') {
      this.bridge.receiveMessage(data);
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.bridge) {
      try {
        return this.bridge.process(inputs, outputs);
      } catch (error) {
        return failProcess(this.port, outputs, error);
      }
    }
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
  private readonly maxBlockSize: number;
  private readonly numChannels: number;

  constructor(options?: { processorOptions?: StreamingRetuneProcessorOptions }) {
    super();
    const processorOptions = options?.processorOptions ?? {};
    this.sampleRateValue = processorOptions.sampleRate ?? 48_000;
    this.maxBlockSize = Math.max(1, Math.floor(processorOptions.maxBlockSize ?? 128));
    this.numChannels = Math.max(1, Math.floor(processorOptions.numChannels ?? 1));
    this.zero = new Float32Array(this.maxBlockSize);
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
      maxBlockSize: _maxBlockSize,
      numChannels: _numChannels,
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
        this.retunes = Array.from({ length: this.numChannels }, () => {
          const retune = new StreamingRetune(config);
          retune.prepare(this.sampleRateValue, this.maxBlockSize);
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
          message: errorMessage(error),
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
    try {
      for (let ch = 0; ch < channels; ch++) {
        const dst = output[ch];
        const src = input[ch] ?? this.zero;
        const processed = this.retunes[ch].processMono(src);
        const frames = Math.min(dst.length, processed.length);
        for (let frame = 0; frame < frames; frame++) dst[frame] = processed[frame];
        for (let frame = frames; frame < dst.length; frame++) dst[frame] = 0;
      }
    } catch (error) {
      return failProcess(this.port, outputs, error);
    }
    return true;
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const retune of this.retunes) retune.destroy();
    this.retunes = [];
  }
}

registerProcessor('sonare-streaming-retune-processor', SonareStreamingRetuneWorklet);
