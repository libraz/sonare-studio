import { describe, expect, it } from 'vitest';
import { audioFileMetadataForDocument } from '@/export/audio-file-metadata';
import type { ProjectDocument } from '@/project/serialization';

function document(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Delivery',
    sampleRate: 48_000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    tracks: [],
    markers: [{ ppq: 4, name: 'Drop' }],
    sections: [{ startPpq: 8, endPpq: 12, name: 'Verse', color: '#123456' }],
  };
}

describe('audioFileMetadataForDocument', () => {
  it('rebases project markers and sections to the rendered range', () => {
    const metadata = audioFileMetadataForDocument(document(), {
      sampleRate: 48_000,
      startPpq: 2,
      endPpq: 10,
      now: new Date('2026-08-05T03:04:05Z'),
    });
    expect(metadata).toMatchObject({
      title: 'Delivery',
      originator: 'Sonare Studio',
      timeReference: 0,
      markers: [
        { sampleOffset: 48_000, name: 'Drop' },
        { sampleOffset: 144_000, name: 'Section: Verse' },
      ],
    });
  });
});
