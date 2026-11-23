import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, saveAsset } from '@/persistence/assets';
import { clipRangesCollide } from '@/project/command/clip-lane';
import {
  addAudioClip,
  addAudioTrack,
  addMidiClip,
  addNote,
  addRecordedAudioClips,
  addRecordedMidiClip,
  applyNoteEdits,
  canUndo,
  clearActiveClipSelection,
  clearHistory,
  consolidateAudioClips,
  crossfadeClips,
  deleteClip,
  deleteTime,
  duplicateClip,
  duplicateTime,
  glueMidiClips,
  insertTime,
  moveClips,
  setActiveClip,
  setClipWarp,
  trimClip,
  undo,
  updateNotes,
} from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

interface FakeDoc {
  clips: Array<{ id: number; trackId: number; warpRefId?: number }>;
  warpMaps?: Array<{ id: number }>;
}

function readDoc(): FakeDoc {
  return JSON.parse(getProject().toJson()) as FakeDoc;
}

describe('clip lane placement', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  /** Lane ranges of a track in timeline order. */
  const lane = (id = trackId): Array<[number, number]> =>
    store.clips
      .filter((clip) => clip.trackId === id)
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
    // Refuse overlapping placements the way the real engine does.
    (getProject() as unknown as { enforceClipLanes(): void }).enforceClipLanes();
    trackId = store.tracks[0].id;
    deleteClip(store.clips[0].id);
    clearHistory();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  const midi = (startPpq: number, lengthPpq: number, track = trackId): number =>
    addMidiClip({ trackId: track, startPpq, lengthPpq });

  describe('collision rule', () => {
    it('treats abutting ranges and float noise at a shared edge as touching', () => {
      expect(clipRangesCollide(0, 4, 4, 4)).toBe(false);
      expect(clipRangesCollide(0, 0.1 + 0.2, 0.3, 1)).toBe(false);
      expect(clipRangesCollide(0, 4, 3.5, 4)).toBe(true);
    });
  });

  describe('group moves and ripple edits on abutting clips', () => {
    it('moves a group of abutting clips right in ascending caller order, in one undo', () => {
      const a = midi(0, 4);
      const b = midi(4, 4);
      const c = midi(8, 4);
      clearHistory();

      moveClips([
        { clipId: a, newStartPpq: 4 },
        { clipId: b, newStartPpq: 8 },
        { clipId: c, newStartPpq: 12 },
      ]);

      expect(lane()).toEqual([
        [4, 8],
        [8, 12],
        [12, 16],
      ]);
      expect(undo()).toBe(true);
      expect(lane()).toEqual([
        [0, 4],
        [4, 8],
        [8, 12],
      ]);
    });

    it('moves a group left in descending caller order', () => {
      const a = midi(4, 4);
      const b = midi(8, 4);
      moveClips([
        { clipId: b, newStartPpq: 4 },
        { clipId: a, newStartPpq: 0 },
      ]);
      expect(lane()).toEqual([
        [0, 4],
        [4, 8],
      ]);
    });

    it('swaps two abutting clips by parking one while the other moves', () => {
      const a = midi(0, 4);
      const b = midi(4, 4);
      moveClips([
        { clipId: a, newStartPpq: 4 },
        { clipId: b, newStartPpq: 0 },
      ]);
      expect(store.clips.find((clip) => clip.id === a)?.startPpq).toBe(4);
      expect(store.clips.find((clip) => clip.id === b)?.startPpq).toBe(0);
    });

    it('inserts time before back-to-back clips and through one that spans the boundary', () => {
      midi(0, 16);
      midi(16, 16);
      insertTime(8, 8);
      expect(lane()).toEqual([
        [0, 8],
        [16, 24],
        [24, 40],
      ]);
      expect(undo()).toBe(true);
      expect(lane()).toEqual([
        [0, 16],
        [16, 32],
      ]);
    });

    it('duplicates a time window across back-to-back clips', () => {
      midi(0, 16);
      midi(16, 16);
      clearHistory();
      duplicateTime(8, 24);
      expect(lane()).toEqual([
        [0, 16],
        [16, 24],
        [24, 32],
        [32, 40],
        [40, 48],
      ]);
      expect(undo()).toBe(true);
      expect(lane()).toEqual([
        [0, 16],
        [16, 32],
      ]);
    });

    it('deletes time ahead of back-to-back clips', () => {
      midi(0, 8);
      midi(8, 8);
      midi(16, 8);
      deleteTime(0, 8);
      expect(lane()).toEqual([
        [0, 8],
        [8, 16],
      ]);
    });
  });

  describe('replacing clips', () => {
    it('glues abutting MIDI clips into one spanning clip and restores them on undo', () => {
      const a = midi(0, 4);
      const b = midi(4, 4);
      setActiveClip(a);
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      setActiveClip(b);
      addNote({ pitch: 62, startPpq: 0, durationPpq: 1 });
      clearHistory();

      const glued = glueMidiClips([a, b]);

      expect(lane()).toEqual([[0, 8]]);
      expect(store.clips[0].id).toBe(glued);
      expect(store.clips[0].notes.map((note) => note.pitch).sort()).toEqual([60, 62]);
      expect(undo()).toBe(true);
      expect(lane()).toEqual([
        [0, 4],
        [4, 8],
      ]);
    });

    it('consolidates abutting audio clips into one spanning clip', async () => {
      await saveAsset({ id: 'lane-a', name: 'A', sampleRate: 4 }, [new Float32Array(8).fill(1)]);
      await saveAsset({ id: 'lane-b', name: 'B', sampleRate: 4 }, [new Float32Array(8).fill(2)]);
      const audioTrack = addAudioTrack({ name: 'Audio' });
      const a = await addAudioClip({
        trackId: audioTrack,
        assetId: 'lane-a',
        startPpq: 0,
        lengthPpq: 2,
      });
      const b = await addAudioClip({
        trackId: audioTrack,
        assetId: 'lane-b',
        startPpq: 2,
        lengthPpq: 2,
      });
      clearHistory();

      const id = await consolidateAudioClips([a, b], { tempoBpm: 60 });

      expect(id).not.toBeNull();
      expect(lane(audioTrack)).toEqual([[0, 4]]);
      expect(undo()).toBe(true);
      expect(lane(audioTrack)).toEqual([
        [0, 2],
        [2, 4],
      ]);
    });
  });

  describe('recording onto an occupied lane', () => {
    it('stores a MIDI take over an existing clip by splitting the clip around it', () => {
      midi(0, 12);
      clearHistory();

      const id = addRecordedMidiClip({
        trackId,
        startPpq: 4,
        lengthPpq: 4,
        notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
      });

      expect(lane()).toEqual([
        [0, 4],
        [4, 8],
        [8, 12],
      ]);
      expect(store.clips.find((clip) => clip.id === id)?.notes).toHaveLength(1);
      expect(undo()).toBe(true);
      expect(lane()).toEqual([[0, 12]]);
    });

    it('clears the range for a MIDI recording even when the project allows overlap', () => {
      midi(0, 12);
      getProject().setOverlapPolicy('allow');
      clearHistory();

      addRecordedMidiClip({ trackId, startPpq: 4, lengthPpq: 4, notes: [] });

      expect(lane()).toEqual([
        [0, 4],
        [4, 8],
        [8, 12],
      ]);
    });

    it('clears an empty clip under a MIDI recording', () => {
      midi(2, 4);
      const id = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
      });
      expect(lane()).toEqual([
        [0, 4],
        [4, 6],
      ]);
      expect(store.clips.some((clip) => clip.id === id)).toBe(true);
    });

    it('leaves the lane untouched and nothing in history when the take cannot be stored', () => {
      midi(0, 12);
      clearHistory();
      const project = getProject();
      const original = project.setMidiEvents.bind(project);
      project.setMidiEvents = () => {
        throw new Error('write failed');
      };
      try {
        expect(() =>
          addRecordedMidiClip({
            trackId,
            startPpq: 4,
            lengthPpq: 4,
            notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
          }),
        ).toThrow('write failed');
      } finally {
        project.setMidiEvents = original;
      }
      expect(lane()).toEqual([[0, 12]]);
      expect(canUndo()).toBe(false);
    });

    it('stores an audio take over an existing clip', async () => {
      await saveAsset({ id: 'rec-old', name: 'Old', sampleRate: 4 }, [new Float32Array(32)]);
      await saveAsset({ id: 'rec-new', name: 'New', sampleRate: 4 }, [new Float32Array(8)]);
      const audioTrack = addAudioTrack({ name: 'Audio' });
      await addAudioClip({ trackId: audioTrack, assetId: 'rec-old', startPpq: 0, lengthPpq: 12 });
      clearHistory();

      const [id] = addRecordedAudioClips([
        { trackId: audioTrack, assetId: 'rec-new', startPpq: 4, lengthPpq: 4, name: 'Take' },
      ]);

      expect(lane(audioTrack)).toEqual([
        [0, 4],
        [4, 8],
        [8, 12],
      ]);
      expect(store.clips.find((clip) => clip.id === id)).toMatchObject({ assetId: 'rec-new' });
      expect(undo()).toBe(true);
      expect(lane(audioTrack)).toEqual([[0, 12]]);
    });
  });

  describe('drawing without an open clip', () => {
    it('fills only the gap between neighbouring clips', () => {
      midi(0, 8);
      midi(16, 8);
      clearActiveClipSelection(trackId);
      clearHistory();

      applyNoteEdits({
        additions: [{ pitch: 60, startPpq: 10, durationPpq: 1 }],
      });

      expect(lane()).toEqual([
        [0, 8],
        [8, 12],
        [16, 24],
      ]);
    });

    it('refuses a draw on top of a clip before touching the Project', () => {
      midi(0, 8);
      clearActiveClipSelection(trackId);
      clearHistory();
      expect(() =>
        applyNoteEdits({ additions: [{ pitch: 60, startPpq: 2, durationPpq: 1 }] }),
      ).toThrow(RangeError);
      expect(lane()).toEqual([[0, 8]]);
      expect(canUndo()).toBe(false);
    });

    it('refuses a draw whose note starts inside the next clip', () => {
      midi(8, 8);
      clearActiveClipSelection(trackId);
      clearHistory();
      expect(() =>
        applyNoteEdits({
          additions: [
            { pitch: 60, startPpq: 1, durationPpq: 1 },
            { pitch: 62, startPpq: 9, durationPpq: 1 },
          ],
        }),
      ).toThrow(RangeError);
      expect(lane()).toEqual([[8, 16]]);
      expect(canUndo()).toBe(false);
    });
  });

  describe('note edits on a trimmed clip', () => {
    it('does not regrow a clip when an unrelated note changes', () => {
      const clipId = midi(0, 32);
      setActiveClip(clipId);
      const visible = addNote({ pitch: 60, startPpq: 1, durationPpq: 1 });
      const tail = addNote({ pitch: 62, startPpq: 30, durationPpq: 1 });
      updateNotes([{ id: tail, durationPpq: 3 }]);
      expect(store.activeClip?.lengthPpq).toBeGreaterThan(32);
      trimClip(clipId, 0, 16);
      expect(store.activeClip?.lengthPpq).toBe(16);

      updateNotes([{ id: visible, velocity: 40 }]);

      expect(store.activeClip?.lengthPpq).toBe(16);
    });
  });

  describe('warped audio clips', () => {
    const warped = async (startPpq: number, lengthPpq: number, assetId: string) => {
      await saveAsset({ id: assetId, name: assetId, sampleRate: 4 }, [new Float32Array(64)]);
      const audioTrack =
        store.tracks.find((track) => track.kind === 'audio')?.id ?? addAudioTrack();
      const id = await addAudioClip({ trackId: audioTrack, assetId, startPpq, lengthPpq });
      setClipWarp(id, { enabled: true, sourceBpm: 120 });
      return { id, audioTrack };
    };

    it('duplicates a time window across a warped clip with every clip on its own map', async () => {
      const { id, audioTrack } = await warped(0, 8, 'warp-a');
      clearHistory();

      duplicateTime(2, 6);

      const doc = readDoc();
      const onTrack = doc.clips.filter((clip) => clip.trackId === audioTrack);
      expect(onTrack.length).toBeGreaterThanOrEqual(3);
      for (const clip of onTrack) expect(clip.warpRefId).toBe(clip.id);
      expect(doc.clips.find((clip) => clip.id === id)?.warpRefId).toBe(id);
      expect(lane(audioTrack)).toEqual([
        [0, 6],
        [6, 10],
        [10, 12],
      ]);
    });

    it('gives a duplicated warped clip its own warp map', async () => {
      const { id, audioTrack } = await warped(0, 8, 'warp-b');
      const copy = duplicateClip(id, 16);
      const doc = readDoc();
      expect(doc.clips.find((clip) => clip.id === copy)?.warpRefId).toBe(copy);
      expect(doc.clips.find((clip) => clip.id === id)?.warpRefId).toBe(id);
      expect(lane(audioTrack)).toEqual([
        [0, 8],
        [16, 24],
      ]);
    });

    it('extends a warped clip into its neighbour for a crossfade', async () => {
      const { id: left, audioTrack } = await warped(0, 4, 'warp-c');
      const right = await addAudioClip({
        trackId: audioTrack,
        assetId: 'warp-c',
        startPpq: 4,
        lengthPpq: 4,
      });

      crossfadeClips(left, right, { lengthPpq: 1, leftSourceEndPpq: 8 });

      expect(store.clips.find((clip) => clip.id === left)).toMatchObject({ lengthPpq: 5 });
      expect(readDoc().clips.find((clip) => clip.id === left)?.warpRefId).toBe(left);
    });
  });
});
