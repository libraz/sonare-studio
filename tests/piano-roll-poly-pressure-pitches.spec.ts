import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { addNote, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { usePianoRollCcLanes } from '@/ui/piano-roll/use-piano-roll-cc-lanes';
import type { PianoRollLanes } from '@/ui/piano-roll/use-piano-roll-lanes';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('polyPressurePitches', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('resolves the selected pitches without a per-id note search', () => {
    const store = useProjectStore();
    const ids = Array.from({ length: 20 }, (_, i) =>
      addNote({ pitch: 40 + (i % 5), startPpq: i, durationPpq: 1 }),
    );
    store.selection = new Set(ids);
    const lanes = {
      laneParam: ref('velocity'),
      laneChannel: ref(0),
      laneCurve: ref('hold'),
      laneCc: ref(null),
      lanePitchBend: ref(false),
      laneChannelPressure: ref(false),
      lanePolyPressure: ref(true),
    } as unknown as PianoRollLanes;
    const cc = usePianoRollCcLanes({ lanes, gridPpq: ref(1) });

    const find = vi.spyOn(Array.prototype, 'find');
    const pitches = cc.polyPressurePitches.value;
    const searches = find.mock.calls.length;
    find.mockRestore();

    expect(pitches).toEqual([40, 41, 42, 43, 44]);
    expect(searches).toBe(0);
  });
});
