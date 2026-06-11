import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addInsert,
  addMixerBus,
  addNote,
  canUndo,
  clearHistory,
  redo,
  removeInsert,
  removeMixerBus,
  setInsertEnabled,
  setInsertParam,
  setSend,
  setStripEq,
  setStripGain,
  setStripPan,
  setTrackInstrument,
  undo,
} from '@/project/commands';
import type { TrackInstrument } from '@/project/instrument';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('mixer commands', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
  });

  describe('setTrackInstrument', () => {
    it('sets, undoes and redoes as one edit', () => {
      const instrument: TrackInstrument = { kind: 'synth-preset', preset: 'saw-lead' };
      setTrackInstrument(trackId, instrument);
      expect(store.tracks[0].instrument).toEqual(instrument);
      expect(undo()).toBe(true);
      expect(store.tracks[0].instrument).toBeUndefined();
      expect(redo()).toBe(true);
      expect(store.tracks[0].instrument).toEqual(instrument);
    });

    it('clears with null and survives a note edit in between', () => {
      setTrackInstrument(trackId, { kind: 'sf2', fontId: 'gm', program: 1 });
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      expect(store.tracks[0].instrument).toEqual({ kind: 'sf2', fontId: 'gm', program: 1 });
      setTrackInstrument(trackId, null);
      expect(store.tracks[0].instrument).toBeUndefined();
      undo(); // clear
      expect(store.tracks[0].instrument).toEqual({ kind: 'sf2', fontId: 'gm', program: 1 });
      undo(); // note
      undo(); // set
      expect(store.tracks[0].instrument).toBeUndefined();
    });

    it('is a no-op for an equal instrument', () => {
      setTrackInstrument(trackId, { kind: 'synth-preset', preset: 'sine' });
      setTrackInstrument(trackId, { kind: 'synth-preset', preset: 'sine' });
      expect(undo()).toBe(true);
      expect(store.tracks[0].instrument).toBeUndefined();
      expect(undo()).toBe(false);
    });

    it('validates instrument and track id', () => {
      expect(() => setTrackInstrument(trackId, { kind: 'synth-preset', preset: '' })).toThrow(
        RangeError,
      );
      expect(() => setTrackInstrument(9999, { kind: 'synth-preset', preset: 'sine' })).toThrow(
        RangeError,
      );
    });
  });

  describe('setStripGain / setStripPan', () => {
    it('edits the track strip and undoes back to neutral', () => {
      setStripGain(trackId, -6);
      setStripPan(trackId, 0.5);
      expect(store.tracks[0].mixer).toMatchObject({ gainDb: -6, pan: 0.5 });
      undo();
      expect(store.tracks[0].mixer).toMatchObject({ gainDb: -6, pan: 0 });
      undo();
      expect(store.tracks[0].mixer).toBeUndefined();
    });

    it('edits the master strip', () => {
      setStripGain('master', 3);
      setStripPan('master', -0.25);
      expect(store.mixer.master).toMatchObject({ gainDb: 3, pan: -0.25 });
      undo();
      undo();
      expect(store.mixer.master).toMatchObject({ gainDb: 0, pan: 0 });
    });

    it('rejects out-of-range values', () => {
      expect(() => setStripGain(trackId, 100)).toThrow(RangeError);
      expect(() => setStripGain(trackId, Number.NaN)).toThrow(RangeError);
      expect(() => setStripPan(trackId, 2)).toThrow(RangeError);
    });

    it('coalesces a fader drag into one history entry', () => {
      setStripGain(trackId, -2, { commit: false });
      setStripGain(trackId, -4, { commit: false });
      setStripGain(trackId, -6); // commit
      expect(store.tracks[0].mixer?.gainDb).toBe(-6);
      expect(undo()).toBe(true);
      expect(store.tracks[0].mixer).toBeUndefined();
      expect(undo()).toBe(false);
    });

    it('an unrelated command closes a pending gesture first', () => {
      setStripGain(trackId, -2, { commit: false });
      setStripGain(trackId, -4, { commit: false });
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      // Undo the note, then the whole coalesced drag.
      undo();
      expect(store.tracks[0].mixer?.gainDb).toBe(-4);
      undo();
      expect(store.tracks[0].mixer).toBeUndefined();
    });

    it('canUndo reports a pending gesture', () => {
      expect(canUndo()).toBe(false);
      setStripPan(trackId, 0.1, { commit: false });
      expect(canUndo()).toBe(true);
      undo();
      expect(store.tracks[0].mixer).toBeUndefined();
    });
  });

  describe('insert commands', () => {
    it('adds, edits, bypasses and removes inserts undoably', () => {
      const index = addInsert(trackId, 'dynamics.compressor', { thresholdDb: -18 });
      expect(index).toBe(0);
      expect(store.tracks[0].mixer?.inserts[0]).toEqual({
        processor: 'dynamics.compressor',
        params: { thresholdDb: -18 },
        enabled: true,
      });

      setInsertParam(trackId, 0, 'ratio', 4);
      expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ thresholdDb: -18, ratio: 4 });

      setInsertEnabled(trackId, 0, false);
      expect(store.tracks[0].mixer?.inserts[0].enabled).toBe(false);

      removeInsert(trackId, 0);
      expect(store.tracks[0].mixer?.inserts).toEqual([]);

      undo(); // remove
      expect(store.tracks[0].mixer?.inserts).toHaveLength(1);
      undo(); // enable
      expect(store.tracks[0].mixer?.inserts[0].enabled).toBe(true);
      undo(); // param
      expect(store.tracks[0].mixer?.inserts[0].params).toEqual({ thresholdDb: -18 });
      undo(); // add
      expect(store.tracks[0].mixer).toBeUndefined();
    });

    it('supports the master strip target (UI-only DSP)', () => {
      addInsert('master', 'maximizer.maximizer');
      expect(store.mixer.master.inserts).toHaveLength(1);
      undo();
      expect(store.mixer.master.inserts).toEqual([]);
    });

    it('coalesces a knob drag on one param into one entry', () => {
      addInsert(trackId, 'dynamics.compressor');
      setInsertParam(trackId, 0, 'thresholdDb', -10, { commit: false });
      setInsertParam(trackId, 0, 'thresholdDb', -20, { commit: false });
      setInsertParam(trackId, 0, 'thresholdDb', -30);
      expect(store.tracks[0].mixer?.inserts[0].params.thresholdDb).toBe(-30);
      undo(); // the whole drag
      expect(store.tracks[0].mixer?.inserts[0].params.thresholdDb).toBeUndefined();
      undo(); // addInsert
      expect(store.tracks[0].mixer).toBeUndefined();
    });

    it('validates processor names, indices and values', () => {
      expect(() => addInsert(trackId, '')).toThrow(RangeError);
      expect(() => removeInsert(trackId, 0)).toThrow(RangeError);
      addInsert(trackId, 'eq.tilt');
      expect(() => setInsertParam(trackId, 1, 'tiltDb', 1)).toThrow(RangeError);
      expect(() => setInsertParam(trackId, 0, 'tiltDb', Number.POSITIVE_INFINITY)).toThrow(
        RangeError,
      );
    });
  });

  describe('setStripEq', () => {
    it('sets and clears the EQ undoably', () => {
      setStripEq(trackId, {
        enabled: true,
        bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 3 }],
      });
      expect(store.tracks[0].mixer?.eq?.bands).toHaveLength(1);
      setStripEq(trackId, null);
      expect(store.tracks[0].mixer?.eq).toBeUndefined();
      undo();
      expect(store.tracks[0].mixer?.eq?.enabled).toBe(true);
      undo();
      expect(store.tracks[0].mixer).toBeUndefined();
    });
  });

  describe('buses and sends', () => {
    it('adds buses with generated unique ids', () => {
      expect(addMixerBus({ name: 'Reverb' })).toBe('bus-1');
      expect(addMixerBus()).toBe('bus-2');
      expect(store.mixer.buses.map((b) => b.name)).toEqual(['Reverb', 'bus-2']);
      expect(() => addMixerBus({ id: 'bus-1' })).toThrow(RangeError);
    });

    it('upserts and removes sends undoably', () => {
      const busId = addMixerBus({ name: 'FX' });
      setSend(trackId, busId, { levelDb: -12 });
      expect(store.tracks[0].mixer?.sends).toEqual([{ busId, levelDb: -12, enabled: true }]);
      setSend(trackId, busId, { levelDb: -6, enabled: false });
      expect(store.tracks[0].mixer?.sends).toEqual([{ busId, levelDb: -6, enabled: false }]);
      setSend(trackId, busId, null);
      expect(store.tracks[0].mixer?.sends).toEqual([]);
      undo();
      expect(store.tracks[0].mixer?.sends).toHaveLength(1);
      expect(() => setSend(trackId, 'nope', { levelDb: 0 })).toThrow(RangeError);
    });

    it('removing a bus cascades the sends referencing it', () => {
      const busId = addMixerBus();
      setSend(trackId, busId, { levelDb: -9 });
      setSend('master', busId, { levelDb: -3 });
      removeMixerBus(busId);
      expect(store.mixer.buses).toEqual([]);
      expect(store.tracks[0].mixer?.sends).toEqual([]);
      expect(store.mixer.master.sends).toEqual([]);
      undo();
      expect(store.mixer.buses).toHaveLength(1);
      expect(store.tracks[0].mixer?.sends).toHaveLength(1);
      expect(store.mixer.master.sends).toHaveLength(1);
      expect(() => removeMixerBus('nope')).toThrow(RangeError);
    });
  });
});
