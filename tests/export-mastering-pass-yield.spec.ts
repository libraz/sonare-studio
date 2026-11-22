import { describe, expect, it } from 'vitest';
import { BLOCKS_PER_CHECKPOINT, RENDER_BLOCK_FRAMES } from '@/export/engine-render-types';
import { runMasteringEnginePass } from '@/export/mastering-automation';
import { FakeRenderEngine } from './fakes/engine';

describe('mastering pass yielding', () => {
  it('yields at the render checkpoint cadence, not once per block', async () => {
    const blocks = BLOCKS_PER_CHECKPOINT * 3 + 5;
    const frames = blocks * RENDER_BLOCK_FRAMES;
    let yields = 0;
    await runMasteringEnginePass(
      { kind: 'engine', latencySamples: 0, slots: [] },
      new Float32Array(frames),
      new Float32Array(frames),
      {
        createEngine: () => new FakeRenderEngine(),
        sampleRate: 48000,
        startSample: 0,
        startPpq: 0,
        tempoSegments: [{ startPpq: 0, bpm: 120 }],
        yieldBetweenBlocks: async () => {
          yields += 1;
        },
      },
    );
    expect(yields).toBe(3);
  });
});
