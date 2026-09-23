import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setTrackPitchRange } from '@/project/command/tracks';
import { addTrack, clearHistory, undo } from '@/project/commands';
import {
  isValidPitchRange,
  PITCH_RANGE_PRESET_IDS,
  PITCH_RANGE_PRESETS,
} from '@/project/pitch-range';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('pitch range presets', () => {
  it('lists the seven preset ids', () => {
    expect(PITCH_RANGE_PRESET_IDS).toEqual([
      'soprano',
      'alto',
      'tenor',
      'bass',
      'bass4',
      'bass5',
      'guitar',
    ]);
  });

  // SATB ranges come from libcantus's SATB_RANGES (ascending, bass first);
  // instrument ranges come from libcantus's instrumentRange.
  it('fixes the SATB vocal ranges', () => {
    expect(PITCH_RANGE_PRESETS.soprano).toEqual({ low: 60, high: 79 });
    expect(PITCH_RANGE_PRESETS.alto).toEqual({ low: 55, high: 74 });
    expect(PITCH_RANGE_PRESETS.tenor).toEqual({ low: 48, high: 67 });
    expect(PITCH_RANGE_PRESETS.bass).toEqual({ low: 40, high: 60 });
  });

  it('fixes the instrument ranges', () => {
    expect(PITCH_RANGE_PRESETS.bass4).toEqual({ low: 28, high: 67 });
    expect(PITCH_RANGE_PRESETS.bass5).toEqual({ low: 23, high: 67 });
    expect(PITCH_RANGE_PRESETS.guitar).toEqual({ low: 40, high: 88 });
  });

  it('validates a well-formed inclusive MIDI range and rejects malformed ones', () => {
    expect(isValidPitchRange({ low: 40, high: 60 })).toBe(true);
    expect(isValidPitchRange({ low: 60, high: 60 })).toBe(true);
    expect(isValidPitchRange({ low: 61, high: 60 })).toBe(false);
    expect(isValidPitchRange({ low: -1, high: 60 })).toBe(false);
    expect(isValidPitchRange({ low: 0, high: 128 })).toBe(false);
    expect(isValidPitchRange({ low: 40.5, high: 60 })).toBe(false);
  });
});

describe('setTrackPitchRange command', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    await store.init();
    clearHistory();
  });

  it('sets a preset range on a track as one undoable edit', () => {
    const trackId = addTrack({ name: 'Lead' });

    setTrackPitchRange(trackId, PITCH_RANGE_PRESETS.soprano);

    expect(store.tracks.find((track) => track.id === trackId)?.pitchRange).toEqual({
      low: 60,
      high: 79,
    });

    expect(undo()).toBe(true);
    expect(store.tracks.find((track) => track.id === trackId)?.pitchRange).toBeUndefined();
  });

  it('clears a range with null as one undoable edit', () => {
    const trackId = addTrack({ name: 'Lead' });
    setTrackPitchRange(trackId, PITCH_RANGE_PRESETS.bass);
    clearHistory();

    setTrackPitchRange(trackId, null);

    expect(store.tracks.find((track) => track.id === trackId)?.pitchRange).toBeUndefined();
    expect(undo()).toBe(true);
    expect(store.tracks.find((track) => track.id === trackId)?.pitchRange).toEqual({
      low: 40,
      high: 60,
    });
  });

  it('rejects a malformed range', () => {
    const trackId = addTrack({ name: 'Lead' });
    expect(() => setTrackPitchRange(trackId, { low: 80, high: 60 })).toThrow(RangeError);
    expect(() => setTrackPitchRange(trackId, { low: 0, high: 128 })).toThrow(RangeError);
    expect(store.tracks.find((track) => track.id === trackId)?.pitchRange).toBeUndefined();
  });

  it('throws for an unknown track id', () => {
    expect(() => setTrackPitchRange(-1, PITCH_RANGE_PRESETS.alto)).toThrow(RangeError);
  });

  it('is a no-op when the range is unchanged', () => {
    const trackId = addTrack({ name: 'Lead' });
    setTrackPitchRange(trackId, PITCH_RANGE_PRESETS.tenor);
    clearHistory();

    setTrackPitchRange(trackId, { ...PITCH_RANGE_PRESETS.tenor });

    expect(undo()).toBe(false);
  });
});
