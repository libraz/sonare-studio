import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportDawproject, importDawproject } from '@/export/dawproject';
import type { NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { importMusicXmlWithReport } from '@/notation/musicxml-import';
import type { ProjectDocument } from '@/project/serialization';
import { documentClip } from './fakes/project';

const ENABLED = process.env.EXTERNAL_VALIDATORS === '1';
const NOTATION_CLI_BIN = process.env.NOTATION_CLI_BIN?.trim();
const MUSICXML_RELEASE_URL =
  'https://github.com/w3c/musicxml/releases/download/v4.0/musicxml-4.0.zip';
const MUSICXML_RELEASE_SHA256 = '4c815790c6cdcceef6b5c6a3c17b7229f52c2754eb31b61a63d30f60ef41acbc';
const DAWPROJECT_REVISION = 'ee4dcdde75940f30e14e55401a26955a58b8322b';
const DAWPROJECT_SCHEMAS = {
  Project: {
    sha256: '58e2fd9864772850aac3eab1f3de8693857dc5384df6d29fbc320ae1de2347cc',
  },
  MetaData: {
    sha256: 'fb3ba378271770dddbcced8990aba537de3d36ff2d58573523460a699221c99f',
  },
} as const;
const DAWPROJECT_README_SHA256 = 'd2a501c0315f128deff7e367ed1ee68b3ec0ef88f3f36d0cd4ca2d2c03f2a8f0';
const DAWPROJECT_APP_FIXTURE = process.env.DAWPROJECT_APP_FIXTURE?.trim();

let workDir = '';
let musicXmlSchemaDir = '';
let dawprojectSchemaDir = '';
let referenceProjectXml = '';

async function fetchPinned(url: string, expectedSha256: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to download validator source: ${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(
      `Validator checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`,
    );
  }
  return bytes;
}

function write(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function validateXml(schema: string, xml: string, name: string): void {
  const xmlPath = join(workDir, name);
  write(xmlPath, xml);
  execFileSync('xmllint', ['--nonet', '--noout', '--schema', schema, xmlPath], {
    env: {
      ...process.env,
      XML_CATALOG_FILES: join(musicXmlSchemaDir, 'catalog.xml'),
    },
    stdio: 'pipe',
  });
}

function scoreFixture(): NotatedScore {
  return {
    metadata: { title: 'Validator & Roundtrip' },
    divisions: 960,
    keyFifths: 0,
    parts: [
      {
        id: 'P1',
        name: 'Piano',
        clef: 'treble',
        measures: [
          {
            index: 0,
            startPpq: 0,
            lengthPpq: 4,
            timeSig: { beats: 4, beatUnit: 4 },
            voices: [
              {
                voice: 1,
                events: [
                  {
                    kind: 'note',
                    pitches: [60],
                    voice: 1,
                    startPpq: 0,
                    durationPpq: 4,
                    value: { base: 'whole', dots: 0 },
                    tieStart: false,
                    tieStop: false,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Representative engraved score: grand staff, two voices, chords, and ties. */
function richScoreFixture(): NotatedScore {
  const quarter = { base: 'quarter' as const, dots: 0 };
  const half = { base: 'half' as const, dots: 0 };
  const whole = { base: 'whole' as const, dots: 0 };
  return {
    metadata: { title: 'Validator rich score' },
    divisions: 960,
    keyFifths: 1,
    chordSymbols: [
      { ppq: 0, text: 'G', rootPc: 7, quality: 0 },
      { ppq: 2, text: 'Cmaj7', rootPc: 0, quality: 5 },
      { ppq: 4, text: 'D/F#', rootPc: 2, quality: 0, bassPc: 6 },
    ],
    parts: [
      {
        id: 'P1',
        name: 'Piano',
        clef: 'grand',
        measures: [
          {
            index: 0,
            startPpq: 0,
            lengthPpq: 4,
            timeSig: { beats: 4, beatUnit: 4 },
            voices: [
              {
                voice: 1,
                events: [
                  {
                    kind: 'note',
                    pitches: [67, 71],
                    voice: 1,
                    startPpq: 0,
                    durationPpq: 1,
                    value: quarter,
                    tieStart: false,
                    tieStop: false,
                  },
                  {
                    kind: 'note',
                    pitches: [71],
                    voice: 1,
                    startPpq: 1,
                    durationPpq: 1,
                    value: quarter,
                    tieStart: false,
                    tieStop: false,
                  },
                  {
                    kind: 'note',
                    pitches: [74],
                    voice: 1,
                    startPpq: 2,
                    durationPpq: 2,
                    value: half,
                    tieStart: true,
                    tieStop: false,
                  },
                ],
              },
              {
                voice: 2,
                events: [
                  {
                    kind: 'note',
                    pitches: [48],
                    voice: 2,
                    startPpq: 0,
                    durationPpq: 2,
                    value: half,
                    tieStart: false,
                    tieStop: false,
                  },
                  {
                    kind: 'rest',
                    pitches: [],
                    voice: 2,
                    startPpq: 2,
                    durationPpq: 2,
                    value: half,
                    tieStart: false,
                    tieStop: false,
                  },
                ],
              },
            ],
          },
          {
            index: 1,
            startPpq: 4,
            lengthPpq: 4,
            timeSig: { beats: 4, beatUnit: 4 },
            voices: [
              {
                voice: 1,
                events: [
                  {
                    kind: 'note',
                    pitches: [74],
                    voice: 1,
                    startPpq: 4,
                    durationPpq: 2,
                    value: half,
                    tieStart: false,
                    tieStop: true,
                  },
                  {
                    kind: 'rest',
                    pitches: [],
                    voice: 1,
                    startPpq: 6,
                    durationPpq: 2,
                    value: half,
                    tieStart: false,
                    tieStop: false,
                  },
                ],
              },
              {
                voice: 2,
                events: [
                  {
                    kind: 'rest',
                    pitches: [],
                    voice: 2,
                    startPpq: 4,
                    durationPpq: 4,
                    value: whole,
                    tieStart: false,
                    tieStop: false,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function projectFixture(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Validator & Roundtrip',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Keys',
        color: '#60a5fa',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 0.75,
        pan: 0,
        clips: [
          documentClip({
            name: 'Phrase',
            kind: 'midi',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            notes: [{ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          }),
        ],
      },
    ],
    markers: [],
    sections: [],
  };
}

describe('rich external-format fixtures', () => {
  it('serializes the multi-voice MusicXML fixture before the networked schema gate', () => {
    const document = new DOMParser().parseFromString(
      serializeMusicXml(richScoreFixture()),
      'text/xml',
    );

    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.querySelectorAll('part > measure')).toHaveLength(2);
    expect(document.querySelectorAll('note chord')).toHaveLength(1);
    expect(document.querySelectorAll('tie[type="start"]')).toHaveLength(1);
    expect(document.querySelectorAll('tie[type="stop"]')).toHaveLength(1);
    expect(document.querySelectorAll('harmony')).toHaveLength(3);
  });
});

describe.skipIf(!ENABLED)('external format schema release gate', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'sonare-external-validators-'));
    musicXmlSchemaDir = join(workDir, 'musicxml-schema');
    const release = unzipSync(await fetchPinned(MUSICXML_RELEASE_URL, MUSICXML_RELEASE_SHA256));
    for (const [name, bytes] of Object.entries(release)) {
      if (!name.startsWith('schema/') || name.endsWith('/')) continue;
      write(join(musicXmlSchemaDir, name.slice('schema/'.length)), bytes);
    }

    dawprojectSchemaDir = join(workDir, 'dawproject-schema');
    for (const [name, expected] of Object.entries(DAWPROJECT_SCHEMAS)) {
      const url = `https://raw.githubusercontent.com/bitwig/dawproject/${DAWPROJECT_REVISION}/${name}.xsd`;
      write(join(dawprojectSchemaDir, `${name}.xsd`), await fetchPinned(url, expected.sha256));
    }
    const readmeUrl = `https://raw.githubusercontent.com/bitwig/dawproject/${DAWPROJECT_REVISION}/README.md`;
    const readme = new TextDecoder().decode(await fetchPinned(readmeUrl, DAWPROJECT_README_SHA256));
    referenceProjectXml = readme.match(/```xml\s+([\s\S]*?)\s+```/)?.[1] ?? '';
    if (!referenceProjectXml.startsWith('<?xml') || !referenceProjectXml.endsWith('</Project>')) {
      throw new Error('Pinned DAWproject reference project could not be extracted from README.md');
    }
  }, 30_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('validates current MusicXML output against the pinned W3C 4.0 XSD and DTD', () => {
    const xml = serializeMusicXml(scoreFixture());
    validateXml(join(musicXmlSchemaDir, 'musicxml.xsd'), xml, 'score.musicxml');
    const xmlPath = join(workDir, 'score.musicxml');
    expect(() =>
      execFileSync('xmllint', ['--nonet', '--noout', '--valid', xmlPath], {
        env: {
          ...process.env,
          XML_CATALOG_FILES: join(musicXmlSchemaDir, 'catalog.xml'),
        },
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('validates rich multi-voice MusicXML against the pinned W3C 4.0 XSD and DTD', () => {
    const xml = serializeMusicXml(richScoreFixture());
    validateXml(join(musicXmlSchemaDir, 'musicxml.xsd'), xml, 'rich-score.musicxml');
    const xmlPath = join(workDir, 'rich-score.musicxml');
    expect(() =>
      execFileSync('xmllint', ['--nonet', '--noout', '--valid', xmlPath], {
        env: {
          ...process.env,
          XML_CATALOG_FILES: join(musicXmlSchemaDir, 'catalog.xml'),
        },
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('validates current project and metadata XML against pinned DAWproject schemas', async () => {
    const archive = unzipSync(await exportDawproject(projectFixture(), { includeAudio: false }));
    const projectXml = archive['project.xml'];
    const metadataXml = archive['metadata.xml'];
    expect(projectXml).toBeDefined();
    expect(metadataXml).toBeDefined();
    validateXml(join(dawprojectSchemaDir, 'Project.xsd'), strFromU8(projectXml), 'project.xml');
    validateXml(join(dawprojectSchemaDir, 'MetaData.xsd'), strFromU8(metadataXml), 'metadata.xml');
  });

  it('imports and semantically round-trips the pinned DAWproject reference project', async () => {
    validateXml(
      join(dawprojectSchemaDir, 'Project.xsd'),
      referenceProjectXml,
      'dawproject-reference.xml',
    );
    const imported = importDawproject(zipSync({ 'project.xml': strToU8(referenceProjectXml) }));
    expect(imported.name).toBe(referenceProjectXml.match(/<Application name="([^"]+)"/)?.[1]);
    expect(imported.tracks.some((track) => track.kind === 'midi')).toBe(true);
    expect(imported.tracks.some((track) => track.kind === 'audio')).toBe(true);
    expect(
      imported.tracks.flatMap((track) => track.clips).flatMap((clip) => clip.notes).length,
    ).toBe(9);

    const reimported = importDawproject(await exportDawproject(imported, { includeAudio: false }));
    expect(reimported.tracks.map((track) => [track.name, track.kind])).toEqual(
      imported.tracks.map((track) => [track.name, track.kind]),
    );
    expect(reimported.tracks.flatMap((track) => track.clips).flatMap((clip) => clip.notes)).toEqual(
      imported.tracks.flatMap((track) => track.clips).flatMap((clip) => clip.notes),
    );
  });

  it.skipIf(!DAWPROJECT_APP_FIXTURE)(
    'round-trips a configured application-exported DAWproject fixture through Sonare',
    async () => {
      const source = new Uint8Array(readFileSync(DAWPROJECT_APP_FIXTURE as string));
      const imported = importDawproject(source);
      const reimported = importDawproject(
        await exportDawproject(imported, { includeAudio: false }),
      );
      expect(
        reimported.tracks.map((track) => [track.name, track.kind, track.clips.length]),
      ).toEqual(imported.tracks.map((track) => [track.name, track.kind, track.clips.length]));
    },
  );

  it.skipIf(!NOTATION_CLI_BIN)(
    'round-trips the current MusicXML fixture through the configured notation CLI',
    () => {
      const input = join(workDir, 'notation-cli-input.musicxml');
      const output = join(workDir, 'notation-cli-output.musicxml');
      write(input, serializeMusicXml(scoreFixture()));
      execFileSync(NOTATION_CLI_BIN as string, ['-o', output, input], { stdio: 'pipe' });
      const roundTripped = readFileSync(output, 'utf8');
      validateXml(
        join(musicXmlSchemaDir, 'musicxml.xsd'),
        roundTripped,
        'notation-cli-validated.musicxml',
      );
      const imported = importMusicXmlWithReport(roundTripped, 'notation-cli-output.musicxml');
      expect(imported.document.tracks).toHaveLength(1);
      expect(imported.document.tracks[0].clips[0].notes).toHaveLength(1);
      expect(imported.report.entries).toEqual([]);
    },
  );
});
