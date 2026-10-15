import { describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '@/project/serialization';
import { projectDocumentToSmf } from '@/project/smf';

vi.mock('@/lib/wasm', async () => {
  const [wasm, fs] = await Promise.all([import('@/wasm/index.js'), import('node:fs')]);
  let module: typeof wasm | null = null;
  return {
    ensureWasm: async () => {
      if (!module) {
        const wasmBinary = fs.readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`);
        await wasm.init({ wasmBinary } as Parameters<typeof wasm.init>[0]);
        module = wasm;
      }
      return module;
    },
  };
});

function midiTrack(
  name: string,
  instrument: NonNullable<ProjectDocument['tracks'][number]['instrument']>,
  channels: number[],
  mix: { volume: number; pan: number },
): ProjectDocument['tracks'][number] {
  return {
    name,
    color: '#000',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: mix.volume,
    pan: mix.pan,
    instrument,
    clips: [
      {
        name,
        startPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        gain: 1,
        loopEnabled: false,
        loopLengthPpq: 0,
        kind: 'midi',
        notes: channels.map((channel, index) => ({
          pitch: 40 + index,
          velocity: 100,
          startPpq: index,
          durationPpq: 1,
          channel,
        })),
      },
    ],
  };
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('projectDocumentToSmf channel prelude', () => {
  it('writes volume, pan and bank/program setup per channel in a stable order', async () => {
    const doc: ProjectDocument = {
      schemaVersion: 3,
      name: 'Prelude',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 100 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [
        midiTrack('Bass', { kind: 'synth-preset', preset: 'sub-bass' }, [0, 1, 2], {
          volume: 0.5,
          pan: -0.5,
        }),
        midiTrack('Kit', { kind: 'synth-preset', preset: 'drum-kit' }, [9, 10], {
          volume: 1,
          pan: 0.25,
        }),
        midiTrack(
          'Imported',
          { kind: 'synth-preset', preset: 'organ', gmBank: (120 << 7) | 8, gmProgram: 5 },
          [3, 4],
          { volume: 0.8, pan: 0 },
        ),
        midiTrack('Font', { kind: 'sf2', fontId: 'f', bank: 130, program: 7 }, [5, 6], {
          volume: 1,
          pan: 0,
        }),
      ],
      markers: [],
      sections: [],
    };

    expect(hex(await projectDocumentToSmf(doc))).toBe(
      '4d546864000000060001000501e04d54726b0000001300ff51030927c000ff58040402180800ff2f004d54726b0000004800ff03044261737300c02600c12600c22600b2075a00b20a2000b1075a00b10a2000b0075a00b00a2000902864836080280000912964836081290000922a648360822a0000ff2f004d54726b0000003b00ff03034b697400b9007800ba007800b9200000ba200000c90000ca0000ba0a4f00b90a4f009928648360892800009a296483608a290000ff2f004d54726b0000004000ff0308496d706f7274656400b3007800b4007800b3200800b4200800c30500c40500b4077200b3077200932864836083280000942964836084290000ff2f004d54726b0000003400ff0304466f6e7400b5000100b6000100b5200200b6200200c50700c60700952864836085280000962964836086290000ff2f00',
    );
  });
});
