import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { addNote, clearHistory, setClipLoop, trimClip } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { usePianoRollCcLanes } from '@/ui/piano-roll/use-piano-roll-cc-lanes';
import type { PianoRollLanes } from '@/ui/piano-roll/use-piano-roll-lanes';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** A lanes double exposing just the mode refs usePianoRollCcLanes reads. */
function makeLanes(over: Record<string, unknown> = {}): PianoRollLanes {
  return {
    laneParam: ref('velocity'),
    laneChannel: ref(0),
    laneCurve: ref('hold'),
    laneCc: ref(null),
    lanePitchBend: ref(false),
    laneChannelPressure: ref(false),
    lanePolyPressure: ref(false),
    ...over,
  } as unknown as PianoRollLanes;
}

describe('usePianoRollCcLanes channel routing', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('writes and reads the pitch-bend lane on the selected channel', () => {
    const laneChannel = ref(3);
    const lanes = makeLanes({ lanePitchBend: ref(true), laneChannel });
    const cc = usePianoRollCcLanes({ lanes, gridPpq: ref(1) });

    cc.commitPitchBendPoints([{ ppq: 0, value: 12000 }]);
    expect(cc.activePitchBendPoints.value).toEqual([{ ppq: 0, value: 12000 }]);

    // The lane lives on channel 3; selecting channel 0 shows an empty lane.
    laneChannel.value = 0;
    expect(cc.activePitchBendPoints.value).toEqual([]);
  });

  it('uses the supplied meter-aware grid to snap expression breakpoints', () => {
    const cc = usePianoRollCcLanes({
      lanes: makeLanes(),
      gridPpq: ref(1),
      snapPpq: (ppq) => (ppq < 7.25 ? 6 : 8.5),
    });

    expect(cc.ccSnap(8.2)).toBe(8.5);
  });

  it('keeps CC lanes on distinct channels independent', () => {
    const laneChannel = ref(2);
    const lanes = makeLanes({ laneCc: ref(11), laneChannel });
    const cc = usePianoRollCcLanes({ lanes, gridPpq: ref(1) });

    cc.commitCcPoints([{ ppq: 0, value: 64 }]);
    expect(cc.activeCcPoints.value).toEqual([{ ppq: 0, value: 64 }]);

    // A different channel starts empty and writes its own lane.
    laneChannel.value = 5;
    expect(cc.activeCcPoints.value).toEqual([]);
    cc.commitCcPoints([{ ppq: 1, value: 100 }]);
    expect(cc.activeCcPoints.value).toEqual([{ ppq: 1, value: 100 }]);

    // The channel-2 lane is untouched.
    laneChannel.value = 2;
    expect(cc.activeCcPoints.value).toEqual([{ ppq: 0, value: 64 }]);
  });

  it('writes channel-pressure on the selected channel', () => {
    const laneChannel = ref(7);
    const lanes = makeLanes({ laneChannelPressure: ref(true), laneChannel });
    const cc = usePianoRollCcLanes({ lanes, gridPpq: ref(1) });

    cc.commitChannelPressurePoints([{ ppq: 0, value: 90 }]);
    expect(cc.activeChannelPressurePoints.value).toEqual([{ ppq: 0, value: 90 }]);

    laneChannel.value = 0;
    expect(cc.activeChannelPressurePoints.value).toEqual([]);
  });

  it('keeps poly-pressure lanes scoped by selected channel and pitch', () => {
    const noteId = addNote({ pitch: 62, startPpq: 0, durationPpq: 1 });
    store.selection = new Set([noteId]);
    const laneChannel = ref(4);
    const lanes = makeLanes({ lanePolyPressure: ref(true), laneChannel });
    const cc = usePianoRollCcLanes({ lanes, gridPpq: ref(1) });

    cc.commitPolyPressurePoints([{ ppq: 0.25, value: 88 }]);
    expect(cc.activePolyPressurePoints.value).toEqual([{ ppq: 0.25, value: 88 }]);

    laneChannel.value = 0;
    expect(cc.activePolyPressurePoints.value).toEqual([]);
    cc.commitPolyPressurePoints([{ ppq: 0.5, value: 40 }]);
    expect(cc.activePolyPressurePoints.value).toEqual([{ ppq: 0.5, value: 40 }]);

    laneChannel.value = 4;
    expect(cc.activePolyPressurePoints.value).toEqual([{ ppq: 0.25, value: 88 }]);
  });

  it('targets every selected pitch when editing poly-pressure', () => {
    const low = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const high = addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    const doubled = addNote({ pitch: 64, startPpq: 2, durationPpq: 1 });
    store.selection = new Set([high, low, doubled]);
    const lanes = makeLanes({ lanePolyPressure: ref(true), laneChannel: ref(1) });
    const cc = usePianoRollCcLanes({ lanes, gridPpq: ref(1) });

    expect(cc.polyPressurePitches.value).toEqual([60, 64]);
    cc.commitPolyPressurePoints([{ ppq: 0.25, value: 70 }]);

    expect(store.activeClip?.polyPressureLanes).toEqual([
      { channel: 1, pitch: 60, points: [{ ppq: 0.25, value: 70 }] },
      { channel: 1, pitch: 64, points: [{ ppq: 0.25, value: 70 }] },
    ]);
    expect(cc.activePolyPressurePoints.value).toEqual([{ ppq: 0.25, value: 70 }]);
  });

  it('edits expression in source coordinates while preserving points outside the loop window', () => {
    const clipId = store.clipId;
    const timelineStart = store.activeClip?.startPpq ?? 0;
    trimClip(clipId, timelineStart + 2, 5);
    setClipLoop(clipId, true, 2);
    store.clips = store.clips.map((clip) =>
      clip.id === clipId
        ? {
            ...clip,
            ccLanes: [
              {
                controller: 1,
                channel: 0,
                points: [
                  { ppq: 0, value: 10 },
                  { ppq: 1, value: 20 },
                  { ppq: 3, value: 30 },
                ],
              },
            ],
          }
        : clip,
    );
    const lanes = makeLanes({ laneCc: ref(1), laneChannel: ref(0) });
    const cc = usePianoRollCcLanes({ lanes, gridPpq: ref(1) });

    expect(cc.activeCcPoints.value).toEqual([
      { ppq: 2, value: 10 },
      { ppq: 3, value: 20 },
    ]);
    cc.commitCcPoints([{ ppq: 2.5, value: 99 }]);

    expect(store.activeClip?.ccLanes?.[0].points).toEqual([
      { ppq: 0.5, value: 99 },
      { ppq: 3, value: 30 },
    ]);
    expect(cc.activeCcPoints.value).toEqual([{ ppq: 2.5, value: 99 }]);
    expect(cc.ccSnap(0)).toBe(2);
    expect(cc.ccSnap(9)).toBe(4);
  });
});
