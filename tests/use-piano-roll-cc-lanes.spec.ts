import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { usePianoRollCcLanes } from '@/components/piano-roll/use-piano-roll-cc-lanes';
import type { PianoRollLanes } from '@/components/piano-roll/use-piano-roll-lanes';
import { clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

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
});
