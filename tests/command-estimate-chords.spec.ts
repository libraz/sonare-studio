import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateChordsFromArrangement } from '@/project/command/chords';
import { addMidiClip, setActiveClip } from '@/project/command/clips';
import { clearHistory, undo } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { addTrack, setTrackPercussion } from '@/project/command/tracks';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('estimateChordsFromArrangement', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('writes an inferred progression to the chord track in one undoable edit', () => {
    // A C-major triad held for a bar on the default clip.
    for (const pitch of [60, 64, 67]) {
      addNote({ pitch, startPpq: 0, durationPpq: 4 });
    }
    expect(store.chords).toEqual([]);

    const summary = estimateChordsFromArrangement();
    expect(summary.count).toBeGreaterThan(0);
    expect(store.chords.length).toBe(summary.count);
    expect(summary.confidenceByStartPpq.size).toBe(summary.count);
    expect(summary.confidenceByStartPpq.get(store.chords[0].startPpq)).toBeDefined();
    expect(store.chords[0].rootPc).toBe(0);

    undo();
    expect(store.chords).toEqual([]);
  });

  it('excludes percussion tracks and reports them', () => {
    for (const pitch of [60, 64, 67]) {
      addNote({ pitch, startPpq: 0, durationPpq: 4 });
    }
    const drumTrack = addTrack({ name: 'Drums' });
    const drumClip = addMidiClip({ trackId: drumTrack, lengthPpq: 4 });
    setActiveClip(drumClip);
    addNote({ pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 });

    const summary = estimateChordsFromArrangement();
    expect(summary.excludedTrackNames).toContain('Drums');
    expect(store.chords[0].rootPc).toBe(0);
  });

  it('is a no-op when there are no harmonic notes', () => {
    const summary = estimateChordsFromArrangement();
    expect(summary.count).toBe(0);
    expect(store.chords).toEqual([]);
  });

  it('honors an explicit percussion override that forces harmonic', () => {
    // A "Drums"-named track carrying a real triad: the name heuristic would
    // exclude it, but an explicit false override keeps it in the estimate.
    for (const pitch of [60, 64, 67]) {
      addNote({ pitch, startPpq: 0, durationPpq: 4 });
    }
    const drumTrackId = store.tracks[0].id;
    // Force the seeding heuristic to exclude, then override it back to harmonic.
    setTrackPercussion(drumTrackId, false);
    store.tracks = store.tracks.map((track) =>
      track.id === drumTrackId ? { ...track, name: 'Drums' } : track,
    );

    const summary = estimateChordsFromArrangement();
    expect(summary.excludedTrackNames).not.toContain('Drums');
    expect(summary.count).toBeGreaterThan(0);
    expect(store.chords[0].rootPc).toBe(0);
  });

  it('honors an explicit percussion override that forces exclusion', () => {
    for (const pitch of [60, 64, 67]) {
      addNote({ pitch, startPpq: 0, durationPpq: 4 });
    }
    setTrackPercussion(store.tracks[0].id, true);

    const summary = estimateChordsFromArrangement();
    expect(summary.count).toBe(0);
    expect(store.chords).toEqual([]);
  });
});
