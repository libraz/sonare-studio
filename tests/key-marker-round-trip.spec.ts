import { describe, expect, it, vi } from 'vitest';
import type { NotatedMeasure, NotatedScore } from '@/notation/model';
import type { ProjectDocument } from '@/project/serialization';
import { projectDocumentToSmf } from '@/project/smf';
import { smfToProjectDocument } from '@/project/smf-import';
import {
  SCORE_KEY_MODES,
  SCORE_KEY_ROOTS,
  type ScoreKeyMode,
  type ScoreKeyRoot,
  scoreKeyMarkerName,
} from '@/ui/score/marker-editors';
import { applyKeySignatureMarks, transposeKeyFifths } from '@/ui/score/use-score-notation';
import { coreWasmBinary } from './core-package';

vi.mock('@/lib/wasm', async () => {
  const wasm = await import('@libraz/libsonare');
  let module: typeof wasm | null = null;
  return {
    ensureWasm: async () => {
      if (!module) {
        const wasmBinary = coreWasmBinary();
        await wasm.init({ wasmBinary } as Parameters<typeof wasm.init>[0]);
        module = wasm;
      }
      return module;
    },
  };
});

function documentWithMarkers(names: readonly string[]): ProjectDocument {
  return {
    schemaVersion: 1,
    name: 'keys',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Lead',
        color: '#60a5fa',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 0.8,
        pan: 0,
        instrument: { kind: 'synth-preset', preset: 'acousticPiano' },
        clips: [
          {
            name: 'Lead',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            kind: 'midi',
            notes: [{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
          },
        ],
      },
    ],
    markers: names.map((name, index) => ({ ppq: index, name })),
    sections: [],
  };
}

/** Every `FF 59 02 sf mi` key-signature meta event in an SMF byte stream. */
function keySignatureMetas(bytes: Uint8Array): Array<{ fifths: number; minor: boolean }> {
  const metas: Array<{ fifths: number; minor: boolean }> = [];
  for (let index = 0; index + 4 < bytes.length; index += 1) {
    if (bytes[index] !== 0xff || bytes[index + 1] !== 0x59 || bytes[index + 2] !== 0x02) continue;
    const sf = bytes[index + 3];
    metas.push({ fifths: sf > 127 ? sf - 256 : sf, minor: bytes[index + 4] === 1 });
  }
  return metas;
}

async function exportedKeySignature(
  name: string,
): Promise<{ fifths: number; minor: boolean } | undefined> {
  const metas = keySignatureMetas(await projectDocumentToSmf(documentWithMarkers([name])));
  return metas.length === 1 ? metas[0] : undefined;
}

function measure(index: number): NotatedMeasure {
  return {
    index,
    startPpq: index * 4,
    lengthPpq: 4,
    timeSig: { beats: 4, beatUnit: 4 },
    voices: [{ voice: 1, events: [] }],
  };
}

/** Key fifths the score pipeline engraves for a key marker, or undefined. */
function engravedFifths(name: string): number | undefined {
  const score: NotatedScore = {
    parts: [{ id: 'P1', name: 'Lead', clef: 'treble', measures: [measure(0), measure(1)] }],
    // Out of the engraved -5..+6 range, so every marker registers as a change.
    keyFifths: 99,
    divisions: 960,
  };
  applyKeySignatureMarks(score, [{ id: 1, ppq: 4, name }], 0, 8, 4);
  return score.measureKeyFifths?.[1];
}

function markerNames(): Array<{ root: ScoreKeyRoot; mode: ScoreKeyMode; name: string }> {
  return SCORE_KEY_ROOTS.flatMap((root) =>
    SCORE_KEY_MODES.map((mode) => ({ root, mode, name: scoreKeyMarkerName(root, mode) })),
  );
}

describe('key marker round trip', () => {
  it('exports every key the score toolbar can write as a key signature', async () => {
    for (const { mode, name } of markerNames()) {
      const exported = await exportedKeySignature(name);
      expect(exported, name).toBeDefined();
      expect(exported?.minor, name).toBe(mode === 'minor');
    }
  });

  it('engraves the key the SMF export writes, up to enharmonic spelling', async () => {
    for (const { name } of markerNames()) {
      const exported = await exportedKeySignature(name);
      expect(transposeKeyFifths(exported?.fifths ?? 99, 0), name).toBe(engravedFifths(name));
    }
  });

  it('keeps key markers readable after an SMF round trip', async () => {
    const names = markerNames().map((entry) => entry.name);
    const roundTrip = await smfToProjectDocument(
      await projectDocumentToSmf(documentWithMarkers(names)),
      'keys.mid',
    );

    for (const marker of roundTrip.markers) {
      expect(engravedFifths(marker.name), marker.name).toBeDefined();
    }
  });

  it('exports the eight-flat Db minor marker as its C# minor signature', async () => {
    expect(await exportedKeySignature('Key: Db minor')).toEqual({ fifths: 4, minor: true });
    expect(engravedFifths('Key: Db minor')).toBe(4);
  });
});
