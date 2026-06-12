import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeSzd, encodeSzd, readSzdMeta, SZD_APP_ID, SzdFormatError } from '@/persistence/szd';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';

/** Builds a small but representative project document. */
function makeDocument(): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: 'Round Trip',
    sampleRate: 48000,
    tempoSegments: [
      { startPpq: 0, bpm: 120 },
      { startPpq: 16, bpm: 90, endBpm: 110 },
    ],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Piano',
        color: '#60a5fa',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips: [
          {
            name: 'Theme',
            startPpq: 0,
            lengthPpq: 32,
            sourceOffsetPpq: 0,
            gain: 0.75,
            loopEnabled: true,
            loopLengthPpq: 8,
            notes: [
              { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
              {
                pitch: 64,
                velocity: 80,
                startPpq: 1.5,
                durationPpq: 0.5,
                channel: 2,
                offVelocity: 30,
              },
            ],
          },
        ],
      },
    ],
    markers: [{ ppq: 0, name: 'Intro' }],
    sections: [{ name: 'Verse', color: '#334455', startPpq: 0, endPpq: 16 }],
  };
}

describe('szd encode/decode', () => {
  it('round-trips a project document losslessly', () => {
    const doc = makeDocument();
    const bytes = encodeSzd(doc);
    expect(decodeSzd(bytes)).toEqual(doc);
  });

  it('round-trips automation lanes and tolerates their absence', () => {
    const base = makeDocument();
    const withLanes: ProjectDocument = {
      ...base,
      tracks: [
        {
          ...base.tracks[0],
          automation: [
            {
              param: 'faderDb',
              points: [
                { ppq: 0, value: -6 },
                { ppq: 8, value: 0, curve: 'hold' },
              ],
              enabled: true,
            },
          ],
        },
      ],
      masterAutomation: [{ param: 'pan', points: [{ ppq: 4, value: 0.5 }], enabled: false }],
    };
    expect(decodeSzd(encodeSzd(withLanes))).toEqual(withLanes);
    // Documents that predate the fields decode without them (loading defaults to []).
    const plain = decodeSzd(encodeSzd(makeDocument()));
    expect(plain.masterAutomation).toBeUndefined();
    expect(plain.tracks[0].automation).toBeUndefined();
  });

  it('rejects a present but non-array masterAutomation field', () => {
    const doc = makeDocument() as unknown as Record<string, unknown>;
    doc['masterAutomation'] = 'oops';
    const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(doc)) });
    expect(() => decodeSzd(bytes)).toThrow(/"masterAutomation"/);
  });

  it('is deterministic for the same input (no clock reads)', () => {
    const doc = makeDocument();
    expect(encodeSzd(doc)).toEqual(encodeSzd(doc));
    const stamped = { savedAt: '2026-01-02T03:04:05.000Z' };
    expect(encodeSzd(doc, stamped)).toEqual(encodeSzd(doc, stamped));
  });

  it('writes project.json and meta.json with the caller-provided timestamp', () => {
    const doc = makeDocument();
    const entries = unzipSync(encodeSzd(doc, { savedAt: '2026-01-02T03:04:05.000Z' }));
    expect(Object.keys(entries).sort()).toEqual(['meta.json', 'project.json']);
    expect(JSON.parse(strFromU8(entries['project.json']))).toEqual(doc);
    expect(JSON.parse(strFromU8(entries['meta.json']))).toEqual({
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
      app: SZD_APP_ID,
      savedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('omits savedAt from meta.json when the caller provides none', () => {
    const entries = unzipSync(encodeSzd(makeDocument()));
    expect(JSON.parse(strFromU8(entries['meta.json']))).toEqual({
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
      app: SZD_APP_ID,
    });
  });

  it('readSzdMeta returns the metadata without validating the document', () => {
    const bytes = encodeSzd(makeDocument(), { savedAt: '2026-01-02T03:04:05.000Z' });
    expect(readSzdMeta(bytes)).toEqual({
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
      app: SZD_APP_ID,
      savedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(readSzdMeta(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('rejects schema version 0', () => {
    const bytes = encodeSzd({ ...makeDocument(), schemaVersion: 0 });
    expect(() => decodeSzd(bytes)).toThrow(SzdFormatError);
    expect(() => decodeSzd(bytes)).toThrow(/schema version/);
  });

  it('rejects documents from a newer schema with a helpful message', () => {
    const bytes = encodeSzd({
      ...makeDocument(),
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION + 1,
    });
    expect(() => decodeSzd(bytes)).toThrow(/newer app version/);
  });

  it('rejects bytes that are not a zip archive', () => {
    expect(() => decodeSzd(new Uint8Array(0))).toThrow(SzdFormatError);
    expect(() => decodeSzd(new Uint8Array([1, 2, 3, 4]))).toThrow(/zip/);
  });

  it('rejects a corrupted (truncated) archive', () => {
    const bytes = encodeSzd(makeDocument());
    expect(() => decodeSzd(bytes.subarray(0, Math.floor(bytes.length / 2)))).toThrow(
      SzdFormatError,
    );
  });

  it('rejects an archive without project.json', () => {
    const bytes = zipSync({ 'meta.json': strToU8('{}') });
    expect(() => decodeSzd(bytes)).toThrow(/project\.json/);
  });

  it('rejects an archive whose project.json is not JSON', () => {
    const bytes = zipSync({ 'project.json': strToU8('not json at all') });
    expect(() => decodeSzd(bytes)).toThrow(/not valid JSON/);
  });

  it('rejects an archive written by another application', () => {
    const bytes = zipSync({
      'project.json': strToU8(JSON.stringify(makeDocument())),
      'meta.json': strToU8(JSON.stringify({ schemaVersion: 1, app: 'other-daw' })),
    });
    expect(() => decodeSzd(bytes)).toThrow(/another application/);
  });

  it('rejects documents with missing top-level collections', () => {
    const doc = makeDocument() as unknown as Record<string, unknown>;
    doc['tracks'] = 'oops';
    const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(doc)) });
    expect(() => decodeSzd(bytes)).toThrow(/"tracks"/);
  });

  it('tolerates a missing or unreadable meta.json', () => {
    const doc = makeDocument();
    const noMeta = zipSync({ 'project.json': strToU8(JSON.stringify(doc)) });
    expect(decodeSzd(noMeta)).toEqual(doc);
    const badMeta = zipSync({
      'project.json': strToU8(JSON.stringify(doc)),
      'meta.json': strToU8('not json'),
    });
    expect(decodeSzd(badMeta)).toEqual(doc);
  });
});
