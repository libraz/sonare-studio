import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache } from '@/persistence/assets';
import {
  addAudioClip,
  addAudioTrack,
  addMidiClip,
  addRecordedMidiClip,
  canUndo,
  clearHistory,
  crossfadeClips,
  deleteClip,
  undo,
} from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

type Lane = Array<[number, number]>;

describe('a MIDI recording replaces the recorded range', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  const lane = (): Lane =>
    store.clips
      .filter((clip) => clip.trackId === trackId)
      .map((clip): [number, number] => [clip.startPpq, clip.startPpq + clip.lengthPpq])
      .sort((a, b) => a[0] - b[0]);

  beforeEach(async () => {
    installMockOpfs();
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    clearAudioAssetCache();
    await store.init();
    (getProject() as unknown as { enforceClipLanes(): void }).enforceClipLanes();
    trackId = store.tracks[0].id;
    deleteClip(store.clips[0].id);
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  /** A crossfade on another track: the project now holds an intentional overlap. */
  async function crossfadeElsewhere(): Promise<void> {
    const audioTrack = addAudioTrack();
    const left = await addAudioClip({
      trackId: audioTrack,
      assetId: 'a',
      lengthPpq: 4,
      startPpq: 0,
    });
    const right = await addAudioClip({
      trackId: audioTrack,
      assetId: 'b',
      lengthPpq: 4,
      startPpq: 4,
    });
    crossfadeClips(left, right, { lengthPpq: 1, leftSourceEndPpq: 8 });
    expect(getProject().overlapPolicy).toBe('allow');
  }

  const scenarios: Array<{ name: string; existing: Lane; expected: Lane }> = [
    {
      name: 'a clip covering the range',
      existing: [[0, 12]],
      expected: [
        [0, 4],
        [4, 8],
        [8, 12],
      ],
    },
    {
      name: 'a clip partly in the range',
      existing: [[0, 6]],
      expected: [
        [0, 4],
        [4, 8],
      ],
    },
    { name: 'an empty clip inside the range', existing: [[5, 6]], expected: [[4, 8]] },
  ];

  for (const crossfaded of [false, true]) {
    for (const scenario of scenarios) {
      it(`${crossfaded ? 'after a crossfade on another track, ' : ''}replaces ${scenario.name} in one undo entry`, async () => {
        if (crossfaded) await crossfadeElsewhere();
        for (const [start, end] of scenario.existing) {
          addMidiClip({ trackId, startPpq: start, lengthPpq: end - start });
        }
        clearHistory();

        addRecordedMidiClip({ trackId, startPpq: 4, lengthPpq: 4, notes: [] });

        expect(lane()).toEqual(scenario.expected);
        expect(undo()).toBe(true);
        expect(canUndo()).toBe(false);
        expect(lane()).toEqual(scenario.existing);
      });
    }
  }
});
