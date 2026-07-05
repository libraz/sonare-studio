import sonareWasmUrl from '@/wasm/sonare.wasm?url';
import type { SonareRealtimeEngineNodeCapabilities } from '@/wasm/worklet.js';
import { init as initWorkletModule, SonareEngine } from '@/wasm/worklet.js';

/** Fixed same-origin path of the self-contained AudioWorklet module bundle. */
const WORKLET_MODULE_URL = '/sonare-engine-worklet.js';

/** Default scope telemetry interval in frames (~47 Hz at 48 kHz). */
const DEFAULT_SCOPE_INTERVAL_FRAMES = 1024;
/** Default scope spectrum band count. */
const DEFAULT_SCOPE_BANDS = 96;

/** Options for {@link createEngine}. */
export interface CreateEngineOptions {
  /** Transport mode; 'auto' degrades to postMessage when SharedArrayBuffer is unavailable. */
  mode?: 'auto' | 'sab' | 'postMessage';
  /** Output channel count (default 2). */
  channelCount?: number;
  /**
   * Scope telemetry (per-target spectrum + goniometer) interval in frames.
   * 0 disables scope telemetry. Defaults to {@link DEFAULT_SCOPE_INTERVAL_FRAMES}.
   * Only flows in SAB mode on the embind runtime.
   */
  scopeIntervalFrames?: number;
  /** Scope spectrum band count. Defaults to {@link DEFAULT_SCOPE_BANDS}. */
  scopeBands?: number;
}

/** A running audio engine instance with its owning AudioContext. */
export interface EngineHandle {
  /** The libsonare realtime engine facade. */
  engine: SonareEngine;
  /** The AudioContext driving the engine's AudioWorklet. */
  ctx: AudioContext;
  /** Negotiated runtime capabilities (mode, SAB availability, ABI status, degradedReason). */
  capabilities: SonareRealtimeEngineNodeCapabilities;
  /** Destroys the engine and closes the AudioContext. Safe to call once. */
  dispose(): Promise<void>;
}

interface WorkletReadyPort {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

/** Fetches the sonare WASM bytes once (same-origin, as COEP require-corp demands). */
function fetchWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = fetch(sonareWasmUrl)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to fetch engine WASM (HTTP ${res.status}): ${sonareWasmUrl}`);
        }
        return res.arrayBuffer();
      })
      .catch((err) => {
        wasmBinaryPromise = null;
        throw err;
      });
  }
  return wasmBinaryPromise;
}

export function waitForWorkletReady(port: WorkletReadyPort): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      port.removeEventListener('message', onMessage);
    };
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; message?: unknown } | null;
      if (data?.type === 'ready') {
        cleanup();
        resolve();
      } else if (data?.type === 'error') {
        cleanup();
        reject(new Error(`Engine worklet failed to initialize: ${String(data.message)}`));
      }
    };
    port.addEventListener('message', onMessage);
  });
}

/**
 * Creates an AudioContext, loads the engine worklet module, and returns a ready engine.
 *
 * The sonare WASM bytes are fetched once and used twice: to initialize the worklet
 * module's main-thread copy (SonareEngine keeps an offline engine mirror there), and
 * passed via processorOptions into the AudioWorklet, whose scope has no fetch().
 * Resolution waits for the worklet to confirm its own WASM initialization, and the
 * engine node is connected to the destination, so the returned engine is audible.
 *
 * Verifies the engine ABI after creation; on mismatch the engine is disposed and an
 * error instructing to re-sync the WASM assets is thrown.
 *
 * @param options Optional transport mode and channel count overrides.
 * @returns A handle exposing the engine, its context, capabilities, and a disposer.
 */
export async function createEngine(options: CreateEngineOptions = {}): Promise<EngineHandle> {
  const wasmBinary = await fetchWasmBinary();
  // The published init() type only declares locateFile, but options pass through to
  // the Emscripten factory, which accepts wasmBinary.
  await (initWorkletModule as (opts?: object) => Promise<void>)({ wasmBinary });

  const ctx = new AudioContext();
  let engine: SonareEngine;
  let workletReady!: Promise<void>;
  try {
    engine = await SonareEngine.create(ctx, {
      moduleUrl: WORKLET_MODULE_URL,
      mode: options.mode ?? 'auto',
      channelCount: options.channelCount ?? 2,
      scopeIntervalFrames: options.scopeIntervalFrames ?? DEFAULT_SCOPE_INTERVAL_FRAMES,
      scopeBands: options.scopeBands ?? DEFAULT_SCOPE_BANDS,
      nodeFactory: (context, processorName, nodeOptions) => {
        const node = new AudioWorkletNode(context, processorName, {
          ...nodeOptions,
          processorOptions: { ...(nodeOptions.processorOptions ?? {}), wasmBinary },
        });
        workletReady = waitForWorkletReady(node.port);
        return node;
      },
    });
    await workletReady;
  } catch (err) {
    await ctx.close().catch(() => undefined);
    throw err;
  }

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    engine.destroy();
    if (ctx.state !== 'closed') {
      await ctx.close().catch(() => undefined);
    }
  };

  if (engine.capabilities.abiCompatible === false) {
    await dispose();
    throw new Error(
      'libsonare engine ABI mismatch. Run "yarn copy:wasm" to align WASM and JS to the same release.',
    );
  }

  engine.node.connect(ctx.destination);
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => undefined);
  }

  return { engine, ctx, capabilities: engine.capabilities, dispose };
}
