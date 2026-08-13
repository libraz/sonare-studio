import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecordedMidiClip,
  clearHistory,
  duplicateClip,
  duplicateTime,
  setClipMidiActiveTake,
  setClipMidiCompSegments,
  splitClip,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { MidiClipTake } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('derived MIDI cycle-take metadata', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  function cycleTakes(): MidiClipTake[] {
    return [
      {
        name: 'Pass 1',
        notes: [
          { pitch: 60, velocity: 90, startPpq: 1, durationPpq: 1, channel: 0 },
          // This sustain crosses the split boundary and must be clipped in
          // the derived take while keeping its source-relative start.
          { pitch: 62, velocity: 88, startPpq: 3, durationPpq: 4, channel: 0 },
        ],
        ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 5, value: 55 }] }],
      },
      {
        name: 'Pass 2',
        notes: [
          { pitch: 65, velocity: 86, startPpq: 2, durationPpq: 1, channel: 0 },
          { pitch: 67, velocity: 84, startPpq: 5, durationPpq: 2, channel: 0 },
          { pitch: 69, velocity: 82, startPpq: 7, durationPpq: 1, channel: 0 },
        ],
        ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 7, value: 77 }] }],
      },
    ];
  }

  function addCycleClip(): number {
    const takes = cycleTakes();
    const clipId = addRecordedMidiClip({
      trackId: store.tracks[0].id,
      startPpq: 0,
      lengthPpq: 8,
      notes: takes[1].notes,
      midiTakes: takes,
      activeMidiTakeIndex: 1,
      name: 'Cycle phrase',
    });
    setClipMidiCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 4, takeIndex: 1, crossfadePpq: 0.125 },
      { startPpq: 6, takeIndex: 0 },
    ]);
    return clipId;
  }

  it('duplicates all MIDI takes, active index, source notes and comp ranges', () => {
    const sourceId = addCycleClip();
    const source = store.clips.find((clip) => clip.id === sourceId)!;

    const copyId = duplicateClip(sourceId, 16);
    const copy = store.clips.find((clip) => clip.id === copyId)!;

    expect(copy.midiTakes).toHaveLength(2);
    expect(copy.midiActiveTakeIndex).toBe(1);
    expect(copy.midiCompSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 4, takeIndex: 1, crossfadePpq: 0.125 },
      { startPpq: 6, takeIndex: 0 },
    ]);
    expect(copy.midiTakes?.map((take) => take.notes)).toEqual(
      source.midiTakes?.map((take) => take.notes),
    );
    expect(copy.midiTakes).not.toBe(source.midiTakes);
    expect(copy.midiTakes?.[0].notes).not.toBe(source.midiTakes?.[0].notes);
  });

  it('splits MIDI takes into source-relative windows and rebases comp ranges', () => {
    const sourceId = addCycleClip();
    const rightId = splitClip(sourceId, 4);
    const left = store.clips.find((clip) => clip.id === sourceId)!;
    const right = store.clips.find((clip) => clip.id === rightId)!;

    expect(left.midiTakes).toHaveLength(2);
    expect(left.midiTakes?.[0].notes).toEqual([
      { pitch: 60, velocity: 90, startPpq: 1, durationPpq: 1, channel: 0 },
      { pitch: 62, velocity: 88, startPpq: 3, durationPpq: 1, channel: 0 },
    ]);
    expect(left.midiCompSegments).toEqual([{ startPpq: 0, takeIndex: 0 }]);

    expect(right.midiTakes).toHaveLength(2);
    expect(right.midiTakes?.[0].notes).toEqual([
      { pitch: 62, velocity: 88, startPpq: 4, durationPpq: 3, channel: 0 },
    ]);
    expect(right.midiTakes?.[1].notes).toEqual([
      { pitch: 67, velocity: 84, startPpq: 5, durationPpq: 2, channel: 0 },
      { pitch: 69, velocity: 82, startPpq: 7, durationPpq: 1, channel: 0 },
    ]);
    expect(right.midiActiveTakeIndex).toBe(1);
    expect(right.midiCompSegments).toEqual([
      { startPpq: 0, takeIndex: 1, crossfadePpq: 0.125 },
      { startPpq: 2, takeIndex: 0 },
    ]);

    // Switching the derived clip must write source-relative events. A right
    // split starts at source PPQ 4, so none of its native notes may land back
    // in the discarded [0, 4) source range.
    setClipMidiActiveTake(rightId, 0);
    const switched = store.clips.find((clip) => clip.id === rightId)!;
    expect(switched.notes).toEqual([
      { id: expect.any(Number), pitch: 62, velocity: 88, startPpq: 4, durationPpq: 3, channel: 0 },
    ]);
    expect(
      switched.notes.every(
        (note) =>
          note.startPpq >= switched.sourceOffsetPpq &&
          note.startPpq + note.durationPpq <= switched.sourceOffsetPpq + switched.lengthPpq,
      ),
    ).toBe(true);
  });

  it('keeps MIDI take metadata on a duplicate-time ripple window', () => {
    addCycleClip();

    duplicateTime(2, 6);

    const copy = store.clips.find(
      (clip) => clip.midiTakes !== undefined && clip.startPpq === 6 && clip.lengthPpq === 4,
    )!;
    expect(copy).toMatchObject({ startPpq: 6, lengthPpq: 4, sourceOffsetPpq: 2 });
    expect(copy.midiTakes).toHaveLength(2);
    expect(copy.midiActiveTakeIndex).toBe(1);
    expect(copy.midiTakes?.[0].notes).toEqual([
      { pitch: 62, velocity: 88, startPpq: 3, durationPpq: 3, channel: 0 },
    ]);
    expect(copy.midiTakes?.[1].notes).toEqual([
      { pitch: 65, velocity: 86, startPpq: 2, durationPpq: 1, channel: 0 },
      { pitch: 67, velocity: 84, startPpq: 5, durationPpq: 1, channel: 0 },
    ]);
    expect(copy.midiCompSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1, crossfadePpq: 0.125 },
    ]);
  });

  it('comps a right split using source-relative take notes and local lanes', () => {
    const sourceId = addCycleClip();
    const rightId = splitClip(sourceId, 4);

    setClipMidiCompSegments(rightId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);

    const right = store.clips.find((clip) => clip.id === rightId)!;
    expect(right.midiCompSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
    expect(right.notes).toEqual([
      { id: expect.any(Number), pitch: 62, velocity: 88, startPpq: 4, durationPpq: 2, channel: 0 },
      { id: expect.any(Number), pitch: 67, velocity: 84, startPpq: 6, durationPpq: 1, channel: 0 },
      { id: expect.any(Number), pitch: 69, velocity: 82, startPpq: 7, durationPpq: 1, channel: 0 },
    ]);
    expect(right.ccLanes).toEqual([
      { controller: 1, channel: 0, points: [{ ppq: 1, value: 55 }] },
      { controller: 1, channel: 0, points: [{ ppq: 3, value: 77 }] },
    ]);
    expect(
      right.notes.every(
        (note) =>
          note.startPpq >= right.sourceOffsetPpq &&
          note.startPpq + note.durationPpq <= right.sourceOffsetPpq + right.lengthPpq,
      ),
    ).toBe(true);
  });
});
