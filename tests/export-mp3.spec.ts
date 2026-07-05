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
