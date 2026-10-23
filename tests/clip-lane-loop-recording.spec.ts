import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMidiClip,
  addNotes,
  addRecordedMidiClip,
  clearHistory,
  deleteClip,
  setActiveClip,
  setClipFades,
  setClipLoop,
  undo,
} from '@/project/commands';
import { projectMidiNoteOccurrences } from '@/project/midi-projection';
import { getProject, useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('recording over a looped clip', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    installMockOpfs();
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    (getProject() as unknown as { enforceClipLanes(): void }).enforceClipLanes();
    trackId = store.tracks[0].id;
    deleteClip(store.clips[0].id);
    clearHistory();
  });

  afterEach(() => {
    uninstallMockOpfs();
  });

  /** A 16-beat clip looping a 4-beat pass with one note per beat (pitches 60-63). */
  const loopClip = (startPpq = 0): number => {
    const id = addMidiClip({ trackId, startPpq, lengthPpq: 16 });
    setActiveClip(id);
    addNotes([0, 1, 2, 3].map((beat) => ({ pitch: 60 + beat, startPpq: beat, durationPpq: 0.5 })));
    setClipLoop(id, true, 4);
    return id;
  };

  /** Audible timeline notes on the track outside a range, excluding one clip. */
  const audibleOutside = (fromPpq: number, toPpq: number, excludeId = -1) =>
    store.clips
      .filter((clip) => clip.trackId === trackId && clip.id !== excludeId)
      .flatMap((clip) => projectMidiNoteOccurrences(clip))
      .filter((note) => note.startPpq < fromPpq || note.startPpq >= toPpq)
      .map((note) => [note.startPpq, note.pitch, note.durationPpq])
      .sort((a, b) => a[0] - b[0]);

  const record = (startPpq: number, lengthPpq: number): number =>
    addRecordedMidiClip({
      trackId,
      startPpq,
      lengthPpq,
      notes: [{ pitch: 72, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
    });

  it.each([
    ['inside both edges', 6, 4],
    ['across the clip start', 0, 2.5],
    ['across the clip end', 13.5, 6],
    ['on a pass boundary', 4, 4],
  ])(
    'lands the take %s and leaves the loop outside the range audibly unchanged',
    (_, start, length) => {
      loopClip();
      const before = audibleOutside(start, start + length);
      clearHistory();

      const takeId = record(start, length);

      const take = store.clips.find((clip) => clip.id === takeId);
      expect(take?.startPpq).toBe(start);
      expect(take?.notes.map((note) => note.pitch)).toEqual([72]);
      expect(audibleOutside(start, start + length, takeId)).toEqual(before);
      const lane = store.clips
        .filter((clip) => clip.trackId === trackId)
        .map((clip) => [clip.startPpq, clip.startPpq + clip.lengthPpq])
        .sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < lane.length; i += 1) {
        expect(lane[i][0]).toBeGreaterThanOrEqual(lane[i - 1][1] - 1e-9);
      }
      expect(lane[lane.length - 1][1]).toBe(Math.max(16, start + length));

      expect(undo()).toBe(true);
      expect(store.clips.filter((clip) => clip.trackId === trackId)).toHaveLength(1);
      expect(audibleOutside(start, start + length)).toEqual(before);
    },
  );

  it('keeps only the outer fades on the remainders', () => {
    const id = loopClip();
    setClipFades(id, 1, 1);

    const takeId = record(6, 4);

    const rest = store.clips
      .filter((clip) => clip.trackId === trackId && clip.id !== takeId)
      .sort((a, b) => a.startPpq - b.startPpq);
    expect(rest.map((clip) => [clip.fadeInPpq ?? 0, clip.fadeOutPpq ?? 0])).toEqual([
      [1, 0],
      [0, 0],
      [0, 1],
    ]);
  });
});
