import { describe, expect, it } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { renderAudibleAudioClipWindow } from '@/project/audio-clip-render';

/** A 10 Hz stereo ramp, so each PPQ at 60 BPM is ten distinct frames. */
function rampAsset(frames: number): LoadedAudioAsset {
  const left = Float32Array.from({ length: frames }, (_, frame) => frame + 1);
  const right = Float32Array.from({ length: frames }, (_, frame) => -(frame + 1));
  return {
    meta: { id: 'ramp', name: 'Ramp', sampleRate: 10, numChannels: 2, numFrames: frames },
    channels: [left, right],
  };
}

describe('renderAudibleAudioClipWindow', () => {
  const asset = rampAsset(40);
  const load = async () => asset;
  // Looped, offset and faded, so every seam the window can cut is exercised.
  const clip = {
    assetId: 'ramp',
    startPpq: 2,
    lengthPpq: 9,
    sourceOffsetPpq: 1,
    loopEnabled: true,
    loopLengthPpq: 3,
    fadeInPpq: 0.5,
    fadeOutPpq: 0.7,
  };

  it('renders a frame window identical to the same frames of the whole clip', async () => {
    const whole = await renderAudibleAudioClipWindow(clip, 60, load);
    expect(whole?.channels[0]).toHaveLength(90);
    const pieces: Float32Array[][] = [];
    for (let startFrame = 0; startFrame < 90; startFrame += 17) {
      const piece = await renderAudibleAudioClipWindow(clip, 60, load, {
        window: { startFrame, frameCount: 17 },
      });
      pieces.push(piece?.channels ?? []);
    }
    for (const channel of [0, 1]) {
      const joined = Float32Array.from(pieces.flatMap((piece) => [...piece[channel]]));
      expect(joined).toEqual(whole?.channels[channel]);
    }
  });

  it('clamps a window running past the clip end', async () => {
    const tail = await renderAudibleAudioClipWindow(clip, 60, load, {
      window: { startFrame: 80, frameCount: 50 },
    });
    expect(tail?.channels[0]).toHaveLength(10);
  });
});
