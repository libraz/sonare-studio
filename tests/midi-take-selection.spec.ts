import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecordedMidiClip,
  clearHistory,
  flattenClipMidiComp,
  redo,
  setClipMidiActiveTake,
  setClipMidiCompSegments,
  undo,
} from '@/project/commands';
import { loadProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import type { ClipCompSegment, EditorClip, MidiClipTake } from '@/project/types';
import type { ClipPoint } from '@/ui/arrangement/clip-hit';
import { type TakeLaneClip, useTakeInteractions } from '@/ui/arrangement/use-take-interactions';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** A one-bar take holding one note per bar of a 3-bar clip, all at one pitch. */
const take = (index: number): MidiClipTake => ({
  name: `Take ${index + 1}`,
  notes: [0, 4, 8].map((startPpq) => ({
    pitch: 60 + index,
    velocity: 90,
    startPpq,
    durationPpq: 1,
    channel: 0,
  })),
});

describe('MIDI take selection', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  const clip = (id: number): EditorClip => {
    const found = store.clips.find((entry) => entry.id === id);
    if (!found) throw new Error(`missing clip ${id}`);
    return found;
  };

  const recordThreeTakes = (): number =>
    addRecordedMidiClip({
      trackId: store.tracks[0].id,
      startPpq: 16,
      lengthPpq: 12,
      notes: [],
      midiTakes: [take(0), take(1), take(2)],
    });

  /** Drags across take row `takeIndex` over clip-relative [from, to). */
  const dragTake = (target: TakeLaneClip, takeIndex: number, from: number, to: number) => {
    const calls: Array<{ clipId: number; segments: ClipCompSegment[] }> = [];
    const at = (ppq: number): ClipPoint => ({ x: ppq, y: takeIndex * 10 + 5 });
    const takes = useTakeInteractions({
      view: {
        ppqToX: (ppq) => ppq,
        xToPpq: (x) => x,
        takeRowAt: (point) => ({ trackId: target.trackId, takeIndex: Math.floor(point.y / 10) }),
      },
      getClips: () => [target],
      commands: {
        setActiveTake: () => {},
        setCompSegments: () => {},
        setMidiCompSegments: (clipId, segments) => calls.push({ clipId, segments }),
      },
    });
    takes.onPointerDown(at(target.startPpq + from));
    takes.onPointerMove(at(target.startPpq + to));
    takes.onPointerUp(at(target.startPpq + to));
    return calls;
  };

  it('builds a comp drag on the playing take, leaving the rest of the clip unchanged', () => {
    const id = recordThreeTakes();
    expect(clip(id).midiActiveTakeIndex).toBe(2);

    const [call] = dragTake(clip(id), 1, 4, 8);
    expect(call.segments).toEqual([
      { startPpq: 0, takeIndex: 2 },
      { startPpq: 4, takeIndex: 1 },
      { startPpq: 8, takeIndex: 2 },
    ]);
    setClipMidiCompSegments(id, call.segments);
    expect(clip(id).notes.map((note) => note.pitch)).toEqual([62, 61, 62]);
  });

  it('clears the comp when a whole take is selected, across undo, redo and reload', async () => {
    const id = recordThreeTakes();
    setClipMidiCompSegments(id, [
      { startPpq: 0, takeIndex: 2 },
      { startPpq: 4, takeIndex: 1 },
    ]);
    expect(clip(id).midiCompSegments).toHaveLength(2);

    setClipMidiActiveTake(id, 0);
    expect(clip(id).midiCompSegments).toBeUndefined();
    expect(clip(id).midiActiveTakeIndex).toBe(0);
    expect(clip(id).notes.map((note) => note.pitch)).toEqual([60, 60, 60]);
    const [call] = dragTake(clip(id), 1, 0, 4);
    expect(call.segments).toEqual([
      { startPpq: 0, takeIndex: 1 },
      { startPpq: 4, takeIndex: 0 },
    ]);

    expect(undo()).toBe(true);
    expect(clip(id).midiCompSegments).toHaveLength(2);
    expect(redo()).toBe(true);
    expect(clip(id).midiCompSegments).toBeUndefined();

    await loadProjectDocument(JSON.parse(JSON.stringify(serializeProject())));
    const reloaded = store.clips.find((entry) => (entry.midiTakes?.length ?? 0) === 3);
    expect(reloaded?.midiCompSegments).toBeUndefined();
    expect(reloaded?.midiActiveTakeIndex).toBe(0);
    expect(reloaded?.notes.map((note) => note.pitch)).toEqual([60, 60, 60]);
  });

  it('refuses MIDI recording and take edits on a frozen track', () => {
    const id = recordThreeTakes();
    const trackId = store.tracks[0].id;
    const clipCount = store.clips.length;
    store.tracks = store.tracks.map((track) =>
      track.id === trackId ? { ...track, frozen: { assetId: 'render' } } : track,
    );

    expect(() => recordThreeTakes()).toThrow(/frozen/);
    expect(() => setClipMidiActiveTake(id, 0)).toThrow(/frozen/);
    expect(() => setClipMidiCompSegments(id, [{ startPpq: 0, takeIndex: 0 }])).toThrow(/frozen/);
    expect(() => flattenClipMidiComp(id)).toThrow(/frozen/);
    expect(store.clips).toHaveLength(clipCount);
    expect(clip(id).midiActiveTakeIndex).toBe(2);
  });
});
