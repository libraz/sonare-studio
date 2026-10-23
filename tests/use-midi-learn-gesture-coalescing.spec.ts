import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { addTrack, clearHistory, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { midiLearnStripControlTargetId, midiLearnTargetId } from '@/ui/midi/midi-learn';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Number of undo steps available, consuming the history. */
function drainUndoDepth(): number {
  let depth = 0;
  while (undo()) depth++;
  return depth;
}

describe('useMidiLearn gesture coalescing', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function trackIds(count: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) ids.push(addTrack({ kind: 'midi', name: `T${i}` }));
    clearHistory();
    return ids;
  }

  function sweep(learn: ReturnType<typeof useMidiLearn>, controller: number): void {
    for (let value = 10; value < 30; value++) {
      learn.handleCc({ channel: 0, controller, value });
    }
    vi.advanceTimersByTime(1000);
  }

  it('commits one undo step for a CC sweep on the channel delay', async () => {
    const [id] = await trackIds(1);
    const store = useProjectStore();
    const learn = useMidiLearn();
    learn.armId(midiLearnStripControlTargetId(id, 'channelDelaySamples'));
    learn.handleCc({ channel: 0, controller: 40, value: 0 });
    vi.advanceTimersByTime(1000);
    clearHistory();

    sweep(learn, 40);

    expect(
      store.tracks.find((track) => track.id === id)?.mixer?.channelDelaySamples,
    ).toBeGreaterThan(0);
    expect(drainUndoDepth()).toBe(1);
    expect(store.tracks.find((track) => track.id === id)?.mixer?.channelDelaySamples ?? 0).toBe(0);
  });

  it('commits one undo step for a CC sweep on dual-pan left', async () => {
    const [id] = await trackIds(1);
    const learn = useMidiLearn();
    learn.armId(midiLearnStripControlTargetId(id, 'dualPanLeft'));
    learn.handleCc({ channel: 0, controller: 41, value: 64 });
    vi.advanceTimersByTime(1000);
    clearHistory();

    sweep(learn, 41);

    expect(drainUndoDepth()).toBe(1);
  });

  it('keeps several targets driven by one CC to a single undo step', async () => {
    const [a, b] = await trackIds(2);
    const learn = useMidiLearn();
    learn.armId(midiLearnTargetId('gain', a));
    learn.handleCc({ channel: 0, controller: 42, value: 64 });
    learn.armId(midiLearnTargetId('gain', b));
    learn.handleCc({ channel: 0, controller: 42, value: 64 });
    vi.advanceTimersByTime(1000);
    clearHistory();

    sweep(learn, 42);

    expect(drainUndoDepth()).toBeLessThanOrEqual(1);
  });
});
