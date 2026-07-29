import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AAC_ENCODER_ID,
  encodeBrowserMedia,
  OPUS_OGG_ENCODER_ID,
  OPUS_WEBM_ENCODER_ID,
  registerBrowserMediaEncoders,
} from '@/export/browser-media';
import { getEncoder, listEncoders } from '@/export/codecs';

class FakeBuffer {
  readonly copied: Float32Array[] = [];

  copyToChannel(samples: Float32Array, channel: number): void {
    this.copied[channel] = new Float32Array(samples);
  }
}

class FakeSource extends EventTarget {
  static last: FakeSource | null = null;
  buffer: FakeBuffer | null = null;
  readonly listenerCounts = new Map<string, number>();

  constructor() {
    super();
    FakeSource.last = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    super.addEventListener(type, listener);
    this.listenerCounts.set(type, (this.listenerCounts.get(type) ?? 0) + 1);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    super.removeEventListener(type, listener);
    this.listenerCounts.set(type, Math.max(0, (this.listenerCounts.get(type) ?? 0) - 1));
  }

  connect(_destination: unknown): void {}

  start(): void {
    queueMicrotask(() => this.dispatchEvent(new Event('ended')));
  }

  stop(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  readonly sampleRate: number;
  closed = false;

  constructor(options: { sampleRate?: number } = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    FakeAudioContext.last = this;
  }

  createMediaStreamDestination(): { stream: MediaStream } {
    return { stream: {} as MediaStream };
  }

  createBuffer(_channels: number, _frames: number, _sampleRate: number): FakeBuffer {
    return new FakeBuffer();
  }

  createBufferSource(): FakeSource {
    return new FakeSource();
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeMediaRecorder extends EventTarget {
  static supported = new Set<string>();
  static lastOptions: MediaRecorderOptions | null = null;
  static last: FakeMediaRecorder | null = null;
  state: RecordingState = 'inactive';
  readonly listenerCounts = new Map<string, number>();

  static isTypeSupported(mimeType: string): boolean {
    return FakeMediaRecorder.supported.has(mimeType);
  }

  constructor(
    readonly _stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    super();
    FakeMediaRecorder.lastOptions = options;
    FakeMediaRecorder.last = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    super.addEventListener(type, listener);
    this.listenerCounts.set(type, (this.listenerCounts.get(type) ?? 0) + 1);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    super.removeEventListener(type, listener);
    this.listenerCounts.set(type, Math.max(0, (this.listenerCounts.get(type) ?? 0) - 1));
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    const data = new Blob([new Uint8Array([0x4f, 0x70, 0x75, 0x73])], {
      type: this.options.mimeType,
    });
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data }));
    this.dispatchEvent(new Event('stop'));
  }
}

describe('browser MediaRecorder export encoders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeMediaRecorder.supported.clear();
    FakeMediaRecorder.lastOptions = null;
    FakeMediaRecorder.last = null;
    FakeAudioContext.last = null;
    FakeSource.last = null;
  });

  it('registers only browser-supported AAC/Opus encoders', () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus']);

    const registered = registerBrowserMediaEncoders();

    expect(registered).toEqual([AAC_ENCODER_ID, OPUS_WEBM_ENCODER_ID]);
    expect(listEncoders().map((encoder) => encoder.id)).toEqual(
      expect.arrayContaining([AAC_ENCODER_ID, OPUS_WEBM_ENCODER_ID]),
    );
    expect(getEncoder(AAC_ENCODER_ID).deterministic).toBe(false);
    expect(getEncoder(OPUS_WEBM_ENCODER_ID).deterministic).toBe(false);
    expect(() => getEncoder(OPUS_OGG_ENCODER_ID)).toThrow(RangeError);
    expect(registerBrowserMediaEncoders()).toEqual([]);
  });

  it('encodes through AudioContext and MediaRecorder when supported', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);

    await expect(
      encodeBrowserMedia(
        'audio/webm;codecs=opus',
        [new Float32Array([0, 0.25]), new Float32Array([0.5, -0.5])],
        48000,
        { bitrate: 256 },
      ),
    ).resolves.toEqual(new Uint8Array([0x4f, 0x70, 0x75, 0x73]));
    expect(FakeMediaRecorder.lastOptions).toMatchObject({
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 256000,
    });
    expect(FakeMediaRecorder.last?.listenerCounts.get('dataavailable')).toBe(0);
    expect(FakeMediaRecorder.last?.listenerCounts.get('error')).toBe(0);
    expect(FakeMediaRecorder.last?.listenerCounts.get('stop')).toBe(0);
    expect(FakeSource.last?.listenerCounts.get('ended')).toBe(0);
  });

  it('reports browser-encoder progress from start through recorder completion', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);
    const progress = vi.fn();

    await encodeBrowserMedia('audio/webm;codecs=opus', [new Float32Array([0, 0.25])], 48000, {
      onProgress: progress,
    });

    expect(progress).toHaveBeenCalledWith(0);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('cleans up MediaRecorder listeners and closes the context after encoder errors', async () => {
    class ErroringSource extends FakeSource {
      override start(): void {
        queueMicrotask(() => {
          FakeMediaRecorder.last?.dispatchEvent(new Event('error'));
        });
      }
    }
    class ErroringAudioContext extends FakeAudioContext {
      override createBufferSource(): FakeSource {
        return new ErroringSource();
      }
    }
    vi.stubGlobal('AudioContext', ErroringAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);

    await expect(
      encodeBrowserMedia('audio/webm;codecs=opus', [new Float32Array([0, 0.25])], 48000),
    ).rejects.toThrow('Browser media encoding failed');

    expect(FakeMediaRecorder.last?.state).toBe('inactive');
    expect(FakeMediaRecorder.last?.listenerCounts.get('dataavailable')).toBe(0);
    expect(FakeMediaRecorder.last?.listenerCounts.get('error')).toBe(0);
    expect(FakeMediaRecorder.last?.listenerCounts.get('stop')).toBe(0);
    expect(FakeSource.last?.listenerCounts.get('ended')).toBe(0);
    expect(FakeAudioContext.last?.closed).toBe(true);
  });

  it('aborts a hanging browser encode and releases recorder/context listeners', async () => {
    class NoCopyBuffer extends FakeBuffer {
      override copyToChannel(): void {}
    }
    class HangingSource extends FakeSource {
      override start(): void {}
    }
    class HangingAudioContext extends FakeAudioContext {
      override createBuffer(): FakeBuffer {
        return new NoCopyBuffer();
      }
      override createBufferSource(): FakeSource {
        return new HangingSource();
      }
    }
    vi.stubGlobal('AudioContext', HangingAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);
    const controller = new AbortController();

    const encoding = encodeBrowserMedia(
      'audio/webm;codecs=opus',
      [{ length: 48_000 * 60 * 60 * 2 } as Float32Array],
      48_000,
      { signal: controller.signal },
    );
    // Let the async AudioContext resume path install recorder listeners before
    // exercising cancellation during an active encode.
    await Promise.resolve();
    controller.abort(new DOMException('user cancelled', 'AbortError'));

    await expect(encoding).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeMediaRecorder.last?.state).toBe('inactive');
    expect(FakeMediaRecorder.last?.listenerCounts.get('stop')).toBe(0);
    expect(FakeSource.last?.listenerCounts.get('ended')).toBe(0);
    expect(FakeAudioContext.last?.closed).toBe(true);
  });

  it('rejects unsupported environments and channel shapes', async () => {
    await expect(
      encodeBrowserMedia('audio/webm;codecs=opus', [new Float32Array(1)], 48000),
    ).rejects.toThrow('unavailable');

    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);

    await expect(
      encodeBrowserMedia(
        'audio/webm;codecs=opus',
        [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
        48000,
      ),
    ).rejects.toThrow(RangeError);

    await expect(
      encodeBrowserMedia('audio/webm;codecs=opus', [new Float32Array()], 48000),
    ).rejects.toThrow('requires at least one audio frame');
    expect(FakeAudioContext.last).toBeNull();
    expect(FakeMediaRecorder.last).toBeNull();
  });
});
