import { describe, expect, it, vi } from 'vitest';
import { nextTick, watch } from 'vue';
import { useAutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import {
  type ArrangeClip,
  type ClipInteractionsView,
  useClipInteractions,
} from '@/ui/arrangement/use-clip-interactions';

describe('automation hover', () => {
  it('does not retrigger watchers while hovering the same point', async () => {
    const automation = useAutomationInteractions({
      view: {
        ppqToX: (ppq) => ppq * 10,
        xToPpq: (x) => x / 10,
        sublaneAt: () => ({ trackId: 1, param: 'pan', top: 0, height: 40 }),
      },
      getLanePoints: () => [{ ppq: 1, value: 0, curve: 'linear' }],
      getGridPpq: () => 1,
      commands: { setPoints: vi.fn() },
    });
    const triggered = vi.fn();
    watch(() => automation.hover.value, triggered);
    automation.onPointerMove({ x: 10, y: 20 });
    await nextTick();
    expect(triggered).toHaveBeenCalledTimes(1);
    automation.onPointerMove({ x: 11, y: 20 });
    automation.onPointerMove({ x: 10, y: 21 });
    await nextTick();
    expect(triggered).toHaveBeenCalledTimes(1);
  });
});

describe('clip interactions hover cost', () => {
  const view: ClipInteractionsView = {
    ppqToX: (ppq) => ppq * 10,
    xToPpq: (x) => x / 10,
    laneTop: (index) => index * 50,
    laneIndexAtY: (y) => Math.floor(y / 50),
    laneHeight: 50,
    laneCount: 2,
  };
  const commands = {
    selectClip: vi.fn(),
    clearClipSelection: vi.fn(),
    moveClip: vi.fn(),
    trimClip: vi.fn(),
    duplicateClip: vi.fn(() => 99),
    createClip: vi.fn(() => 77),
    setClipFades: vi.fn(),
    deleteClip: vi.fn(),
    splitClip: vi.fn(() => 88),
  };

  it('projects clips once while the clip array is unchanged', () => {
    let trackReads = 0;
    const clips: ArrangeClip[] = Array.from({ length: 50 }, (_, i) => {
      const clip = { id: i + 1, startPpq: i * 2, lengthPpq: 1 } as ArrangeClip;
      Object.defineProperty(clip, 'trackId', {
        enumerable: true,
        get() {
          trackReads++;
          return 10;
        },
      });
      return clip;
    });
    const interactions = useClipInteractions({
      view,
      getClips: () => clips,
      getTrackIds: () => [10, 20],
      getGridPpq: () => 1,
      getBarRange: (ppq) => ({ startPpq: Math.floor(ppq / 4) * 4, lengthPpq: 4 }),
      commands,
    });
    for (let i = 0; i < 10; i++) interactions.onPointerMove({ x: 5 + i, y: 25 });
    expect(trackReads).toBeLessThanOrEqual(clips.length);
  });

  it('rebuilds the projection when the clip array is replaced', () => {
    let clips: ArrangeClip[] = [{ id: 1, trackId: 10, startPpq: 0, lengthPpq: 4 }];
    const interactions = useClipInteractions({
      view,
      getClips: () => clips,
      getTrackIds: () => [10, 20],
      getGridPpq: () => 1,
      getBarRange: (ppq) => ({ startPpq: Math.floor(ppq / 4) * 4, lengthPpq: 4 }),
      commands,
    });
    interactions.onPointerMove({ x: 20, y: 25 });
    expect(interactions.cursor.value).toBe('pointer');
    clips = [{ id: 1, trackId: 10, startPpq: 100, lengthPpq: 4 }];
    interactions.onPointerMove({ x: 20, y: 25 });
    expect(interactions.cursor.value).toBe('default');
  });

  it('moves a selected group across lanes without scanning track ids per clip', () => {
    let indexOfCalls = 0;
    const trackIds = new Proxy([10, 20], {
      get(target, key, receiver) {
        if (key === 'indexOf') indexOfCalls++;
        return Reflect.get(target, key, receiver);
      },
    });
    const clips: ArrangeClip[] = [
      { id: 1, trackId: 10, startPpq: 0, lengthPpq: 4 },
      { id: 2, trackId: 10, startPpq: 8, lengthPpq: 4 },
    ];
    const selection = new Set([1, 2]);
    const interactions = useClipInteractions({
      view,
      getClips: () => clips,
      getTrackIds: () => trackIds,
      getSelectedClipIds: () => selection,
      getGridPpq: () => 1,
      getBarRange: (ppq) => ({ startPpq: Math.floor(ppq / 4) * 4, lengthPpq: 4 }),
      commands,
    });
    interactions.onPointerDown({ x: 20, y: 25 });
    interactions.onPointerMove({ x: 20, y: 75 });
    expect(interactions.previewClips.value.map((p) => [p.clipId, p.trackId, p.lengthPpq])).toEqual([
      [1, 20, 4],
      [2, 20, 4],
    ]);
    expect(indexOfCalls).toBe(0);
  });
});
