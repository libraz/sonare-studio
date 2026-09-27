import { describe, expect, it, vi } from 'vitest';
import { renderProjectWithEngine } from '@/export/engine-render';
import {
  assertMasteringBufferWithinLimit,
  MASTERING_FLOAT32_INPUT_ELEMENT_LIMIT,
  MASTERING_STEREO_FRAME_LIMIT,
  MasteringBufferLimitError,
} from '@/export/mastering-limit';
import type { ProjectDocument } from '@/project/serialization';

function limitOptions(
  overrides: Partial<Parameters<typeof assertMasteringBufferWithinLimit>[0]> = {},
) {
  return {
    totalFrames: MASTERING_STEREO_FRAME_LIMIT,
    sampleRate: 48_000,
    includeMasterChain: true,
    usesPreset: false,
    wholeBufferProcessorCount: 1,
    ...overrides,
  };
}

function oversizedDocument(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Oversized master',
    sampleRate: 48_000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    markers: [],
    sections: [],
    mixer: {
      master: { gainDb: 0, pan: 0, inserts: [] },
      buses: [],
      masteringChain: {
        processors: [{ processor: 'repair.declick', params: {}, enabled: true }],
      },
    },
    tracks: [
      {
        name: 'Long MIDI',
        color: '#fff',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips: [
          {
            name: 'Long clip',
            startPpq: 0,
            lengthPpq: 4096,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [],
          },
        ],
      },
    ],
  } as unknown as ProjectDocument;
}

describe('whole-buffer mastering limit', () => {
  it('accepts the exact stereo frame boundary', () => {
    expect(MASTERING_FLOAT32_INPUT_ELEMENT_LIMIT).toBe(64 * 1024 * 1024);
    expect(MASTERING_STEREO_FRAME_LIMIT).toBe(32 * 1024 * 1024);
    expect(() => assertMasteringBufferWithinLimit(limitOptions())).not.toThrow();
  });

  it('rejects only an active whole-buffer mastering path above the boundary', () => {
    expect(() =>
      assertMasteringBufferWithinLimit(
        limitOptions({ totalFrames: MASTERING_STEREO_FRAME_LIMIT + 1 }),
      ),
    ).toThrow(MasteringBufferLimitError);

    expect(() =>
      assertMasteringBufferWithinLimit(
        limitOptions({ totalFrames: MASTERING_STEREO_FRAME_LIMIT + 1, includeMasterChain: false }),
      ),
    ).not.toThrow();
    expect(() =>
      assertMasteringBufferWithinLimit(
        limitOptions({
          totalFrames: MASTERING_STEREO_FRAME_LIMIT + 1,
          wholeBufferProcessorCount: 0,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertMasteringBufferWithinLimit(
        limitOptions({
          totalFrames: MASTERING_STEREO_FRAME_LIMIT + 1,
          usesPreset: true,
          wholeBufferProcessorCount: 0,
        }),
      ),
    ).toThrow(MasteringBufferLimitError);
  });

  it('blocks before an oversized render creates an engine or PCM buffer', async () => {
    const createEngine = vi.fn(() => {
      throw new Error('the render engine must not be created');
    });
    const processStereo = vi.fn();
    await expect(
      renderProjectWithEngine(oversizedDocument(), {
        sampleRate: 48_000,
        releaseTailSeconds: 0,
        createEngine,
        deps: { mastering: { processStereo }, metering: null },
      }),
    ).rejects.toBeInstanceOf(MasteringBufferLimitError);
    expect(createEngine).not.toHaveBeenCalled();
    expect(processStereo).not.toHaveBeenCalled();
  });
});
