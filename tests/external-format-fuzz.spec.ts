import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportDawproject, importDawproject } from '@/export/dawproject';
import type { NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { importMusicXml } from '@/notation/musicxml-import';
import { restoreBrowserBackup } from '@/persistence/backup';
import { decodeSzd, encodeSzd } from '@/persistence/szd';
import type { ProjectDocument } from '@/project/serialization';
import { projectDocumentToSmf, smfToProjectDocument } from '@/project/smf';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const wasm = await import('@/wasm/index.js');
  let module: typeof wasm | null = null;
  return {
    ensureWasm: async () => {
      if (!module) {
        const wasmBinary = readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`);
        await wasm.init({ wasmBinary } as Parameters<typeof wasm.init>[0]);
        module = wasm;
      }
      return module;
    },
  };
});

const MAX_FUZZ_INPUT_BYTES = 256 * 1024;
const MUTATIONS_PER_FORMAT = 24;

function projectFixture(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'External fuzz seed',
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
        volume: 1,
        pan: 0,
        clips: [
          {
            name: 'Loop',
            kind: 'midi',
            startPpq: 0,
            lengthPpq: 8,
            sourceOffsetPpq: 0,
            loopEnabled: true,
            loopLengthPpq: 4,
            gain: 1,
            notes: [
              { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
              { pitch: 36, velocity: 110, startPpq: 2, durationPpq: 0.5, channel: 9 },
            ],
          },
        ],
      },
    ],
    markers: [],
    sections: [],
  };
}

function scoreFixture(): NotatedScore {
  return {
    title: 'MusicXML fuzz seed',
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
            lengthPpq: 1,
            timeSig: { beats: 4, beatUnit: 4 },
            implicit: true,
            voices: [
              {
                voice: 1,
                events: [
                  {
                    kind: 'note',
                    pitches: [60],
                    voice: 1,
                    startPpq: 0,
                    durationPpq: 1,
                    value: { base: 'quarter', dots: 0 },
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

/** Deterministic, size-capped structural and byte mutations shared by every format. */
function boundedCorpus(seed: Uint8Array): Uint8Array[] {
  if (seed.byteLength > MAX_FUZZ_INPUT_BYTES) throw new Error('Fuzz seed exceeds corpus cap');
  const corpus = [seed];
  let state = 0x6d2b79f5;
  const random = (): number => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  for (let index = 0; index < MUTATIONS_PER_FORMAT; index += 1) {
    const mode = index % 4;
    let bytes: Uint8Array;
    if (mode === 0) {
      bytes = seed.slice(0, Math.floor(seed.length * random()));
    } else if (mode === 1) {
      bytes = seed.slice();
      const flips = Math.max(1, Math.min(16, bytes.length));
      for (let flip = 0; flip < flips; flip += 1) {
        const offset = Math.floor(random() * Math.max(1, bytes.length));
        if (bytes.length > 0) bytes[offset] ^= 1 << (flip % 8);
      }
    } else if (mode === 2) {
      const suffixLength = Math.min(1024, MAX_FUZZ_INPUT_BYTES - seed.length);
      bytes = new Uint8Array(seed.length + suffixLength);
      bytes.set(seed);
      for (let offset = seed.length; offset < bytes.length; offset += 1) {
        bytes[offset] = Math.floor(random() * 256);
      }
    } else {
      const length = Math.min(MAX_FUZZ_INPUT_BYTES, Math.max(1, seed.length));
      bytes = new Uint8Array(length);
      for (let offset = 0; offset < bytes.length; offset += 1) {
        bytes[offset] = Math.floor(random() * 256);
      }
    }
    if (bytes.byteLength > MAX_FUZZ_INPUT_BYTES) {
      throw new Error(`Generated fuzz input exceeds ${MAX_FUZZ_INPUT_BYTES} bytes`);
    }
    corpus.push(bytes);
  }
  return corpus;
}

async function exerciseCorpus(
  seed: Uint8Array,
  parse: (bytes: Uint8Array) => unknown | Promise<unknown>,
): Promise<void> {
  const corpus = boundedCorpus(seed);
  expect(corpus).toHaveLength(MUTATIONS_PER_FORMAT + 1);
  expect(Math.max(...corpus.map((bytes) => bytes.byteLength))).toBeLessThanOrEqual(
    MAX_FUZZ_INPUT_BYTES,
  );
  for (const bytes of corpus) {
    try {
      await parse(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  }
}

describe('bounded external-format fuzz corpus', () => {
  beforeAll(() => installMockOpfs());
  afterAll(() => uninstallMockOpfs());

  it('keeps .szd and browser-backup mutations inside the resource cap', async () => {
    const doc = projectFixture();
    await exerciseCorpus(encodeSzd(doc), (bytes) => decodeSzd(bytes));
    const backup = zipSync({
      'meta.json': strToU8(
        JSON.stringify({
          app: 'sonare-studio',
          kind: 'browser-backup',
          version: 1,
          savedAt: '2026-07-15T00:00:00.000Z',
          projects: 0,
          assets: 0,
          fonts: 0,
        }),
      ),
    });
    await exerciseCorpus(backup, (bytes) => restoreBrowserBackup(bytes));
  });

  it('keeps DAWproject and SMF mutations inside the resource cap', async () => {
    const doc = projectFixture();
    await exerciseCorpus(await exportDawproject(doc, { includeAudio: false }), (bytes) =>
      importDawproject(bytes),
    );
    await exerciseCorpus(await projectDocumentToSmf(doc), (bytes) => smfToProjectDocument(bytes));
  });

  it('keeps MusicXML mutations inside byte/element/depth limits', async () => {
    const seed = new TextEncoder().encode(serializeMusicXml(scoreFixture()));
    await exerciseCorpus(seed, (bytes) =>
      importMusicXml(new TextDecoder().decode(bytes), 'fuzz.musicxml'),
    );
  });
});
