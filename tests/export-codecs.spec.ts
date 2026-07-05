import { describe, expect, it } from 'vitest';
import {
  type AudioEncoder,
  getEncoder,
  listEncoders,
  registerEncoder,
  WAV_ENCODER_ID,
} from '@/export/codecs';
import { encodeWav } from '@/export/wav';

describe('audio encoder registry', () => {
  it('ships the WAV encoder built in', () => {
    const encoder = getEncoder(WAV_ENCODER_ID);
    expect(encoder.id).toBe('wav');
    expect(encoder.extension).toBe('.wav');
    expect(encoder.mime).toBe('audio/wav');
    expect(encoder.deterministic).toBe(true);
    expect(encoder.label).toContain('WAV');
    expect(listEncoders().some((e) => e.id === WAV_ENCODER_ID)).toBe(true);
  });

  it('produces the same bytes as encodeWav with mapped options', async () => {
    const channels = [new Float32Array([0.1, -0.2]), new Float32Array([0.3, -0.4])];
    const viaRegistry = await getEncoder(WAV_ENCODER_ID).encode(channels, 48000, {
      bitDepth: 24,
    });
    expect(viaRegistry).toEqual(encodeWav(channels, 48000, { bitDepth: 24 }));
  });

  it('ignores unknown option values for the WAV encoder', async () => {
    const channels = [new Float32Array([0.5])];
    const bytes = await getEncoder(WAV_ENCODER_ID).encode(channels, 48000, {
      bitDepth: 'huge',
      dither: 'yes',
    });
    expect(bytes).toEqual(encodeWav(channels, 48000));
  });

  it('registers and resolves custom encoders', async () => {
    const custom: AudioEncoder = {
      id: 'test-codec',
      label: 'Test codec',
      extension: '.tst',
      mime: 'audio/test',
      encode: async () => new Uint8Array([1, 2, 3]),
    };
    registerEncoder(custom);
    expect(getEncoder('test-codec')).toBe(custom);
    expect(listEncoders().map((e) => e.id)).toContain('test-codec');
    expect(await getEncoder('test-codec').encode([new Float32Array(1)], 48000)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('rejects duplicate and empty encoder ids', () => {
    expect(() =>
      registerEncoder({
        id: WAV_ENCODER_ID,
        label: 'dup',
        extension: '.wav',
        mime: 'audio/wav',
        encode: () => new Uint8Array(0),
      }),
    ).toThrow(RangeError);
    expect(() =>
      registerEncoder({
        id: '',
        label: 'empty',
        extension: '.x',
        mime: 'audio/x',
        encode: () => new Uint8Array(0),
      }),
    ).toThrow(RangeError);
  });

  it('throws for unknown encoder ids', () => {
    expect(() => getEncoder('no-such-codec')).toThrow(RangeError);
  });
});
