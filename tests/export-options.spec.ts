import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { WAV_ENCODER_ID } from '@/export/codecs';
import { MP3_ENCODER_ID } from '@/export/mp3';
import {
  buildStemsZip,
  createDefaultExportOptions,
  type EXPORT_SAMPLE_RATES,
  type ExportOptionsModel,
  encodeOptionsForModel,
  exportFileName,
  sanitizeFileBaseName,
  stemEntryNames,
  stemsZipFileName,
  toRenderOptions,
  validateExportOptions,
} from '@/export/options';

const CONTEXT = { hasLoop: false, encoderIds: [WAV_ENCODER_ID, MP3_ENCODER_ID] };

function model(overrides: Partial<ExportOptionsModel> = {}): ExportOptionsModel {
  return { ...createDefaultExportOptions('My Song'), ...overrides };
}

describe('createDefaultExportOptions', () => {
  it('defaults to a 16-bit WAV mixdown of the whole project', () => {
    const defaults = createDefaultExportOptions('My Song');
    expect(defaults).toEqual({
      encoderId: 'wav',
      sampleRate: 48000,
      range: 'project',
      mode: 'mixdown',
      includeMasterChain: true,
      baseName: 'My Song',
      wavBitDepth: 16,
      wavDither: false,
      mp3Bitrate: 320,
    });
    expect(createDefaultExportOptions().baseName).toBe('project');
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

  it('passes nothing for unknown encoders', () => {
    expect(encodeOptionsForModel(model({ encoderId: 'flac' }))).toEqual({});
  });
});

describe('toRenderOptions', () => {
  it('maps the project range and toggles', () => {
    expect(toRenderOptions(model({ sampleRate: 44100, includeMasterChain: false }))).toEqual({
      sampleRate: 44100,
      range: 'project',
      includeMasterChain: false,
      stems: false,
    });
  });

  it('maps stems mode', () => {
    expect(toRenderOptions(model({ mode: 'stems' })).stems).toBe(true);
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
    expect(stemEntryNames(['Drums', 'Bass', 'Bass'], '.wav')).toEqual([
      '01 Drums.wav',
      '02 Bass.wav',
      '03 Bass.wav',
    ]);
    expect(stemEntryNames(['a:b', ''], '.mp3')).toEqual(['01 a_b.mp3', '02 Track.mp3']);
  });

  it('widens the ordinal padding for large track counts', () => {
    const names = stemEntryNames(new Array<string>(120).fill('T'), '.wav');
    expect(names[0]).toBe('001 T.wav');
    expect(names[119]).toBe('120 T.wav');
  });
});

describe('buildStemsZip', () => {
  it('packs entries into a zip that round-trips through unzipSync', () => {
    const zip = buildStemsZip([
      { name: '01 Drums.wav', bytes: new Uint8Array([1, 2, 3]) },
      { name: '02 Bass.wav', bytes: strToBytes('bass') },
    ]);
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(['01 Drums.wav', '02 Bass.wav']);
    expect(entries['01 Drums.wav']).toEqual(new Uint8Array([1, 2, 3]));
    expect(strFromU8(entries['02 Bass.wav'])).toBe('bass');
  });

  it('is deterministic for identical inputs', () => {
    const entries = [{ name: '01 T.wav', bytes: new Uint8Array([9, 9, 9]) }];
    expect(buildStemsZip(entries)).toEqual(buildStemsZip(entries));
  });

  it('rejects an empty entry list', () => {
    expect(() => buildStemsZip([])).toThrow(RangeError);
  });
});

/** Encodes ASCII text to bytes (test helper). */
function strToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
