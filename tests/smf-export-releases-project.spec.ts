import { describe, expect, it, vi } from 'vitest';
import { ensureWasm } from '@/lib/wasm';
import type { ProjectDocument } from '@/project/serialization';
import { projectDocumentToSmf } from '@/project/smf';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('SMF export native project lifetime', () => {
  it('destroys the native project when building it throws', async () => {
    const wasm = await ensureWasm();
    const destroy = vi.spyOn(wasm.Project.prototype, 'destroy');
    const doc: ProjectDocument = {
      schemaVersion: 3,
      name: 'Ramp',
      sampleRate: 48000,
      tempoSegments: [
        { startPpq: 0, bpm: 20, endBpm: 1000 },
        { startPpq: 4, bpm: 1000 },
      ],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [],
      markers: [],
      sections: [],
    };
    try {
      await expect(projectDocumentToSmf(doc)).rejects.toThrow(RangeError);
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      destroy.mockRestore();
    }
  });
});
