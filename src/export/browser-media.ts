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

/** AAC-LC has 1,024 PCM samples per access unit. */
const AAC_MINIMUM_INPUT_FRAMES = 1024;
/** Use one conventional 20 ms Opus packet as the shortest useful delivery. */
const OPUS_MINIMUM_DURATION_SECONDS = 0.02;
/** Allows recorder/container finalization after the source has ended. */
const MEDIA_RECORDER_COMPLETION_GRACE_MS = 5_000;
/** Bounds autoplay-permission and device-start waits before a recorder exists. */
const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 5_000;

function assertPlanar(channels: ReadonlyArray<Float32Array>): number {
  if (channels.length !== 1 && channels.length !== 2) {
    throw new RangeError(`Browser media encoding supports 1 or 2 channels, got ${channels.length}`);
  }
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) {
    throw new RangeError('Browser media encoding requires at least one audio frame');
  }
  if (channels.some((channel) => channel.length !== frames)) {
    throw new RangeError('Browser media encoder channel buffers must have equal lengths');
  }
  return frames;
}

function minimumInputFrames(mimeType: string, sampleRate: number): number {
  const mediaType = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (mediaType === 'audio/mp4') return AAC_MINIMUM_INPUT_FRAMES;
  if (mediaType === 'audio/webm' || mediaType === 'audio/ogg') {
    return Math.ceil(sampleRate * OPUS_MINIMUM_DURATION_SECONDS);
  }
  return 1;
}

function assertCompleteCodecInput(mimeType: string, frames: number, sampleRate: number): void {
  const minimumFrames = minimumInputFrames(mimeType, sampleRate);
  if (frames < minimumFrames) {
    throw new RangeError(
      `Browser media encoding requires at least ${minimumFrames} input frames for one complete codec frame, got ${frames}`,
    );
  }
}

/**
 * Starts Web Audio under the same bounded/cancellable contract as the
 * recorder phase. `AudioContext.resume()` may remain pending indefinitely
 * while a browser waits for autoplay permission, so awaiting it directly
 * would leave an export and its context permanently live.
 */
async function resumeAudioContext(
  context: AudioContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        removeAbortListener?.();
        action();
      };
      const onAbort = (): void =>
        finish(() =>
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException('Browser media encoding cancelled.', 'AbortError'),
          ),
        );
      signal?.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
      timer = setTimeout(
        () => finish(() => reject(new Error('Browser media AudioContext did not start in time'))),
        AUDIO_CONTEXT_RESUME_TIMEOUT_MS,
      );
      try {
        void Promise.resolve(context.resume?.()).then(
          () => finish(resolve),
          (error: unknown) => finish(() => reject(error)),
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
  }
  signal?.throwIfAborted();
  if (context.state !== 'running') {
    throw new Error('Browser media AudioContext could not start');
  }
}

function toBlobBytes(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

interface Mp4Box {
  readonly type: string;
  /** Byte position of the complete box header. */
  readonly start: number;
  readonly payloadStart: number;
  readonly end: number;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  );
}

function readUint64(bytes: Uint8Array, offset: number): number | null {
  const high = readUint32(bytes, offset);
  const low = readUint32(bytes, offset + 4);
  const value = high * 0x100000000 + low;
  return Number.isSafeInteger(value) ? value : null;
}

function readUint64Le(bytes: Uint8Array, offset: number): number | null {
  const low = readUint32Le(bytes, offset);
  const high = readUint32Le(bytes, offset + 4);
  const value = high * 0x100000000 + low;
  return Number.isSafeInteger(value) ? value : null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index]!);
  }
  return value;
}

function parseMp4Boxes(bytes: Uint8Array, start: number, end: number): Mp4Box[] | null {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) return null;
    const size = readUint32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;
    let boxEnd: number;
    if (size === 1) {
      if (end - offset < 16) return null;
      const largeSize = readUint64(bytes, offset + 8);
      if (largeSize === null || largeSize < 16) return null;
      headerSize = 16;
      boxEnd = offset + largeSize;
    } else if (size === 0) {
      boxEnd = end;
    } else {
      if (size < 8) return null;
      boxEnd = offset + size;
    }
    if (!Number.isSafeInteger(boxEnd) || boxEnd > end || boxEnd <= offset) return null;
    boxes.push({ type, start: offset, payloadStart: offset + headerSize, end: boxEnd });
    offset = boxEnd;
  }
  return offset === end ? boxes : null;
}

function findMp4Box(boxes: ReadonlyArray<Mp4Box>, type: string): Mp4Box | undefined {
  return boxes.find((box) => box.type === type);
}

function mp4Children(bytes: Uint8Array, box: Mp4Box): Mp4Box[] | null {
  return parseMp4Boxes(bytes, box.payloadStart, box.end);
}

function validateMp4FullBox(box: Mp4Box, minimumPayload: number): boolean {
  return box.end - box.payloadStart >= minimumPayload;
}

function mp4FullBoxFlags(bytes: Uint8Array, box: Mp4Box): number | null {
  if (!validateMp4FullBox(box, 4)) return null;
  return (
    bytes[box.payloadStart + 1]! * 0x10000 +
    bytes[box.payloadStart + 2]! * 0x100 +
    bytes[box.payloadStart + 3]!
  );
}

function validateMp4EntryCount(
  bytes: Uint8Array,
  box: Mp4Box,
  minimumPayload: number,
  requireEntries: boolean,
  entrySize = 0,
): boolean {
  if (!validateMp4FullBox(box, minimumPayload)) return false;
  const count = readUint32(bytes, box.payloadStart + 4);
  if (requireEntries && count === 0) return false;
  return entrySize === 0 || count <= (box.end - box.payloadStart - minimumPayload) / entrySize;
}

function validateMp4SampleDescription(bytes: Uint8Array, box: Mp4Box): boolean {
  if (!validateMp4FullBox(box, 8)) return false;
  const entryCount = readUint32(bytes, box.payloadStart + 4);
  if (entryCount === 0) return false;
  const entries = parseMp4Boxes(bytes, box.payloadStart + 8, box.end);
  if (entries === null || entries.length !== entryCount) return false;
  const audioEntry = entries.find((entry) => entry.type === 'mp4a' || entry.type === 'enca');
  if (!audioEntry || audioEntry.end - audioEntry.payloadStart < 28) return false;
  const extensions = parseMp4Boxes(bytes, audioEntry.payloadStart + 28, audioEntry.end);
  if (extensions === null) return false;
  if (audioEntry.type === 'mp4a') return extensions.some((entry) => entry.type === 'esds');
  return extensions.some((entry) => entry.type === 'sinf');
}

function mp4ChunkOffset(bytes: Uint8Array, box: Mp4Box, index: number): number | null {
  const offset = box.payloadStart + 8 + index * (box.type === 'co64' ? 8 : 4);
  if (box.type === 'co64') return readUint64(bytes, offset);
  return readUint32(bytes, offset);
}

function mp4RangeIsInMediaData(
  offset: number,
  length: number,
  mediaData: ReadonlyArray<Mp4Box>,
): boolean {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0) return false;
  const end = offset + length;
  return (
    Number.isSafeInteger(end) &&
    mediaData.some((mdat) => offset >= mdat.payloadStart && end <= mdat.end)
  );
}

function validateMp4SampleDurations(bytes: Uint8Array, stts: Mp4Box, sampleCount: number): boolean {
  const entryCount = readUint32(bytes, stts.payloadStart + 4);
  let countedSamples = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = stts.payloadStart + 8 + index * 8;
    const count = readUint32(bytes, offset);
    const duration = readUint32(bytes, offset + 4);
    if (count === 0 || duration === 0) return false;
    countedSamples += count;
    if (!Number.isSafeInteger(countedSamples) || countedSamples > sampleCount) return false;
  }
  return countedSamples === sampleCount;
}

function validateMp4SampleTable(
  bytes: Uint8Array,
  stbl: Mp4Box,
  mediaData: ReadonlyArray<Mp4Box>,
): boolean {
  const children = mp4Children(bytes, stbl);
  if (children === null) return false;
  const stts = findMp4Box(children, 'stts');
  const stsc = findMp4Box(children, 'stsc');
  const stsz = findMp4Box(children, 'stsz');
  const chunkOffsets = findMp4Box(children, 'stco') ?? findMp4Box(children, 'co64');
  if (!stts || !stsc || !stsz || !chunkOffsets) return false;
  if (!validateMp4EntryCount(bytes, stts, 8, true, 8)) return false;
  if (!validateMp4EntryCount(bytes, stsc, 8, true, 12)) return false;
  if (!validateMp4FullBox(stsz, 12)) return false;
  const sampleSize = readUint32(bytes, stsz.payloadStart + 4);
  const sampleCount = readUint32(bytes, stsz.payloadStart + 8);
  if (sampleCount === 0) return false;
  if (sampleSize === 0 && stsz.end - stsz.payloadStart < 12 + sampleCount * 4) return false;
  if (!validateMp4EntryCount(bytes, chunkOffsets, 8, true, chunkOffsets.type === 'co64' ? 8 : 4)) {
    return false;
  }
  if (!validateMp4SampleDurations(bytes, stts, sampleCount)) return false;

  const chunkCount = readUint32(bytes, chunkOffsets.payloadStart + 4);
  const stscEntryCount = readUint32(bytes, stsc.payloadStart + 4);
  let previousFirstChunk = 0;
  for (let index = 0; index < stscEntryCount; index += 1) {
    const offset = stsc.payloadStart + 8 + index * 12;
    const firstChunk = readUint32(bytes, offset);
    const samplesInChunk = readUint32(bytes, offset + 4);
    const sampleDescriptionIndex = readUint32(bytes, offset + 8);
    if (
      (index === 0 && firstChunk !== 1) ||
      firstChunk <= previousFirstChunk ||
      samplesInChunk === 0 ||
      sampleDescriptionIndex === 0
    ) {
      return false;
    }
    previousFirstChunk = firstChunk;
  }
  let stscIndex = 0;
  let sampleIndex = 0;
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const oneBasedChunk = chunkIndex + 1;
    while (
      stscIndex + 1 < stscEntryCount &&
      readUint32(bytes, stsc.payloadStart + 8 + (stscIndex + 1) * 12) <= oneBasedChunk
    ) {
      stscIndex += 1;
    }
    const stscOffset = stsc.payloadStart + 8 + stscIndex * 12;
    const firstChunk = readUint32(bytes, stscOffset);
    const samplesInChunk = readUint32(bytes, stscOffset + 4);
    const sampleDescriptionIndex = readUint32(bytes, stscOffset + 8);
    if (
      firstChunk === 0 ||
      firstChunk > oneBasedChunk ||
      samplesInChunk === 0 ||
      sampleDescriptionIndex === 0
    ) {
      return false;
    }
    if (sampleIndex + samplesInChunk > sampleCount) return false;
    let chunkBytes = 0;
    if (sampleSize !== 0) {
      chunkBytes = sampleSize * samplesInChunk;
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) return false;
    } else {
      for (let index = 0; index < samplesInChunk; index += 1) {
        chunkBytes += readUint32(bytes, stsz.payloadStart + 12 + (sampleIndex + index) * 4);
        if (!Number.isSafeInteger(chunkBytes)) return false;
      }
      if (chunkBytes === 0) return false;
    }
    const chunkOffset = mp4ChunkOffset(bytes, chunkOffsets, chunkIndex);
    if (chunkOffset === null || !mp4RangeIsInMediaData(chunkOffset, chunkBytes, mediaData)) {
      return false;
    }
    sampleIndex += samplesInChunk;
  }
  if (sampleIndex !== sampleCount) return false;
  return true;
}

function validateMp4AudioTrack(
  bytes: Uint8Array,
  trak: Mp4Box,
  mediaData: ReadonlyArray<Mp4Box>,
): boolean {
  const trakChildren = mp4Children(bytes, trak);
  if (trakChildren === null) return false;
  const mdia = findMp4Box(trakChildren, 'mdia');
  if (!mdia || !findMp4Box(trakChildren, 'tkhd')) return false;
  const mdiaChildren = mp4Children(bytes, mdia);
  if (mdiaChildren === null) return false;
  const mdhd = findMp4Box(mdiaChildren, 'mdhd');
  const hdlr = findMp4Box(mdiaChildren, 'hdlr');
  const minf = findMp4Box(mdiaChildren, 'minf');
  if (!mdhd || !hdlr || !minf || !validateMp4FullBox(mdhd, 16)) return false;
  const mdhdVersion = bytes[mdhd.payloadStart]!;
  if (mdhdVersion !== 0 && mdhdVersion !== 1) return false;
  const mdhdTimescaleOffset = mdhdVersion === 1 ? 20 : 12;
  if (!validateMp4FullBox(mdhd, mdhdTimescaleOffset + 4)) return false;
  if (readUint32(bytes, mdhd.payloadStart + mdhdTimescaleOffset) === 0) return false;
  if (!validateMp4FullBox(hdlr, 12)) return false;
  if (ascii(bytes, hdlr.payloadStart + 8, 4) !== 'soun') return false;
  const minfChildren = mp4Children(bytes, minf);
  if (minfChildren === null) return false;
  const stbl = findMp4Box(minfChildren, 'stbl');
  if (!stbl) return false;
  const stblChildren = mp4Children(bytes, stbl);
  if (stblChildren === null) return false;
  const stsd = findMp4Box(stblChildren, 'stsd');
  if (!stsd || !validateMp4SampleDescription(bytes, stsd)) return false;
  return validateMp4SampleTable(bytes, stbl, mediaData);
}

interface Mp4FragmentDefaults {
  readonly duration: number;
  readonly size: number;
}

interface Mp4FragmentHeader {
  readonly trackId: number;
  readonly baseDataOffset: number;
  readonly defaultDuration: number;
  readonly defaultSize: number;
}

function readInt32(bytes: Uint8Array, offset: number): number {
  const value = readUint32(bytes, offset);
  return value > 0x7fff_ffff ? value - 0x1_0000_0000 : value;
}

/**
 * Read the identifier from a tkhd without requiring its optional matrix and
 * presentation fields. Fragmented M4A still needs a real audio-track identity
 * so a traf cannot point at an arbitrary (or nonexistent) track.
 */
function mp4TrackId(bytes: Uint8Array, tkhd: Mp4Box): number | null {
  if (!validateMp4FullBox(tkhd, 4)) return null;
  const version = bytes[tkhd.payloadStart]!;
  const trackIdOffset = tkhd.payloadStart + (version === 0 ? 12 : version === 1 ? 20 : -1);
  if (trackIdOffset < tkhd.payloadStart || trackIdOffset + 4 > tkhd.end) return null;
  const trackId = readUint32(bytes, trackIdOffset);
  return trackId === 0 ? null : trackId;
}

/**
 * The regular sample-table validator below deliberately accepts the compact
 * fixture used by older browsers. Fragmented output has no complete stbl, so
 * validate the independent audio-track identity and sample description here.
 */
function fragmentAudioTrackIds(
  bytes: Uint8Array,
  tracks: ReadonlyArray<Mp4Box>,
): Set<number> | null {
  const trackIds = new Set<number>();
  for (const trak of tracks) {
    const trakChildren = mp4Children(bytes, trak);
    if (trakChildren === null) return null;
    const mdia = findMp4Box(trakChildren, 'mdia');
    const tkhd = findMp4Box(trakChildren, 'tkhd');
    if (!mdia || !tkhd) continue;
    const mdiaChildren = mp4Children(bytes, mdia);
    if (mdiaChildren === null) return null;
    const hdlr = findMp4Box(mdiaChildren, 'hdlr');
    if (!hdlr || !validateMp4FullBox(hdlr, 12)) continue;
    if (ascii(bytes, hdlr.payloadStart + 8, 4) !== 'soun') continue;
    const mdhd = findMp4Box(mdiaChildren, 'mdhd');
    const minf = findMp4Box(mdiaChildren, 'minf');
    if (!mdhd || !minf || !validateMp4FullBox(mdhd, 16)) return null;
    const mdhdVersion = bytes[mdhd.payloadStart]!;
    const mdhdTimescaleOffset = mdhdVersion === 1 ? 20 : mdhdVersion === 0 ? 12 : -1;
    if (
      mdhdTimescaleOffset < 0 ||
      !validateMp4FullBox(mdhd, mdhdTimescaleOffset + 4) ||
      readUint32(bytes, mdhd.payloadStart + mdhdTimescaleOffset) === 0
    ) {
      return null;
    }
    const minfChildren = mp4Children(bytes, minf);
    const stbl = minfChildren && findMp4Box(minfChildren, 'stbl');
    if (!stbl) return null;
    const stblChildren = mp4Children(bytes, stbl);
    const stsd = stblChildren && findMp4Box(stblChildren, 'stsd');
    if (!stsd || !validateMp4SampleDescription(bytes, stsd)) return null;
    const trackId = mp4TrackId(bytes, tkhd);
    if (trackId === null || trackIds.has(trackId)) return null;
    trackIds.add(trackId);
  }
  return trackIds;
}

function fragmentDefaults(
  bytes: Uint8Array,
  mvex: Mp4Box,
  audioTrackIds: ReadonlySet<number>,
): Map<number, Mp4FragmentDefaults> | null {
  const children = mp4Children(bytes, mvex);
  if (children === null) return null;
  const defaults = new Map<number, Mp4FragmentDefaults>();
  for (const trex of children.filter((box) => box.type === 'trex')) {
    if (!validateMp4FullBox(trex, 24)) return null;
    const trackId = readUint32(bytes, trex.payloadStart + 4);
    if (!audioTrackIds.has(trackId)) continue;
    if (defaults.has(trackId)) return null;
    defaults.set(trackId, {
      duration: readUint32(bytes, trex.payloadStart + 12),
      size: readUint32(bytes, trex.payloadStart + 16),
    });
  }
  return [...audioTrackIds].every((trackId) => defaults.has(trackId)) ? defaults : null;
}

function fragmentHeader(
  bytes: Uint8Array,
  tfhd: Mp4Box,
  moof: Mp4Box,
  defaults: ReadonlyMap<number, Mp4FragmentDefaults>,
): Mp4FragmentHeader | null {
  const flags = mp4FullBoxFlags(bytes, tfhd);
  if (flags === null || !validateMp4FullBox(tfhd, 8)) return null;
  const allowedFlags = 0x000001 | 0x000002 | 0x000008 | 0x000010 | 0x000020 | 0x020000;
  if ((flags & ~allowedFlags) !== 0) return null;
  const trackId = readUint32(bytes, tfhd.payloadStart + 4);
  const trex = defaults.get(trackId);
  if (!trex) return null;
  let offset = tfhd.payloadStart + 8;
  let baseDataOffset: number;
  if ((flags & 0x000001) !== 0) {
    if (offset + 8 > tfhd.end) return null;
    const value = readUint64(bytes, offset);
    if (value === null) return null;
    baseDataOffset = value;
    offset += 8;
  } else if ((flags & 0x020000) !== 0) {
    baseDataOffset = moof.start;
  } else {
    // The inherited-base-data-offset form depends on prior fragments. It
    // cannot be proven locally, so do not call a result complete from it.
    return null;
  }
  if ((flags & 0x000002) !== 0) {
    if (offset + 4 > tfhd.end) return null;
    offset += 4;
  }
  let defaultDuration = trex.duration;
  if ((flags & 0x000008) !== 0) {
    if (offset + 4 > tfhd.end) return null;
    defaultDuration = readUint32(bytes, offset);
    offset += 4;
  }
  let defaultSize = trex.size;
  if ((flags & 0x000010) !== 0) {
    if (offset + 4 > tfhd.end) return null;
    defaultSize = readUint32(bytes, offset);
    offset += 4;
  }
  if ((flags & 0x000020) !== 0) {
    if (offset + 4 > tfhd.end) return null;
    offset += 4;
  }
  return offset === tfhd.end ? { trackId, baseDataOffset, defaultDuration, defaultSize } : null;
}

function validateMp4FragmentRun(
  bytes: Uint8Array,
  trun: Mp4Box,
  header: Mp4FragmentHeader,
  mediaData: ReadonlyArray<Mp4Box>,
  previousDataEnd: number | null,
): number | null {
  const flags = mp4FullBoxFlags(bytes, trun);
  if (flags === null || !validateMp4FullBox(trun, 8)) return null;
  const allowedFlags = 0x000001 | 0x000004 | 0x000100 | 0x000200 | 0x000400 | 0x000800;
  if ((flags & ~allowedFlags) !== 0) return null;
  const sampleCount = readUint32(bytes, trun.payloadStart + 4);
  if (sampleCount === 0) return null;
  let offset = trun.payloadStart + 8;
  let dataStart: number;
  if ((flags & 0x000001) !== 0) {
    if (offset + 4 > trun.end) return null;
    dataStart = header.baseDataOffset + readInt32(bytes, offset);
    if (!Number.isSafeInteger(dataStart)) return null;
    offset += 4;
  } else if (previousDataEnd !== null) {
    dataStart = previousDataEnd;
  } else {
    const firstMediaData = mediaData[0];
    if (!firstMediaData) return null;
    dataStart = firstMediaData.payloadStart;
  }
  if ((flags & 0x000004) !== 0) {
    if (offset + 4 > trun.end) return null;
    offset += 4;
  }
  const entryBytes =
    ((flags & 0x000100) !== 0 ? 4 : 0) +
    ((flags & 0x000200) !== 0 ? 4 : 0) +
    ((flags & 0x000400) !== 0 ? 4 : 0) +
    ((flags & 0x000800) !== 0 ? 4 : 0);
  if (sampleCount > (trun.end - offset) / entryBytes && entryBytes > 0) return null;
  let dataBytes = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    let duration = header.defaultDuration;
    if ((flags & 0x000100) !== 0) {
      duration = readUint32(bytes, offset);
      offset += 4;
    }
    let size = header.defaultSize;
    if ((flags & 0x000200) !== 0) {
      size = readUint32(bytes, offset);
      offset += 4;
    }
    if ((flags & 0x000400) !== 0) offset += 4;
    if ((flags & 0x000800) !== 0) offset += 4;
    if (duration === 0 || size === 0) return null;
    dataBytes += size;
    if (!Number.isSafeInteger(dataBytes)) return null;
  }
  if (offset !== trun.end || !mp4RangeIsInMediaData(dataStart, dataBytes, mediaData)) return null;
  return dataStart + dataBytes;
}

function validateMp4Fragment(
  bytes: Uint8Array,
  moof: Mp4Box,
  mediaData: ReadonlyArray<Mp4Box>,
  defaults: ReadonlyMap<number, Mp4FragmentDefaults>,
): boolean {
  const moofChildren = mp4Children(bytes, moof);
  const mfhd = moofChildren && findMp4Box(moofChildren, 'mfhd');
  if (moofChildren === null || !mfhd || !validateMp4FullBox(mfhd, 8)) return false;
  const trafs = moofChildren.filter((box) => box.type === 'traf');
  if (trafs.length === 0) return false;
  return trafs.every((traf) => {
    const trafChildren = mp4Children(bytes, traf);
    const tfhd = trafChildren && findMp4Box(trafChildren, 'tfhd');
    if (trafChildren === null || !tfhd) return false;
    const header = fragmentHeader(bytes, tfhd, moof, defaults);
    if (!header) return false;
    const runs = trafChildren.filter((box) => box.type === 'trun');
    if (runs.length === 0) return false;
    let previousDataEnd: number | null = null;
    for (const run of runs) {
      previousDataEnd = validateMp4FragmentRun(bytes, run, header, mediaData, previousDataEnd);
      if (previousDataEnd === null) return false;
    }
    return true;
  });
}

function validateMp4(bytes: Uint8Array): boolean {
  const boxes = parseMp4Boxes(bytes, 0, bytes.length);
  if (boxes === null) return false;
  const ftyp = findMp4Box(boxes, 'ftyp');
  const moov = findMp4Box(boxes, 'moov');
  const mdats = boxes.filter((box) => box.type === 'mdat' && box.end > box.payloadStart);
  if (!ftyp || !moov || mdats.length === 0 || !validateMp4FullBox(ftyp, 8)) return false;
  const majorBrand = ascii(bytes, ftyp.payloadStart, 4);
  if (!new Set(['M4A ', 'isom', 'iso2', 'mp41', 'mp42', '3gp4', 'qt  ']).has(majorBrand)) {
    return false;
  }
  if ((ftyp.end - ftyp.payloadStart - 8) % 4 !== 0) return false;
  const moovChildren = mp4Children(bytes, moov);
  const mvhd = moovChildren && findMp4Box(moovChildren, 'mvhd');
  if (moovChildren === null || !mvhd || !validateMp4FullBox(mvhd, 16)) return false;
  const mvhdVersion = bytes[mvhd.payloadStart]!;
  if (mvhdVersion !== 0 && mvhdVersion !== 1) return false;
  const mvhdTimescaleOffset = mvhdVersion === 1 ? 20 : 12;
  if (
    !validateMp4FullBox(mvhd, mvhdTimescaleOffset + 4) ||
    readUint32(bytes, mvhd.payloadStart + mvhdTimescaleOffset) === 0
  ) {
    return false;
  }
  const tracks = moovChildren.filter((box) => box.type === 'trak');
  if (tracks.length === 0) return false;
  const hasAudioTrack = tracks.some((track) => validateMp4AudioTrack(bytes, track, mdats));
  if (hasAudioTrack) return true;
  const moofs = boxes.filter((box) => box.type === 'moof');
  const mvex = findMp4Box(moovChildren, 'mvex');
  if (!mvex || moofs.length === 0) return false;
  const audioTrackIds = fragmentAudioTrackIds(bytes, tracks);
  if (!audioTrackIds || audioTrackIds.size === 0) return false;
  const defaults = fragmentDefaults(bytes, mvex, audioTrackIds);
  if (!defaults) return false;
  return moofs.every((moof, index) => {
    const nextMoof = moofs[index + 1];
    const fragmentMediaData = mdats.filter(
      (mdat) => mdat.start > moof.start && (!nextMoof || mdat.start < nextMoof.start),
    );
    return validateMp4Fragment(bytes, moof, fragmentMediaData, defaults);
  });
}

interface EbmlElement {
  readonly id: number;
  readonly dataStart: number;
  readonly end: number;
  readonly unknownSize: boolean;
}

function readEbmlVint(
  bytes: Uint8Array,
  offset: number,
  maxWidth: number,
  limit = bytes.length,
): { length: number; value: number; unknown: boolean } | null {
  if (offset >= limit) return null;
  const first = bytes[offset]!;
  let mask = 0x80;
  let length = 1;
  while (length <= maxWidth && (first & mask) === 0) {
    mask >>>= 1;
    length += 1;
  }
  if (length > maxWidth || offset + length > limit) return null;
  let value = first & (mask - 1);
  let unknown = value === mask - 1;
  for (let index = 1; index < length; index += 1) {
    value = value * 0x100 + bytes[offset + index]!;
    unknown = unknown && bytes[offset + index] === 0xff;
  }
  if (!Number.isSafeInteger(value)) return null;
  return { length, value, unknown };
}

function readEbmlId(
  bytes: Uint8Array,
  offset: number,
  limit = bytes.length,
): { length: number; id: number } | null {
  if (offset >= limit) return null;
  const first = bytes[offset]!;
  let mask = 0x80;
  let length = 1;
  while (length <= 4 && (first & mask) === 0) {
    mask >>>= 1;
    length += 1;
  }
  if (length > 4 || offset + length > limit) return null;
  let id = first;
  for (let index = 1; index < length; index += 1) {
    id = id * 0x100 + bytes[offset + index]!;
  }
  return { length, id };
}

function parseEbmlElements(bytes: Uint8Array, start: number, end: number): EbmlElement[] | null {
  const elements: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    const id = readEbmlId(bytes, offset, end);
    if (id === null) return null;
    const size = readEbmlVint(bytes, offset + id.length, 8, end);
    if (size === null) return null;
    const dataStart = offset + id.length + size.length;
    const elementEnd = size.unknown ? end : dataStart + size.value;
    if (elementEnd > end || elementEnd < dataStart) return null;
    elements.push({ id: id.id, dataStart, end: elementEnd, unknownSize: size.unknown });
    offset = elementEnd;
  }
  return offset === end ? elements : null;
}

function ebmlChildren(bytes: Uint8Array, element: EbmlElement): EbmlElement[] | null {
  if (!element.unknownSize && element.end < element.dataStart) return null;
  return parseEbmlElements(bytes, element.dataStart, element.end);
}

function ebmlUnsigned(bytes: Uint8Array, element: EbmlElement): number | null {
  const length = element.end - element.dataStart;
  if (length === 0 || length > 8) return null;
  let value = 0;
  for (let offset = element.dataStart; offset < element.end; offset += 1) {
    value = value * 0x100 + bytes[offset]!;
  }
  return Number.isSafeInteger(value) ? value : null;
}

function ebmlString(bytes: Uint8Array, element: EbmlElement): string {
  return ascii(bytes, element.dataStart, element.end - element.dataStart);
}

const EBML_SEGMENT_ID = 0x18538067;
const EBML_INFO_ID = 0x1549a966;
const EBML_TRACKS_ID = 0x1654ae6b;
const EBML_TRACK_ENTRY_ID = 0xae;
const EBML_TRACK_NUMBER_ID = 0xd7;
const EBML_TRACK_TYPE_ID = 0x83;
const EBML_CODEC_ID = 0x86;
const EBML_CODEC_PRIVATE_ID = 0x63a2;
const EBML_AUDIO_ID = 0xe1;
const EBML_CHANNELS_ID = 0x9f;
const EBML_SAMPLING_FREQUENCY_ID = 0xb5;
const EBML_CLUSTER_ID = 0x1f43b675;
const EBML_SIMPLE_BLOCK_ID = 0xa3;
const EBML_BLOCK_GROUP_ID = 0xa0;
const EBML_BLOCK_ID = 0xa1;
const EBML_TIMECODE_SCALE_ID = 0x2ad7b1;

function validateWebmTrack(bytes: Uint8Array, tracks: EbmlElement): ReadonlySet<number> | null {
  const trackEntries = ebmlChildren(bytes, tracks);
  if (trackEntries === null) return null;
  const audioTracks = new Set<number>();
  for (const track of trackEntries.filter((entry) => entry.id === EBML_TRACK_ENTRY_ID)) {
    const children = ebmlChildren(bytes, track);
    if (children === null) return null;
    const trackNumberElement = children.find((entry) => entry.id === EBML_TRACK_NUMBER_ID);
    const trackType = children.find((entry) => entry.id === EBML_TRACK_TYPE_ID);
    const codec = children.find((entry) => entry.id === EBML_CODEC_ID);
    const audio = children.find((entry) => entry.id === EBML_AUDIO_ID);
    if (!trackNumberElement || !trackType || !codec || !audio) continue;
    const trackNumber = ebmlUnsigned(bytes, trackNumberElement);
    if (trackNumber === null || trackNumber === 0 || ebmlUnsigned(bytes, trackType) !== 2) continue;
    if (ebmlString(bytes, codec) !== 'A_OPUS') continue;
    const audioChildren = ebmlChildren(bytes, audio);
    if (audioChildren === null) return null;
    const channels = audioChildren.find((entry) => entry.id === EBML_CHANNELS_ID);
    const sampleRate = audioChildren.find((entry) => entry.id === EBML_SAMPLING_FREQUENCY_ID);
    if (!channels || !sampleRate) continue;
    const channelCount = ebmlUnsigned(bytes, channels);
    if (channelCount !== 1 && channelCount !== 2) continue;
    const rateLength = sampleRate.end - sampleRate.dataStart;
    if (rateLength !== 4 && rateLength !== 8) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset + sampleRate.dataStart, rateLength);
    const rate = rateLength === 4 ? view.getFloat32(0) : view.getFloat64(0);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const codecPrivate = children.find((entry) => entry.id === EBML_CODEC_PRIVATE_ID);
    if (codecPrivate && ebmlString(bytes, codecPrivate).slice(0, 8) !== 'OpusHead') continue;
    audioTracks.add(trackNumber);
  }
  return audioTracks.size > 0 ? audioTracks : null;
}

function ebmlBlockTrack(bytes: Uint8Array, block: EbmlElement): number | null {
  if (block.unknownSize || block.end - block.dataStart < 5) return null;
  const track = readEbmlVint(bytes, block.dataStart, 8, block.end);
  if (track === null || track.value === 0 || track.length + 3 >= block.end - block.dataStart) {
    return null;
  }
  return track.value;
}

function validateWebmCluster(
  bytes: Uint8Array,
  cluster: EbmlElement,
  audioTracks: ReadonlySet<number>,
): boolean {
  const children = ebmlChildren(bytes, cluster);
  if (children === null) return false;
  const timecode = children.find((child) => child.id === 0xe7);
  if (!timecode || ebmlUnsigned(bytes, timecode) === null) return false;
  for (const child of children) {
    if (child.id === EBML_SIMPLE_BLOCK_ID) {
      const track = ebmlBlockTrack(bytes, child);
      if (track !== null && audioTracks.has(track)) return true;
    } else if (child.id === EBML_BLOCK_GROUP_ID) {
      const groupChildren = ebmlChildren(bytes, child);
      if (groupChildren === null) return false;
      const block = groupChildren.find((entry) => entry.id === EBML_BLOCK_ID);
      const track = block ? ebmlBlockTrack(bytes, block) : null;
      if (track !== null && audioTracks.has(track)) return true;
    }
  }
  return false;
}

function validateWebm(bytes: Uint8Array): boolean {
  const header = parseEbmlElements(bytes, 0, bytes.length);
  if (header === null || header.length < 2 || header[0]!.id !== 0x1a45dfa3) return false;
  const headerEnd = header[0]!.end;
  const headerChildren = ebmlChildren(bytes, header[0]!);
  if (headerChildren === null) return false;
  const docType = headerChildren.find((entry) => entry.id === 0x4282);
  if (!docType || ebmlString(bytes, docType) !== 'webm') return false;
  const segment = parseEbmlElements(bytes, headerEnd, bytes.length)?.[0];
  if (!segment || segment.id !== EBML_SEGMENT_ID || segment.dataStart > bytes.length) return false;
  if (!segment.unknownSize && segment.end !== bytes.length) return false;
  const segmentChildren = ebmlChildren(bytes, segment);
  if (segmentChildren === null) return false;
  const info = segmentChildren.find((entry) => entry.id === EBML_INFO_ID);
  const tracks = segmentChildren.find((entry) => entry.id === EBML_TRACKS_ID);
  if (!info || !tracks) return false;
  const infoChildren = ebmlChildren(bytes, info);
  if (infoChildren === null) return false;
  const timecodeScale = infoChildren.find((entry) => entry.id === EBML_TIMECODE_SCALE_ID);
  if (!timecodeScale || ebmlUnsigned(bytes, timecodeScale) === 0) return false;
  const audioTracks = validateWebmTrack(bytes, tracks);
  if (audioTracks === null) return false;
  return segmentChildren
    .filter((entry) => entry.id === EBML_CLUSTER_ID)
    .some((cluster) => validateWebmCluster(bytes, cluster, audioTracks));
}

function oggCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let offset = start; offset < end; offset += 1) {
    const byte = offset >= start + 22 && offset < start + 26 ? 0 : bytes[offset]!;
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
  }
  return crc >>> 0;
}

function validateOpusHead(packet: Uint8Array): boolean {
  if (packet.length < 19 || ascii(packet, 0, 8) !== 'OpusHead') return false;
  if (packet[8] !== 1 || (packet[9] !== 1 && packet[9] !== 2)) return false;
  const inputRate =
    packet[12]! + packet[13]! * 0x100 + packet[14]! * 0x10000 + packet[15]! * 0x1000000;
  return inputRate > 0;
}

function validateOpusTags(packet: Uint8Array): boolean {
  if (packet.length < 16 || ascii(packet, 0, 8) !== 'OpusTags') return false;
  let offset = 8;
  if (offset + 4 > packet.length) return false;
  const vendorLength = readUint32Le(packet, offset) >>> 0;
  offset += 4;
  if (vendorLength > packet.length - offset) return false;
  offset += vendorLength;
  if (offset + 4 > packet.length) return false;
  const commentCount = readUint32Le(packet, offset) >>> 0;
  offset += 4;
  for (let index = 0; index < commentCount; index += 1) {
    if (offset + 4 > packet.length) return false;
    const commentLength = readUint32Le(packet, offset) >>> 0;
    offset += 4;
    if (commentLength > packet.length - offset) return false;
    offset += commentLength;
  }
  return offset === packet.length;
}

function validateOgg(bytes: Uint8Array): boolean {
  const packets: Uint8Array[] = [];
  let offset = 0;
  let serial: number | null = null;
  let sequence = 0;
  let continuedPacket: number[] = [];
  let sawBos = false;
  let sawEos = false;
  let eosGranulePosition: number | null = null;
  while (offset < bytes.length) {
    if (bytes.length - offset < 27 || ascii(bytes, offset, 4) !== 'OggS') return false;
    if (bytes[offset + 4] !== 0) return false;
    const headerType = bytes[offset + 5]!;
    if ((headerType & 0xf8) !== 0) return false;
    const pageSerial = readUint32Le(bytes, offset + 14);
    const pageSequence = readUint32Le(bytes, offset + 18);
    const segmentCount = bytes[offset + 26]!;
    const segmentTableEnd = offset + 27 + segmentCount;
    if (segmentTableEnd > bytes.length) return false;
    let payloadLength = 0;
    for (let index = 0; index < segmentCount; index += 1)
      payloadLength += bytes[offset + 27 + index]!;
    const pageEnd = segmentTableEnd + payloadLength;
    if (
      pageEnd > bytes.length ||
      oggCrc(bytes, offset, pageEnd) !== readUint32Le(bytes, offset + 22)
    ) {
      return false;
    }
    if (serial === null) serial = pageSerial;
    if (serial !== pageSerial || pageSequence !== sequence) return false;
    sequence += 1;
    if (offset === 0) {
      if ((headerType & 0x02) === 0 || (headerType & 0x01) !== 0) return false;
      sawBos = true;
    } else if (((headerType & 0x01) !== 0) !== continuedPacket.length > 0) {
      return false;
    }
    let payloadOffset = segmentTableEnd;
    for (let index = 0; index < segmentCount; index += 1) {
      const segmentLength = bytes[offset + 27 + index]!;
      for (let byte = 0; byte < segmentLength; byte += 1) {
        continuedPacket.push(bytes[payloadOffset + byte]!);
      }
      payloadOffset += segmentLength;
      if (segmentLength < 255) {
        if (continuedPacket.length === 0) return false;
        packets.push(Uint8Array.from(continuedPacket));
        continuedPacket = [];
      }
    }
    if ((headerType & 0x04) !== 0) {
      if (pageEnd !== bytes.length || continuedPacket.length > 0) return false;
      sawEos = true;
      eosGranulePosition = readUint64Le(bytes, offset + 6);
    }
    offset = pageEnd;
  }
  if (
    !sawBos ||
    !sawEos ||
    eosGranulePosition === null ||
    eosGranulePosition <= 0 ||
    packets.length < 3
  )
    return false;
  if (!validateOpusHead(packets[0]!) || !validateOpusTags(packets[1]!)) return false;
  return packets.slice(2).some((packet) => packet.length > 0);
}

function hasStructurallyCompleteMedia(bytes: Uint8Array, mimeType: string): boolean {
  if (bytes.byteLength === 0) return false;
  const mediaType = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (mediaType === 'audio/mp4') return validateMp4(bytes);
  if (mediaType === 'audio/webm') return validateWebm(bytes);
  if (mediaType === 'audio/ogg') return validateOgg(bytes);
  return false;
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
  assertCompleteCodecInput(mimeType, frames, sampleRate);

  const context = new AudioContextCtor({ sampleRate });
  try {
    await resumeAudioContext(context, signal);
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
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
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
          const blob = new Blob(chunks, { type: mimeType });
          if (blob.size === 0) {
            reject(new Error('Browser media encoding produced zero-byte output'));
            return;
          }
          void toBlobBytes(blob).then(
            (bytes) => {
              if (!hasStructurallyCompleteMedia(bytes, mimeType)) {
                reject(new Error('Browser media encoding produced structurally invalid output'));
                return;
              }
              onProgress?.(1);
              resolve(bytes);
            },
            (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
          );
        });
      };
      const onEnded = (): void => {
        if (recorder.state === 'recording') recorder.stop();
      };
      const stopActiveEncoding = (): void => {
        try {
          source.stop();
        } catch {
          // The source may already have ended.
        }
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
        stopActiveEncoding();
      };
      const onWatchdog = (): void => {
        settle(() => reject(new Error('Browser media encoding did not complete in time')));
        stopActiveEncoding();
      };
      cleanupRecorderListeners = () => {
        if (progressTimer !== null) clearInterval(progressTimer);
        progressTimer = null;
        if (watchdogTimer !== null) clearTimeout(watchdogTimer);
        watchdogTimer = null;
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
      // An AudioContext can remain suspended after resume() resolves or a
      // recorder can fail to emit stop. Never leave the export promise pending
      // indefinitely; a normal delivery gets its playback duration plus a
      // container-finalization grace window.
      watchdogTimer = setTimeout(
        onWatchdog,
        Math.ceil(durationSeconds * 1000) + MEDIA_RECORDER_COMPLETION_GRACE_MS,
      );
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
