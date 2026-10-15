import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecordedMidiClip,
  clearHistory,
  setClipMidiActiveTake,
  setClipMidiCompSegments,
} from '@/project/commands';
import { loadProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import type { EditorClip, MidiClipTake } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const LANE_FIELDS = [
  'ccLanes',
  'pitchBendLanes',
  'programChangeLanes',
  'channelPressureLanes',
  'polyPressureLanes',
] as const;

type AnyRecord = Record<string, any>;

/** One non-empty lane per kind, points at the given ppq. */
function lanes(ppq: number, seed: number): Pick<MidiClipTake, (typeof LANE_FIELDS)[number]> {
  return {
    ccLanes: [{ controller: 7, channel: 0, points: [{ ppq, value: seed }] }],
    pitchBendLanes: [{ channel: 1, points: [{ ppq, value: 8192 + seed }] }],
    programChangeLanes: [{ channel: 2, points: [{ ppq, program: seed }] }],
    channelPressureLanes: [{ channel: 3, points: [{ ppq, value: seed }] }],
    polyPressureLanes: [{ channel: 4, pitch: 60, points: [{ ppq, value: seed }] }],
  };
}

function take(name: string, ppq: number, seed: number): MidiClipTake {
  return {
    name,
    notes: [{ pitch: 60 + seed, velocity: 90, startPpq: ppq, durationPpq: 1, channel: 0 }],
    ...lanes(ppq, seed),
  };
}

describe('MIDI lane kinds across load, refresh, serialize and recording', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  function clipNamed(clipId: number): EditorClip {
    const clip = store.clips.find((entry) => entry.id === clipId);
    if (!clip) throw new Error(`missing clip ${clipId}`);
    return clip;
  }

  function documentClip(clipId: number): AnyRecord {
    const document = JSON.parse(JSON.stringify(serializeProject()));
    return document.tracks[0].clips.find((c: AnyRecord) => c.name === `Clip ${clipId}`);
  }

  describe('recording a clip', () => {
    it('copies input lanes of every kind onto the clip', () => {
      const trackId = store.tracks[0].id;
      const input = lanes(1, 20);
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        ...input,
      });
      const clip = clipNamed(clipId);
      for (const field of LANE_FIELDS) {
        expect(clip[field]).toEqual(input[field]);
        expect(clip[field]).not.toBe(input[field]);
      }
    });

    it('prefers the active take lanes per kind and falls back to the input lanes', () => {
      const trackId = store.tracks[0].id;
      const partial = take('Take 2', 2, 30);
      delete partial.pitchBendLanes;
      delete partial.polyPressureLanes;
      const input = lanes(1, 20);
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        ...input,
        midiTakes: [take('Take 1', 0, 10), partial],
      });
      const clip = clipNamed(clipId);
      expect(clip.ccLanes).toEqual(partial.ccLanes);
      expect(clip.programChangeLanes).toEqual(partial.programChangeLanes);
      expect(clip.channelPressureLanes).toEqual(partial.channelPressureLanes);
      expect(clip.pitchBendLanes).toEqual(input.pitchBendLanes);
      expect(clip.polyPressureLanes).toEqual(input.polyPressureLanes);
    });

    it('seeds a clip entry from lanes of a single kind only', () => {
      const trackId = store.tracks[0].id;
      for (const field of LANE_FIELDS) {
        const clipId = addRecordedMidiClip({
          trackId,
          startPpq: 0,
          lengthPpq: 4,
          notes: [],
          [field]: lanes(1, 20)[field],
        });
        const clip = clipNamed(clipId);
        for (const other of LANE_FIELDS) {
          if (other === field) expect(clip[other]).toEqual(lanes(1, 20)[other]);
          else expect(clip[other]).toBeUndefined();
        }
      }
    });

    it('deep-copies take lanes, keeping empty cc lanes and extra lane properties', () => {
      const trackId = store.tracks[0].id;
      const first = take('Take 1', 0, 10);
      first.ccLanes = [
        { controller: 7, channel: 0, points: [{ ppq: 0, value: 10 }] },
        { controller: 11, channel: 0, points: [] },
      ];
      (first.pitchBendLanes as AnyRecord[])[0].extra = 'kept';
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        midiTakes: [first, take('Take 2', 2, 30)],
      });
      const stored = clipNamed(clipId).midiTakes!;
      expect(stored[0]).toEqual(first);
      for (const field of LANE_FIELDS) {
        expect(stored[0][field]).not.toBe(first[field]);
        expect(stored[0][field]![0].points).not.toBe(first[field]![0].points);
      }
      store.refresh();
      expect(clipNamed(clipId).midiTakes![0]).toEqual(first);
    });
  });

  describe('switching and comping takes', () => {
    function recordTwoTakes(): { clipId: number; first: MidiClipTake } {
      const trackId = store.tracks[0].id;
      const first = take('Take 1', 0, 10);
      first.ccLanes = [
        { controller: 7, channel: 0, points: [{ ppq: 0, value: 10 }] },
        { controller: 11, channel: 0, points: [] },
      ];
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        midiTakes: [first, take('Take 2', 2, 30)],
      });
      return { clipId, first };
    }

    it('replaces the clip lanes of every kind with the chosen take', () => {
      const { clipId, first } = recordTwoTakes();
      setClipMidiActiveTake(clipId, 0);
      const clip = clipNamed(clipId);
      expect(clip.ccLanes).toEqual([first.ccLanes![0]]);
      for (const field of LANE_FIELDS.slice(1)) expect(clip[field]).toEqual(first[field]);
      expect(clip.midiTakes![0]).toEqual(first);
      setClipMidiActiveTake(clipId, 1);
      for (const field of LANE_FIELDS)
        expect(clipNamed(clipId)[field]).toEqual(lanes(2, 30)[field]);
    });

    it('drops lane kinds the chosen take does not carry', () => {
      const trackId = store.tracks[0].id;
      const sparse = take('Take 2', 2, 30);
      delete sparse.programChangeLanes;
      delete sparse.polyPressureLanes;
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        midiTakes: [take('Take 1', 0, 10), sparse],
      });
      setClipMidiActiveTake(clipId, 0);
      expect(clipNamed(clipId).programChangeLanes).toBeDefined();
      setClipMidiActiveTake(clipId, 1);
      const clip = clipNamed(clipId);
      expect(clip.programChangeLanes).toBeUndefined();
      expect(clip.polyPressureLanes).toBeUndefined();
      expect(clip.ccLanes).toEqual(sparse.ccLanes);
    });

    it('composes lanes of every kind from the selected ranges', () => {
      const { clipId } = recordTwoTakes();
      setClipMidiCompSegments(clipId, [
        { startPpq: 0, takeIndex: 0 },
        { startPpq: 2, takeIndex: 1 },
      ]);
      const clip = clipNamed(clipId);
      const [a, b] = [lanes(0, 10), lanes(2, 30)];
      for (const field of LANE_FIELDS) {
        const expected = [...a[field]!, ...b[field]!];
        expect(clip[field]).toEqual(expected);
      }
    });

    it('omits kinds the selected takes do not carry', () => {
      const trackId = store.tracks[0].id;
      const sparse = take('Take 2', 2, 30);
      delete sparse.pitchBendLanes;
      delete sparse.polyPressureLanes;
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        midiTakes: [take('Take 1', 0, 10), sparse],
      });
      setClipMidiCompSegments(clipId, [{ startPpq: 0, takeIndex: 1 }]);
      const clip = clipNamed(clipId);
      expect(clip.pitchBendLanes).toBeUndefined();
      expect(clip.polyPressureLanes).toBeUndefined();
      expect(clip.ccLanes).toEqual(sparse.ccLanes);
      expect(clip.programChangeLanes).toEqual(sparse.programChangeLanes);
      expect(clip.channelPressureLanes).toEqual(sparse.channelPressureLanes);
    });
  });

  describe('serializing', () => {
    it('writes clip lanes of every kind, dropping empty cc lanes and empty lists only', () => {
      const trackId = store.tracks[0].id;
      const clipId = addRecordedMidiClip({ trackId, startPpq: 0, lengthPpq: 4, notes: [] });
      store.clips = store.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              ccLanes: [
                { controller: 7, channel: 0, points: [{ ppq: 0, value: 10 }] },
                { controller: 11, channel: 0, points: [] },
              ],
              pitchBendLanes: [{ channel: 1, points: [] }],
              programChangeLanes: [],
              channelPressureLanes: [{ channel: 3, points: [{ ppq: 0, value: 5 }] }],
              polyPressureLanes: [{ channel: 4, pitch: 60, points: [{ ppq: 1, value: 6 }] }],
            }
          : clip,
      );
      const doc = documentClip(clipId);
      expect(doc.ccLanes).toEqual([{ controller: 7, channel: 0, points: [{ ppq: 0, value: 10 }] }]);
      expect(doc.pitchBendLanes).toEqual([{ channel: 1, points: [] }]);
      expect(doc.programChangeLanes).toBeUndefined();
      expect(doc.channelPressureLanes).toEqual([{ channel: 3, points: [{ ppq: 0, value: 5 }] }]);
      expect(doc.polyPressureLanes).toEqual([
        { channel: 4, pitch: 60, points: [{ ppq: 1, value: 6 }] },
      ]);
    });

    it('keeps clip lanes across a store refresh', () => {
      const trackId = store.tracks[0].id;
      const input = lanes(1, 20);
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        ...input,
      });
      store.refresh();
      for (const field of LANE_FIELDS) expect(clipNamed(clipId)[field]).toEqual(input[field]);
    });

    it('writes take lanes verbatim, including empty cc lanes and extra properties', () => {
      const trackId = store.tracks[0].id;
      const first = take('Take 1', 0, 10);
      first.ccLanes = [{ controller: 11, channel: 0, points: [] }];
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        midiTakes: [first, take('Take 2', 2, 30)],
      });
      store.clips = store.clips.map((clip) => {
        if (clip.id !== clipId) return clip;
        const takes = clip.midiTakes!.map((t) => ({ ...t }));
        (takes[1].polyPressureLanes as AnyRecord[]) = [
          { ...takes[1].polyPressureLanes![0], extra: 1 },
        ];
        return { ...clip, midiTakes: takes };
      });
      const doc = documentClip(clipId);
      expect(doc.midiTakes[0].ccLanes).toEqual([{ controller: 11, channel: 0, points: [] }]);
      expect(doc.midiTakes[1].polyPressureLanes).toEqual([
        { channel: 4, pitch: 60, extra: 1, points: [{ ppq: 2, value: 30 }] },
      ]);
      for (const field of LANE_FIELDS.slice(1)) {
        expect(doc.midiTakes[0][field]).toEqual(first[field]);
      }
    });

    it('round-trips clip and take lanes through a document load', async () => {
      const trackId = store.tracks[0].id;
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        midiTakes: [take('Take 1', 0, 10), take('Take 2', 2, 30)],
      });
      const before = JSON.parse(JSON.stringify(serializeProject()));
      await loadProjectDocument(before);
      const after = JSON.parse(JSON.stringify(serializeProject()));
      expect(after).toEqual(before);
      const clip = store.clips.find((entry) => entry.name === `Clip ${clipId}`)!;
      for (const field of LANE_FIELDS) {
        expect(clip[field]).toEqual(lanes(2, 30)[field]);
        expect(clip.midiTakes![0][field]).toEqual(lanes(0, 10)[field]);
      }
    });
  });

  describe('loading a document', () => {
    async function loadWith(patch: (clip: AnyRecord) => void): Promise<EditorClip> {
      const trackId = store.tracks[0].id;
      const clipId = addRecordedMidiClip({ trackId, startPpq: 0, lengthPpq: 4, notes: [] });
      const doc = JSON.parse(JSON.stringify(serializeProject()));
      patch(doc.tracks[0].clips.find((c: AnyRecord) => c.name === `Clip ${clipId}`));
      await loadProjectDocument(doc);
      return store.clips.find((entry) => entry.name === `Clip ${clipId}`)!;
    }

    it('sanitizes, filters and sorts clip lanes of every kind', async () => {
      const clip = await loadWith((c) => {
        c.ccLanes = [
          { controller: 11, channel: 0, points: [{ ppq: 1, value: 5 }] },
          { controller: 7, channel: 0, points: [{ ppq: 0, value: 9 }] },
          { controller: 7, channel: 99, points: [{ ppq: 0, value: 9 }] },
          { controller: 8, channel: 0, points: [] },
        ];
        c.pitchBendLanes = [
          { channel: 5, points: [{ ppq: 1, value: 9000 }] },
          { channel: 2, points: [{ ppq: 0, value: 8000 }] },
          { channel: 99, points: [{ ppq: 0, value: 8000 }] },
        ];
        c.programChangeLanes = [
          {
            channel: 5,
            points: [
              { ppq: 2, program: 3 },
              { ppq: 1, program: 4 },
            ],
          },
          { channel: 1, points: [{ ppq: 0, program: 200 }] },
          { channel: 0, points: [{ ppq: 0, program: 9 }] },
        ];
        c.channelPressureLanes = [
          { channel: 6, points: [{ ppq: 1, value: 40 }] },
          { channel: 3, points: [{ ppq: 0, value: 30 }] },
          { channel: -1, points: [{ ppq: 0, value: 30 }] },
        ];
        c.polyPressureLanes = [
          { channel: 4, pitch: 70, points: [{ ppq: 1, value: 40 }] },
          { channel: 4, pitch: 60, points: [{ ppq: 0, value: 30 }] },
          { channel: 4, pitch: 300, points: [{ ppq: 0, value: 30 }] },
          { channel: 1, pitch: 90, points: [{ ppq: 0, value: 30 }] },
        ];
      });
      expect(clip.ccLanes).toEqual([
        { controller: 7, channel: 0, points: [{ ppq: 0, value: 9 }] },
        { controller: 11, channel: 0, points: [{ ppq: 1, value: 5 }] },
      ]);
      expect(clip.pitchBendLanes).toEqual([
        { channel: 2, points: [{ ppq: 0, value: 8000 }] },
        { channel: 5, points: [{ ppq: 1, value: 9000 }] },
      ]);
      expect(clip.programChangeLanes).toEqual([
        { channel: 0, points: [{ ppq: 0, program: 9 }] },
        {
          channel: 5,
          points: [
            { ppq: 1, program: 4 },
            { ppq: 2, program: 3 },
          ],
        },
      ]);
      expect(clip.channelPressureLanes).toEqual([
        { channel: 3, points: [{ ppq: 0, value: 30 }] },
        { channel: 6, points: [{ ppq: 1, value: 40 }] },
      ]);
      expect(clip.polyPressureLanes).toEqual([
        { channel: 1, pitch: 90, points: [{ ppq: 0, value: 30 }] },
        { channel: 4, pitch: 60, points: [{ ppq: 0, value: 30 }] },
        { channel: 4, pitch: 70, points: [{ ppq: 1, value: 40 }] },
      ]);
    });

    it('drops a kind whose lanes are all invalid', async () => {
      const clip = await loadWith((c) => {
        for (const field of LANE_FIELDS) c[field] = [{ channel: 99, controller: 99, points: [] }];
      });
      for (const field of LANE_FIELDS) expect(clip[field]).toBeUndefined();
    });

    it('restores take lanes of every kind as copies, keeping extra lane properties', async () => {
      const doc = JSON.parse(JSON.stringify(serializeProject()));
      const trackId = store.tracks[0].id;
      const clipId = addRecordedMidiClip({
        trackId,
        startPpq: 0,
        lengthPpq: 4,
        notes: [],
        midiTakes: [take('Take 1', 0, 10), take('Take 2', 2, 30)],
      });
      doc.tracks = JSON.parse(JSON.stringify(serializeProject())).tracks;
      const target = doc.tracks[0].clips.find((c: AnyRecord) => c.name === `Clip ${clipId}`);
      target.midiTakes[0].ccLanes = [
        { controller: 7, channel: 0, extra: 'x', points: [{ ppq: 0, value: 1, more: true }] },
        { controller: 8, channel: 0, points: [] },
      ];
      delete target.midiTakes[0].polyPressureLanes;
      await loadProjectDocument(doc);
      const clip = store.clips.find((entry) => entry.name === `Clip ${clipId}`)!;
      expect(clip.midiTakes![0].ccLanes).toEqual([
        { controller: 7, channel: 0, extra: 'x', points: [{ ppq: 0, value: 1, more: true }] },
        { controller: 8, channel: 0, points: [] },
      ]);
      expect(clip.midiTakes![0].polyPressureLanes).toBeUndefined();
      for (const field of LANE_FIELDS.slice(1, 4)) {
        expect(clip.midiTakes![0][field]).toEqual(lanes(0, 10)[field]);
      }
      expect(clip.midiTakes![1].polyPressureLanes).toEqual(lanes(2, 30).polyPressureLanes);
    });
  });
});
