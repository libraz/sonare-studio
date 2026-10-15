import { describe, expect, it } from 'vitest';
import { getEncoder, listEncoders } from '@/export/codecs';
import {
  createMp3Encoder,
  DEFAULT_MP3_BITRATE,
  encodeMp3,
  isMp3Bitrate,
  isMp3SampleRate,
  MP3_BITRATES,
  MP3_ENCODER_ID,
  MP3_SAMPLE_RATES,
  registerMp3Encoder,
} from '@/export/mp3';

/** A short stereo sine burst (still several MP3 frames at 44.1 kHz). */
function makeStereo(frames = 4 * 1152): [Float32Array, Float32Array] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    right[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 44100);
  }
  return [left, right];
}

/** Asserts the bytes start with an MPEG audio frame sync (11 set bits). */
function expectMpegSync(bytes: Uint8Array): void {
  expect(bytes.length).toBeGreaterThan(0);
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1] & 0xe0).toBe(0xe0);
}

function synchsafe(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3]
  );
}

function mpegFrameInfo(bytes: Uint8Array, offset: number): { size: number; infoOffset: number } {
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0xf;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x3;
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const sampleRates = [44100, 48000, 32000];
  const size =
    Math.floor((144000 * bitrates[bitrateIndex]) / sampleRates[sampleRateIndex]) +
    ((bytes[offset + 2] >> 1) & 1);
  const hasCrc = (bytes[offset + 1] & 1) === 0;
  const mono = bytes[offset + 3] >> 6 === 3;
  return { size, infoOffset: offset + 4 + (hasCrc ? 2 : 0) + (mono ? 17 : 32) };
}

describe('mp3 encoder registration', () => {
  it('registers once and is idempotent afterwards', () => {
    const hadMp3 = listEncoders().some((encoder) => encoder.id === MP3_ENCODER_ID);
    expect(registerMp3Encoder()).toBe(!hadMp3);
    expect(registerMp3Encoder()).toBe(false);
    expect(listEncoders().some((encoder) => encoder.id === MP3_ENCODER_ID)).toBe(true);
  });

  it('exposes the registry metadata', () => {
    registerMp3Encoder();
    const encoder = getEncoder(MP3_ENCODER_ID);
    expect(encoder.id).toBe('mp3');
    expect(encoder.extension).toBe('.mp3');
    expect(encoder.mime).toBe('audio/mpeg');
    expect(encoder.deterministic).toBe(true);
    expect(encoder.label).toContain('MP3');
  });
});

describe('encodeMp3', () => {
  it('encodes stereo 44.1 kHz audio into MPEG frames', async () => {
    const bytes = await encodeMp3(makeStereo(), 44100, { bitrate: 192 });
    expectMpegSync(bytes);
  });

  it('encodes mono audio', async () => {
    const [left] = makeStereo();
    const bytes = await encodeMp3([left], 48000, { bitrate: 128 });
    expectMpegSync(bytes);
  });

  it('produces larger files at higher bitrates', async () => {
    const channels = makeStereo(16 * 1152);
    const low = await encodeMp3(channels, 44100, { bitrate: 128 });
    const high = await encodeMp3(channels, 44100, { bitrate: 320 });
    expect(high.length).toBeGreaterThan(low.length);
  });

  it('defaults to the documented bitrate', async () => {
    const channels = makeStereo(8 * 1152);
    const explicit = await encodeMp3(channels, 44100, { bitrate: DEFAULT_MP3_BITRATE });
    const implicit = await encodeMp3(channels, 44100);
    expect(implicit).toEqual(explicit);
  });

  it('rejects unsupported sample rates (no 96 kHz)', async () => {
    await expect(encodeMp3(makeStereo(), 96000)).rejects.toThrow(RangeError);
    await expect(encodeMp3(makeStereo(), 22050)).rejects.toThrow(RangeError);
  });

  it('rejects bitrates outside the CBR list', async () => {
    await expect(
      encodeMp3(makeStereo(), 44100, { bitrate: 64 as (typeof MP3_BITRATES)[number] }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects bad channel layouts', async () => {
    const [left, right] = makeStereo();
    await expect(encodeMp3([], 44100)).rejects.toThrow(RangeError);
    await expect(encodeMp3([left, right, left], 44100)).rejects.toThrow(RangeError);
    await expect(encodeMp3([left, right.subarray(0, 100)], 44100)).rejects.toThrow(RangeError);
  });

  it('handles empty input (header/flush only)', async () => {
    const bytes = await encodeMp3([new Float32Array(0), new Float32Array(0)], 44100);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('adds ID3v2 and CBR Info/LAME gapless metadata for a delivery', async () => {
    const input = makeStereo(4 * 1152);
    const bytes = await encodeMp3(input, 44100, {
      bitrate: 128,
      metadata: { title: 'Mix', originator: 'Sonare Studio' },
    });
    expect(String.fromCharCode(...bytes.slice(0, 3))).toBe('ID3');
    const audioOffset = 10 + synchsafe(bytes, 6);
    expectMpegSync(bytes.slice(audioOffset));
    const { size, infoOffset } = mpegFrameInfo(bytes, audioOffset);
    expect(size).toBeGreaterThan(0);
    expect(String.fromCharCode(...bytes.slice(infoOffset, infoOffset + 4))).toBe('Info');
    const lameOffset = infoOffset + 16;
    expect(String.fromCharCode(...bytes.slice(lameOffset, lameOffset + 9))).toBe('LAME3.100');
    const delay = (bytes[lameOffset + 21] << 4) | (bytes[lameOffset + 22] >> 4);
    const padding = ((bytes[lameOffset + 22] & 0xf) << 8) | bytes[lameOffset + 23];
    expect(delay).toBe(576);
    // Frame count excludes the Info frame; frames minus delay and padding is the input length.
    const frameCount =
      ((bytes[infoOffset + 8] << 24) |
        (bytes[infoOffset + 9] << 16) |
        (bytes[infoOffset + 10] << 8) |
        bytes[infoOffset + 11]) >>>
      0;
    expect(frameCount * 1152 - delay - padding).toBe(input[0].length);
    expect(padding).toBeGreaterThanOrEqual(576);
    expect(padding).toBeLessThanOrEqual(1728);
    const tags = new TextDecoder().decode(bytes.slice(10, audioOffset));
    expect(tags).toContain('TIT2');
    expect(tags).toContain('Mix');
    expect(tags).toContain('TPE1');
    expect(tags).toContain('Sonare Studio');
  });
});

describe('mp3 registry encoder', () => {
  it('maps the open option bag onto the bitrate', async () => {
    const encoder = createMp3Encoder();
    const channels = makeStereo(8 * 1152);
    const viaBag = await encoder.encode(channels, 44100, { bitrate: 128 });
    expect(viaBag).toEqual(await encodeMp3(channels, 44100, { bitrate: 128 }));
    // Non-numeric values are ignored and fall back to the default.
    const fallback = await encoder.encode(channels, 44100, { bitrate: 'fast' });
    expect(fallback).toEqual(await encodeMp3(channels, 44100));
  });

  it('still validates numeric but unsupported bitrates', async () => {
    const encoder = createMp3Encoder();
    await expect(encoder.encode(makeStereo(), 44100, { bitrate: 999 })).rejects.toThrow(RangeError);
  });
});

describe('mp3 capability predicates', () => {
  it('accepts exactly the documented bitrates and sample rates', () => {
    for (const bitrate of MP3_BITRATES) expect(isMp3Bitrate(bitrate)).toBe(true);
    expect(isMp3Bitrate(64)).toBe(false);
    expect(isMp3Bitrate('320')).toBe(false);
    for (const rate of MP3_SAMPLE_RATES) expect(isMp3SampleRate(rate)).toBe(true);
    expect(isMp3SampleRate(96000)).toBe(false);
  });
});
