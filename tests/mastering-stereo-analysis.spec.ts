import { describe, expect, it } from 'vitest';
import { parseMonoCompatibility } from '@/ui/mastering/stereo-analysis';

describe('parseMonoCompatibility', () => {
  it('parses the mono compatibility fields returned by libsonare', () => {
    expect(
      parseMonoCompatibility(
        JSON.stringify({
          correlation: -0.2,
          monoCompatWidth: 1.4,
          monoCompatPeak: -1.5,
          likelyMonoCompatible: false,
        }),
      ),
    ).toEqual({
      correlation: -0.2,
      width: 1.4,
      monoPeakDb: -1.5,
      compatible: false,
    });
  });

  it('tolerates malformed payloads', () => {
    expect(parseMonoCompatibility('not json')).toBeNull();
    expect(parseMonoCompatibility('[]')).toEqual({
      correlation: 0,
      width: 0,
      monoPeakDb: Number.NEGATIVE_INFINITY,
      compatible: false,
    });
  });
});
