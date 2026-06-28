import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAudioTrack,
  addRecordedMidiClip,
  clearHistory,
  redo,
  setActiveClip,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('addRecordedMidiClip', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('lays the recorded notes onto the track as one undoable clip', () => {
    const trackId = store.tracks[0].id;
    const clipId = addRecordedMidiClip({
      trackId,
      startPpq: 8,
      lengthPpq: 4,
      notes: [
        { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
        { pitch: 64, velocity: 80, startPpq: 1, durationPpq: 2, channel: 0 },
      ],
      name: 'Take 1',
    });

    const clip = store.clips.find((c) => c.id === clipId);
    expect(clip).toMatchObject({ trackId, name: 'Take 1', startPpq: 8, lengthPpq: 4 });

    setActiveClip(clipId);
    expect(
      store.notes.map((n) => ({
        pitch: n.pitch,
        startPpq: n.startPpq,
        durationPpq: n.durationPpq,
        velocity: n.velocity,
      })),
    ).toEqual([
      { pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 },
      { pitch: 64, startPpq: 1, durationPpq: 2, velocity: 80 },
    ]);

    // The clip and its events undo together.
    expect(undo()).toBe(true);
    expect(store.clips.find((c) => c.id === clipId)).toBeUndefined();
    expect(redo()).toBe(true);
    expect(store.clips.find((c) => c.id === clipId)).toBeDefined();
  });

  it('creates an empty clip when no notes were captured', () => {
    const trackId = store.tracks[0].id;
    const clipId = addRecordedMidiClip({ trackId, startPpq: 0, lengthPpq: 4, notes: [] });
    setActiveClip(clipId);
    expect(store.notes).toEqual([]);
  });

  it('rejects recording onto a non-MIDI track', () => {
    const audioTrackId = addAudioTrack({ name: 'Vox' });
    expect(() =>
      addRecordedMidiClip({ trackId: audioTrackId, startPpq: 0, lengthPpq: 4, notes: [] }),
    ).toThrow(/not a MIDI track/);
  });

  it('rejects invalid placement', () => {
    const trackId = store.tracks[0].id;
    expect(() => addRecordedMidiClip({ trackId, startPpq: 0, lengthPpq: 0, notes: [] })).toThrow(
      /lengthPpq/,
    );
    expect(() => addRecordedMidiClip({ trackId, startPpq: -1, lengthPpq: 4, notes: [] })).toThrow(
      /startPpq/,
    );
  });

  it('throws on an unknown track', () => {
    expect(() =>
      addRecordedMidiClip({ trackId: 9999, startPpq: 0, lengthPpq: 4, notes: [] }),
    ).toThrow();
  });
});
