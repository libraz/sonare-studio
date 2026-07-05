import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAudioTrack,
  addGroupTrack,
  addInsert,
  addMixerBus,
  addNote,
  addTrack,
  addVcaGroup,
  applyMixerSceneJson,
  canUndo,
  clearHistory,
  mixerBusStripTarget,
  redo,
  removeInsert,
  removeMixerBus,
  removeTrack,
  removeVcaGroup,
  renameMixerBus,
  renameVcaGroup,
  setInsertEnabled,
  setInsertParam,
  setInsertSidechain,
  setMasteringPreset,
  setMixerBusGain,
  setMixerSoloMode,
  setSend,
  setStripChannelDelaySamples,
  setStripDualPan,
  setStripEq,
  setStripGain,
  setStripInputTrim,
  setStripOutputBus,
  setStripPan,
  setStripPanLaw,
  setStripPanMode,
  setStripPolarityInvert,
  setStripWidth,
  setTrackFrozen,
  setTrackGroup,
  setTrackInstrument,
  setTrackSoloSafe,
  setTrackVca,
  setVcaGroupGain,
  setVcaGroupMute,
  setVcaGroupSolo,
  undo,
} from '@/project/commands';
import type { TrackInstrument } from '@/project/instrument';
import { MAX_MIXER_BUSES, MAX_VCA_GROUPS } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { fakeMixingScenePresetJson } from './fake-wasm';

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

  describe('strip-local DSP controls', () => {
    it('sets and clears input trim, width and polarity as undoable strip data', () => {
      setStripInputTrim(trackId, 6);
      setStripWidth(trackId, 0.5);
      setStripPolarityInvert(trackId, true, false);

      expect(store.tracks[0].mixer?.inputTrimDb).toBe(6);
      expect(store.tracks[0].mixer?.width).toBe(0.5);
      expect(store.tracks[0].mixer?.polarityInvertLeft).toBe(true);

      setStripInputTrim(trackId, 0);
      setStripWidth(trackId, 1);
      setStripPolarityInvert(trackId, false, false);

      expect(store.tracks[0].mixer?.inputTrimDb).toBeUndefined();
      expect(store.tracks[0].mixer?.width).toBeUndefined();
      expect(store.tracks[0].mixer?.polarityInvertLeft).toBeUndefined();

      expect(undo()).toBe(true);
      expect(store.tracks[0].mixer?.polarityInvertLeft).toBe(true);
    });
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

  describe('setMixerSoloMode', () => {
    it('stores AFL/PFL modes and clears the default in-place mode undoably', () => {
      setMixerSoloMode('pfl');
      expect(store.mixer.soloMode).toBe('pfl');
      setMixerSoloMode('afl');
      expect(store.mixer.soloMode).toBe('afl');
      setMixerSoloMode('inPlace');
      expect(store.mixer.soloMode).toBeUndefined();

      expect(undo()).toBe(true);
      expect(store.mixer.soloMode).toBe('afl');
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

  describe('setStripChannelDelaySamples', () => {
    it('sets, clears and validates the channel delay undoably', () => {
      setStripChannelDelaySamples(trackId, 256);
      expect(store.tracks[0].mixer?.channelDelaySamples).toBe(256);
      // 0 clears the field so a neutral strip stays neutral.
      setStripChannelDelaySamples(trackId, 0);
      expect(store.tracks[0].mixer?.channelDelaySamples).toBeUndefined();
      undo();
      expect(store.tracks[0].mixer?.channelDelaySamples).toBe(256);
      expect(() => setStripChannelDelaySamples(trackId, -1)).toThrow(RangeError);
      expect(() => setStripChannelDelaySamples(trackId, 1.5)).toThrow(RangeError);
      expect(() => setStripChannelDelaySamples(trackId, 1e9)).toThrow(RangeError);
    });
  });

  describe('pan law / mode / dual pan', () => {
    it('sets pan law, clearing the field at the default, undoably', () => {
      setStripPanLaw(trackId, 'const6dB');
      expect(store.tracks[0].mixer?.panLaw).toBe('const6dB');
      // The default clears the field so a neutral strip stays neutral.
      setStripPanLaw(trackId, 'const3dB');
      expect(store.tracks[0].mixer?.panLaw).toBeUndefined();
      undo();
      expect(store.tracks[0].mixer?.panLaw).toBe('const6dB');
      expect(() => setStripPanLaw(trackId, 'bogus' as 'const3dB')).toThrow(RangeError);
    });

    it('sets pan mode, clearing the field at the default, undoably', () => {
      setStripPanMode(trackId, 'dualPan');
      expect(store.tracks[0].mixer?.panMode).toBe('dualPan');
      setStripPanMode(trackId, 'balance');
      expect(store.tracks[0].mixer?.panMode).toBeUndefined();
      undo();
      expect(store.tracks[0].mixer?.panMode).toBe('dualPan');
      expect(() => setStripPanMode(trackId, 'bogus' as 'balance')).toThrow(RangeError);
    });

    it('sets and validates dual-pan positions undoably', () => {
      setStripDualPan(trackId, -0.5, 0.75);
      expect(store.tracks[0].mixer?.dualPan).toEqual({ left: -0.5, right: 0.75 });
      undo();
      expect(store.tracks[0].mixer?.dualPan).toBeUndefined();
      expect(() => setStripDualPan(trackId, -2, 0)).toThrow(RangeError);
      expect(() => setStripDualPan(trackId, 0, Number.NaN)).toThrow(RangeError);
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

    it('re-applying an identical EQ adds no undo step', () => {
      const eq = { enabled: true, bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 3 }] };
      setStripEq(trackId, eq);
      expect(canUndo()).toBe(true);
      undo();
      expect(canUndo()).toBe(false);
      // A second, value-identical apply must not push history on its own.
      setStripEq(trackId, eq);
      setStripEq(trackId, {
        enabled: true,
        bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 3 }],
      });
      undo();
      expect(store.tracks[0].mixer?.eq).toBeUndefined();
      expect(canUndo()).toBe(false);
    });

    it('clearing an already-absent EQ is a no-op', () => {
      expect(canUndo()).toBe(false);
      setStripEq(trackId, null);
      expect(canUndo()).toBe(false);
    });

    it('rejects bus return EQ because the engine has no bus EQ ABI', () => {
      const busId = addMixerBus({ name: 'FX' });
      const target = mixerBusStripTarget(busId);

      expect(() =>
        setStripEq(target, {
          enabled: true,
          bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 3 }],
        }),
      ).toThrow(RangeError);
      expect(store.mixer.buses[0].strip?.eq).toBeUndefined();
      expect(canUndo()).toBe(true); // only the bus creation is undoable
    });
  });

  describe('buses and sends', () => {
    it('adds buses with generated unique ids', () => {
      expect(addMixerBus({ name: 'Reverb' })).toBe('bus-1');
      expect(addMixerBus()).toBe('bus-2');
      expect(store.mixer.buses.map((b) => b.name)).toEqual(['Reverb', 'bus-2']);
      expect(() => addMixerBus({ id: 'bus-1' })).toThrow(RangeError);
    });

    it('sets bus gain undoably and validates input', () => {
      const busId = addMixerBus();
      setMixerBusGain(busId, -6);
      expect(store.mixer.buses[0].gainDb).toBe(-6);
      undo();
      expect(store.mixer.buses[0].gainDb).toBe(0);
      expect(() => setMixerBusGain('nope', 0)).toThrow(RangeError);
      expect(() => setMixerBusGain(busId, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });

    it('renames a bus undoably without changing its id', () => {
      const busId = addMixerBus({ name: 'Reverb' });
      renameMixerBus(busId, '  Plate  ');
      expect(store.mixer.buses[0]).toMatchObject({ id: busId, name: 'Plate' });
      undo();
      expect(store.mixer.buses[0]).toMatchObject({ id: busId, name: 'Reverb' });
      expect(() => renameMixerBus(busId, '   ')).toThrow(RangeError);
      expect(() => renameMixerBus('missing', 'FX')).toThrow(RangeError);
    });

    it('coalesces a bus-gain drag into one history entry', () => {
      const busId = addMixerBus();
      setMixerBusGain(busId, -3, { commit: false });
      setMixerBusGain(busId, -9, { commit: false });
      setMixerBusGain(busId, -12, { commit: true });
      expect(store.mixer.buses[0].gainDb).toBe(-12);
      undo();
      expect(store.mixer.buses[0].gainDb).toBe(0);
    });

    it('edits a bus return insert chain through the shared strip commands', () => {
      const busId = addMixerBus({ name: 'FX' });
      const target = mixerBusStripTarget(busId);
      const index = addInsert(target, 'dynamics.compressor', { thresholdDb: -20 });
      setInsertParam(target, index, 'ratio', 4);

      expect(store.mixer.buses[0].strip?.inserts).toEqual([
        {
          processor: 'dynamics.compressor',
          params: { thresholdDb: -20, ratio: 4 },
          enabled: true,
        },
      ]);

      removeInsert(target, index);
      expect(store.mixer.buses[0].strip?.inserts).toEqual([]);
      undo();
      expect(store.mixer.buses[0].strip?.inserts).toHaveLength(1);
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
      expect(() => setSend('master', busId, { levelDb: -3 })).toThrow(RangeError);
    });

    it('coalesces send level gestures into one undo entry', () => {
      const busId = addMixerBus({ name: 'FX' });
      clearHistory();
      setSend(trackId, busId, { levelDb: -24 }, { commit: false });
      setSend(trackId, busId, { levelDb: -12 }, { commit: false });
      setSend(trackId, busId, { levelDb: -6 });

      expect(store.tracks[0].mixer?.sends).toEqual([{ busId, levelDb: -6, enabled: true }]);
      expect(undo()).toBe(true);
      expect(store.tracks[0].mixer).toBeUndefined();
      expect(undo()).toBe(false);
    });

    it('sets and preserves the send tap point (pre/post-fader)', () => {
      const busId = addMixerBus({ name: 'FX' });
      // Default send omits timing (post-fader).
      setSend(trackId, busId, { levelDb: -12 });
      expect(store.tracks[0].mixer?.sends[0].timing).toBeUndefined();
      // Switching to pre-fader records the field.
      setSend(trackId, busId, { levelDb: -12, enabled: true, timing: 'preFader' });
      expect(store.tracks[0].mixer?.sends[0].timing).toBe('preFader');
      // A level edit without a timing preserves the pre-fader tap.
      setSend(trackId, busId, { levelDb: -3 });
      expect(store.tracks[0].mixer?.sends[0]).toEqual({
        busId,
        levelDb: -3,
        enabled: true,
        timing: 'preFader',
      });
      // Switching back to post-fader drops the field so neutral stays neutral.
      setSend(trackId, busId, { levelDb: -3, enabled: true, timing: 'postFader' });
      expect(store.tracks[0].mixer?.sends[0].timing).toBeUndefined();
    });

    it('rejects adding a bus beyond the engine limit', () => {
      for (let i = 0; i < MAX_MIXER_BUSES; i++) addMixerBus();
      expect(store.mixer.buses).toHaveLength(MAX_MIXER_BUSES);
      expect(() => addMixerBus()).toThrow(RangeError);
    });

    it('counts group tracks against the engine bus limit when adding send buses', () => {
      addGroupTrack();
      for (let i = 1; i < MAX_MIXER_BUSES; i++) addMixerBus();
      expect(store.mixer.buses).toHaveLength(MAX_MIXER_BUSES - 1);
      expect(() => addMixerBus()).toThrow(RangeError);
    });

    it('removing a bus keeps the mastering chain', () => {
      const busId = addMixerBus();
      setMasteringPreset('club');
      removeMixerBus(busId);
      expect(store.mixer.masteringChain?.preset).toBe('club');
    });

    it('removing a bus cascades the sends referencing it', () => {
      const busId = addMixerBus();
      setSend(trackId, busId, { levelDb: -9 });
      store.mixer.master.sends = [{ busId, levelDb: -3, enabled: true }];
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

    it('routes a track output to a bus and back undoably', () => {
      const busId = addMixerBus({ name: 'FX' });
      setStripOutputBus(trackId, busId);
      expect(store.tracks[0].mixer?.outputBusId).toBe(busId);
      setStripOutputBus(trackId, null);
      expect(store.tracks[0].mixer?.outputBusId).toBeUndefined();
      undo();
      expect(store.tracks[0].mixer?.outputBusId).toBe(busId);
      redo();
      expect(store.tracks[0].mixer?.outputBusId).toBeUndefined();
    });

    it('is a no-op for the current output routing', () => {
      const busId = addMixerBus();
      setStripOutputBus(trackId, busId);
      clearHistory();
      setStripOutputBus(trackId, busId);
      expect(canUndo()).toBe(false);
    });

    it('rejects routing the master, a group track, or an unknown bus', () => {
      const busId = addMixerBus();
      const groupId = addGroupTrack();
      expect(() => setStripOutputBus('master', busId)).toThrow(RangeError);
      expect(() => setStripOutputBus(groupId, busId)).toThrow(RangeError);
      expect(() => setStripOutputBus(trackId, 'nope')).toThrow(RangeError);
    });

    it('clears a dangling output routing when its bus is removed', () => {
      const busId = addMixerBus();
      setStripOutputBus(trackId, busId);
      setSend(trackId, busId, { levelDb: -6 });
      removeMixerBus(busId);
      expect(store.tracks[0].mixer?.outputBusId).toBeUndefined();
      expect(store.tracks[0].mixer?.sends).toEqual([]);
      undo();
      expect(store.tracks[0].mixer?.outputBusId).toBe(busId);
    });
  });

  describe('group tracks', () => {
    it('addGroupTrack creates a group track whose kind survives refresh', () => {
      const groupId = addGroupTrack({ name: 'Drum Bus' });
      const track = store.tracks.find((t) => t.id === groupId);
      expect(track?.kind).toBe('group');
      expect(track?.name).toBe('Drum Bus');
      // The wasm Project stores group tracks as aux; the app-level kind must
      // survive a refresh from the Project document.
      store.refresh();
      expect(store.tracks.find((t) => t.id === groupId)?.kind).toBe('group');
      expect(undo()).toBe(true);
      expect(store.tracks.some((t) => t.id === groupId)).toBe(false);
      expect(redo()).toBe(true);
      expect(store.tracks.find((t) => t.id === groupId)?.kind).toBe('group');
    });

    it('counts send buses against the engine bus limit when adding group tracks', () => {
      for (let i = 1; i < MAX_MIXER_BUSES; i++) addMixerBus();
      const groupId = addGroupTrack();
      expect(store.tracks.find((track) => track.id === groupId)?.kind).toBe('group');
      expect(() => addGroupTrack()).toThrow(RangeError);
    });

    it('setTrackGroup sets and clears the membership undoably', () => {
      const groupId = addGroupTrack();
      setTrackGroup(trackId, groupId);
      expect(store.tracks[0].groupId).toBe(groupId);
      setTrackGroup(trackId, null);
      expect(store.tracks[0].groupId).toBeUndefined();
      undo(); // clear
      expect(store.tracks[0].groupId).toBe(groupId);
      undo(); // set
      expect(store.tracks[0].groupId).toBeUndefined();
      redo();
      expect(store.tracks[0].groupId).toBe(groupId);
    });

    it('validates the target, nesting and self references', () => {
      const groupA = addGroupTrack();
      const groupB = addGroupTrack();
      expect(() => setTrackGroup(trackId, trackId)).toThrow(/not a group track/);
      expect(() => setTrackGroup(groupA, groupB)).toThrow(/cannot be nested/);
      expect(() => setTrackGroup(groupA, groupA)).toThrow(RangeError);
      expect(() => setTrackGroup(9999, groupA)).toThrow(RangeError);
      expect(() => setTrackGroup(trackId, 9999)).toThrow(RangeError);
      expect(store.tracks.every((t) => t.groupId === undefined)).toBe(true);
    });

    it('clearing an absent membership is not an undoable edit', () => {
      clearHistory();
      setTrackGroup(trackId, null);
      expect(canUndo()).toBe(false);
    });

    it('removing a group track clears its members and restores them on undo', () => {
      const groupId = addGroupTrack();
      setTrackGroup(trackId, groupId);
      removeTrack(groupId);
      expect(store.tracks.some((t) => t.id === groupId)).toBe(false);
      expect(store.tracks[0].groupId).toBeUndefined();
      undo();
      expect(store.tracks.some((t) => t.id === groupId)).toBe(true);
      expect(store.tracks[0].groupId).toBe(groupId);
    });
  });

  describe('setTrackFrozen', () => {
    it('sets, clears, undoes and redoes the frozen state as single edits', () => {
      setTrackFrozen(trackId, { assetId: 'baked-1' });
      expect(store.tracks[0].frozen).toEqual({ assetId: 'baked-1' });
      // Frozen is app metadata: it must survive a refresh from the Project.
      store.refresh();
      expect(store.tracks[0].frozen).toEqual({ assetId: 'baked-1' });

      setTrackFrozen(trackId, null);
      expect(store.tracks[0].frozen).toBeUndefined();
      undo(); // clear
      expect(store.tracks[0].frozen).toEqual({ assetId: 'baked-1' });
      undo(); // set
      expect(store.tracks[0].frozen).toBeUndefined();
      redo();
      expect(store.tracks[0].frozen).toEqual({ assetId: 'baked-1' });
    });

    it('rejects group tracks, empty asset ids and unknown tracks', () => {
      const groupId = addGroupTrack();
      expect(() => setTrackFrozen(groupId, { assetId: 'baked-1' })).toThrow(/cannot be frozen/);
      expect(() => setTrackFrozen(trackId, { assetId: '' })).toThrow(/must not be empty/);
      expect(() => setTrackFrozen(9999, { assetId: 'baked-1' })).toThrow(RangeError);
      expect(store.tracks.every((track) => track.frozen === undefined)).toBe(true);
    });
  });

  describe('setInsertSidechain', () => {
    it('sets and clears the sidechain source undoably', () => {
      addInsert(trackId, 'dynamics.compressor');
      const sourceId = addAudioTrack({ name: 'Kick' });
      setInsertSidechain(trackId, 0, sourceId);
      expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBe(sourceId);
      setInsertSidechain(trackId, 0, null);
      expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBeUndefined();
      undo(); // clear
      expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBe(sourceId);
      undo(); // set
      expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBeUndefined();
      redo();
      expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBe(sourceId);
    });

    it('validates the strip, slot index and source track', () => {
      const sourceId = addAudioTrack({ name: 'Kick' });
      expect(() => setInsertSidechain(trackId, 0, sourceId)).toThrow(/no mixer strip/);
      addInsert(trackId, 'dynamics.compressor');
      expect(() => setInsertSidechain(trackId, 5, sourceId)).toThrow(RangeError);
      expect(() => setInsertSidechain(trackId, 0, trackId)).toThrow(/its own track/);
      expect(() => setInsertSidechain(trackId, 0, 9999)).toThrow(RangeError);
      expect(() => setInsertSidechain(9999, 0, sourceId)).toThrow(RangeError);
      const groupId = addGroupTrack({ name: 'Group' });
      addInsert(groupId, 'dynamics.compressor');
      expect(() => setInsertSidechain(groupId, 0, sourceId)).toThrow(/Group track inserts/);
      expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBeUndefined();
    });

    it('clearing an absent source is not an undoable edit', () => {
      addInsert(trackId, 'dynamics.compressor');
      clearHistory();
      setInsertSidechain(trackId, 0, null);
      expect(canUndo()).toBe(false);
    });

    it('removing the source track clears referencing slots and restores on undo', () => {
      addInsert(trackId, 'dynamics.compressor');
      const sourceId = addAudioTrack({ name: 'Kick' });
      setInsertSidechain(trackId, 0, sourceId);
      removeTrack(sourceId);
      expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBeUndefined();
      undo();
      expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBe(sourceId);
    });

    it('removing the source track also clears bus insert sidechains', () => {
      const busId = addMixerBus({ name: 'Parallel Comp' });
      const target = mixerBusStripTarget(busId);
      const sourceId = addAudioTrack({ name: 'Kick' });
      addInsert(target, 'dynamics.compressor');
      // Bus sidechains are not exposed for editing, but stale/imported project
      // data can still carry a source id and must be cleaned with track removal.
      store.mixer.buses[0].strip!.inserts[0].sidechainSourceTrackId = sourceId;

      removeTrack(sourceId);

      expect(store.mixer.buses[0].strip?.inserts[0].sidechainSourceTrackId).toBeUndefined();
      undo();
      expect(store.mixer.buses[0].strip?.inserts[0].sidechainSourceTrackId).toBe(sourceId);
    });
  });

  describe('solo-safe', () => {
    it('sets, dedupes and undoes the flag', () => {
      setTrackSoloSafe(trackId, true);
      expect(store.tracks[0].soloSafe).toBe(true);
      const depth = canUndo();
      setTrackSoloSafe(trackId, true); // no-op
      expect(canUndo()).toBe(depth);
      setTrackSoloSafe(trackId, false);
      expect(store.tracks[0].soloSafe).toBeUndefined();
      undo();
      expect(store.tracks[0].soloSafe).toBe(true);
    });
  });

  describe('VCA groups', () => {
    it('applies a mixer scene preset as one undoable template', () => {
      const result = applyMixerSceneJson(fakeMixingScenePresetJson('vocalReverbSend'));

      expect(result).toEqual({ trackCount: 1, busCount: 1, vcaCount: 0 });
      expect(store.tracks[0].mixer?.gainDb).toBe(-3);
      expect(store.tracks[0].mixer?.sends).toEqual([
        { busId: 'vocal-verb', levelDb: -14, enabled: true },
      ]);
      expect(store.mixer.buses[0]).toMatchObject({
        id: 'vocal-verb',
        name: 'Vocal Verb',
        gainDb: -10,
      });
      expect(store.mixer.buses[0].strip?.width).toBe(1.25);
      expect(store.mixer.buses[0].strip?.inserts).toEqual([
        {
          processor: 'stereo.imager',
          params: { width: 1.35 },
          enabled: true,
        },
      ]);

      expect(undo()).toBe(true);
      expect(store.mixer.buses).toEqual([]);
      expect(store.tracks[0].mixer).toBeUndefined();
    });

    it('maps mixer scene VCA groups and sidechain keys onto current tracks', () => {
      const guestId = addTrack({ name: 'Guest' });
      const musicId = addTrack({ name: 'Music' });

      const result = applyMixerSceneJson(fakeMixingScenePresetJson('commentaryDucking'));

      expect(result).toEqual({ trackCount: 3, busCount: 0, vcaCount: 1 });
      expect(store.mixer.vcaGroups).toEqual([{ id: 'voices', name: 'Voices', gainDb: 0 }]);
      expect(store.tracks[0].vcaId).toBe('voices');
      expect(store.tracks.find((track) => track.id === guestId)?.vcaId).toBe('voices');
      const music = store.tracks.find((track) => track.id === musicId);
      expect(music?.mixer?.gainDb).toBe(-18);
      expect(music?.mixer?.inserts[0]).toEqual({
        processor: 'dynamics.sidechainRouter',
        params: { rangeDb: 18 },
        enabled: true,
        sidechainSourceTrackId: trackId,
      });
    });

    it('drops mixer scene sidechain keys on group-track insert strips', () => {
      const groupId = addGroupTrack({ name: 'Group' });

      const result = applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          strips: [
            { id: 'host' },
            {
              id: 'group',
              inserts: [
                {
                  processor: 'dynamics.sidechainRouter',
                  params: { rangeDb: 12 },
                  sidechainKey: 'host',
                },
              ],
            },
          ],
          buses: [],
          connections: [],
        }),
      );

      const group = store.tracks.find((track) => track.id === groupId);
      expect(result.trackCount).toBe(2);
      expect(group?.kind).toBe('group');
      expect(group?.mixer?.inserts[0]).toEqual({
        processor: 'dynamics.sidechainRouter',
        params: { rangeDb: 12 },
        enabled: true,
      });
    });

    it('keeps mixer scene strip mapping bounded to existing tracks', () => {
      const result = applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          strips: [
            { id: 'lead', faderDb: -4 },
            { id: 'extra', faderDb: -18, pan: 1 },
          ],
          buses: [],
          connections: [],
          vcaGroups: [],
        }),
      );

      expect(result).toEqual({ trackCount: 1, busCount: 0, vcaCount: 0 });
      expect(store.tracks).toHaveLength(1);
      expect(store.tracks[0].mixer?.gainDb).toBe(-4);

      expect(undo()).toBe(true);
      expect(store.tracks).toHaveLength(1);
      expect(store.tracks[0].mixer).toBeUndefined();
    });

    it('drops mixer scene inserts that are not in the realtime catalog', () => {
      const result = applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          buses: [
            {
              id: 'master',
              role: 'master',
              inserts: [
                { processor: 'dynamics.compressor', params: { thresholdDb: -18 } },
                { processor: 'effects.reverb.plate', params: { decaySec: 1.8 } },
              ],
            },
            { id: 'room', role: 'aux' },
          ],
          connections: [
            { source: 'lead', destination: 'master' },
            { source: 'lead', destination: 'room' },
            { source: 'room', destination: 'room-return' },
          ],
          strips: [
            {
              id: 'lead',
              inserts: [
                { processor: 'stereo.imager', params: { width: 1.2 } },
                { processor: 'made.up', params: { amount: 1 } },
              ],
            },
            {
              id: 'room-return',
              inserts: [
                { processor: 'saturation.tape', params: { driveDb: 2 } },
                { processor: 'effects.reverb.plate', params: { decaySec: 2 } },
              ],
            },
          ],
        }),
      );

      expect(result).toEqual({ trackCount: 1, busCount: 1, vcaCount: 0 });
      expect(store.mixer.master.inserts).toEqual([
        { processor: 'dynamics.compressor', params: { thresholdDb: -18 }, enabled: true },
      ]);
      expect(store.tracks[0].mixer?.inserts).toEqual([
        { processor: 'stereo.imager', params: { width: 1.2 }, enabled: true },
      ]);
      expect(store.mixer.buses[0].strip?.inserts).toEqual([
        { processor: 'saturation.tape', params: { driveDb: 2 }, enabled: true },
      ]);
    });

    it('adds a group with a default name and undoes it', () => {
      const id = addVcaGroup();
      expect(store.mixer.vcaGroups).toEqual([{ id, name: 'VCA 1', gainDb: 0 }]);
      expect(undo()).toBe(true);
      expect(store.mixer.vcaGroups ?? []).toEqual([]);
    });

    it('rejects a duplicate id and enforces the group limit', () => {
      addVcaGroup({ id: 'g' });
      expect(() => addVcaGroup({ id: 'g' })).toThrow(RangeError);
      while ((store.mixer.vcaGroups?.length ?? 0) < MAX_VCA_GROUPS) addVcaGroup();
      expect(() => addVcaGroup()).toThrow(RangeError);
    });

    it('assigns a track to a group and validates the group id', () => {
      const id = addVcaGroup();
      setTrackVca(trackId, id);
      expect(store.tracks[0].vcaId).toBe(id);
      expect(() => setTrackVca(trackId, 'nope')).toThrow(RangeError);
      setTrackVca(trackId, null);
      expect(store.tracks[0].vcaId).toBeUndefined();
    });

    it('renames a group undoably without changing member assignments', () => {
      const id = addVcaGroup({ name: 'Band' });
      setTrackVca(trackId, id);
      renameVcaGroup(id, '  Drums  ');
      expect(store.mixer.vcaGroups?.[0]).toMatchObject({ id, name: 'Drums' });
      expect(store.tracks[0].vcaId).toBe(id);
      undo();
      expect(store.mixer.vcaGroups?.[0]).toMatchObject({ id, name: 'Band' });
      expect(store.tracks[0].vcaId).toBe(id);
      expect(() => renameVcaGroup(id, '   ')).toThrow(RangeError);
      expect(() => renameVcaGroup('missing', 'FX')).toThrow(RangeError);
    });

    it('sets the group gain with range validation', () => {
      const id = addVcaGroup();
      setVcaGroupGain(id, -6);
      expect(store.mixer.vcaGroups?.[0].gainDb).toBe(-6);
      expect(() => setVcaGroupGain(id, 999)).toThrow(RangeError);
      expect(() => setVcaGroupGain('nope', 0)).toThrow(RangeError);
    });

    it('sets VCA mute and solo flags undoably', () => {
      const id = addVcaGroup();
      setVcaGroupMute(id, true);
      setVcaGroupSolo(id, true);
      expect(store.mixer.vcaGroups?.[0]).toMatchObject({ id, mute: true, solo: true });

      undo();
      expect(store.mixer.vcaGroups?.[0].solo).toBeUndefined();
      expect(store.mixer.vcaGroups?.[0].mute).toBe(true);

      setVcaGroupMute(id, false);
      expect(store.mixer.vcaGroups?.[0].mute).toBeUndefined();
      expect(() => setVcaGroupMute('nope', true)).toThrow(RangeError);
      expect(() => setVcaGroupSolo('nope', true)).toThrow(RangeError);
    });

    it('unassigns member tracks when the group is removed', () => {
      const id = addVcaGroup();
      const otherId = addTrack({ name: 'Other' });
      setTrackVca(trackId, id);
      setTrackVca(otherId, id);
      removeVcaGroup(id);
      expect(store.mixer.vcaGroups ?? []).toEqual([]);
      expect(store.tracks.find((t) => t.id === trackId)?.vcaId).toBeUndefined();
      expect(store.tracks.find((t) => t.id === otherId)?.vcaId).toBeUndefined();
      expect(() => removeVcaGroup('nope')).toThrow(RangeError);
    });
  });
});
