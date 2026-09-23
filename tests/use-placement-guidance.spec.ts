import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { usePlacementGuidance } from '@/composables/usePlacementGuidance';
import { keyMarkerName } from '@/compose/key-name';
import {
  addAudioClip,
  addAudioTrack,
  addMidiClip,
  addNote,
  addTrack,
  clearHistory,
  setActiveClip,
  setMarker,
  setProjectChords,
  setTimeSignatures,
  setTrackFrozen,
  setTrackLeadFollow,
  setTrackPercussion,
  setTrackPitchRange,
  trimClip,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

// Wraps the real implementation so verdicts stay correct while the test
// counts how often the (expensive) column evaluation actually runs.
vi.mock('@/compose/placement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/compose/placement')>();
  return { ...actual, evaluatePlacementColumn: vi.fn(actual.evaluatePlacementColumn) };
});

const { evaluatePlacementColumn } = await import('@/compose/placement');
const evaluateSpy = vi.mocked(evaluatePlacementColumn);

describe('usePlacementGuidance', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    useAppSettings().reset();
    evaluateSpy.mockClear();
  });

  it('is null while no cell is hovered', () => {
    const column = usePlacementGuidance(ref(null));
    expect(column.value).toBeNull();
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('is null when the placement-guide setting is off', () => {
    useAppSettings().set('pianoRollPlacementGuide', false);
    const column = usePlacementGuidance(ref({ startPpq: 0, lengthPpq: 1 }));
    expect(column.value).toBeNull();
  });

  it('is null while the edited track is frozen', () => {
    const store = useProjectStore();
    const trackId = store.activeClip?.trackId;
    if (trackId === undefined) throw new Error('no active track');
    setTrackFrozen(trackId, { assetId: 'asset-1' });
    const column = usePlacementGuidance(ref({ startPpq: 0, lengthPpq: 1 }));
    expect(column.value).toBeNull();
  });

  it('is null for a non-MIDI clip', async () => {
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({ trackId, assetId: 'asset-1', lengthPpq: 8 });
    setActiveClip(clipId);
    const column = usePlacementGuidance(ref({ startPpq: 0, lengthPpq: 1 }));
    expect(column.value).toBeNull();
  });

  it('is null while the edited track is a drum track', () => {
    const store = useProjectStore();
    const trackId = store.activeClip?.trackId;
    if (trackId === undefined) throw new Error('no active track');
    setTrackPercussion(trackId, true);
    const column = usePlacementGuidance(ref({ startPpq: 0, lengthPpq: 1 }));
    expect(column.value).toBeNull();
  });

  it('evaluates a column for an eligible cell', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    expect(column.value).toEqual({ startPpq: 0, endPpq: 1, verdicts: expect.any(Array) });
    expect(column.value?.verdicts).toHaveLength(128);
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
  });

  it('does not recompute when the same cell is set again', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    cell.value = { startPpq: 0, lengthPpq: 1 };
    column.value;
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
  });

  it('recomputes when the cell moves', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    cell.value = { startPpq: 4, lengthPpq: 1 };
    column.value;
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
  });

  it('does not recompute for a UI-state change unrelated to placement', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    useAppSettings().set('pianoRollGuidanceTint', false);
    column.value;
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
  });

  it('recomputes when the clip own notes change', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 });
    column.value;
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
  });

  it('recomputes when another track changes', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    const otherTrack = addTrack({ name: 'Other' });
    const otherClip = addMidiClip({ trackId: otherTrack, startPpq: 0, lengthPpq: 8 });
    setActiveClip(otherClip);
    addNote({ pitch: 55, startPpq: 0, durationPpq: 1, velocity: 96 });
    column.value;
    expect(evaluateSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('recomputes when the chords change', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    setProjectChords([{ startPpq: 0, endPpq: 32, rootPc: 0, quality: 0 }]);
    column.value;
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
  });

  it('recomputes when the key map changes', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    setMarker(null, 0, keyMarkerName(1, false));
    column.value;
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
  });

  it('recomputes when the time signature changes', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    setTimeSignatures([{ startPpq: 0, numerator: 3, denominator: 4 }]);
    column.value;
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
  });

  it('recomputes when the guidance profile changes', () => {
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    useAppSettings().set('guidanceProfile', 'pop');
    column.value;
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
  });

  it('recomputes when the track pitch range changes', () => {
    const store = useProjectStore();
    const trackId = store.activeClip?.trackId;
    if (trackId === undefined) throw new Error('no active track');
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    setTrackPitchRange(trackId, { low: 48, high: 72 });
    column.value;
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(column.value?.verdicts[0].reasons).toContain('outOfRange');
  });

  it('recomputes when the follower relationship changes', () => {
    const store = useProjectStore();
    const leadTrackId = store.activeClip?.trackId;
    if (leadTrackId === undefined) throw new Error('no active track');
    const accompTrackId = addTrack({ name: 'Backing' });
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    setTrackLeadFollow(accompTrackId, leadTrackId);
    column.value;
    expect(evaluateSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('derives followerTrackIds from tracks that follow the edited track', () => {
    const store = useProjectStore();
    const leadTrackId = store.activeClip?.trackId;
    if (leadTrackId === undefined) throw new Error('no active track');
    const accompTrackId = addTrack({ name: 'Backing' });
    setTrackLeadFollow(accompTrackId, leadTrackId);
    const cell = ref({ startPpq: 0, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    const lastCall = evaluateSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.followerTrackIds.has(accompTrackId)).toBe(true);
  });

  it('converts a trimmed clip source-relative cell to absolute PPQ', () => {
    const store = useProjectStore();
    const trackId = store.activeClip?.trackId;
    if (trackId === undefined) throw new Error('no active track');
    const clipId = addMidiClip({ trackId, startPpq: 100, lengthPpq: 16 });
    setActiveClip(clipId);
    // Trims the left edge: sourceOffsetPpq moves from 0 to 8, timeline start to 108.
    trimClip(clipId, 108, 8);
    const cell = ref({ startPpq: 10, lengthPpq: 1 });
    const column = usePlacementGuidance(cell);
    column.value;
    const call = evaluateSpy.mock.calls.at(-1)?.[0];
    expect(call?.startPpq).toBe(110);
    expect(column.value).toEqual({ startPpq: 10, endPpq: 11, verdicts: expect.any(Array) });
  });
});
