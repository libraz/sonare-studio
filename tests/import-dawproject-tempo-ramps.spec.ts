import { describe, expect, it } from 'vitest';
import { exportDawproject, importDawproject } from '@/export/dawproject';
import type { ProjectDocument } from '@/project/serialization';

describe('DAWproject tempo ramp import', () => {
  it('links each ramp to the next tempo without rescanning the point list', async () => {
    const tempoSegments = Array.from({ length: 300 }, (_, i) => ({
      startPpq: i * 4,
      bpm: 100 + (i % 50),
      endBpm: 100 + ((i + 1) % 50),
    }));
    const doc: ProjectDocument = {
      schemaVersion: 3,
      name: 'Ramps',
      sampleRate: 48000,
      tempoSegments,
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [],
      markers: [],
      sections: [],
    };
    const bytes = await exportDawproject(doc, { includeAudio: false });

    const original = Array.prototype.find;
    let finds = 0;
    Array.prototype.find = function (this: unknown[], ...args: Parameters<typeof original>) {
      finds += 1;
      return original.apply(this, args);
    } as typeof original;
    let imported: ProjectDocument;
    try {
      imported = importDawproject(bytes);
    } finally {
      Array.prototype.find = original;
    }

    expect(imported.tempoSegments).toHaveLength(300);
    expect(imported.tempoSegments[0]).toMatchObject({ startPpq: 0, bpm: 100, endBpm: 101 });
    expect(imported.tempoSegments[299]?.endBpm).toBeUndefined();
    expect(finds).toBeLessThan(100);
  });
});
