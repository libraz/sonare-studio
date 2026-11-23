import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { WAV_ENCODER_ID } from '@/export/codecs';
import { FLAC_ENCODER_ID } from '@/export/flac';
import { MP3_ENCODER_ID } from '@/export/mp3';
import {
  createDefaultExportOptions,
  createStemsZipWriter,
  type EXPORT_SAMPLE_RATES,
  type ExportOptionsModel,
  encodeOptionsForModel,
  exportFileName,
  normalizeMixdownLoudness,
  sanitizeFileBaseName,
  selectedEncoderIds,
  stemEntryName,
  stemsZipFileName,
  toRenderOptions,
  validateExportOptions,
} from '@/export/options';

const CONTEXT = { hasLoop: false, encoderIds: [WAV_ENCODER_ID, MP3_ENCODER_ID] };

function model(overrides: Partial<ExportOptionsModel> = {}): ExportOptionsModel {
  return { ...createDefaultExportOptions('My Song'), ...overrides };
}

describe('createDefaultExportOptions', () => {
  it('defaults to a 24-bit WAV mixdown of the whole project', () => {
    const defaults = createDefaultExportOptions('My Song');
    expect(defaults).toEqual({
      encoderId: 'wav',
      additionalEncoderIds: [],
      sampleRate: 48000,
      range: 'project',
      mode: 'mixdown',
      includeBusStems: true,
      includeMasterStem: true,
      includeMasterChain: true,
      normalizeLoudness: false,
      releaseTailSeconds: 2,
      baseName: 'My Song',
      wavBitDepth: 24,
      wavDither: false,
      flacBitDepth: 24,
      flacDither: false,
      mp3Bitrate: 320,
      compressedBitrateKbps: 256,
      memoryBudgetMiB: 1024,
    });
    expect(createDefaultExportOptions().baseName).toBe('project');
  });

  it('defaults to the project sample rate when it is a selectable output rate', () => {
    expect(createDefaultExportOptions('Song', 44100).sampleRate).toBe(44100);
    expect(createDefaultExportOptions('Song', 96000).sampleRate).toBe(96000);
    expect(createDefaultExportOptions('Song', 22050).sampleRate).toBe(48000);
  });
});

describe('validateExportOptions', () => {
  it('accepts the defaults', () => {
    expect(validateExportOptions(model(), CONTEXT)).toEqual([]);
  });

  it('rejects unknown encoders', () => {
    const errors = validateExportOptions(model({ encoderId: 'flac' }), CONTEXT);
    expect(errors.some((e) => e.includes('flac'))).toBe(true);
  });

  it('validates every supplemental format', () => {
    const errors = validateExportOptions(
      model({ additionalEncoderIds: [MP3_ENCODER_ID, 'unknown-format'] }),
      CONTEXT,
    );
    expect(errors).toEqual(['Unknown export format: unknown-format']);
  });

  it('rejects a sample rate outside the selectable list', () => {
    const errors = validateExportOptions(
      model({ sampleRate: 22050 as (typeof EXPORT_SAMPLE_RATES)[number] }),
      CONTEXT,
    );
    expect(errors.some((e) => e.includes('22050'))).toBe(true);
  });

  it('requires an active loop for the loop range', () => {
    expect(validateExportOptions(model({ range: 'loop' }), CONTEXT)).toEqual([
      'Loop range requires an active loop region',
    ]);
    expect(validateExportOptions(model({ range: 'loop' }), { ...CONTEXT, hasLoop: true })).toEqual(
      [],
    );
  });

  it('requires a non-blank filename', () => {
    expect(validateExportOptions(model({ baseName: '   ' }), CONTEXT)).toEqual([
      'Filename must not be empty',
    ]);
  });

  it('rejects MP3 at 96 kHz and off-list bitrates', () => {
    const mp3 = model({ encoderId: MP3_ENCODER_ID, sampleRate: 96000 });
    expect(validateExportOptions(mp3, CONTEXT)).toEqual(['MP3 supports 44.1 kHz and 48 kHz only']);
    const badRate = model({
      encoderId: MP3_ENCODER_ID,
      mp3Bitrate: 64 as ExportOptionsModel['mp3Bitrate'],
    });
    expect(validateExportOptions(badRate, CONTEXT)).toEqual(['Unsupported MP3 bitrate: 64 kbps']);
    // WAV at 96 kHz stays valid.
    expect(validateExportOptions(model({ sampleRate: 96000 }), CONTEXT)).toEqual([]);
  });

  it('rejects off-list browser compressed bitrates', () => {
    const errors = validateExportOptions(
      model({ encoderId: 'opus-webm', compressedBitrateKbps: 64 as never }),
      { ...CONTEXT, encoderIds: [...CONTEXT.encoderIds, 'opus-webm'] },
    );
    expect(errors).toEqual(['Unsupported compressed bitrate: 64 kbps']);
  });

  it('rejects off-list bitrates for runtime compressed encoders', () => {
    const errors = validateExportOptions(
      model({ encoderId: 'runtime-aac', compressedBitrateKbps: 64 as never }),
      {
        ...CONTEXT,
        encoderIds: [...CONTEXT.encoderIds, 'runtime-aac'],
        compressedEncoderIds: ['runtime-aac'],
      },
    );
    expect(errors).toEqual(['Unsupported compressed bitrate: 64 kbps']);
  });

  it('rejects off-list FLAC bit depths', () => {
    const errors = validateExportOptions(
      model({ encoderId: FLAC_ENCODER_ID, flacBitDepth: 32 as never }),
      { ...CONTEXT, encoderIds: [...CONTEXT.encoderIds, FLAC_ENCODER_ID] },
    );
    expect(errors).toEqual(['Unsupported FLAC bit depth: 32']);
  });

  it('rejects an unsupported retained-payload memory budget', () => {
    expect(validateExportOptions(model({ memoryBudgetMiB: 768 as never }), CONTEXT)).toEqual([
      'Unsupported export memory budget: 768 MiB',
    ]);
  });
});

describe('selectedEncoderIds', () => {
  it('keeps primary order and removes duplicate or blank supplemental formats', () => {
    expect(
      selectedEncoderIds(
        model({ additionalEncoderIds: [MP3_ENCODER_ID, WAV_ENCODER_ID, '', MP3_ENCODER_ID] }),
      ),
    ).toEqual([WAV_ENCODER_ID, MP3_ENCODER_ID]);
  });
});

describe('encodeOptionsForModel', () => {
  it('maps WAV options', () => {
    expect(encodeOptionsForModel(model({ wavBitDepth: 24, wavDither: true }))).toEqual({
      bitDepth: 24,
      dither: true,
    });
  });

  it('maps MP3 options', () => {
    expect(encodeOptionsForModel(model({ encoderId: MP3_ENCODER_ID, mp3Bitrate: 192 }))).toEqual({
      bitrate: 192,
    });
  });

  it('maps FLAC options', () => {
    expect(
      encodeOptionsForModel(
        model({ encoderId: FLAC_ENCODER_ID, flacBitDepth: 16, flacDither: true }),
      ),
    ).toEqual({ bitDepth: 16, dither: true });
  });

  it('maps browser compressed encoder bitrate options', () => {
    expect(
      encodeOptionsForModel(model({ encoderId: 'opus-webm', compressedBitrateKbps: 192 })),
    ).toEqual({ bitrate: 192 });
  });

  it('maps runtime compressed encoder bitrate options from context', () => {
    expect(
      encodeOptionsForModel(model({ encoderId: 'runtime-aac', compressedBitrateKbps: 128 }), {
        compressedEncoderIds: ['runtime-aac'],
      }),
    ).toEqual({ bitrate: 128 });
  });

  it('passes nothing for unknown encoders', () => {
    expect(encodeOptionsForModel(model({ encoderId: 'no-such-encoder' }))).toEqual({});
  });
});

describe('normalizeMixdownLoudness', () => {
  it('caps loudness gain at the true-peak ceiling', () => {
    const left = new Float32Array([0.25]);
    const right = new Float32Array([-0.5]);

    const report = normalizeMixdownLoudness(
      [left, right],
      { peakDb: -6, truePeakDbtp: -5.5, lufs: -20 },
      -14,
    );

    expect(left[0]).toBeCloseTo(0.25 * 10 ** (4.5 / 20), 6);
    expect(right[0]).toBeCloseTo(-0.5 * 10 ** (4.5 / 20), 6);
    expect(report).toEqual({
      peakDb: -1.5,
      truePeakDbtp: -1,
      lufs: -15.5,
    });
  });

  it('applies the same gain delta to every absolute loudness report field', () => {
    const report = normalizeMixdownLoudness(
      [new Float32Array([0.1]), new Float32Array([0.1])],
      {
        peakDb: -20,
        truePeakDbtp: -19,
        lufs: -20,
        momentaryLufs: -18,
        shortTermLufs: -19,
        loudnessRangeLu: 4,
      },
      -14,
    );

    expect(report).toMatchObject({
      peakDb: -14,
      truePeakDbtp: -13,
      lufs: -14,
      momentaryLufs: -12,
      shortTermLufs: -13,
      loudnessRangeLu: 4,
    });
  });

  it('drops the clipping census once a gain is applied', () => {
    const clipping = {
      clippedSamples: 12,
      clippingRatio: 0.5,
      maxClippedPeak: 1.4,
      regionCount: 2,
      firstRegionStartSample: 4,
    };

    const attenuated = normalizeMixdownLoudness(
      [new Float32Array([0.9]), new Float32Array([0.9])],
      { peakDb: 0.5, truePeakDbtp: 1, lufs: -6, clipping },
      -14,
    );
    // The counts describe samples crossing a fixed threshold, so they cannot
    // be rescaled — and the ceiling puts the normalized file below it anyway.
    expect(attenuated.clipping).toBeUndefined();

    const unchanged = normalizeMixdownLoudness(
      [new Float32Array([0.9]), new Float32Array([0.9])],
      { peakDb: -1, truePeakDbtp: -1, lufs: Number.NaN, clipping },
      Number.NaN,
    );
    expect(unchanged.clipping).toEqual(clipping);
  });

  it('reaches the loudness target when there is enough true-peak headroom', () => {
    const channels: [Float32Array, Float32Array] = [
      new Float32Array([0.1]),
      new Float32Array([-0.1]),
    ];
    const report = normalizeMixdownLoudness(
      channels,
      { peakDb: -20, truePeakDbtp: -19.5, lufs: -20 },
      -14,
    );
    expect(report.lufs).toBe(-14);
    expect(report.truePeakDbtp).toBe(-13.5);
  });

  it('leaves audio unchanged when loudness is unavailable and the peak is under the ceiling', () => {
    const left = new Float32Array([0.25]);
    const right = new Float32Array([-0.5]);

    const report = normalizeMixdownLoudness([left, right], { peakDb: -6 }, -14);

    expect(Array.from(left)).toEqual([0.25]);
    expect(Array.from(right)).toEqual([-0.5]);
    expect(report).toEqual({ peakDb: -6 });
  });

  it('enforces the peak ceiling even when loudness is unavailable', () => {
    const left = new Float32Array([0.25]);
    const right = new Float32Array([-0.5]);

    // Sample peak is +3 dBFS, well over the default -1 dB ceiling; with no LUFS
    // the mix must still be attenuated by 4 dB, not left to clip.
    const report = normalizeMixdownLoudness([left, right], { peakDb: 3 }, -14);

    const gain = 10 ** (-4 / 20);
    expect(left[0]).toBeCloseTo(0.25 * gain, 6);
    expect(right[0]).toBeCloseTo(-0.5 * gain, 6);
    expect(report).toEqual({ peakDb: -1 });
  });

  it('falls back to the sample peak when the true peak is unmeasured', () => {
    const left = new Float32Array([0.1]);
    const right = new Float32Array([-0.1]);

    // A large loudness deficit would boost far past the ceiling, but with no
    // true-peak measurement the sample peak (-2 dBFS) caps the gain at +1 dB.
    const report = normalizeMixdownLoudness([left, right], { peakDb: -2, lufs: -30 }, -14);

    const gain = 10 ** (1 / 20);
    expect(left[0]).toBeCloseTo(0.1 * gain, 6);
    expect(right[0]).toBeCloseTo(-0.1 * gain, 6);
    expect(report).toEqual({ peakDb: -1, lufs: -29 });
  });
});

describe('toRenderOptions', () => {
  it('maps the project range and toggles', () => {
    expect(toRenderOptions(model({ sampleRate: 44100, includeMasterChain: false }))).toEqual({
      sampleRate: 44100,
      range: 'project',
      includeMasterChain: false,
      stems: false,
      busStems: false,
      masterStem: false,
      releaseTailSeconds: 2,
      memoryBudgetBytes: 1024 * 1024 * 1024,
    });
  });

  it('threads the selected memory budget to the worker preflight', () => {
    expect(toRenderOptions(model({ memoryBudgetMiB: 2048 })).memoryBudgetBytes).toBe(
      2048 * 1024 * 1024,
    );
  });

  it('maps stems mode', () => {
    expect(toRenderOptions(model({ mode: 'stems' }))).toMatchObject({
      stems: true,
      busStems: true,
      masterStem: true,
    });
    expect(
      toRenderOptions(model({ mode: 'stems', includeBusStems: false, includeMasterStem: false })),
    ).toMatchObject({
      stems: true,
      busStems: false,
      masterStem: false,
    });
  });

  it('maps the loop range with the given window', () => {
    const options = toRenderOptions(model({ range: 'loop' }), { startPpq: 4, endPpq: 16 });
    expect(options.range).toBe('loop');
    expect(options.loopRegion).toEqual({ startPpq: 4, endPpq: 16 });
  });

  it('throws when the loop range has no window', () => {
    expect(() => toRenderOptions(model({ range: 'loop' }))).toThrow(RangeError);
    expect(() => toRenderOptions(model({ range: 'loop' }), null)).toThrow(RangeError);
  });
});

describe('filename derivation', () => {
  it('sanitizes unsafe characters and falls back when empty', () => {
    expect(sanitizeFileBaseName('My/Song: *final*?')).toBe('My_Song_ _final__');
    expect(sanitizeFileBaseName('   ')).toBe('project');
    expect(sanitizeFileBaseName('', 'Track')).toBe('Track');
  });

  it('appends the extension once', () => {
    expect(exportFileName('My Song', '.wav')).toBe('My Song.wav');
    expect(exportFileName('My Song.WAV', '.wav')).toBe('My Song.WAV');
    expect(exportFileName('a:b', '.mp3')).toBe('a_b.mp3');
  });

  it('derives the stems archive name', () => {
    expect(stemsZipFileName('My Song')).toBe('My Song stems.zip');
    expect(stemsZipFileName('a/b')).toBe('a_b stems.zip');
  });

  it('numbers stem entries and keeps duplicates unique', () => {
    const names = ['Drums', 'Bass', 'Bass'];
    expect(names.map((name, i) => stemEntryName(name, i, names.length, '.wav', 'Track'))).toEqual([
      '01 Drums.wav',
      '02 Bass.wav',
      '03 Bass.wav',
    ]);
    expect(stemEntryName('a:b', 0, 2, '.mp3', 'Track 1')).toBe('01 a_b.mp3');
    expect(stemEntryName('', 1, 2, '.mp3', 'Track 2')).toBe('02 Track 2.mp3');
  });

  it('widens the ordinal padding for large track counts', () => {
    expect(stemEntryName('T', 0, 120, '.wav', 'Track 1')).toBe('001 T.wav');
    expect(stemEntryName('T', 119, 120, '.wav', 'Track 120')).toBe('120 T.wav');
  });

  it('rejects an ordinal outside the stem count', () => {
    expect(() => stemEntryName('T', 3, 3, '.wav', 'Track 4')).toThrow(RangeError);
  });
});

describe('createStemsZipWriter', () => {
  it('consumes entries incrementally into a valid archive', async () => {
    const writer = createStemsZipWriter();
    writer.add({ name: '01 A.wav', bytes: new Uint8Array([1, 2]) });
    writer.add({ name: '02 B.wav', bytes: new Uint8Array([3, 4]) });
    const entries = unzipSync(new Uint8Array(await (await writer.close()).arrayBuffer()));
    expect(entries['01 A.wav']).toEqual(new Uint8Array([1, 2]));
    expect(entries['02 B.wav']).toEqual(new Uint8Array([3, 4]));
  });

  // A hundred real zip entries: the point is that the writer keeps no table
  // of them, not that it finishes quickly. Compression dominates the runtime,
  // so the default timeout leaves no headroom on a loaded machine.
  it('handles a 100-stem archive without retaining an input entry table', async () => {
    const writer = createStemsZipWriter();
    for (let index = 0; index < 100; index++) {
      writer.add({
        name: `${String(index).padStart(3, '0')} Stem.wav`,
        bytes: new Uint8Array([index]),
      });
    }
    const entries = unzipSync(new Uint8Array(await (await writer.close()).arrayBuffer()));
    expect(Object.keys(entries)).toHaveLength(100);
    expect(entries['099 Stem.wav']).toEqual(new Uint8Array([99]));
  }, 30_000);

  it('rejects work after its abort signal is cancelled', async () => {
    const controller = new AbortController();
    const writer = createStemsZipWriter(controller.signal);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(
      writer.add({ name: '01 A.wav', bytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(writer.close()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
