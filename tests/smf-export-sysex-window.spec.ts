import { describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '@/project/serialization';
import { projectDocumentToSmf } from '@/project/smf';
import { extractSmfSysEx } from '@/project/smf-import';
import { coreWasmBinary } from './core-package';

vi.mock('@/lib/wasm', async () => {
  const wasm = await import('@libraz/libsonare');
  let module: typeof wasm | null = null;
  return {
    ensureWasm: async () => {
      if (!module) {
        await wasm.init({ wasmBinary: coreWasmBinary() } as Parameters<typeof wasm.init>[0]);
        module = wasm;
      }
      return module;
    },
  };
});

function docWithSysEx(ppqs: number[]): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'SysEx',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Synth',
        kind: 'midi',
        clips: [
          {
            name: 'Clip',
            startPpq: 8,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            notes: [],
            smfSysEx: ppqs.map((ppq) => ({ ppq, status: 0xf0, data: [0x41, 0x10, 0x42] })),
          },
        ],
      } as ProjectDocument['tracks'][number],
    ],
    markers: [],
    sections: [],
  };
}

describe('SMF export SysEx window', () => {
  it('writes only packets that fall inside the clip', async () => {
    const exported = await projectDocumentToSmf(docWithSysEx([1, 3.5, 4, 9]));

    expect(extractSmfSysEx(exported).map((packet) => packet.ppq)).toEqual([9, 11.5]);
  });
});
