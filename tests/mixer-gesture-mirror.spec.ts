import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addInsert,
  addMasteringProcessor,
  addMixerBus,
  addNote,
  addVcaGroup,
  canUndo,
  clearHistory,
  mixerBusStripTarget,
  setInsertParam,
  setMasteringParam,
  setMasteringPreset,
  setMasteringPresetOverride,
  setMixerBusGain,
  setSend,
  setStripEq,
  setStripGain,
  setStripPan,
  setTrackInstrument,
  setVcaGroupGain,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('mixer drag gestures patch the mirror in place', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;
  let busId: string;
  let groupId: string;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    busId = addMixerBus({ name: 'Verb' });
    groupId = addVcaGroup({ name: 'Drums' });
    clearHistory();
  });

  /** Runs each drag frame and checks clips and notes keep their identity. */
  function dragKeepsIdentity(frames: Array<() => void>, finish: () => void): void {
    const clips = store.clips;
    const notes = store.notes;
    const refresh = vi.spyOn(store, 'refresh');
    for (const frame of frames) {
      frame();
      expect(store.clips).toBe(clips);
      expect(store.notes).toBe(notes);
    }
    finish();
    expect(store.clips).toBe(clips);
    expect(store.notes).toBe(notes);
    expect(refresh).not.toHaveBeenCalled();
  }

  it('keeps clips and notes identity-equal across a strip gain drag and undoes in one step', () => {
    const before = store.tracks[0].mixer?.gainDb;
    dragKeepsIdentity(
      [
        () => setStripGain(trackId, -3, { commit: false }),
        () => setStripGain(trackId, -6, { commit: false }),
      ],
      () => setStripGain(trackId, -9),
    );
    expect(store.tracks[0].mixer?.gainDb).toBe(-9);
    expect(undo()).toBe(true);
    expect(store.tracks[0].mixer?.gainDb ?? 0).toBe(before ?? 0);
    expect(canUndo()).toBe(false);
  });

  it('keeps identity across pan, eq and send drags', () => {
    dragKeepsIdentity(
      [
        () => setStripPan(trackId, 0.25, { commit: false }),
        () => setSend(trackId, busId, { levelDb: -12 }, { commit: false }),
        () =>
          setStripEq(
            trackId,
            { bands: [{ type: 'peak', freqHz: 1000, gainDb: 3, q: 1, enabled: true }] } as never,
            { commit: false },
          ),
      ],
      () => setStripPan(trackId, 0.5),
    );
  });

  it('keeps identity across return-bus and VCA gain drags and undoes each as one step', () => {
    dragKeepsIdentity(
      [
        () => setMixerBusGain(busId, -4, { commit: false }),
        () => setMixerBusGain(busId, -8, { commit: false }),
        () => setVcaGroupGain(groupId, -2, { commit: false }),
        () => setVcaGroupGain(groupId, -5, { commit: false }),
      ],
      () => setVcaGroupGain(groupId, -6),
    );
    expect(store.mixer.vcaGroups?.[0].gainDb).toBe(-6);
    expect(undo()).toBe(true);
    expect(store.mixer.vcaGroups?.[0].gainDb).toBe(0);
    expect(store.mixer.buses[0].gainDb).toBe(-8);
    expect(undo()).toBe(true);
    expect(store.mixer.buses[0].gainDb).toBe(0);
  });

  it('matches the mirror a full refresh produces', () => {
    setStripGain(trackId, -6, { commit: false });
    setStripPan(trackId, -0.5, { commit: false });
    setStripGain(mixerBusStripTarget(busId), -3, { commit: false });
    setVcaGroupGain(groupId, -4, { commit: false });
    const patched = JSON.stringify({
      tracks: store.tracks,
      mixer: store.mixer,
      clips: store.clips,
      selection: [...store.trackSelection],
    });
    store.refresh();
    const refreshed = JSON.stringify({
      tracks: store.tracks,
      mixer: store.mixer,
      clips: store.clips,
      selection: [...store.trackSelection],
    });
    expect(patched).toBe(refreshed);
  });

  /** Mirror state a refresh must leave untouched for gesture-written fields. */
  function snapshot(): string {
    return JSON.stringify({
      tracks: store.tracks,
      mixer: store.mixer,
      clips: store.clips,
      selection: [...store.trackSelection],
    });
  }

  it('patches insert param drags in place, one undo step, equal to a refresh', () => {
    const index = addInsert(trackId, 'gain.gain');
    clearHistory();
    dragKeepsIdentity(
      [
        () => setInsertParam(trackId, index, 'gainDb', -3, { commit: false }),
        () => setInsertParam(trackId, index, 'gainDb', -6, { commit: false }),
      ],
      () => setInsertParam(trackId, index, 'gainDb', -9),
    );
    expect(store.tracks[0].mixer?.inserts[index].params.gainDb).toBe(-9);
    const patched = snapshot();
    store.refresh();
    expect(snapshot()).toBe(patched);
    expect(undo()).toBe(true);
    expect(canUndo()).toBe(false);
  });

  it('patches instrument drags in place, one undo step, equal to a refresh', () => {
    dragKeepsIdentity(
      [
        () => setTrackInstrument(trackId, { kind: 'synth-preset', preset: 'a' }, { commit: false }),
        () => setTrackInstrument(trackId, { kind: 'synth-preset', preset: 'b' }, { commit: false }),
      ],
      () => setTrackInstrument(trackId, { kind: 'synth-preset', preset: 'c' }),
    );
    expect(store.tracks[0].instrument).toEqual({ kind: 'synth-preset', preset: 'c' });
    const patched = snapshot();
    store.refresh();
    expect(snapshot()).toBe(patched);
    expect(undo()).toBe(true);
    expect(canUndo()).toBe(false);
  });

  it('patches mastering preset, override and param drags in place', () => {
    const index = addMasteringProcessor('gain.gain');
    clearHistory();
    dragKeepsIdentity(
      [
        () => setMasteringPreset('streaming', { commit: false }),
        () => setMasteringPresetOverride('loudness.targetLufs', -16, { commit: false }),
        () => setMasteringPresetOverride('loudness.targetLufs', -14, { commit: false }),
        () => setMasteringParam(index, 'gainDb', -3, { commit: false }),
      ],
      () => setMasteringParam(index, 'gainDb', -6),
    );
    expect(store.mixer.masteringChain?.preset).toBe('streaming');
    expect(store.mixer.masteringChain?.presetOverrides?.['loudness.targetLufs']).toBe(-14);
    expect(store.mixer.masteringChain?.processors[index].params.gainDb).toBe(-6);
    const patched = snapshot();
    store.refresh();
    expect(snapshot()).toBe(patched);
    expect(undo()).toBe(true);
    expect(undo()).toBe(true);
    expect(undo()).toBe(true);
    expect(canUndo()).toBe(false);
  });
});
