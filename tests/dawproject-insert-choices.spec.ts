import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportDawproject, importDawproject } from '@/export/dawproject';
import { setWasmModule } from '@/project/runtime';
import type { ProjectDocument } from '@/project/serialization';
import * as core from '@/wasm/index.js';

beforeAll(async () => {
  await core.init({ wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`) });
  setWasmModule(core);
});

function docWithCompressor(params: Record<string, number | boolean | string>): ProjectDocument {
  return {
    schemaVersion: 5,
    name: 'Choices',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Vox',
        color: '#60a5fa',
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips: [],
        mixer: {
          gainDb: 0,
          pan: 0,
          sends: [],
          inserts: [{ processor: 'dynamics.compressor', params, enabled: true }],
        },
      },
    ],
    markers: [],
    sections: [],
  };
}

describe('DAWproject closed-set insert params', () => {
  it('writes a choice name as an EnumParameter over the catalog choices', async () => {
    const entries = unzipSync(
      await exportDawproject(docWithCompressor({ detector: 'rms' }), { includeAudio: false }),
    );
    const xml = new DOMParser().parseFromString(
      strFromU8(entries['project.xml']),
      'application/xml',
    );
    const parameter = xml.querySelector('BuiltinDevice EnumParameter[name="detector"]');
    expect(parameter?.getAttribute('count')).toBe('3');
    expect(parameter?.getAttribute('labels')).toBe('peak rms logRms');
    expect(parameter?.getAttribute('value')).toBe('1');
  });

  it('reads the choice name back from the EnumParameter', async () => {
    const exported = await exportDawproject(docWithCompressor({ detector: 'logRms', ratio: 4 }), {
      includeAudio: false,
    });
    const imported = importDawproject(exported);
    expect(imported.tracks[0].mixer?.inserts[0].params).toEqual({ detector: 'logRms', ratio: 4 });
  });
});
