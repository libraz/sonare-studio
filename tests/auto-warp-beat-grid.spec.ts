import { describe, expect, it, vi } from 'vitest';
import { effectScope, reactive } from 'vue';
import { clipSourceWindowFrames } from '@/project/audible-clip-window';
import type { ClipWarp } from '@/project/types';
import { warpSourceSecondsAt } from '@/project/warp';
import { useSampleWarp } from '@/ui/sample-editor/use-sample-warp';
import { segmentStretchRatios } from '@/ui/sample-editor/warp-controls';

const setClipWarp = vi.hoisted(() => vi.fn());

vi.mock('@/project/commands', () => ({
  setClipWarp: (...args: unknown[]) => setClipWarp(...args),
}));

const SAMPLE_RATE = 1000;

function audioClip(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    kind: 'audio',
    assetId: 'asset-1',
    startPpq: 0,
    lengthPpq: 8,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    trackId: 1,
    ...overrides,
  };
}

function silentAsset(seconds: number) {
  const frames = seconds * SAMPLE_RATE;
  return {
    meta: {
      id: 'asset-1',
      name: 'a.wav',
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      numFrames: frames,
    },
    channels: [new Float32Array(frames)],
  };
}

describe('clip source window', () => {
  it('covers one loop pass of a looping clip', () => {
    // 120 BPM: 4 PPQ is 2 s, i.e. 2000 frames from a 2 PPQ (1 s) source offset.
    const window = clipSourceWindowFrames(
      { startPpq: 8, lengthPpq: 16, sourceOffsetPpq: 2, loopEnabled: true, loopLengthPpq: 4 },
      20 * SAMPLE_RATE,
      SAMPLE_RATE,
      120,
      [],
    );
    expect(window).toEqual({ start: 1000, end: 3000 });
  });
});

describe('Auto-Warp beat grid', () => {
  it('starts the warp on the first beat so every segment stretches alike', async () => {
    setClipWarp.mockClear();
    const project = reactive({
      clips: [audioClip()],
      clipId: 7,
      tempoBpm: 120,
      tempoSegments: [],
    });
    // Source at 100 BPM (0.6 s beats) whose first beat sits 0.3 s into the window.
    const beats = Array.from({ length: 7 }, (_, k) => 0.3 + 0.6 * k);
    const scope = effectScope();
    const errors: string[] = [];
    const warp = scope.run(() =>
      useSampleWarp({
        project: project as never,
        assetId: () => 'asset-1',
        setError: (message) => errors.push(message),
        autoWarp: {
          loadAudioAsset: async () => silentAsset(10) as never,
          detectBeats: () => beats,
        },
      }),
    );
    if (!warp) throw new Error('effect scope did not run');

    await warp.onAutoWarp();

    expect(errors).toEqual([]);
    const committed = setClipWarp.mock.calls[0]?.[1] as ClipWarp;
    expect(committed.sourceStartSeconds).toBeCloseTo(0.3, 9);
    expect(committed.sourceEndSeconds).toBeCloseTo(0.3 + 8 * 0.6, 9);
    const warped = { ...audioClip(), warp: committed };
    const ratios = segmentStretchRatios(warped, 120);
    expect(ratios.length).toBeGreaterThan(1);
    for (const ratio of ratios) expect(ratio).toBeCloseTo(1.2, 6);
    for (let k = 0; k <= 8; k++) {
      expect(warpSourceSecondsAt(warped, k)).toBeCloseTo(0.3 + 0.6 * k, 6);
    }
    scope.stop();
  });
});
