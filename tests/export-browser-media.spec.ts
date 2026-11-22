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

/** Fixture bytes, as a plain list or an encoded buffer. */
type Bytes = ReadonlyArray<number> | Uint8Array;

function concatBytes(...parts: ReadonlyArray<Bytes>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

function ebmlId(id: number): number[] {
  if (id <= 0xff) return [id];
  if (id <= 0xffff) return [id >>> 8, id & 0xff];
  if (id <= 0xffffff) return [id >>> 16, (id >>> 8) & 0xff, id & 0xff];
  return [id >>> 24, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff];
}

function ebmlSize(size: number): number[] {
  if (size < 0x7f) return [0x80 | size];
  if (size < 0x3fff) return [0x40 | (size >>> 8), size & 0xff];
  throw new RangeError(`test EBML fixture is too large: ${size}`);
}

function ebmlElement(id: number, payload: Bytes): number[] {
  return [...ebmlId(id), ...ebmlSize(payload.length), ...payload];
}

function createWebmOpusFixture(): Uint8Array<ArrayBuffer> {
  const opusHead = [
    ...Array.from(new TextEncoder().encode('OpusHead')),
    1,
    1,
    0x38,
    0x01,
    0x80,
    0xbb,
    0x00,
    0x00,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const info = ebmlElement(0x1549a966, ebmlElement(0x2ad7b1, [0x00, 0x0f, 0x42, 0x40]));
  const audio = ebmlElement(
    0xe1,
    concatBytes(ebmlElement(0x9f, [1]), ebmlElement(0xb5, [0x47, 0x3b, 0x80, 0x00])),
  );
  const track = ebmlElement(
    0xae,
    concatBytes(
      ebmlElement(0xd7, [1]),
      ebmlElement(0x83, [2]),
      ebmlElement(0x86, Array.from(new TextEncoder().encode('A_OPUS'))),
      ebmlElement(0x63a2, opusHead),
      audio,
    ),
  );
  const tracks = ebmlElement(0x1654ae6b, track);
  const block = ebmlElement(0xa3, [0x81, 0x00, 0x00, 0x80, 0x00]);
  const cluster = ebmlElement(0x1f43b675, concatBytes(ebmlElement(0xe7, [0]), block));
  const segment = concatBytes(info, tracks, cluster);
  const header = concatBytes(
    ebmlElement(0x4286, [1]),
    ebmlElement(0x42f7, [1]),
    ebmlElement(0x42f2, [4]),
    ebmlElement(0x42f3, [8]),
    ebmlElement(0x4282, Array.from(new TextEncoder().encode('webm'))),
    ebmlElement(0x4287, [4]),
    ebmlElement(0x4285, [2]),
  );
  return concatBytes(ebmlElement(0x1a45dfa3, header), ebmlElement(0x18538067, segment));
}

function uint32Le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
}

function uint64Le(value: number): number[] {
  return [...uint32Le(value), ...uint32Le(Math.floor(value / 0x1_0000_0000))];
}

function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let offset = 0; offset < bytes.length; offset += 1) {
    const byte = offset >= 22 && offset < 26 ? 0 : bytes[offset]!;
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
  }
  return crc >>> 0;
}

function createOggPage(
  packet: ReadonlyArray<number>,
  sequence: number,
  headerType: number,
  granulePosition = 0,
): Uint8Array<ArrayBuffer> {
  const header = concatBytes(
    [...Array.from(new TextEncoder().encode('OggS')), 0, headerType],
    uint64Le(granulePosition),
    uint32Le(0x12345678),
    uint32Le(sequence),
    [0, 0, 0, 0, 1, packet.length],
    packet,
  );
  const crc = uint32Le(oggCrc(header));
  header.set(crc, 22);
  return header;
}

function createOggOpusFixture(): Uint8Array<ArrayBuffer> {
  const head = [
    ...Array.from(new TextEncoder().encode('OpusHead')),
    1,
    1,
    0x38,
    0x01,
    0x80,
    0xbb,
    0x00,
    0x00,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const tags = [...Array.from(new TextEncoder().encode('OpusTags')), 0, 0, 0, 0, 0, 0, 0, 0];
  return concatBytes(
    createOggPage(head, 0, 0x02),
    createOggPage(tags, 1, 0),
    createOggPage([0x00, 0x00], 2, 0x04, 960),
  );
}

function uint32Be(value: number): number[] {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function mp4Box(type: string, payload: Bytes): number[] {
  return [
    ...uint32Be(payload.length + 8),
    ...Array.from(new TextEncoder().encode(type)),
    ...payload,
  ];
}

function mp4FullBox(type: string, payload: Bytes): number[] {
  return mp4Box(type, [0, 0, 0, 0, ...payload]);
}

function mp4FullBoxWithFlags(type: string, flags: number, payload: Bytes): number[] {
  return mp4Box(type, [0, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff, ...payload]);
}

function createM4aFixture(): Uint8Array<ArrayBuffer> {
  const ftyp = mp4Box('ftyp', [0x4d, 0x34, 0x41, 0x20, 0, 0, 2, 0, 0x4d, 0x34, 0x41, 0x20]);
  const mdat = mp4Box('mdat', [0x01]);
  const makeMoov = (chunkOffset: number): number[] => {
    const stsdEntry = mp4Box('mp4a', [...new Array(28).fill(0), ...mp4Box('esds', [0, 0, 0, 0])]);
    const stbl = mp4Box(
      'stbl',
      concatBytes(
        mp4FullBox('stsd', [0, 0, 0, 1, ...stsdEntry]),
        mp4FullBox('stts', [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 4, 0]),
        mp4FullBox('stsc', [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
        mp4FullBox('stsz', [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]),
        mp4FullBox('stco', [0, 0, 0, 1, ...uint32Be(chunkOffset)]),
      ),
    );
    const mdia = mp4Box(
      'mdia',
      concatBytes(
        mp4FullBox('mdhd', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0xbb, 0x80, 0, 0, 0, 0, 0]),
        mp4FullBox('hdlr', [0, 0, 0, 0, ...Array.from(new TextEncoder().encode('soun'))]),
        mp4Box('minf', stbl),
      ),
    );
    const trak = mp4Box('trak', concatBytes(mp4Box('tkhd', new Array(8).fill(0)), mdia));
    return mp4Box(
      'moov',
      concatBytes(mp4FullBox('mvhd', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0xe8, 0, 0, 0, 1]), trak),
    );
  };
  const firstMoov = makeMoov(0);
  const moov = makeMoov(ftyp.length + firstMoov.length + 8);
  return concatBytes(ftyp, moov, mdat);
}

function fixtureForMimeType(mimeType: string): Uint8Array<ArrayBuffer> {
  if (mimeType.startsWith('audio/mp4')) return createM4aFixture();
  if (mimeType.startsWith('audio/ogg')) return createOggOpusFixture();
  return createWebmOpusFixture();
}

function corruptM4aChunkOffset(): Uint8Array<ArrayBuffer> {
  const bytes = createM4aFixture();
  const stco = [0x73, 0x74, 0x63, 0x6f];
  for (let index = 0; index <= bytes.length - stco.length; index += 1) {
    if (stco.every((value, byte) => bytes[index + byte] === value)) {
      bytes.set(uint32Be(0x00ff_ffff), index + 12);
      return bytes;
    }
  }
  throw new Error('M4A fixture has no stco box');
}

function createFragmentedM4aFixture(dataOffset: number | null = null): Uint8Array<ArrayBuffer> {
  const ftyp = mp4Box('ftyp', [0x4d, 0x34, 0x41, 0x20, 0, 0, 2, 0, 0x4d, 0x34, 0x41, 0x20]);
  const stsdEntry = mp4Box('mp4a', [...new Array(28).fill(0), ...mp4Box('esds', [0, 0, 0, 0])]);
  const stbl = mp4Box('stbl', mp4FullBox('stsd', [0, 0, 0, 1, ...stsdEntry]));
  const mdia = mp4Box(
    'mdia',
    concatBytes(
      mp4FullBox('mdhd', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0xbb, 0x80, 0, 0, 0, 0, 0]),
      mp4FullBox('hdlr', [0, 0, 0, 0, ...Array.from(new TextEncoder().encode('soun'))]),
      mp4Box('minf', stbl),
    ),
  );
  const trak = mp4Box(
    'trak',
    concatBytes(mp4FullBox('tkhd', [...new Array(8).fill(0), 0, 0, 0, 1]), mdia),
  );
  const mvex = mp4Box(
    'mvex',
    mp4FullBox('trex', [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 4, 0, 0, 0, 0, 2, 0, 0, 0, 0]),
  );
  const moov = mp4Box(
    'moov',
    concatBytes(
      mp4FullBox('mvhd', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0xe8, 0, 0, 0, 1]),
      trak,
      mvex,
    ),
  );
  const makeMoof = (sampleDataOffset: number): number[] => {
    const tfhd = mp4FullBoxWithFlags('tfhd', 0x020018, [0, 0, 0, 1, 0, 0, 4, 0, 0, 0, 0, 2]);
    const trun = mp4FullBoxWithFlags('trun', 0x000001, [0, 0, 0, 1, ...uint32Be(sampleDataOffset)]);
    return mp4Box(
      'moof',
      concatBytes(mp4FullBox('mfhd', [0, 0, 0, 1]), mp4Box('traf', concatBytes(tfhd, trun))),
    );
  };
  const provisionalMoof = makeMoof(0);
  const moof = makeMoof(dataOffset ?? provisionalMoof.length + 8);
  return concatBytes(ftyp, moov, moof, mp4Box('mdat', [0x01, 0x02]));
}

/**
 * A fragmented M4A with a valid-looking audio init segment but a trun whose
 * sample data points past the following mdat. Older validation accepted it by
 * checking only that the trun count was nonzero.
 */
function createFragmentedM4aWithInvalidSampleRange(): Uint8Array<ArrayBuffer> {
  return createFragmentedM4aFixture(0x100);
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  readonly sampleRate: number;
  state: AudioContextState = 'running';
  currentTime = 0;
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

  async resume(): Promise<void> {}

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

  protected emitData(data: Uint8Array<ArrayBuffer>): void {
    this.state = 'inactive';
    const blob = new Blob([data], { type: this.options.mimeType });
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: blob }));
    this.dispatchEvent(new Event('stop'));
  }

  stop(): void {
    this.emitData(fixtureForMimeType(this.options.mimeType));
  }
}

class ZeroByteMediaRecorder extends FakeMediaRecorder {
  override stop(): void {
    this.emitData(new Uint8Array());
  }
}

class MalformedMediaRecorder extends FakeMediaRecorder {
  override stop(): void {
    this.emitData(new Uint8Array([0x4f, 0x70, 0x75, 0x73]));
  }
}

class InvalidM4aOffsetMediaRecorder extends FakeMediaRecorder {
  override stop(): void {
    this.emitData(corruptM4aChunkOffset());
  }
}

class InvalidFragmentedM4aMediaRecorder extends FakeMediaRecorder {
  override stop(): void {
    this.emitData(createFragmentedM4aWithInvalidSampleRange());
  }
}

class FragmentedM4aMediaRecorder extends FakeMediaRecorder {
  override stop(): void {
    this.emitData(createFragmentedM4aFixture());
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
        [new Float32Array(1024), new Float32Array(1024)],
        48000,
        { bitrate: 256 },
      ),
    ).resolves.toEqual(createWebmOpusFixture());
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

    await encodeBrowserMedia('audio/webm;codecs=opus', [new Float32Array(1024)], 48000, {
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
      encodeBrowserMedia('audio/webm;codecs=opus', [new Float32Array(1024)], 48000),
    ).rejects.toThrow('Browser media encoding failed');

    expect(FakeMediaRecorder.last?.state).toBe('inactive');
    expect(FakeMediaRecorder.last?.listenerCounts.get('dataavailable')).toBe(0);
    expect(FakeMediaRecorder.last?.listenerCounts.get('error')).toBe(0);
    expect(FakeMediaRecorder.last?.listenerCounts.get('stop')).toBe(0);
    expect(FakeSource.last?.listenerCounts.get('ended')).toBe(0);
    expect(FakeAudioContext.last?.closed).toBe(true);
  });

  it('rejects a zero-byte final MediaRecorder output instead of reporting success', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', ZeroByteMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);
    const progress = vi.fn();

    await expect(
      encodeBrowserMedia('audio/webm;codecs=opus', [new Float32Array(1024)], 48000, {
        onProgress: progress,
      }),
    ).rejects.toThrow('zero-byte output');

    expect(progress).toHaveBeenCalledWith(0);
    expect(progress).not.toHaveBeenCalledWith(1);
    expect(FakeAudioContext.last?.closed).toBe(true);
    expect(FakeMediaRecorder.last?.listenerCounts.get('stop')).toBe(0);
    expect(FakeSource.last?.listenerCounts.get('ended')).toBe(0);
  });

  it('rejects input shorter than one complete AAC or Opus codec frame', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    FakeMediaRecorder.supported = new Set([
      'audio/mp4;codecs=mp4a.40.2',
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
    ]);

    for (const [mimeType, frames] of [
      ['audio/mp4;codecs=mp4a.40.2', 1023],
      ['audio/webm;codecs=opus', 959],
      ['audio/ogg;codecs=opus', 959],
    ] as const) {
      await expect(
        encodeBrowserMedia(mimeType, [new Float32Array(frames)], 48_000),
      ).rejects.toThrow('complete codec frame');
    }
    expect(FakeMediaRecorder.last).toBeNull();
  });

  it('accepts structurally complete AAC/M4A, WebM Opus, and Ogg Opus output', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    FakeMediaRecorder.supported = new Set([
      'audio/mp4;codecs=mp4a.40.2',
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
    ]);

    for (const mimeType of [
      'audio/mp4;codecs=mp4a.40.2',
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
    ]) {
      await expect(encodeBrowserMedia(mimeType, [new Float32Array(1024)], 48000)).resolves.toEqual(
        fixtureForMimeType(mimeType),
      );
    }
  });

  it('rejects nonzero malformed or truncated output without reporting completion', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', MalformedMediaRecorder);
    FakeMediaRecorder.supported = new Set([
      'audio/mp4;codecs=mp4a.40.2',
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
    ]);
    for (const mimeType of [
      'audio/mp4;codecs=mp4a.40.2',
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
    ]) {
      const progress = vi.fn();
      await expect(
        encodeBrowserMedia(mimeType, [new Float32Array(1024)], 48000, {
          onProgress: progress,
        }),
      ).rejects.toThrow('structurally invalid');

      expect(progress).toHaveBeenCalledWith(0);
      expect(progress).not.toHaveBeenCalledWith(1);
    }
    expect(FakeAudioContext.last?.closed).toBe(true);
    expect(FakeMediaRecorder.last?.listenerCounts.get('stop')).toBe(0);
  });

  it('rejects an MP4 whose sample table points outside media data', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', InvalidM4aOffsetMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/mp4;codecs=mp4a.40.2']);

    await expect(
      encodeBrowserMedia('audio/mp4;codecs=mp4a.40.2', [new Float32Array(1024)], 48_000),
    ).rejects.toThrow('structurally invalid');
  });

  it('rejects a fragmented MP4 whose audio samples point outside media data', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', InvalidFragmentedM4aMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/mp4;codecs=mp4a.40.2']);

    await expect(
      encodeBrowserMedia('audio/mp4;codecs=mp4a.40.2', [new Float32Array(1024)], 48_000),
    ).rejects.toThrow('structurally invalid');
  });

  it('accepts a complete fragmented MP4 with audio samples inside media data', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FragmentedM4aMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/mp4;codecs=mp4a.40.2']);

    await expect(
      encodeBrowserMedia('audio/mp4;codecs=mp4a.40.2', [new Float32Array(1024)], 48_000),
    ).resolves.toEqual(createFragmentedM4aFixture());
  });

  it('rejects a context that stays suspended after resume', async () => {
    class SuspendedAudioContext extends FakeAudioContext {
      override state: AudioContextState = 'suspended';

      override async resume(): Promise<void> {}
    }
    vi.stubGlobal('AudioContext', SuspendedAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);

    await expect(
      encodeBrowserMedia('audio/webm;codecs=opus', [new Float32Array(1024)], 48_000),
    ).rejects.toThrow('AudioContext could not start');
    expect(FakeMediaRecorder.last).toBeNull();
    expect(FakeAudioContext.last?.closed).toBe(true);
  });

  it('times out a resume request that never settles and closes the context', async () => {
    class NeverResumingAudioContext extends FakeAudioContext {
      override resume(): Promise<void> {
        return new Promise(() => {});
      }
    }
    vi.useFakeTimers();
    try {
      vi.stubGlobal('AudioContext', NeverResumingAudioContext);
      vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
      FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);

      const encoding = encodeBrowserMedia(
        'audio/webm;codecs=opus',
        [new Float32Array(1024)],
        48_000,
      );
      const settled = expect(encoding).rejects.toThrow('AudioContext did not start in time');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);

      await settled;
      expect(FakeMediaRecorder.last).toBeNull();
      expect(FakeAudioContext.last?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a recorder that never completes and releases its resources', async () => {
    class HangingSource extends FakeSource {
      override start(): void {}
    }
    class HangingAudioContext extends FakeAudioContext {
      override createBufferSource(): FakeSource {
        return new HangingSource();
      }
    }
    vi.useFakeTimers();
    try {
      vi.stubGlobal('AudioContext', HangingAudioContext);
      vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
      FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus']);

      const encoding = encodeBrowserMedia(
        'audio/webm;codecs=opus',
        [new Float32Array(1024)],
        48_000,
      );
      const settled = expect(encoding).rejects.toThrow('did not complete in time');
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(6_000);

      await settled;
      expect(FakeMediaRecorder.last?.state).toBe('inactive');
      expect(FakeMediaRecorder.last?.listenerCounts.get('stop')).toBe(0);
      expect(FakeSource.last?.listenerCounts.get('ended')).toBe(0);
      expect(FakeAudioContext.last?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
    // Wait until the async AudioContext resume path has installed the active
    // recorder listeners before exercising cancellation during an encode.
    await vi.waitFor(() => expect(FakeMediaRecorder.last).not.toBeNull());
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
