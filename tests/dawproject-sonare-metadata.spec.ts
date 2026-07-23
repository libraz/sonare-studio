import { describe, expect, it } from 'vitest';
import {
  MAX_SONARE_DAWPROJECT_METADATA_BYTES,
  parseSonareDawprojectMetadata,
} from '@/export/dawproject/sonare-metadata';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('Sonare DAWproject metadata limits', () => {
  it('drops an oversized vendor entry before decoding or parsing it', () => {
    const bytes = new Uint8Array(MAX_SONARE_DAWPROJECT_METADATA_BYTES + 1);
    expect(parseSonareDawprojectMetadata(bytes)).toEqual({ schemaVersion: 1 });
  });

  it('bounds metadata maps and untrusted string fields', () => {
    const tracks = Object.fromEntries(
      Array.from({ length: 4100 }, (_, index) => [`track-${index}`, { kind: 'aux' }]),
    );
    const metadata = parseSonareDawprojectMetadata(
      encode({
        schemaVersion: 1,
        tracks,
        vcaGroups: [{ id: 'x'.repeat(1025), name: 'too long' }],
      }),
    );

    expect(Object.keys(metadata.tracks ?? {})).toHaveLength(4096);
    expect(metadata.vcaGroups).toBeUndefined();
  });
});
