import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { effectScope, ref, shallowRef } from 'vue';
import { useEngineProjectSync } from '@/composables/useEngineProjectSync';
import type { EngineHandle } from '@/engine/engine';
import { createMixerSync, type MixerSync } from '@/engine/mixer-sync';
import type { StripSync } from '@/engine/strip-sync';
import { createDefaultStrip, MAX_TRACK_LANES } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

function track(id: number): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
  };
}

/** Engine stub enforcing append-only lanes and the lane cap the real engine applies. */
function makeHandle() {
  const declared: number[] = [];
  const engine = {
    setTrackLanes: vi.fn((lanes: number[]) => {
      if (lanes.length > MAX_TRACK_LANES) throw new Error('too many lanes');
      if (declared.some((id, index) => lanes[index] !== id)) throw new Error('append-only');
      declared.splice(0, declared.length, ...lanes);
    }),
    setStripGain: vi.fn((id: number | 'master') => id === 'master' || declared.includes(id)),
    setStripPan: vi.fn(() => true),
    setSoloMute: vi.fn(() => true),
    setTrackStripChannelDelaySamples: vi.fn(),
    setTrackStripPanLaw: vi.fn(),
    setTrackStripPanMode: vi.fn(),
    setTrackStripDualPan: vi.fn(),
  };
  return { engine, handle: { engine, ctx: { state: 'running' } } as unknown as EngineHandle };
}

describe('engine lane reclaim', () => {
  it('never over-declares after more than 32 tracks come and go, and a rebuild gives every live track a lane', () => {
    const { engine, handle } = makeHandle();
    const sync = createMixerSync(handle);
    const live: EditorTrack[] = [];
    // Add and delete one track at a time; the engine keeps every retired lane.
    for (let id = 1; id <= MAX_TRACK_LANES; id++) {
      live.splice(0, live.length, track(id));
      expect(() => sync.sync(live, createDefaultStrip())).not.toThrow();
    }
    expect(sync.laneReclaimNeeded?.()).toBe(false);

    live.push(track(100));
    engine.setStripGain.mockClear();
    expect(() => sync.sync(live, createDefaultStrip())).not.toThrow();
    expect(sync.laneReclaimNeeded?.()).toBe(true);
    // The live track that still has a lane keeps receiving updates.
    live[0] = { ...live[0], volume: 0.5 };
    sync.sync(live, createDefaultStrip());
    expect(engine.setStripGain).toHaveBeenCalledWith(MAX_TRACK_LANES, expect.any(Number));
    expect(engine.setStripGain).not.toHaveBeenCalledWith(100, expect.any(Number));

    const rebuilt = makeHandle();
    const fresh = createMixerSync(rebuilt.handle);
    fresh.sync(live, createDefaultStrip());
    expect(rebuilt.engine.setTrackLanes).toHaveBeenLastCalledWith([MAX_TRACK_LANES, 100]);
    expect(fresh.laneReclaimNeeded?.()).toBe(false);
  });

  it('requests the engine rebuild once and strips only the laned tracks meanwhile', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1), track(2)];
    const mixerSync: MixerSync = {
      sync: vi.fn(),
      laneTrackIds: () => [1],
      sceneGeneration: () => 1,
      positiveChannelDelayTrackIds: () => new Set(),
      applyChannelDelays: vi.fn(),
      laneReclaimNeeded: () => true,
    };
    const stripSync = { sync: vi.fn(), sceneGeneration: () => 1 } as unknown as StripSync;
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');
    const rebuild = vi.fn();
    projectSync.setEngineRebuildHandler(rebuild);
    projectSync.setEngineSyncHandles({
      mixerSync,
      stripSync,
      automationSync: null,
      midiSync: null,
      transportSync: null,
      webMidiOutput: null,
    });

    projectSync.syncMixerState();
    projectSync.syncMixerState();

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(stripSync.sync)
        .mock.calls.at(-1)?.[0]
        .map((entry) => entry.id),
    ).toEqual([1]);
    scope.stop();
  });
});
