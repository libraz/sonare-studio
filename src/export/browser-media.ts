/**
 * Browser MediaRecorder-backed export encoders.
 *
 * These provide compressed formats that the current wasm bundle does not
 * encode directly. Availability is runtime-dependent; only MIME types accepted
 * by `MediaRecorder.isTypeSupported()` are registered.
 */

import {
  type AudioEncodeOptions,
  type AudioEncoder,
  listEncoders,
  registerEncoder,
} from './codecs';

export const AAC_ENCODER_ID = 'aac';
export const OPUS_WEBM_ENCODER_ID = 'opus-webm';
export const OPUS_OGG_ENCODER_ID = 'opus-ogg';

const BROWSER_MEDIA_ENCODER_IDS = new Set<string>([
  AAC_ENCODER_ID,
  OPUS_WEBM_ENCODER_ID,
  OPUS_OGG_ENCODER_ID,
]);

/** Returns true for encoders backed by the browser MediaRecorder path. */
export function isBrowserMediaEncoderId(id: string): boolean {
  return BROWSER_MEDIA_ENCODER_IDS.has(id);
}

interface BrowserMediaEncoderDesc {
  id: string;
  label: string;
  extension: string;
  mime: string;
}

const BROWSER_MEDIA_ENCODERS: ReadonlyArray<BrowserMediaEncoderDesc> = [
  {
    id: AAC_ENCODER_ID,
    label: 'AAC (M4A)',
    extension: '.m4a',
    mime: 'audio/mp4;codecs=mp4a.40.2',
  },
  {
    id: OPUS_WEBM_ENCODER_ID,
    label: 'Opus (WebM)',
    extension: '.webm',
    mime: 'audio/webm;codecs=opus',
  },
  {
    id: OPUS_OGG_ENCODER_ID,
    label: 'Ogg Opus',
    extension: '.ogg',
    mime: 'audio/ogg;codecs=opus',
  },
];

function assertPlanar(channels: ReadonlyArray<Float32Array>): number {
  if (channels.length !== 1 && channels.length !== 2) {
    throw new RangeError(`Browser media encoding supports 1 or 2 channels, got ${channels.length}`);
  }
  const frames = channels[0]?.length ?? 0;
  if (channels.some((channel) => channel.length !== frames)) {
    throw new RangeError('Browser media encoder channel buffers must have equal lengths');
  }
  return frames;
}

function toBlobBytes(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

/**
 * Encodes planar audio through the browser MediaRecorder stack.
 *
 * @throws RangeError for unsupported buffer shapes.
 * @throws Error when MediaRecorder or AudioContext are unavailable.
 */
export async function encodeBrowserMedia(
  mimeType: string,
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: AudioEncodeOptions = {},
): Promise<Uint8Array> {
  const signal = options['signal'] as AbortSignal | undefined;
  const onProgress = options['onProgress'] as ((fraction: number) => void) | undefined;
  signal?.throwIfAborted();
  const frames = assertPlanar(channels);
  const AudioContextCtor = globalThis.AudioContext;
  const RecorderCtor = globalThis.MediaRecorder;
  if (typeof AudioContextCtor !== 'function' || typeof RecorderCtor !== 'function') {
    throw new Error('Browser media encoding is unavailable in this environment');
  }
  if (
    typeof RecorderCtor.isTypeSupported === 'function' &&
    !RecorderCtor.isTypeSupported(mimeType)
  ) {
    throw new Error(`Browser media encoding does not support ${mimeType}`);
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Sample rate must be finite and > 0, got ${sampleRate}`);
  }

  const context = new AudioContextCtor({ sampleRate });
  try {
    await context.resume?.();
    signal?.throwIfAborted();
    const destination = context.createMediaStreamDestination();
    const buffer = context.createBuffer(channels.length, frames, sampleRate);
    for (let index = 0; index < channels.length; index += 1) {
      buffer.copyToChannel(channels[index] as Float32Array<ArrayBuffer>, index);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);

    const chunks: Blob[] = [];
    const recorderOptions: MediaRecorderOptions = { mimeType };
    const bitrate = options['bitrate'];
    if (typeof bitrate === 'number' && Number.isFinite(bitrate) && bitrate > 0) {
      recorderOptions.audioBitsPerSecond = bitrate * 1000;
    }
    const recorder = new RecorderCtor(destination.stream, recorderOptions);
    const durationSeconds = frames / sampleRate;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    let cleanupRecorderListeners = (): void => {};
    const done = new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      const onDataAvailable = (event: BlobEvent): void => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      const onError = (event: Event): void => {
        settle(() =>
          reject(
            event instanceof ErrorEvent ? event.error : new Error('Browser media encoding failed'),
          ),
        );
      };
      const onStop = (): void => {
        settle(() => {
          onProgress?.(1);
          resolve(toBlobBytes(new Blob(chunks, { type: mimeType })));
        });
      };
      const onEnded = (): void => {
        if (recorder.state === 'recording') recorder.stop();
      };
      const onAbort = (): void => {
        settle(() =>
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException('Browser media encoding cancelled.', 'AbortError'),
          ),
        );
        try {
          source.stop();
        } catch {
          // The source may already have ended.
        }
        if (recorder.state === 'recording') recorder.stop();
      };
      cleanupRecorderListeners = () => {
        if (progressTimer !== null) clearInterval(progressTimer);
        progressTimer = null;
        recorder.removeEventListener('dataavailable', onDataAvailable);
        recorder.removeEventListener('error', onError);
        recorder.removeEventListener('stop', onStop);
        source.removeEventListener('ended', onEnded);
        signal?.removeEventListener('abort', onAbort);
      };
      recorder.addEventListener('dataavailable', onDataAvailable);
      recorder.addEventListener('error', onError);
      recorder.addEventListener('stop', onStop);
      source.addEventListener('ended', onEnded);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    recorder.start();
    source.start(context.currentTime);
    onProgress?.(0);
    if (durationSeconds > 0 && Number.isFinite(context.currentTime)) {
      progressTimer = setInterval(() => {
        onProgress?.(Math.min(0.99, Math.max(0, context.currentTime / durationSeconds)));
      }, 100);
    }
    if (signal?.aborted) {
      try {
        source.stop();
      } catch {
        // Source already stopped.
      }
    }
    try {
      return await done;
    } finally {
      cleanupRecorderListeners();
      if (recorder.state === 'recording') recorder.stop();
    }
  } finally {
    await context.close();
  }
}

function createBrowserMediaEncoder(desc: BrowserMediaEncoderDesc): AudioEncoder {
  return {
    id: desc.id,
    label: desc.label,
    extension: desc.extension,
    mime: desc.mime,
    deterministic: false,
    encode: (channels, sampleRate, options) =>
      encodeBrowserMedia(desc.mime, channels, sampleRate, options),
  };
}

/** Registers every MediaRecorder-backed encoder supported by the current browser. */
export function registerBrowserMediaEncoders(): string[] {
  const RecorderCtor = globalThis.MediaRecorder;
  if (typeof RecorderCtor !== 'function' || typeof RecorderCtor.isTypeSupported !== 'function') {
    return [];
  }
  const existing = new Set(listEncoders().map((encoder) => encoder.id));
  const registered: string[] = [];
  for (const desc of BROWSER_MEDIA_ENCODERS) {
    if (existing.has(desc.id) || !RecorderCtor.isTypeSupported(desc.mime)) continue;
    registerEncoder(createBrowserMediaEncoder(desc));
    registered.push(desc.id);
    existing.add(desc.id);
  }
  return registered;
}
