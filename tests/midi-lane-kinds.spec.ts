import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execute } from '@/project/command/history';
import {
  addMidiClip,
  addRecordedMidiClip,
  clearHistory,
  duplicateClip,
  glueMidiClips,
  splitClip,
  trimClip,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorClip, MidiClipTake } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

type LaneFields = Pick<
  EditorClip,
  'ccLanes' | 'pitchBendLanes' | 'programChangeLanes' | 'channelPressureLanes' | 'polyPressureLanes'
>;

describe('MIDI clip lane kinds', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  function setLanes(clipId: number, lanes: LaneFields): void {
    store.clips = store.clips.map((clip) => (clip.id === clipId ? { ...clip, ...lanes } : clip));
  }

  function clipById(clipId: number): EditorClip {
    const clip = store.clips.find((entry) => entry.id === clipId);
    if (!clip) throw new Error(`missing clip ${clipId}`);
    return clip;
  }

  function twoClips(): { first: number; second: number } {
    const trackId = store.tracks[0].id;
    const first = store.clipId;
    trimClip(first, 0, 4);
    const second = addMidiClip({ trackId, startPpq: 4, lengthPpq: 4, name: 'Second' });
    return { first, second };
  }

  describe('glueMidiClips', () => {
    it('merges lanes with the same identity key, keeps distinct keys apart and sorts them', () => {
      const { first, second } = twoClips();
      setLanes(first, {
        ccLanes: [
          { controller: 7, channel: 0, points: [{ ppq: 1, value: 5 }] },
          {
            controller: 1,
            channel: 0,
            points: [
              { ppq: 3, value: 20 },
              { ppq: 0, value: 10 },
            ],
          },
        ],
        pitchBendLanes: [{ channel: 1, points: [{ ppq: 0, value: 9000 }] }],
        programChangeLanes: [
          {
            channel: 0,
            points: [
              { ppq: 0, value: 0, program: 5.4 } as never,
              { ppq: 1, program: 5.6 },
              { ppq: 2, program: 200 },
              { ppq: 3, program: -1 },
            ],
          },
        ],
        channelPressureLanes: [{ channel: 2, points: [{ ppq: 1, value: 40 }] }],
        polyPressureLanes: [
          { channel: 0, pitch: 64, points: [{ ppq: 0, value: 10 }] },
          { channel: 0, pitch: 60, points: [{ ppq: 1, value: 20 }] },
        ],
      });
      setLanes(second, {
        ccLanes: [
          { controller: 1, channel: 0, points: [{ ppq: 1, value: 300 }] },
          { controller: 1, channel: 1, points: [{ ppq: 2, value: 9 }] },
        ],
        pitchBendLanes: [
          { channel: 1, points: [{ ppq: 1, value: 100 }] },
          { channel: 0, points: [{ ppq: 0, value: 20000 }] },
        ],
        programChangeLanes: [
          { channel: 1, points: [{ ppq: 0, program: 3 }] },
          { channel: 0, points: [{ ppq: 1, program: 10 }] },
        ],
        channelPressureLanes: [{ channel: 2, points: [{ ppq: 0, value: 50, curve: 'linear' }] }],
        polyPressureLanes: [
          { channel: 0, pitch: 64, points: [{ ppq: 1, value: 30 }] },
          { channel: 1, pitch: 60, points: [{ ppq: 0, value: 40 }] },
        ],
      });

      const joined = clipById(glueMidiClips([second, first]));

      expect(joined.ccLanes).toEqual([
        {
          controller: 1,
          channel: 0,
          points: [
            { ppq: 0, value: 10 },
            { ppq: 3, value: 20 },
            { ppq: 5, value: 127 },
          ],
        },
        { controller: 1, channel: 1, points: [{ ppq: 6, value: 9 }] },
        { controller: 7, channel: 0, points: [{ ppq: 1, value: 5 }] },
      ]);
      expect(joined.pitchBendLanes).toEqual([
        { channel: 0, points: [{ ppq: 4, value: 16383 }] },
        {
          channel: 1,
          points: [
            { ppq: 0, value: 9000 },
            { ppq: 5, value: 100 },
          ],
        },
      ]);
      expect(joined.programChangeLanes).toEqual([
        {
          channel: 0,
          points: [
            { ppq: 0, program: 5 },
            { ppq: 1, program: 6 },
            { ppq: 5, program: 10 },
          ],
        },
        { channel: 1, points: [{ ppq: 4, program: 3 }] },
      ]);
      expect(joined.channelPressureLanes).toEqual([
        {
          channel: 2,
          points: [
            { ppq: 1, value: 40 },
            { ppq: 4, value: 50, curve: 'linear' },
          ],
        },
      ]);
      expect(joined.polyPressureLanes).toEqual([
        { channel: 0, pitch: 60, points: [{ ppq: 1, value: 20 }] },
        {
          channel: 0,
          pitch: 64,
          points: [
            { ppq: 0, value: 10 },
            { ppq: 5, value: 30 },
          ],
        },
        { channel: 1, pitch: 60, points: [{ ppq: 4, value: 40 }] },
      ]);
    });

    it('drops points outside the source clip window and omits kinds that end up empty', () => {
      const { first, second } = twoClips();
      setLanes(first, {
        ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 4.5, value: 10 }] }],
        pitchBendLanes: [{ channel: 0, points: [{ ppq: -1, value: 10 }] }],
        programChangeLanes: [{ channel: 0, points: [{ ppq: 9, program: 1 }] }],
        channelPressureLanes: [{ channel: 0, points: [] }],
        polyPressureLanes: [{ channel: 0, pitch: 60, points: [{ ppq: 4.1, value: 1 }] }],
      });
      setLanes(second, {
        ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 2, value: 70 }] }],
      });

      const joined = clipById(glueMidiClips([first, second]));

      expect(joined.ccLanes).toEqual([
        { controller: 1, channel: 0, points: [{ ppq: 6, value: 70 }] },
      ]);
      expect('pitchBendLanes' in joined).toBe(false);
      expect('programChangeLanes' in joined).toBe(false);
      expect('channelPressureLanes' in joined).toBe(false);
      expect('polyPressureLanes' in joined).toBe(false);
    });

    it('rounds program numbers before the range check and keeps same-position points', () => {
      const { first, second } = twoClips();
      setLanes(first, {
        programChangeLanes: [
          {
            channel: 0,
            points: [
              { ppq: 2, program: 127.4 },
              { ppq: 2, program: 127.6 },
              { ppq: 1, program: -0.4 },
              { ppq: 0, program: Number.NaN },
            ],
          },
        ],
      });

      const joined = clipById(glueMidiClips([first, second]));

      expect(joined.programChangeLanes).toEqual([
        {
          channel: 0,
          points: [
            { ppq: 1, program: -0 },
            { ppq: 2, program: 127 },
          ],
        },
      ]);
    });
  });

  describe('derived clip and take metadata', () => {
    function laneTake(): MidiClipTake {
      return {
        name: 'Take',
        notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
        ccLanes: [
          {
            controller: 1,
            channel: 0,
            points: [
              { ppq: 1, value: 10 },
              { ppq: 5, value: 20 },
            ],
          },
          { controller: 2, channel: 0, points: [{ ppq: 6, value: 30 }] },
        ],
        pitchBendLanes: [
          { channel: 0, points: [{ ppq: 2, value: 9000 }] },
          { channel: 1, points: [{ ppq: 7, value: 100 }] },
        ],
        programChangeLanes: [{ channel: 0, points: [{ ppq: 6, program: 12 }] }],
        channelPressureLanes: [{ channel: 0, points: [{ ppq: 3, value: 33 }] }],
        polyPressureLanes: [{ channel: 0, pitch: 60, points: [{ ppq: 5, value: 44 }] }],
      };
    }

    function laneClipFields(): LaneFields {
      const take = laneTake();
      return {
        ccLanes: take.ccLanes,
        pitchBendLanes: take.pitchBendLanes,
        programChangeLanes: take.programChangeLanes,
        channelPressureLanes: take.channelPressureLanes,
        polyPressureLanes: take.polyPressureLanes,
      };
    }

    function addLaneClip(): number {
      const take = laneTake();
      const clipId = addRecordedMidiClip({
        trackId: store.tracks[0].id,
        startPpq: 8,
        lengthPpq: 8,
        notes: take.notes,
        midiTakes: [take],
      });
      setLanes(clipId, laneClipFields());
      return clipId;
    }

    it('splits every lane kind into the two windows and omits kinds with no points', () => {
      const clipId = addLaneClip();
      const rightId = splitClip(clipId, 12);
      const left = clipById(clipId);
      const right = clipById(rightId);

      expect(left.ccLanes).toEqual([
        { controller: 1, channel: 0, points: [{ ppq: 1, value: 10 }] },
      ]);
      expect(left.pitchBendLanes).toEqual([{ channel: 0, points: [{ ppq: 2, value: 9000 }] }]);
      expect(left.channelPressureLanes).toEqual([{ channel: 0, points: [{ ppq: 3, value: 33 }] }]);
      expect('programChangeLanes' in left).toBe(false);
      expect('polyPressureLanes' in left).toBe(false);

      expect(right.ccLanes).toEqual([
        {
          controller: 1,
          channel: 0,
          points: [
            { ppq: 0, value: 10 },
            { ppq: 1, value: 20 },
          ],
        },
        { controller: 2, channel: 0, points: [{ ppq: 2, value: 30 }] },
      ]);
      expect(right.pitchBendLanes).toEqual([
        { channel: 0, points: [{ ppq: 0, value: 9000 }] },
        { channel: 1, points: [{ ppq: 3, value: 100 }] },
      ]);
      expect(right.programChangeLanes).toEqual([{ channel: 0, points: [{ ppq: 2, program: 12 }] }]);
      expect(right.channelPressureLanes).toEqual([{ channel: 0, points: [{ ppq: 0, value: 33 }] }]);
      expect(right.polyPressureLanes).toEqual([
        { channel: 0, pitch: 60, points: [{ ppq: 1, value: 44 }] },
      ]);
    });

    it('transforms take lanes with the clip window and omits empty kinds', () => {
      const clipId = addLaneClip();
      const rightId = splitClip(clipId, 12);
      const leftTake = clipById(clipId).midiTakes?.[0] as MidiClipTake;
      const rightTake = clipById(rightId).midiTakes?.[0] as MidiClipTake;

      expect(leftTake.ccLanes).toEqual([
        { controller: 1, channel: 0, points: [{ ppq: 1, value: 10 }] },
      ]);
      expect(leftTake.pitchBendLanes).toEqual([{ channel: 0, points: [{ ppq: 2, value: 9000 }] }]);
      expect(leftTake.channelPressureLanes).toEqual([
        { channel: 0, points: [{ ppq: 3, value: 33 }] },
      ]);
      expect('programChangeLanes' in leftTake).toBe(false);
      expect('polyPressureLanes' in leftTake).toBe(false);

      expect(rightTake.ccLanes).toEqual([
        {
          controller: 1,
          channel: 0,
          points: [
            { ppq: 0, value: 10 },
            { ppq: 1, value: 20 },
          ],
        },
        { controller: 2, channel: 0, points: [{ ppq: 2, value: 30 }] },
      ]);
      expect(rightTake.pitchBendLanes).toEqual([
        { channel: 0, points: [{ ppq: 0, value: 9000 }] },
        { channel: 1, points: [{ ppq: 3, value: 100 }] },
      ]);
      expect(rightTake.programChangeLanes).toEqual([
        { channel: 0, points: [{ ppq: 2, program: 12 }] },
      ]);
      expect(rightTake.channelPressureLanes).toEqual([
        { channel: 0, points: [{ ppq: 0, value: 33 }] },
      ]);
      expect(rightTake.polyPressureLanes).toEqual([
        { channel: 0, pitch: 60, points: [{ ppq: 1, value: 44 }] },
      ]);
    });

    it('duplicates every lane kind without sharing lane or point objects', () => {
      const clipId = addLaneClip();
      const source = clipById(clipId);
      const copy = clipById(duplicateClip(clipId, 32));

      expect(copy.ccLanes).toEqual(source.ccLanes);
      expect(copy.pitchBendLanes).toEqual(source.pitchBendLanes);
      expect(copy.programChangeLanes).toEqual(source.programChangeLanes);
      expect(copy.channelPressureLanes).toEqual(source.channelPressureLanes);
      expect(copy.polyPressureLanes).toEqual(source.polyPressureLanes);
      expect(copy.polyPressureLanes?.[0]).not.toBe(source.polyPressureLanes?.[0]);
      expect(copy.polyPressureLanes?.[0].points).not.toBe(source.polyPressureLanes?.[0].points);
      expect(copy.midiTakes?.[0].polyPressureLanes).toEqual(
        source.midiTakes?.[0].polyPressureLanes,
      );
    });
  });

  describe('history snapshots', () => {
    function touch(clipId: number): void {
      execute(0, () => {
        store.clips = store.clips.map((clip) =>
          clip.id === clipId ? { ...clip, name: 'Renamed' } : clip,
        );
      });
    }

    it('restores clip and take lanes of every kind on undo', () => {
      const take: MidiClipTake = {
        name: 'Take',
        notes: [],
        ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 1, value: 10 }] }],
        pitchBendLanes: [{ channel: 0, points: [{ ppq: 1, value: 9000 }] }],
        programChangeLanes: [{ channel: 0, points: [{ ppq: 1, program: 4 }] }],
        channelPressureLanes: [{ channel: 0, points: [{ ppq: 1, value: 30 }] }],
        polyPressureLanes: [{ channel: 0, pitch: 60, points: [{ ppq: 1, value: 40 }] }],
      };
      const clipId = addRecordedMidiClip({
        trackId: store.tracks[0].id,
        startPpq: 8,
        lengthPpq: 8,
        notes: [],
        midiTakes: [take],
      });
      setLanes(clipId, {
        ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 2, value: 11 }] }],
        pitchBendLanes: [{ channel: 1, points: [{ ppq: 2, value: 9001 }] }],
        programChangeLanes: [{ channel: 1, points: [{ ppq: 2, program: 5 }] }],
        channelPressureLanes: [{ channel: 1, points: [{ ppq: 2, value: 31 }] }],
        polyPressureLanes: [{ channel: 1, pitch: 61, points: [{ ppq: 2, value: 41 }] }],
      });

      touch(clipId);
      expect(clipById(clipId).name).toBe('Renamed');
      expect(undo()).toBe(true);

      const restored = clipById(clipId);
      expect(restored.ccLanes).toEqual([
        { controller: 1, channel: 0, points: [{ ppq: 2, value: 11 }] },
      ]);
      expect(restored.pitchBendLanes).toEqual([{ channel: 1, points: [{ ppq: 2, value: 9001 }] }]);
      expect(restored.programChangeLanes).toEqual([
        { channel: 1, points: [{ ppq: 2, program: 5 }] },
      ]);
      expect(restored.channelPressureLanes).toEqual([
        { channel: 1, points: [{ ppq: 2, value: 31 }] },
      ]);
      expect(restored.polyPressureLanes).toEqual([
        { channel: 1, pitch: 61, points: [{ ppq: 2, value: 41 }] },
      ]);
      expect(restored.midiTakes?.[0]).toEqual(take);
    });

    it('drops empty clip lane lists but keeps empty take lane lists except cc', () => {
      const clipId = addRecordedMidiClip({
        trackId: store.tracks[0].id,
        startPpq: 8,
        lengthPpq: 8,
        notes: [],
        midiTakes: [
          {
            name: 'Take',
            notes: [],
            ccLanes: [{ controller: 1, channel: 0, points: [] }],
            pitchBendLanes: [{ channel: 0, points: [] }],
            programChangeLanes: [],
            channelPressureLanes: [],
            polyPressureLanes: [],
          },
        ],
      });
      setLanes(clipId, {
        ccLanes: [{ controller: 1, channel: 0, points: [] }],
        pitchBendLanes: [],
        programChangeLanes: [],
        channelPressureLanes: [],
        polyPressureLanes: [],
      });

      touch(clipId);
      expect(undo()).toBe(true);

      const restored = clipById(clipId);
      expect('ccLanes' in restored).toBe(false);
      expect('pitchBendLanes' in restored).toBe(false);
      expect('programChangeLanes' in restored).toBe(false);
      expect('channelPressureLanes' in restored).toBe(false);
      expect('polyPressureLanes' in restored).toBe(false);

      const restoredTake = restored.midiTakes?.[0] as MidiClipTake;
      expect(restoredTake.ccLanes).toBeUndefined();
      expect(restoredTake.pitchBendLanes).toEqual([{ channel: 0, points: [] }]);
      expect(restoredTake.programChangeLanes).toEqual([]);
      expect(restoredTake.channelPressureLanes).toEqual([]);
      expect(restoredTake.polyPressureLanes).toEqual([]);
    });
  });
});
