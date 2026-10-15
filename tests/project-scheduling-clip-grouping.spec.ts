import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { scheduleProjectClips } from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorTrack } from '@/project/types';

function makeTrack(id: number): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#60a5fa',
    kind: 'audio',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
  };
}

function makeClip(id: number, trackId: number, counter: { reads: number }): EditorClip {
  const clip: EditorClip = {
    id,
    trackId,
    name: `Clip ${id}`,
    startPpq: id,
    lengthPpq: 1,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    kind: 'audio',
    assetId: 'asset-x',
  };
  Object.defineProperty(clip, 'trackId', {
    enumerable: true,
    get() {
      counter.reads++;
      return trackId;
    },
  });
  return clip;
}

describe('scheduleProjectClips clip lookup', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('reads each clip track once regardless of the track count', async () => {
    const store = useProjectStore();
    store.tempoBpm = 120;
    const counter = { reads: 0 };
    store.tracks = [1, 2, 3, 4, 5, 6, 7, 8].map(makeTrack);
    store.clips = [10, 11, 12].map((id, index) => makeClip(id, index + 1, counter));
    let nextId = 500;
    const handle = {
      ctx: { sampleRate: 10 },
      engine: {
        addClip: vi.fn(() => nextId++),
        removeClip: vi.fn(),
        setWarpVoiceCapacity: vi.fn(),
      },
    } as unknown as EngineHandle;
    const asset: LoadedAudioAsset = {
      meta: { id: 'asset-x', name: 'A', sampleRate: 10, numChannels: 1, numFrames: 10 },
      channels: [new Float32Array(10)],
    };

    const scheduled = await scheduleProjectClips(handle, { loadAudioAsset: async () => asset });

    expect(scheduled.map((s) => [s.clipId, s.trackId])).toEqual([
      [10, 1],
      [11, 2],
      [12, 3],
    ]);
    // A constant number of reads per clip; a per-track scan would add one per track per clip.
    expect(counter.reads).toBeLessThanOrEqual(3 * 3);
  });
});
