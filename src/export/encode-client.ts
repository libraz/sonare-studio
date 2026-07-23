/** Main-thread facade for cancellable deterministic codec workers. */

import type {
  AudioEncodeWorkerRequest,
  AudioEncodeWorkerResponse,
  WorkerAudioEncoderId,
} from '@/workers/audio-encode.worker';
import { WAV_ENCODER_ID } from './codecs';
import { FLAC_ENCODER_ID } from './flac';
import { MP3_ENCODER_ID } from './mp3';

const WORKER_ENCODER_IDS = new Set<string>([WAV_ENCODER_ID, FLAC_ENCODER_ID, MP3_ENCODER_ID]);

export type AudioEncodeWorkerFactory = () => Worker;

/** True for deterministic codecs supported by the bundled encode worker. */
export function isWorkerAudioEncoderId(id: string): id is WorkerAudioEncoderId {
  return WORKER_ENCODER_IDS.has(id);
}

function createAudioEncodeWorker(): Worker {
  return new Worker(new URL('../workers/audio-encode.worker.ts', import.meta.url), {
    type: 'module',
  });
}

function transferableChannels(channels: ReadonlyArray<Float32Array>): {
  channels: Float32Array[];
  transfer: ArrayBuffer[];
} {
  const output: Float32Array[] = [];
  const transfer: ArrayBuffer[] = [];
  const used = new Set<ArrayBuffer>();
  for (const channel of channels) {
    const wholeBuffer =
      channel.buffer instanceof ArrayBuffer &&
      channel.byteOffset === 0 &&
      channel.byteLength === channel.buffer.byteLength &&
      !used.has(channel.buffer);
    const transferable = wholeBuffer ? channel : new Float32Array(channel);
    const buffer = transferable.buffer as ArrayBuffer;
    used.add(buffer);
    output.push(transferable);
    transfer.push(buffer);
  }
  return { channels: output, transfer };
}

/** Selects the cloneable codec options that form the worker protocol. */
function workerOptions(
  encoderId: WorkerAudioEncoderId,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const allowed =
    encoderId === WAV_ENCODER_ID
      ? ['bitDepth', 'dither']
      : encoderId === FLAC_ENCODER_ID
        ? ['bitDepth', 'blockSize']
        : ['bitrate'];
  return Object.fromEntries(
    allowed.flatMap((key) => (options[key] === undefined ? [] : [[key, options[key]]])),
  );
}

/**
 * Encodes in a disposable worker. Transferrable input channel buffers are
 * consumed; cancellation terminates synchronous codec work immediately.
 */
export function encodeAudioInWorker(
  encoderId: WorkerAudioEncoderId,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: Record<string, unknown> = {},
  signal?: AbortSignal,
  workerFactory: AudioEncodeWorkerFactory = createAudioEncodeWorker,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const worker = workerFactory();
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError as EventListener);
      worker.terminate();
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = (): void => {
      settle(() =>
        reject(signal?.reason ?? new DOMException('Audio encoding cancelled.', 'AbortError')),
      );
    };
    const onMessage = (event: MessageEvent<AudioEncodeWorkerResponse>): void => {
      const response = event.data;
      if (response.type === 'progress') {
        if (!settled) onProgress?.(response.fraction);
        return;
      }
      if (response.type === 'encoded') settle(() => resolve(response.bytes));
      else settle(() => reject(new Error(response.error)));
    };
    const onError = (event: ErrorEvent): void => {
      settle(() => reject(new Error(event.message || 'Audio encode worker failed')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError as EventListener);

    const input = transferableChannels(channels);
    const request: AudioEncodeWorkerRequest = {
      type: 'encode',
      encoderId,
      channels: input.channels,
      sampleRate,
      // The protocol is deliberately whitelisted: AbortSignal, callbacks and
      // future main-thread-only options never cross structured-clone bounds.
      options: workerOptions(encoderId, options),
    };
    worker.postMessage(request, input.transfer);
    if (signal?.aborted) onAbort();
  });
}
