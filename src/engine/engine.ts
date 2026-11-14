import { errorMessage } from '@/lib/errors';
import { requestPwaEngineRecovery } from '@/pwa';
import sonareWasmUrl from '@/wasm/sonare.wasm?url';
import type { SonareRealtimeEngineNodeCapabilities } from '@/wasm/worklet.js';
import { init as initWorkletModule, SonareEngine } from '@/wasm/worklet.js';

/**
 * Content-addressed same-origin AudioWorklet bundle, injected from the
 * build:worklet manifest in both dev and the app build. The fallback only
 * applies outside Vite (unit tests), where no worklet is ever loaded.
 */
export const WORKLET_MODULE_URL =
  typeof __SONARE_WORKLET_MODULE_URL__ === 'string'
    ? __SONARE_WORKLET_MODULE_URL__
    : '/assets/sonare-engine-worklet.js';

export function isEngineVersionMismatchError(error: unknown): boolean {
  const message = errorMessage(error);
  return /(?:engine|worklet).*ABI mismatch|ABI mismatch.*(?:engine|worklet)/i.test(message);
}

/** Default scope telemetry interval in frames (~47 Hz at 48 kHz). */
const DEFAULT_SCOPE_INTERVAL_FRAMES = 1024;
/** Default scope spectrum band count: the engine's maximum (it refuses more than 64). */
const DEFAULT_SCOPE_BANDS = 64;

/** Options for {@link createEngine}. */
export interface CreateEngineOptions {
  /** Cancels startup before the engine handle is published. */
  signal?: AbortSignal;
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
  /** Latest best-effort cleanup stage status, exposed for recovery diagnostics. */
  cleanupState?(): EngineCleanupState;
}

interface WorkletRuntimeErrorMessage {
  type: 'runtimeError';
  message: string;
}

interface WorkletSyncErrorMessage {
  type: 'syncError';
  syncType: string;
  message: string;
}

function isWorkletRuntimeErrorMessage(value: unknown): value is WorkletRuntimeErrorMessage {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'runtimeError' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

function isWorkletSyncErrorMessage(value: unknown): value is WorkletSyncErrorMessage {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'syncError' &&
    typeof (value as { syncType?: unknown }).syncType === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/**
 * Logs a worklet's `runtimeError` port message and re-dispatches it as the
 * node's standard `processorerror`, so a thrown `process()` reaches the same
 * listeners however the browser reports it. The caller starts the port.
 *
 * @param label Prefix naming the processor in the log line.
 * @returns Detaches the listener.
 */
export function forwardWorkletRuntimeErrors(
  node: { port: MessagePort; dispatchEvent(event: Event): boolean },
  label: string,
): () => void {
  const onMessage = (event: MessageEvent) => {
    if (!isWorkletRuntimeErrorMessage(event.data)) return;
    console.error(`${label} worklet runtime error: ${event.data.message}`);
    node.dispatchEvent(new Event('processorerror'));
  };
  node.port.addEventListener('message', onMessage);
  return () => node.port.removeEventListener('message', onMessage);
}

/**
 * Invokes `onError` once when any of the nodes reports `processorerror`
 * (native or re-dispatched by {@link forwardWorkletRuntimeErrors}).
 *
 * @returns Detaches the listeners.
 */
export function listenProcessorError(
  nodes: ReadonlyArray<{
    addEventListener(type: 'processorerror', listener: () => void): void;
    removeEventListener(type: 'processorerror', listener: () => void): void;
  }>,
  onError: (() => void) | undefined,
): () => void {
  if (!onError) return () => {};
  let fired = false;
  const listener = (): void => {
    if (fired) return;
    fired = true;
    onError();
  };
  for (const node of nodes) node.addEventListener('processorerror', listener);
  return () => {
    for (const node of nodes) node.removeEventListener('processorerror', listener);
  };
}

export interface EngineCleanupState {
  nodeDetached: boolean;
  engineDestroyed: boolean;
  contextClosed: boolean;
}

export interface EngineCleanupFailure {
  stage: keyof EngineCleanupState;
  error: unknown;
}

export class EngineDisposalError extends Error {
  constructor(readonly failures: readonly EngineCleanupFailure[]) {
    super(`Engine cleanup failed at ${failures.map((failure) => failure.stage).join(', ')}`, {
      cause: failures[0]?.error,
    });
    this.name = 'EngineDisposalError';
  }
}

interface DisposableEngineResources {
  destroy(): void;
  node: { disconnect(): void };
}

interface ClosableAudioContext {
  readonly state: string;
  close(): Promise<void>;
}

/** Independent, retryable teardown stages for one engine/context ownership pair. */
export function createEngineResourceDisposer(
  engine: DisposableEngineResources,
  ctx: ClosableAudioContext,
): { dispose(): Promise<void>; state(): EngineCleanupState } {
  const state: EngineCleanupState = {
    nodeDetached: false,
    engineDestroyed: false,
    contextClosed: ctx.state === 'closed',
  };
  return {
    async dispose(): Promise<void> {
      const failures: EngineCleanupFailure[] = [];
      if (!state.nodeDetached) {
        try {
          (engine.node as { onprocessorerror?: unknown }).onprocessorerror = null;
          engine.node.disconnect();
          state.nodeDetached = true;
        } catch (error) {
          failures.push({ stage: 'nodeDetached', error });
        }
      }
      if (!state.engineDestroyed) {
        try {
          engine.destroy();
          state.engineDestroyed = true;
        } catch (error) {
          failures.push({ stage: 'engineDestroyed', error });
        }
      }
      if (!state.contextClosed) {
        try {
          if (ctx.state !== 'closed') await ctx.close();
          state.contextClosed = true;
        } catch (error) {
          failures.push({ stage: 'contextClosed', error });
        }
      }
      if (failures.length > 0) throw new EngineDisposalError(failures);
    },
    state(): EngineCleanupState {
      return { ...state };
    },
  };
}

interface WorkletReadyPort {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
  /** Required when readiness is observed with addEventListener rather than onmessage. */
  start?(): void;
}

interface WorkletProcessorErrorTarget {
  addEventListener(type: 'processorerror', listener: () => void): void;
  removeEventListener(type: 'processorerror', listener: () => void): void;
}

/** Options for the worklet's startup acknowledgement. */
export interface WorkletReadyOptions {
  /** Maximum wait before rejecting. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Cancels the wait and removes every listener. */
  signal?: AbortSignal;
  /** AudioWorkletNode used to observe a processor crash before ready. */
  processor?: WorkletProcessorErrorTarget;
  /** Processor label used in diagnostics (default `engine`). */
  label?: string;
}

const DEFAULT_WORKLET_READY_TIMEOUT_MS = 10_000;

let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

/**
 * Fetches the sonare WASM bytes once (same-origin, as COEP require-corp demands).
 *
 * The worklet build strips its embedded .wasm, so every AudioWorklet processor that
 * initializes the module (the engine and the retune/voice-changer input processors)
 * must receive these bytes through `processorOptions.wasmBinary`; the worklet scope
 * has no fetch() to load them itself.
 */
export function fetchWasmBinary(): Promise<ArrayBuffer> {
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

export function waitForWorkletReady(
  port: WorkletReadyPort,
  options: WorkletReadyOptions = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WORKLET_READY_TIMEOUT_MS;
    const label = options.label?.trim() || 'engine';
    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for ${label} worklet readiness after ${timeoutMs} ms.`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      port.removeEventListener('messageerror', onMessageError);
      options.processor?.removeEventListener('processorerror', onProcessorError);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; message?: unknown } | null;
      if (data?.type === 'ready') {
        succeed();
      } else if (data?.type === 'error') {
        fail(new Error(`${label} worklet failed to initialize: ${String(data.message)}`));
      }
    };
    const onMessageError = (): void => {
      fail(new Error(`${label} worklet readiness message could not be decoded.`));
    };
    const onProcessorError = (): void => {
      fail(new Error(`${label} worklet processor crashed before initialization completed.`));
    };
    const onAbort = (): void => {
      fail(options.signal?.reason ?? new DOMException('Engine startup aborted.', 'AbortError'));
    };
    port.addEventListener('message', onMessage);
    port.addEventListener('messageerror', onMessageError);
    options.processor?.addEventListener('processorerror', onProcessorError);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // MessagePort only starts delivery implicitly through `onmessage`; this
    // path deliberately uses addEventListener so explicit activation is needed.
    port.start?.();
    if (options.signal?.aborted) onAbort();
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
  options.signal?.throwIfAborted();
  // The published init() type only declares locateFile, but options pass through to
  // the Emscripten factory, which accepts wasmBinary.
  await (initWorkletModule as (opts?: object) => Promise<void>)({ wasmBinary });
  options.signal?.throwIfAborted();

  const ctx = new AudioContext();
  let engine: SonareEngine | null = null;
  let workletReady: Promise<void> | null = null;
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
        workletReady = waitForWorkletReady(node.port, {
          processor: node,
          signal: options.signal,
        });
        // Keep a rejection after a failed create() from going unhandled; the await below still observes it.
        workletReady.catch(() => undefined);
        return node;
      },
    });
    if (!workletReady) throw new Error('Engine worklet node was not created.');
    await workletReady;
    options.signal?.throwIfAborted();

    if (engine.capabilities.abiCompatible === false) {
      requestPwaEngineRecovery();
      throw new Error(
        'libsonare engine ABI mismatch. Reload to install matching app and audio-engine files.',
      );
    }

    engine.node.connect(ctx.destination);
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
      options.signal?.throwIfAborted();
    }
  } catch (err) {
    if (isEngineVersionMismatchError(err)) requestPwaEngineRecovery();
    try {
      engine?.destroy();
    } catch {
      // Best-effort rollback continues with closing the owning context.
    }
    await ctx.close().catch(() => undefined);
    throw err;
  }

  const resourceDisposer = createEngineResourceDisposer(engine, ctx);
  // Worklet `process()` exceptions normally surface only as a generic
  // AudioWorkletNode `processorerror`. The entry module sends an explanatory
  // runtimeError first; re-dispatch it through the standard processorerror
  // path so lifecycle ownership and cleanup remain centralized.
  const detachRuntimeErrors = forwardWorkletRuntimeErrors(engine.node, 'Engine');
  const onWorkletSyncError = (event: MessageEvent) => {
    if (!isWorkletSyncErrorMessage(event.data)) return;
    const message = `Audio engine sync failed (${event.data.syncType}): ${event.data.message}`;
    console.error(message);
    engine.node.dispatchEvent(new CustomEvent('processorerror', { detail: message }));
  };
  engine.node.port.addEventListener('message', onWorkletSyncError);
  engine.node.port.start?.();

  return {
    engine,
    ctx,
    capabilities: engine.capabilities,
    dispose: async () => {
      detachRuntimeErrors();
      engine.node.port.removeEventListener('message', onWorkletSyncError);
      await resourceDisposer.dispose();
    },
    cleanupState: resourceDisposer.state,
  };
}
