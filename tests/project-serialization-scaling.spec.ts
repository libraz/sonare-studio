import { createHash } from 'node:crypto';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { busAutomationTarget } from '@/project/automation';
import {
  addGroupTrack,
  addMidiClip,
  addMixerBus,
  addNote,
  addTrack,
  clearHistory,
  setActiveClip,
  setAutomationLanePoints,
  setTrackGroup,
} from '@/project/commands';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

type Store = ReturnType<typeof useProjectStore>;

/** Wraps an array so every element read is counted. */
function countingArray<T extends object>(items: T[]): { array: T[]; reads: () => number } {
  let reads = 0;
  const array = new Proxy(items, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { array, reads: () => reads };
}

/**
 * Builds `trackCount` MIDI tracks of `clipsPerTrack` clips each, all members of
 * one group track, each following the previous track with one stashed note.
 */
function buildGrid(store: Store, trackCount: number, clipsPerTrack: number): void {
  const groupId = addGroupTrack({ name: 'Group' });
  const firstTrackId = store.tracks[0].id;
  for (let t = 0; t < trackCount; t++) {
    const trackId = t === 0 ? firstTrackId : addTrack({ name: `Track ${t}` });
    const existing = store.clips.filter((clip) => clip.trackId === trackId).length;
    for (let c = existing; c < clipsPerTrack; c++) {
      addMidiClip({ trackId, startPpq: c * 4, lengthPpq: 4, name: `C${t}.${c}` });
    }
    setTrackGroup(trackId, groupId);
  }
  const midiTracks = store.tracks.filter((track) => track.kind === 'midi');
  midiTracks.forEach((track, index) => {
    if (index === 0) return;
    const clipId = store.clips.filter((clip) => clip.trackId === track.id)[1].id;
    track.leadFollow = {
      leadTrackId: midiTracks[index - 1].id,
      stash: [
        { clipId, note: { pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 } },
      ],
    };
  });
}

/** Counts serializeProject's element reads of `store.clips` and `store.tracks`. */
function countSerializeReads(store: Store): { clips: number; tracks: number } {
  const clips = countingArray(store.clips.slice());
  const tracks = countingArray(store.tracks.slice());
  store.clips = clips.array;
  store.tracks = tracks.array;
  const before = { clips: clips.reads(), tracks: tracks.reads() };
  serializeProject();
  return { clips: clips.reads() - before.clips, tracks: tracks.reads() - before.tracks };
}

describe('serializeProject scaling', () => {
  let store: Store;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('reads each clip and track a bounded number of times', () => {
    const trackCount = 31;
    const clipsPerTrack = 8;
    buildGrid(store, trackCount, clipsPerTrack);
    const clipCount = store.clips.length;
    const totalTracks = store.tracks.length;
    expect(clipCount).toBe(trackCount * clipsPerTrack);

    const reads = countSerializeReads(store);
    // Per-track filtering of every clip and per-track track lookups would be
    // quadratic; a constant number of passes over each array is the bound.
    expect(reads.clips).toBeLessThanOrEqual(2 * clipCount);
    expect(reads.tracks).toBeLessThanOrEqual(4 * totalTracks);
  });

  it('serializes a multi-track project with buses and automation to a pinned document', () => {
    store.projectName = 'Golden';
    const pianoId = store.tracks[0].id;
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 100 });
    const groupId = addGroupTrack({ name: 'Group' });
    const bassId = addTrack({ name: 'Bass' });
    const bassClip = addMidiClip({ trackId: bassId, startPpq: 0, lengthPpq: 8, name: 'B1' });
    setActiveClip(bassClip);
    addNote({ pitch: 36, startPpq: 0, durationPpq: 2, velocity: 110 });
    addMidiClip({ trackId: pianoId, startPpq: 8, lengthPpq: 8, name: 'P2' });
    addMidiClip({ trackId: bassId, startPpq: 8, lengthPpq: 8, name: 'B2' });
    setTrackGroup(pianoId, groupId);
    setTrackGroup(bassId, groupId);
    const fxId = addMixerBus({ id: 'fx', name: 'FX' });
    addMixerBus({ id: 'verb', name: 'Verb' });
    setAutomationLanePoints(busAutomationTarget(fxId), 'faderDb', [
      { ppq: 0, value: -6 },
      { ppq: 4, value: -3 },
    ]);
    setAutomationLanePoints(bassId, 'faderDb', [{ ppq: 2, value: -1 }]);
    setAutomationLanePoints('master', 'pan', [{ ppq: 4, value: 0.5 }]);
    const bass = store.tracks.find((track) => track.id === bassId);
    if (bass === undefined) throw new Error('bass track missing');
    bass.leadFollow = {
      leadTrackId: pianoId,
      stash: [
        {
          clipId: bassClip,
          note: { pitch: 40, velocity: 80, startPpq: 1, durationPpq: 1, channel: 0 },
        },
        {
          clipId: 99999,
          note: { pitch: 41, velocity: 80, startPpq: 2, durationPpq: 1, channel: 0 },
        },
      ],
    };

    const doc = serializeProject();
    expect(doc.tracks.map((track) => track.groupIndex)).toEqual([1, undefined, 1]);
    expect(doc.tracks[2].leadFollow).toMatchObject({
      leadTrackIndex: 0,
      stash: [{ clipIndex: 0 }],
    });
    expect(doc.mixer?.buses.map((bus) => bus.automation?.length ?? 0)).toEqual([1, 0]);
    expect(doc.tracks[2].automation).toHaveLength(1);
    expect(doc.masterAutomation).toHaveLength(1);
    const json = JSON.stringify(doc);
    expect(createHash('sha256').update(json).digest('hex')).toBe(
      '9fc785ba3b92a250784c903f7af35546ef9a397c0b9ff4abbbb486b939df7756',
    );
  });
});
