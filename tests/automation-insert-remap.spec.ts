import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AutomationLaneState, insertAutomationParam } from '@/project/automation';
import {
  pruneInsertLanesAgainstStrips,
  remapInsertLanesAfterRemoval,
  remapInsertLanesAfterReorder,
} from '@/project/automation-insert';
import {
  addInsert,
  clearHistory,
  removeInsert,
  reorderInsert,
  setAutomationLanePoints,
  setInsertEnabled,
  undo,
} from '@/project/commands';
import { createDefaultStrip, type MixerStrip } from '@/project/mixer';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Builds a strip carrying `count` empty inserts. */
function stripWithInserts(count: number): MixerStrip {
  const strip = createDefaultStrip();
  for (let i = 0; i < count; i++) {
    strip.inserts.push({ processor: 'gain.gain', params: {}, enabled: true });
  }
  return strip;
}

describe('remapInsertLanesAfterRemoval', () => {
  const target = 1;
  const lanes: AutomationLaneState[] = [
    { target, param: insertAutomationParam(0, 'gainDb'), points: [], enabled: true },
    { target, param: insertAutomationParam(1, 'gainDb'), points: [], enabled: true },
    { target, param: insertAutomationParam(2, 'gainDb'), points: [], enabled: true },
    { target, param: 'faderDb', points: [], enabled: true },
    { target: 2, param: insertAutomationParam(1, 'gainDb'), points: [], enabled: true },
  ];

  it('drops the removed slot lane, shifts later slots down, keeps the rest', () => {
    const result = remapInsertLanesAfterRemoval(lanes, target, 1);
    expect(result.map((l) => `${l.target}:${l.param}`)).toEqual([
      '1:insert:0:gainDb',
      // slot 1 dropped, slot 2 -> slot 1
      '1:insert:1:gainDb',
      '1:faderDb',
      // other target untouched
      '2:insert:1:gainDb',
    ]);
  });

  it('leaves lanes on other strips and non-insert lanes untouched', () => {
    const result = remapInsertLanesAfterRemoval(lanes, target, 0);
    const other = result.find((l) => l.target === 2);
    expect(other?.param).toBe(insertAutomationParam(1, 'gainDb'));
    expect(result.some((l) => l.target === target && l.param === 'faderDb')).toBe(true);
  });
});

describe('remapInsertLanesAfterReorder', () => {
  const target = 1;
  const lanes: AutomationLaneState[] = [
    { target, param: insertAutomationParam(0, 'gainDb'), points: [], enabled: true },
    { target, param: insertAutomationParam(1, 'gainDb'), points: [], enabled: true },
    { target, param: insertAutomationParam(2, 'gainDb'), points: [], enabled: true },
    { target, param: 'faderDb', points: [], enabled: true },
    { target: 2, param: insertAutomationParam(1, 'gainDb'), points: [], enabled: true },
  ];

  it('moves the dragged slot lane to the destination, shifting crossed slots down', () => {
    const result = remapInsertLanesAfterReorder(lanes, target, 0, 2);
    expect(result.map((l) => `${l.target}:${l.param}`)).toEqual([
      '1:insert:2:gainDb', // was slot 0, moved to 2
      '1:insert:0:gainDb', // was slot 1, shifted to 0
      '1:insert:1:gainDb', // was slot 2, shifted to 1
      '1:faderDb',
      '2:insert:1:gainDb', // other strip untouched
    ]);
  });

  it('shifts crossed slots up when the slot moves earlier', () => {
    const result = remapInsertLanesAfterReorder(lanes, target, 2, 0);
    expect(result.map((l) => `${l.target}:${l.param}`)).toEqual([
      '1:insert:1:gainDb', // was slot 0, shifted to 1
      '1:insert:2:gainDb', // was slot 1, shifted to 2
      '1:insert:0:gainDb', // was slot 2, moved to 0
      '1:faderDb',
      '2:insert:1:gainDb',
    ]);
  });

  it('returns lanes unchanged for a no-op move', () => {
    const result = remapInsertLanesAfterReorder(lanes, target, 1, 1);
    expect(result.map((l) => `${l.target}:${l.param}`)).toEqual(
      lanes.map((l) => `${l.target}:${l.param}`),
    );
  });
});

describe('pruneInsertLanesAgainstStrips', () => {
  it('drops insert lanes whose slot index exceeds the strip insert count', () => {
    const lanes: AutomationLaneState[] = [
      { target: 1, param: insertAutomationParam(0, 'gainDb'), points: [], enabled: true },
      { target: 1, param: insertAutomationParam(2, 'gainDb'), points: [], enabled: true },
      { target: 'master', param: insertAutomationParam(0, 'gainDb'), points: [], enabled: true },
      { target: 1, param: 'faderDb', points: [], enabled: true },
    ];
    const result = pruneInsertLanesAgainstStrips(lanes, {
      trackStrips: new Map([[1, stripWithInserts(1)]]),
      master: stripWithInserts(0),
      busStrips: new Map(),
    });
    expect(result.map((l) => `${l.target}:${l.param}`)).toEqual(['1:insert:0:gainDb', '1:faderDb']);
  });
});

describe('removeInsert lane remapping', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
    addInsert(trackId, 'gain.gain');
    addInsert(trackId, 'gain.gain');
    addInsert(trackId, 'gain.gain');
    setAutomationLanePoints(trackId, insertAutomationParam(1, 'gainDb'), [{ ppq: 0, value: 3 }]);
    setAutomationLanePoints(trackId, insertAutomationParam(2, 'gainDb'), [{ ppq: 0, value: 6 }]);
  });

  it('drops the removed slot lane and shifts the later slot down', () => {
    removeInsert(trackId, 1);
    const params = store.automationLanes
      .filter((lane) => lane.target === trackId)
      .map((lane) => lane.param);
    expect(params).toContain(insertAutomationParam(1, 'gainDb'));
    expect(params).not.toContain(insertAutomationParam(2, 'gainDb'));
    // The lane originally on slot 2 (value 6) is now on slot 1.
    const moved = store.automationLanes.find(
      (lane) => lane.target === trackId && lane.param === insertAutomationParam(1, 'gainDb'),
    );
    expect(moved?.points).toEqual([{ ppq: 0, value: 6 }]);
  });

  it('restores both the strip and the lanes in a single undo', () => {
    removeInsert(trackId, 1);
    undo();
    expect(store.tracks[0].mixer?.inserts.length).toBe(3);
    const params = store.automationLanes
      .filter((lane) => lane.target === trackId)
      .map((lane) => lane.param)
      .sort();
    expect(params).toEqual([
      insertAutomationParam(1, 'gainDb'),
      insertAutomationParam(2, 'gainDb'),
    ]);
  });

  it('addInsert and bypass leave insert lanes untouched', () => {
    addInsert(trackId, 'gain.gain');
    setInsertEnabled(trackId, 0, false);
    const params = store.automationLanes
      .filter((lane) => lane.target === trackId)
      .map((lane) => lane.param)
      .sort();
    expect(params).toEqual([
      insertAutomationParam(1, 'gainDb'),
      insertAutomationParam(2, 'gainDb'),
    ]);
  });
});

describe('reorderInsert lane remapping', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
    // Three inserts; lanes on slot 1 (value 3) and slot 2 (value 6) so each
    // lane's identity is traceable through the move by its point value.
    addInsert(trackId, 'gain.gain');
    addInsert(trackId, 'gain.gain');
    addInsert(trackId, 'gain.gain');
    setAutomationLanePoints(trackId, insertAutomationParam(1, 'gainDb'), [{ ppq: 0, value: 3 }]);
    setAutomationLanePoints(trackId, insertAutomationParam(2, 'gainDb'), [{ ppq: 0, value: 6 }]);
  });

  /** Point value of the lane on a given slot, or undefined. */
  function laneValue(slot: number): number | undefined {
    return store.automationLanes.find(
      (lane) => lane.target === trackId && lane.param === insertAutomationParam(slot, 'gainDb'),
    )?.points[0]?.value;
  }

  it('moves the slot and the lanes follow it', () => {
    // Move the last insert to the front: [s0, s1, s2] -> [s2, s0, s1].
    reorderInsert(trackId, 2, 0);
    // The lane that was on slot 2 (value 6) is now on slot 0; slot 1 (value 3)
    // shifted to slot 2.
    expect(laneValue(0)).toBe(6);
    expect(laneValue(2)).toBe(3);
    expect(laneValue(1)).toBeUndefined();
  });

  it('clamps an out-of-range destination to the last slot', () => {
    reorderInsert(trackId, 0, 99);
    expect(store.tracks[0].mixer?.inserts.length).toBe(3);
    // Slot 0 moved to the end; the lane on slot 1 (value 3) shifted to slot 0,
    // slot 2 (value 6) shifted to slot 1.
    expect(laneValue(0)).toBe(3);
    expect(laneValue(1)).toBe(6);
  });

  it('is a no-op at the same index', () => {
    reorderInsert(trackId, 1, 1);
    expect(laneValue(1)).toBe(3);
    expect(laneValue(2)).toBe(6);
  });

  it('restores both the order and the lanes in a single undo', () => {
    reorderInsert(trackId, 0, 2);
    undo();
    expect(store.tracks[0].mixer?.inserts.length).toBe(3);
    expect(laneValue(1)).toBe(3);
    expect(laneValue(2)).toBe(6);
  });
});
