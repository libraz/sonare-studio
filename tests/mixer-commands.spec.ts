import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  busAutomationTarget,
  insertAutomationParam,
  masteringAutomationParam,
} from '@/project/automation';
import {
  activeMixerSnapshotSlot,
  addAudioTrack,
  addGroupTrack,
  addInsert,
  addMasteringProcessor,
  addMixerBus,
  addNote,
  addTrack,
  addVcaGroup,
  applyMixerSceneJson,
  canUndo,
  clearAllSolo,
  clearHistory,
  clearMixerSnapshots,
  exportMixerSnapshotSlots,
  mixerBusStripTarget,
  mixerSnapshotFilled,
  recallMixerSnapshot,
  redo,
  removeInsert,
  removeMasteringProcessor,
  removeMixerBus,
  removeTrack,
  removeVcaGroup,
  renameMixerBus,
  renameVcaGroup,
  replaceInsert,
  saveMixerSnapshot,
  setExclusiveTrackSolo,
  setInsertEnabled,
  setInsertParam,
  setInsertSidechain,
  setMasteringPreset,
  setMixerBusChannelLayout,
  setMixerBusGain,
  setMixerBusMute,
  setMixerBusSolo,
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
  setTrackSolo,
  setTrackSoloSafe,
  setTrackVca,
  setVcaGroupGain,
  setVcaGroupMute,
  setVcaGroupSolo,
  undo,
} from '@/project/commands';
import type { TrackInstrument } from '@/project/instrument';
import {
  canRouteReturnSolo,
  createDefaultStrip,
  MAX_MIXER_BUSES,
  MAX_VCA_GROUPS,
  returnSoloRouting,
} from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import {
  midiLearnBusStripControlTargetId,
  midiLearnInsertTargetId,
  midiLearnMasteringTargetId,
  midiLearnTargetId,
} from '@/ui/midi/midi-learn';
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

  describe('solo shortcuts', () => {
    it('makes one track exclusively soloed and clears every solo atomically', () => {
      const secondTrackId = addAudioTrack({ name: 'Snare' });
      setTrackSolo(trackId, true);
      setTrackSolo(secondTrackId, true);
      clearHistory();

      setExclusiveTrackSolo(secondTrackId);
      expect(store.tracks.map((track) => track.solo)).toEqual([false, true]);
      expect(undo()).toBe(true);
      expect(store.tracks.map((track) => track.solo)).toEqual([true, true]);

      clearAllSolo();
      expect(store.tracks.every((track) => !track.solo)).toBe(true);
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
    it('stores PFL and clears the default in-place mode undoably', () => {
      setMixerSoloMode('pfl');
      expect(store.mixer.soloMode).toBe('pfl');
      setMixerSoloMode('inPlace');
      expect(store.mixer.soloMode).toBeUndefined();
      setMixerSoloMode('inPlace');
      expect(store.mixer.soloMode).toBeUndefined();

      expect(undo()).toBe(true);
      expect(store.mixer.soloMode).toBe('pfl');
    });
  });

  describe('setStripGain / setStripPan', () => {
    it('edits the track strip and undoes back to neutral', () => {
      setStripGain(trackId, -6);
      setStripPan(trackId, 0.5);
      expect(store.tracks[0].mixer).toMatchObject({ gainDb: -6, pan: 0.5 });
      expect(store.tracks[0].pan).toBe(0.5);
      undo();
      expect(store.tracks[0].mixer).toMatchObject({ gainDb: -6, pan: 0 });
      expect(store.tracks[0].pan).toBe(0);
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

    it('stores group-bus pan and keeps the legacy track mirror', () => {
      const groupId = addGroupTrack({ name: 'Drum Bus' });
      setStripPan(groupId, 0.5);
      const group = store.tracks.find((track) => track.id === groupId);
      expect(group).toMatchObject({ pan: 0.5, mixer: { pan: 0.5 } });
      expect(undo()).toBe(true);
      expect(store.tracks.find((track) => track.id === groupId)).toMatchObject({
        pan: 0,
      });
      expect(store.tracks.find((track) => track.id === groupId)?.mixer).toBeUndefined();
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
      setStripPanLaw(trackId, 'const6Db');
      expect(store.tracks[0].mixer?.panLaw).toBe('const6Db');
      // The default clears the field so a neutral strip stays neutral.
      setStripPanLaw(trackId, 'const3Db');
      expect(store.tracks[0].mixer?.panLaw).toBeUndefined();
      undo();
      expect(store.tracks[0].mixer?.panLaw).toBe('const6Db');
      expect(() => setStripPanLaw(trackId, 'bogus' as 'const3Db')).toThrow(RangeError);
    });

    it('keeps stereo identity when entering dual-pan from an offset pan, undoably', () => {
      setStripPan(trackId, 0.4);
      setStripPanMode(trackId, 'dualPan');
      expect(store.tracks[0].mixer?.panMode).toBe('dualPan');
      expect(store.tracks[0].mixer?.dualPan).toEqual({ left: -1, right: 1 });
      setStripPanMode(trackId, 'balance');
      expect(store.tracks[0].mixer?.panMode).toBeUndefined();
      undo();
      expect(store.tracks[0].mixer?.panMode).toBe('dualPan');
      expect(store.tracks[0].mixer?.dualPan).toEqual({ left: -1, right: 1 });
      expect(() => setStripPanMode(trackId, 'bogus' as 'balance')).toThrow(RangeError);
    });

    it('keeps a neutral stereo strip in dual-pan identity', () => {
      setStripPanMode(trackId, 'dualPan');
      expect(store.tracks[0].mixer).toMatchObject({
        panMode: 'dualPan',
        dualPan: { left: -1, right: 1 },
      });
    });

    it('supports pan controls on return buses and group buses', () => {
      const busId = addMixerBus({ name: 'FX' });
      const busTarget = mixerBusStripTarget(busId);
      const groupId = addGroupTrack({ name: 'Group' });

      setStripPanLaw(busTarget, 'const6Db');
      setStripPanMode(busTarget, 'dualPan');
      setStripDualPan(busTarget, -1, 0.75);
      setStripPanLaw(groupId, 'linear0Db');
      setStripPanMode(groupId, 'stereoPan');
      setStripDualPan(groupId, -0.5, 0.5);

      expect(store.mixer.buses[0].strip).toMatchObject({
        panLaw: 'const6Db',
        panMode: 'dualPan',
        dualPan: { left: -1, right: 0.75 },
      });
      expect(store.tracks.find((track) => track.id === groupId)?.mixer).toMatchObject({
        panLaw: 'linear0Db',
        panMode: 'stereoPan',
        dualPan: { left: -0.5, right: 0.5 },
      });
      expect(() => setStripPanLaw('master', 'const6Db')).toThrow(RangeError);
      expect(() => setStripPanMode('master', 'stereoPan')).toThrow(RangeError);
      expect(() => setStripDualPan('master', -1, 1)).toThrow(RangeError);
    });

    it('rejects stereo pan stages on surround return buses', () => {
      const busId = addMixerBus({ name: 'Surround FX' });
      const target = mixerBusStripTarget(busId);
      setMixerBusChannelLayout(busId, '5.1');

      expect(() => setStripPan(target, 0.25)).toThrow(/Surround mixer buses/);
      expect(() => setStripWidth(target, 0.5)).toThrow(/Surround mixer buses/);
      expect(() => setStripPanLaw(target, 'const6Db')).toThrow(/Surround mixer buses/);
      expect(() => setStripPanMode(target, 'stereoPan')).toThrow(/Surround mixer buses/);
      expect(() => setStripDualPan(target, -0.5, 0.5)).toThrow(/Surround mixer buses/);
      expect(store.mixer.buses[0].strip).toBeUndefined();

      // Returning to stereo re-enables those controls and removes only the
      // layout marker; no hidden panner state was created by the rejected edits.
      setMixerBusChannelLayout(busId, null);
      setStripPan(target, 0.25);
      expect(store.mixer.buses[0].strip?.pan).toBe(0.25);
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
      expect(store.tracks[0].mixer?.inserts[0]).toMatchObject({
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
        bands: [{ type: 'peak', frequencyHz: 1000, gainDb: 3 }],
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
      const eq = { enabled: true, bands: [{ type: 'peak', frequencyHz: 1000, gainDb: 3 }] };
      setStripEq(trackId, eq);
      expect(canUndo()).toBe(true);
      undo();
      expect(canUndo()).toBe(false);
      // A second, value-identical apply must not push history on its own.
      setStripEq(trackId, eq);
      setStripEq(trackId, {
        enabled: true,
        bands: [{ type: 'peak', frequencyHz: 1000, gainDb: 3 }],
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

    it('supports return-bus EQ and undoes it as one strip edit', () => {
      const busId = addMixerBus({ name: 'FX' });
      const target = mixerBusStripTarget(busId);

      setStripEq(target, {
        enabled: true,
        bands: [{ type: 'peak', frequencyHz: 1000, gainDb: 3 }],
      });
      expect(store.mixer.buses[0].strip?.eq).toEqual({
        enabled: true,
        bands: [{ type: 'peak', frequencyHz: 1000, gainDb: 3 }],
      });
      undo();
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

    it('routes generic strip gain on a return bus to the audible bus fader', () => {
      const busId = addMixerBus();
      setStripGain(mixerBusStripTarget(busId), -9);
      expect(store.mixer.buses[0].gainDb).toBe(-9);
      expect(store.mixer.buses[0].strip?.gainDb).toBeUndefined();
      undo();
      expect(store.mixer.buses[0].gainDb).toBe(0);
    });

    it('mutes a bus undoably without losing its fader value', () => {
      const busId = addMixerBus();
      setMixerBusGain(busId, -7.5);
      setMixerBusMute(busId, true);
      expect(store.mixer.buses[0]).toMatchObject({ gainDb: -7.5, mute: true });

      undo();
      expect(store.mixer.buses[0]).toMatchObject({ gainDb: -7.5 });
      expect(store.mixer.buses[0]?.mute).toBeUndefined();
      expect(() => setMixerBusMute('nope', true)).toThrow(RangeError);
    });

    it('solos one return at a time, undoably', () => {
      const first = addMixerBus({ name: 'Reverb' });
      const second = addMixerBus({ name: 'Delay' });

      setMixerBusSolo(first, true);
      expect(store.mixer.buses[0]).toMatchObject({ solo: true });

      setMixerBusSolo(second, true);
      expect(store.mixer.buses[0]?.solo).toBeUndefined();
      expect(store.mixer.buses[1]).toMatchObject({ solo: true });

      undo();
      expect(store.mixer.buses[0]).toMatchObject({ solo: true });
      expect(store.mixer.buses[1]?.solo).toBeUndefined();
      expect(() => setMixerBusSolo('nope', true)).toThrow(RangeError);
    });

    it('refuses a return solo when no engine bus slot is free', () => {
      const ids = Array.from({ length: MAX_MIXER_BUSES }, () => addMixerBus());

      expect(() => setMixerBusSolo(ids[0], true)).toThrow(/free engine bus|engine bus/);
      removeMixerBus(ids[MAX_MIXER_BUSES - 1]);
      expect(() => setMixerBusSolo(ids[0], true)).not.toThrow();
    });

    it('clears return solos together with track and VCA solos', () => {
      const busId = addMixerBus();
      const trackId = addTrack({ name: 'Keys' });
      setTrackSolo(trackId, true);
      setMixerBusSolo(busId, true);

      clearAllSolo();

      expect(store.mixer.buses[0]?.solo).toBeUndefined();
      expect(store.tracks.find((track) => track.id === trackId)?.solo).toBe(false);
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

      expect(store.mixer.buses[0].strip?.inserts).toMatchObject([
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

    it('does not create an undo entry when a send is already in the requested state', () => {
      const busId = addMixerBus({ name: 'FX' });
      setSend(trackId, busId, { levelDb: -12, timing: 'preFader' });
      clearHistory();

      setSend(trackId, busId, { levelDb: -12 });

      expect(canUndo()).toBe(false);
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

    it('routes bus sends and outputs through the bus strip, rejecting cycles', () => {
      const source = addMixerBus({ name: 'FX' });
      const destination = addMixerBus({ name: 'Print' });
      const sourceTarget = mixerBusStripTarget(source);

      setSend(sourceTarget, destination, { levelDb: -9, timing: 'preFader' });
      setStripOutputBus(sourceTarget, destination);
      expect(store.mixer.buses[0].strip).toMatchObject({
        sends: [{ busId: destination, levelDb: -9, enabled: true, timing: 'preFader' }],
        outputBusId: destination,
      });
      expect(() => setSend(mixerBusStripTarget(destination), source, { levelDb: -6 })).toThrow(
        /routing cycle/,
      );
      expect(() => setStripOutputBus(mixerBusStripTarget(destination), source)).toThrow(
        /routing cycle/,
      );
    });

    it('sets and clears surround bus layouts', () => {
      const busId = addMixerBus({ name: 'Atmos' });
      setMixerBusChannelLayout(busId, '5.1');
      expect(store.mixer.buses[0].channelLayout).toBe('5.1');
      setMixerBusChannelLayout(busId, null);
      expect(store.mixer.buses[0].channelLayout).toBeUndefined();
      expect(() => setMixerBusChannelLayout('missing', '5.1')).toThrow(RangeError);
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
      const busBinding = midiLearnBusStripControlTargetId(busId, 'width');
      store.midiCcBindings.set(busBinding, { channel: 0, controller: 74 });
      setSend(trackId, busId, { levelDb: -9 });
      store.mixer.master.sends = [{ busId, levelDb: -3, enabled: true }];
      removeMixerBus(busId);
      expect(store.mixer.buses).toEqual([]);
      expect(store.midiCcBindings.has(busBinding)).toBe(false);
      expect(store.tracks[0].mixer?.sends).toEqual([]);
      expect(store.mixer.master.sends).toEqual([]);
      undo();
      expect(store.mixer.buses).toHaveLength(1);
      expect(store.tracks[0].mixer?.sends).toHaveLength(1);
      expect(store.mixer.master.sends).toHaveLength(1);
      expect(store.midiCcBindings.get(busBinding)).toEqual({ channel: 0, controller: 74 });
      expect(() => removeMixerBus('nope')).toThrow(RangeError);
    });

    it('detaches sends on surviving bus return strips when a bus is removed', () => {
      const busA = addMixerBus({ name: 'A' });
      const busB = addMixerBus({ name: 'B' });
      const busObjA = store.mixer.buses.find((bus) => bus.id === busA);
      if (busObjA) {
        busObjA.strip = {
          gainDb: 0,
          pan: 0,
          inserts: [],
          sends: [{ busId: busB, levelDb: -6, enabled: true }],
        };
      }
      removeMixerBus(busB);
      const remainingA = store.mixer.buses.find((bus) => bus.id === busA);
      expect(remainingA?.strip?.sends).toEqual([]);
      undo();
      expect(store.mixer.buses.find((bus) => bus.id === busA)?.strip?.sends).toEqual([
        { busId: busB, levelDb: -6, enabled: true },
      ]);
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

    it('rejects routing the master or an unknown bus, while allowing group buses', () => {
      const busId = addMixerBus();
      const groupId = addGroupTrack();
      expect(() => setStripOutputBus('master', busId)).toThrow(RangeError);
      setStripOutputBus(groupId, busId);
      expect(store.tracks.find((track) => track.id === groupId)?.mixer?.outputBusId).toBe(busId);
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
      expect(() => setInsertSidechain(trackId, 0, sourceId)).toThrow(/Unknown insert index/);
      addInsert(trackId, 'dynamics.compressor');
      expect(() => setInsertSidechain(trackId, 5, sourceId)).toThrow(RangeError);
      expect(() => setInsertSidechain(trackId, 0, trackId)).toThrow(/its own track/);
      expect(() => setInsertSidechain(trackId, 0, 9999)).toThrow(RangeError);
      expect(() => setInsertSidechain(9999, 0, sourceId)).toThrow(RangeError);
      const groupId = addGroupTrack({ name: 'Group' });
      addInsert(groupId, 'dynamics.compressor');
      setInsertSidechain(groupId, 0, sourceId);
      expect(
        store.tracks.find((track) => track.id === groupId)?.mixer?.inserts[0]
          .sidechainSourceTrackId,
      ).toBe(sourceId);
      expect(store.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBeUndefined();
    });

    it('refuses a track key that would close a cycle between track lanes', () => {
      const kickId = addAudioTrack({ name: 'Kick' });
      const bassId = addAudioTrack({ name: 'Bass' });
      addInsert(trackId, 'dynamics.compressor');
      addInsert(kickId, 'dynamics.compressor');
      addInsert(bassId, 'dynamics.compressor');
      setInsertSidechain(trackId, 0, kickId);
      setInsertSidechain(kickId, 0, bassId);
      expect(() => setInsertSidechain(bassId, 0, trackId)).toThrow(/cycle/);
      expect(() => setInsertSidechain(kickId, 0, trackId)).toThrow(/cycle/);
    });

    it('requires the group namespace when a group track is the key source', () => {
      const groupId = addGroupTrack({ name: 'Key group' });
      addInsert(trackId, 'dynamics.compressor');
      expect(() => setInsertSidechain(trackId, 0, { kind: 'track', trackId: groupId })).toThrow(
        /group sidechain key/,
      );

      const busId = addMixerBus({ name: 'Target bus' });
      const busTarget = mixerBusStripTarget(busId);
      addInsert(busTarget, 'dynamics.compressor');
      expect(() => setInsertSidechain(busTarget, 0, { kind: 'track', trackId: groupId })).toThrow(
        /group sidechain key/,
      );

      addInsert('master', 'dynamics.compressor');
      expect(() => setInsertSidechain('master', 0, { kind: 'track', trackId: groupId })).toThrow(
        /group sidechain key/,
      );
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

    it('keys a bus insert from another bus and rejects a self key', () => {
      const keyBus = addMixerBus({ name: 'Key' });
      const targetBus = addMixerBus({ name: 'Target' });
      const target = mixerBusStripTarget(targetBus);
      addInsert(target, 'dynamics.compressor');

      setInsertSidechain(target, 0, { kind: 'bus', busId: keyBus });
      expect(store.mixer.buses[1].strip?.inserts[0].sidechainSourceBusId).toBe(keyBus);
      expect(() => setInsertSidechain(target, 0, { kind: 'bus', busId: targetBus })).toThrow(
        /own bus/,
      );

      const keyTarget = mixerBusStripTarget(keyBus);
      addInsert(keyTarget, 'dynamics.compressor');
      expect(() => setInsertSidechain(keyTarget, 0, { kind: 'bus', busId: targetBus })).toThrow(
        /routing cycle/,
      );
    });

    it('validates bus and group sidechain keys against group-bus cycles', () => {
      const sourceBus = addMixerBus({ name: 'Key' });
      const targetGroup = addGroupTrack({ name: 'Target group' });
      setStripOutputBus(targetGroup, sourceBus);
      addInsert(targetGroup, 'dynamics.compressor');

      expect(() => setInsertSidechain(targetGroup, 0, { kind: 'bus', busId: sourceBus })).toThrow(
        /routing cycle/,
      );

      const sourceGroup = addGroupTrack({ name: 'Source group' });
      addInsert(targetGroup, 'dynamics.sidechainRouter');
      setInsertSidechain(targetGroup, 1, { kind: 'group', trackId: sourceGroup });
      expect(
        store.tracks.find((track) => track.id === targetGroup)?.mixer?.inserts[1]
          .sidechainSourceGroupTrackId,
      ).toBe(sourceGroup);
      expect(() =>
        setInsertSidechain(targetGroup, 1, { kind: 'group', trackId: targetGroup }),
      ).toThrow(/own group bus/);
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

    it('prunes master/snapshot sidechains and MIDI targets, then restores all on undo', () => {
      addInsert('master', 'dynamics.compressor');
      const sourceId = addAudioTrack({ name: 'Kick' });
      store.mixer.master.inserts[0].sidechainSourceTrackId = sourceId;
      const bindingTarget = midiLearnTargetId('gain', sourceId);
      store.midiCcBindings.set(bindingTarget, { channel: 0, controller: 7 });
      saveMixerSnapshot('A');
      clearHistory();

      removeTrack(sourceId);

      expect(store.mixer.master.inserts[0].sidechainSourceTrackId).toBeUndefined();
      expect(store.midiCcBindings.has(bindingTarget)).toBe(false);
      const prunedSnapshot = exportMixerSnapshotSlots().snapshots.A;
      expect(prunedSnapshot?.tracks.some((track) => track.id === sourceId)).toBe(false);
      expect(prunedSnapshot?.mixer.master.inserts[0].sidechainSourceTrackId).toBeUndefined();

      expect(undo()).toBe(true);
      expect(store.mixer.master.inserts[0].sidechainSourceTrackId).toBe(sourceId);
      expect(store.midiCcBindings.get(bindingTarget)).toEqual({ channel: 0, controller: 7 });
      const restoredSnapshot = exportMixerSnapshotSlots().snapshots.A;
      expect(restoredSnapshot?.tracks.some((track) => track.id === sourceId)).toBe(true);
      expect(restoredSnapshot?.mixer.master.inserts[0].sidechainSourceTrackId).toBe(sourceId);
    });
  });

  describe('insert copy and paste', () => {
    it('replaces settings atomically while retaining the destination processor id', () => {
      addInsert(trackId, 'dynamics.compressor', { thresholdDb: -18, ratio: 4 });
      const destinationTrackId = addAudioTrack({ name: 'Snare' });
      addInsert(destinationTrackId, 'dynamics.compressor', { thresholdDb: -6 });
      const source = store.tracks[0].mixer!.inserts[0];
      const destinationId = store.tracks[1].mixer!.inserts[0].id;
      const { id: _sourceId, ...copied } = source;
      clearHistory();

      replaceInsert(destinationTrackId, 0, copied);

      expect(store.tracks[1].mixer!.inserts[0]).toMatchObject({
        id: destinationId,
        processor: 'dynamics.compressor',
        params: { thresholdDb: -18, ratio: 4 },
      });
      expect(undo()).toBe(true);
      expect(store.tracks[1].mixer!.inserts[0]).toMatchObject({
        id: destinationId,
        processor: 'dynamics.compressor',
        params: { thresholdDb: -6 },
      });
    });

    it('validates copied sidechain sources and routing cycles before replacing', () => {
      const firstBusId = addMixerBus({ id: 'first' });
      const secondBusId = addMixerBus({ id: 'second' });
      addInsert(trackId, 'dynamics.compressor');
      expect(() =>
        replaceInsert(trackId, 0, {
          processor: 'dynamics.compressor',
          params: {},
          enabled: true,
          sidechainSourceBusId: firstBusId,
        }),
      ).toThrow(/Ordinary track inserts can only use track sidechain keys/);

      const firstTarget = mixerBusStripTarget(firstBusId);
      const secondTarget = mixerBusStripTarget(secondBusId);
      addInsert(firstTarget, 'dynamics.compressor');
      addInsert(secondTarget, 'dynamics.compressor');
      setInsertSidechain(firstTarget, 0, { kind: 'bus', busId: secondBusId });
      expect(() =>
        replaceInsert(secondTarget, 0, {
          processor: 'dynamics.compressor',
          params: {},
          enabled: true,
          sidechainSourceBusId: firstBusId,
        }),
      ).toThrow(/routing cycle/);
    });

    it('changes identity and prunes old processor references when the type changes', () => {
      addInsert(trackId, 'dynamics.compressor', { thresholdDb: -18 });
      addInsert(trackId, 'eq.tilt', { tiltDb: 1 });
      const oldId = store.tracks[0].mixer!.inserts[0].id as string;
      const laterId = store.tracks[0].mixer!.inserts[1].id as string;
      const oldStableParam = insertAutomationParam(oldId, 'thresholdDb');
      const oldLegacyParam = 'insert:0:thresholdDb' as const;
      const laterParam = insertAutomationParam(laterId, 'tiltDb');
      store.automationLanes = [
        {
          target: trackId,
          param: oldStableParam,
          points: [{ ppq: 0, value: -12 }],
          enabled: true,
        },
        {
          target: trackId,
          param: oldLegacyParam,
          points: [{ ppq: 0, value: -6 }],
          enabled: true,
        },
        {
          target: trackId,
          param: laterParam,
          points: [{ ppq: 0, value: 2 }],
          enabled: true,
        },
      ];
      const oldStableTarget = midiLearnInsertTargetId(trackId, oldId, 'thresholdDb');
      const oldLegacyTarget = midiLearnInsertTargetId(trackId, 0, 'thresholdDb');
      const laterTarget = midiLearnInsertTargetId(trackId, laterId, 'tiltDb');
      store.midiCcBindings.set(oldStableTarget, { channel: 0, controller: 20 });
      store.midiCcBindings.set(oldLegacyTarget, { channel: 0, controller: 21 });
      store.midiCcBindings.set(laterTarget, { channel: 0, controller: 22 });
      clearHistory();

      replaceInsert(trackId, 0, {
        processor: 'saturation.tape',
        params: { drive: 0.4 },
        enabled: true,
      });

      const replacementId = store.tracks[0].mixer!.inserts[0].id;
      expect(replacementId).toBeDefined();
      expect(replacementId).not.toBe(oldId);
      expect(store.automationLanes.map((lane) => lane.param)).toEqual([laterParam]);
      expect(store.midiCcBindings.has(oldStableTarget)).toBe(false);
      expect(store.midiCcBindings.has(oldLegacyTarget)).toBe(false);
      expect(store.midiCcBindings.get(laterTarget)).toEqual({ channel: 0, controller: 22 });

      expect(undo()).toBe(true);
      expect(store.tracks[0].mixer!.inserts[0]).toMatchObject({
        id: oldId,
        processor: 'dynamics.compressor',
      });
      expect(store.automationLanes.map((lane) => lane.param)).toEqual([
        oldStableParam,
        oldLegacyParam,
        laterParam,
      ]);
      expect(store.midiCcBindings.get(oldStableTarget)).toEqual({ channel: 0, controller: 20 });
      expect(store.midiCcBindings.get(oldLegacyTarget)).toEqual({ channel: 0, controller: 21 });
    });
  });

  describe('mixer snapshots', () => {
    it('stores a snapshot as an undoable slot edit', () => {
      clearMixerSnapshots();
      saveMixerSnapshot('A');
      expect(mixerSnapshotFilled('A')).toBe(true);
      expect(activeMixerSnapshotSlot()).toBe('A');

      expect(undo()).toBe(true);
      expect(mixerSnapshotFilled('A')).toBe(false);
      expect(activeMixerSnapshotSlot()).toBeNull();

      expect(redo()).toBe(true);
      expect(mixerSnapshotFilled('A')).toBe(true);
      expect(activeMixerSnapshotSlot()).toBe('A');
    });

    it('captures and restores the canonical strip gain with the strip state', () => {
      store.tracks[0].mixer = { ...createDefaultStrip(), gainDb: -6 };
      saveMixerSnapshot('A');
      store.tracks[0].mixer.gainDb = 3;
      clearHistory();

      expect(recallMixerSnapshot('A')).toBe(true);
      expect(store.tracks[0]).toMatchObject({
        volume: 1,
        mixer: expect.objectContaining({ gainDb: -6 }),
      });
    });

    it('restores the active slot together with the recalled mix on undo and redo', () => {
      setStripGain(trackId, -9);
      saveMixerSnapshot('A');
      setStripGain(trackId, 3);
      saveMixerSnapshot('B');
      clearHistory();

      expect(recallMixerSnapshot('A')).toBe(true);
      expect(store.tracks[0].mixer?.gainDb).toBe(-9);
      expect(activeMixerSnapshotSlot()).toBe('A');

      expect(undo()).toBe(true);
      expect(store.tracks[0].mixer?.gainDb).toBe(3);
      expect(activeMixerSnapshotSlot()).toBe('B');

      expect(redo()).toBe(true);
      expect(store.tracks[0].mixer?.gainDb).toBe(-9);
      expect(activeMixerSnapshotSlot()).toBe('A');
    });

    it('recalls processor automation atomically, prunes new-chain targets, and restores them on undo', () => {
      addInsert(trackId, 'saturation.tape', { drive: 0.4 });
      addInsert('master', 'eq.tilt', { tiltDb: 1 });
      addMasteringProcessor('maximizer.truePeakLimiter', { ceilingDb: -1 });
      const capturedTrackId = store.tracks[0].mixer?.inserts[0].id as string;
      const capturedMasterId = store.mixer.master.inserts[0].id as string;
      const capturedMasteringId = store.mixer.masteringChain?.processors[0].id as string;
      const capturedParams = [
        insertAutomationParam(capturedTrackId, 'drive'),
        insertAutomationParam(capturedMasterId, 'tiltDb'),
        masteringAutomationParam(capturedMasteringId, 'ceilingDb'),
      ];
      store.automationLanes = capturedParams.map((param, index) => ({
        target: index === 0 ? trackId : 'master',
        param,
        points: [{ ppq: 0, value: index + 1 }],
        enabled: true,
      }));
      saveMixerSnapshot('A');

      removeInsert(trackId, 0);
      removeInsert('master', 0);
      removeMasteringProcessor(0);
      addInsert(trackId, 'dynamics.compressor', { thresholdDb: -12 });
      addInsert('master', 'saturation.tape', { drive: 0.7 });
      addMasteringProcessor('eq.tilt', { tiltDb: -2 });
      const currentTrackId = store.tracks[0].mixer?.inserts[0].id as string;
      const currentMasterId = store.mixer.master.inserts[0].id as string;
      const currentMasteringId = store.mixer.masteringChain?.processors[0].id as string;
      const currentParams = [
        insertAutomationParam(currentTrackId, 'thresholdDb'),
        insertAutomationParam(currentMasterId, 'drive'),
        masteringAutomationParam(currentMasteringId, 'tiltDb'),
      ];
      store.automationLanes = currentParams.map((param, index) => ({
        target: index === 0 ? trackId : 'master',
        param,
        points: [{ ppq: 0, value: -(index + 1) }],
        enabled: true,
      }));
      const currentMidiTarget = midiLearnInsertTargetId(trackId, currentTrackId, 'thresholdDb');
      store.midiCcBindings.set(currentMidiTarget, { channel: 2, controller: 42 });
      clearHistory();

      expect(recallMixerSnapshot('A')).toBe(true);
      expect(store.automationLanes.map((lane) => lane.param)).toEqual(capturedParams);
      expect(store.midiCcBindings.has(currentMidiTarget)).toBe(false);

      expect(undo()).toBe(true);
      expect(store.automationLanes.map((lane) => lane.param)).toEqual(currentParams);
      expect(store.midiCcBindings.get(currentMidiTarget)).toEqual({ channel: 2, controller: 42 });
      expect(store.tracks[0].mixer?.inserts[0].id).toBe(currentTrackId);
      expect(store.mixer.masteringChain?.processors[0].id).toBe(currentMasteringId);
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
    it('rejects a scene whose send and group buses exceed the final engine limit', () => {
      addGroupTrack({ name: 'Group 1' });
      addGroupTrack({ name: 'Group 2' });
      clearHistory();
      const beforeMixer = JSON.parse(JSON.stringify(store.mixer));
      const beforeTracks = JSON.parse(JSON.stringify(store.tracks));
      const scene = JSON.stringify({
        version: 1,
        strips: [],
        buses: Array.from({ length: 7 }, (_, index) => ({
          id: `bus-${index + 1}`,
          role: 'aux',
        })),
        connections: [],
      });

      expect(() => applyMixerSceneJson(scene)).toThrow(/Mixer bus limit exceeded \(9\/8\)/);
      expect(store.mixer).toEqual(beforeMixer);
      expect(store.tracks).toEqual(beforeTracks);
      expect(undo()).toBe(false);
    });

    it('rejects an oversized snapshot recall without changing state or active slot', () => {
      for (let index = 0; index < MAX_MIXER_BUSES; index += 1) addMixerBus();
      saveMixerSnapshot('A');
      for (const bus of [...store.mixer.buses]) removeMixerBus(bus.id);
      addGroupTrack({ name: 'Group 1' });
      addGroupTrack({ name: 'Group 2' });
      saveMixerSnapshot('B');
      clearHistory();
      const beforeMixer = JSON.parse(JSON.stringify(store.mixer));
      const beforeTracks = JSON.parse(JSON.stringify(store.tracks));

      expect(() => recallMixerSnapshot('A')).toThrow(/Mixer bus limit exceeded \(10\/8\)/);
      expect(activeMixerSnapshotSlot()).toBe('B');
      expect(store.mixer).toEqual(beforeMixer);
      expect(store.tracks).toEqual(beforeTracks);
      expect(undo()).toBe(false);
    });

    it('applies a mixer scene preset as one undoable template', () => {
      setMixerSoloMode('pfl');
      setMasteringPreset('club');
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
      expect(store.mixer.buses[0].strip?.inserts).toMatchObject([
        {
          processor: 'stereo.imager',
          params: { width: 1.35 },
          enabled: true,
        },
      ]);
      expect(store.mixer.soloMode).toBe('pfl');
      expect(store.mixer.masteringChain?.preset).toBe('club');

      expect(undo()).toBe(true);
      expect(store.mixer.buses).toEqual([]);
      expect(store.tracks[0].mixer).toBeUndefined();
    });

    it('maps scene strips named track-<id> onto those tracks instead of by order', () => {
      const secondId = addTrack({ name: 'Second' });
      const scene = JSON.stringify({
        version: 1,
        strips: [{ id: `track-${secondId}`, faderDb: -7 }],
        buses: [],
        connections: [],
      });
      const result = applyMixerSceneJson(scene);
      expect(result.trackCount).toBe(1);
      expect(store.tracks.find((track) => track.id === secondId)?.mixer?.gainDb).toBe(-7);
      expect(store.tracks[0].mixer).toBeUndefined();
    });

    it('keeps the master inserts when the scene names none', () => {
      addInsert('master', 'eq.tilt', { tiltDb: 1 });
      const scene = JSON.stringify({
        version: 1,
        strips: [{ id: `track-${trackId}`, faderDb: -2 }],
        buses: [],
        connections: [],
      });
      applyMixerSceneJson(scene);
      expect(store.mixer.master.inserts.map((slot) => slot.processor)).toEqual(['eq.tilt']);
    });

    it('clamps out-of-range width and channel delay from an imported scene', () => {
      const scene = JSON.stringify({
        version: 1,
        strips: [{ id: 'track-1', width: 5, channelDelaySamples: 5_000_000 }],
        buses: [],
        connections: [],
      });
      applyMixerSceneJson(scene);
      // Width is bounded to [0, 2] and the channel delay to its sample ceiling,
      // never trusting the imported scene's raw numbers.
      expect(store.tracks[0].mixer?.width).toBe(2);
      expect(store.tracks[0].mixer?.channelDelaySamples).toBe(96000);
    });

    it('prunes processor lanes for replaced scene strips and restores them on undo', () => {
      addInsert(trackId, 'saturation.tape', { drive: 0.4 });
      addInsert('master', 'eq.tilt', { tiltDb: 1 });
      addMasteringProcessor('maximizer.truePeakLimiter', { ceilingDb: -1 });
      const oldBusId = addMixerBus('Old return');
      addInsert(mixerBusStripTarget(oldBusId), 'dynamics.compressor', { thresholdDb: -18 });
      const trackProcessorId = store.tracks[0].mixer?.inserts[0].id as string;
      const masterProcessorId = store.mixer.master.inserts[0].id as string;
      const masteringProcessorId = store.mixer.masteringChain?.processors[0].id as string;
      const busProcessorId = store.mixer.buses[0].strip?.inserts[0].id as string;
      const processorMidiTargets = [
        midiLearnInsertTargetId(trackId, trackProcessorId, 'drive'),
        midiLearnInsertTargetId('master', masterProcessorId, 'tiltDb'),
        midiLearnMasteringTargetId(masteringProcessorId, 'ceilingDb'),
      ];
      for (const [index, target] of processorMidiTargets.entries()) {
        store.midiCcBindings.set(target, { channel: index, controller: 40 + index });
      }
      store.automationLanes = [
        {
          target: trackId,
          param: insertAutomationParam(trackProcessorId, 'drive'),
          points: [{ ppq: 0, value: 0.7 }],
          enabled: true,
        },
        {
          target: trackId,
          param: 'faderDb',
          points: [{ ppq: 0, value: -3 }],
          enabled: true,
        },
        {
          target: 'master',
          param: insertAutomationParam(masterProcessorId, 'tiltDb'),
          points: [{ ppq: 0, value: 2 }],
          enabled: true,
        },
        {
          target: 'master',
          param: masteringAutomationParam(masteringProcessorId, 'ceilingDb'),
          points: [{ ppq: 0, value: -2 }],
          enabled: true,
        },
        {
          target: busAutomationTarget(oldBusId),
          param: insertAutomationParam(busProcessorId, 'thresholdDb'),
          points: [{ ppq: 0, value: -24 }],
          enabled: true,
        },
      ];
      const before = store.automationLanes.map((lane) => ({
        ...lane,
        points: lane.points.map((point) => ({ ...point })),
      }));
      clearHistory();

      applyMixerSceneJson(fakeMixingScenePresetJson('vocalReverbSend'));
      // The preset names no master inserts, so the master chain and its lane stay.
      expect(store.automationLanes).toEqual([before[1], before[2], before[3]]);
      expect(store.midiCcBindings.has(processorMidiTargets[0])).toBe(false);
      expect(store.midiCcBindings.has(processorMidiTargets[1])).toBe(true);
      expect(store.midiCcBindings.has(processorMidiTargets[2])).toBe(true);

      expect(undo()).toBe(true);
      expect(store.automationLanes).toEqual(before);
      expect(processorMidiTargets.every((target) => store.midiCcBindings.has(target))).toBe(true);
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
      expect(music?.mixer?.inserts[0]).toMatchObject({
        processor: 'dynamics.sidechainRouter',
        params: { rangeDb: 18 },
        enabled: true,
        sidechainSourceTrackId: trackId,
      });
    });

    it('maps mixer scene sidechain keys onto group-track bus inserts', () => {
      const groupId = addGroupTrack({ name: 'Group' });
      applyMixerSceneJson(
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
      expect(store.tracks.find((track) => track.id === groupId)?.mixer?.inserts[0]).toMatchObject({
        sidechainSourceTrackId: trackId,
      });
    });

    it('preserves group pan imported from a mixer scene', () => {
      const groupId = addGroupTrack({ name: 'Group' });
      applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          strips: [{ id: 'host' }, { id: 'group', pan: 0.75 }],
          buses: [],
          connections: [],
        }),
      );

      expect(store.tracks.find((track) => track.id === groupId)).toMatchObject({
        pan: 0.75,
        mixer: { pan: 0.75 },
      });
    });

    it('imports direct bus pan and EQ fields from the current scene schema', () => {
      const busId = addMixerBus({ id: 'old-bus', name: 'Old' });
      // Keep the current project independent of the scene's bus ids: the
      // scene replaces the bus list as one atomic template operation.
      expect(busId).toBe('old-bus');
      applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          strips: [],
          buses: [
            {
              id: 'renamed-master',
              role: 'master',
              inputTrimDb: -2,
              pan: 0.1,
              eq: {
                enabled: true,
                bands: [{ type: 'peak', frequencyHz: 700, gainDb: -1.5 }],
              },
            },
            {
              id: 'room',
              role: 'aux',
              pan: -0.35,
              panMode: 'dualPan',
              dualPanLeft: -1,
              dualPanRight: 0.6,
              panLaw: 'const6Db',
              inputTrimDb: -3,
              eq: {
                enabled: true,
                bands: [{ type: 'peak', frequencyHz: 1200, gainDb: 2 }],
              },
              inserts: [{ processor: 'dynamics.compressor', params: { thresholdDb: -18 } }],
            },
          ],
          connections: [],
        }),
      );

      expect(store.mixer.buses).toHaveLength(1);
      expect(store.mixer.buses[0]).toMatchObject({ id: 'room' });
      expect(store.mixer.buses[0].strip).toMatchObject({
        pan: -0.35,
        panMode: 'dualPan',
        dualPan: { left: -1, right: 0.6 },
        panLaw: 'const6Db',
        inputTrimDb: -3,
        eq: { enabled: true, bands: [{ type: 'peak', frequencyHz: 1200, gainDb: 2 }] },
        inserts: [{ processor: 'dynamics.compressor' }],
      });
      expect(store.mixer.master).toMatchObject({
        inputTrimDb: -2,
        pan: 0.1,
        eq: { enabled: true, bands: [{ type: 'peak', frequencyHz: 700, gainDb: -1.5 }] },
      });
    });

    it('rejects ambiguous direct bus and legacy return DSP', () => {
      expect(() =>
        applyMixerSceneJson(
          JSON.stringify({
            version: 1,
            buses: [
              {
                id: 'room',
                role: 'aux',
                eq: { enabled: true, bands: [{ type: 'peak', frequencyHz: 900, gainDb: 2 }] },
                inserts: [],
              },
            ],
            connections: [{ source: 'room', destination: 'room-return' }],
            strips: [
              {
                id: 'room-return',
                inserts: [{ processor: 'dynamics.compressor', params: {} }],
              },
            ],
          }),
        ),
      ).toThrow(/direct DSP.*legacy return strip/);
    });

    it('rejects direct bus pan combined with a legacy return insert', () => {
      expect(() =>
        applyMixerSceneJson(
          JSON.stringify({
            version: 1,
            buses: [{ id: 'room', role: 'aux', pan: 0.5 }],
            connections: [{ source: 'room', destination: 'room-return' }],
            strips: [
              { id: 'room-return', inserts: [{ processor: 'dynamics.compressor', params: {} }] },
            ],
          }),
        ),
      ).toThrow(/direct DSP or pan.*legacy return strip/);
    });

    it('keeps legacy return DSP when direct bus fields are explicitly neutral', () => {
      applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          buses: [{ id: 'room', role: 'aux', pan: 0, inputTrimDb: 0, width: 1 }],
          connections: [{ source: 'room', destination: 'room-return' }],
          strips: [{ id: 'room-return', pan: 0.5, inputTrimDb: -3, width: 0.8 }],
        }),
      );

      expect(store.mixer.buses[0].strip).toMatchObject({ pan: 0.5, inputTrimDb: -3, width: 0.8 });
    });

    it('maps legacy return mute and solo onto the audible bus', () => {
      applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          buses: [{ id: 'room', role: 'aux' }],
          connections: [{ source: 'room', destination: 'room-return' }],
          strips: [{ id: 'room-return', muted: true, soloed: true }],
        }),
      );

      expect(store.mixer.buses[0]).toMatchObject({ id: 'room', mute: true, solo: true });
    });

    it('imports legacy return sends into the bus strip', () => {
      applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          buses: [
            { id: 'room', role: 'aux' },
            { id: 'print', role: 'aux' },
          ],
          connections: [{ source: 'room', destination: 'room-return' }],
          strips: [
            {
              id: 'room-return',
              sends: [{ destinationBusId: 'print', sendDb: -6 }],
            },
          ],
        }),
      );
      expect(store.mixer.buses[0].strip?.sends).toEqual([
        { busId: 'print', levelDb: -6, enabled: true },
      ]);
    });

    it('rejects a literal master id on an aux bus when a master role exists', () => {
      expect(() =>
        applyMixerSceneJson(
          JSON.stringify({
            version: 1,
            strips: [],
            buses: [
              { id: 'master', role: 'aux', pan: -0.5 },
              { id: 'actual-master', role: 'master', pan: 0.25 },
            ],
            connections: [],
          }),
        ),
      ).toThrow(/reserved/);
    });

    it('imports the submix role emitted by the Studio bus scene', () => {
      applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          strips: [],
          buses: [{ id: 'drums', role: 'submix', pan: -0.3 }],
          connections: [],
        }),
      );

      expect(store.mixer.buses[0]).toMatchObject({ id: 'drums', strip: { pan: -0.3 } });
    });

    it('imports surround scene bus layouts and strip source positions', () => {
      applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          strips: [
            {
              id: 'source',
              sourceLayout: '5.1',
              surroundPan: {
                azimuth: 30,
                divergence: 0.25,
                lfe: 0.1,
              },
            },
          ],
          buses: [
            {
              id: 'surround',
              role: 'submix',
              layout: '5.1',
            },
          ],
          connections: [],
        }),
      );
      expect(store.mixer.buses[0].channelLayout).toBe('5.1');
      expect(store.mixer.buses[0].strip?.surroundPan).toBeUndefined();
      expect(store.tracks[0].mixer?.sourceLayout).toBe('5.1');
      expect(store.tracks[0].mixer?.surroundPan).toEqual({
        azimuth: 30,
        divergence: 0.25,
        lfe: 0.1,
      });
    });

    it('rejects invalid scene bus ids before replacing the mixer', () => {
      for (const [buses, message] of [
        [[{ id: '' }, { id: 'room' }], /must not be empty/],
        [[{ id: 'room' }, { id: 'room' }], /already exists/],
        [[{ id: 'group:1' }], /reserved/],
        [[{ id: 'return-solo-discard' }], /reserved/],
      ] as const) {
        expect(() =>
          applyMixerSceneJson(JSON.stringify({ strips: [], buses, connections: [] })),
        ).toThrow(message);
      }
    });

    it('rejects bus sidechain keys on ordinary scene tracks', () => {
      expect(() =>
        applyMixerSceneJson(
          JSON.stringify({
            strips: [
              {
                id: 'track',
                inserts: [{ processor: 'dynamics.compressor', sidechainKey: 'room' }],
              },
            ],
            buses: [{ id: 'room', role: 'aux' }],
            connections: [],
          }),
        ),
      ).toThrow(/must reference a track/);
    });

    it('maps legacy return-strip sidechain keys to the owning bus', () => {
      applyMixerSceneJson(
        JSON.stringify({
          strips: [{ id: 'room-return' }],
          buses: [
            { id: 'room', role: 'aux' },
            {
              id: 'print',
              role: 'aux',
              inserts: [{ processor: 'dynamics.compressor', sidechainKey: 'room-return' }],
            },
          ],
          connections: [{ source: 'room', destination: 'room-return' }],
        }),
      );
      expect(store.mixer.buses.find((bus) => bus.id === 'print')?.strip?.inserts[0]).toMatchObject({
        sidechainSourceBusId: 'room',
      });
    });

    it('imports bus-to-bus output routes, sends and bus sidechain keys', () => {
      applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          strips: [
            {
              id: 'room-return',
              sends: [{ destinationBusId: 'print', sendDb: -8, timing: 'preFader' }],
            },
          ],
          buses: [
            { id: 'key', role: 'aux' },
            {
              id: 'room',
              role: 'aux',
              inserts: [
                {
                  processor: 'dynamics.compressor',
                  params: {},
                  sidechainKey: 'key',
                },
              ],
            },
            { id: 'print', role: 'aux' },
          ],
          connections: [
            { source: 'room', destination: 'room-return' },
            { source: 'room', destination: 'print' },
          ],
        }),
      );
      const room = store.mixer.buses.find((bus) => bus.id === 'room');
      expect(room?.strip).toMatchObject({
        outputBusId: 'print',
        sends: [{ busId: 'print', levelDb: -8, timing: 'preFader' }],
        inserts: [{ sidechainSourceBusId: 'key' }],
      });
    });

    it('rejects reciprocal bus sidechain keys in a scene', () => {
      expect(() =>
        applyMixerSceneJson(
          JSON.stringify({
            version: 1,
            strips: [],
            buses: [
              {
                id: 'a',
                role: 'aux',
                inserts: [{ processor: 'dynamics.compressor', sidechainKey: 'b' }],
              },
              {
                id: 'b',
                role: 'aux',
                inserts: [{ processor: 'dynamics.compressor', sidechainKey: 'a' }],
              },
            ],
            connections: [],
          }),
        ),
      ).toThrow(/routing cycle/);
    });

    it.each(['aux', 'master'] as const)('imports %s bus sidechain inserts', (role) => {
      applyMixerSceneJson(
        JSON.stringify({
          version: 1,
          strips: [{ id: 'key-source' }],
          buses: [
            {
              id: role === 'master' ? 'actual-master' : 'room',
              role,
              inserts: [
                {
                  processor: 'dynamics.compressor',
                  params: {},
                  sidechainKey: 'key-source',
                },
              ],
            },
          ],
          connections: [],
        }),
      );
      const strip = role === 'master' ? store.mixer.master : store.mixer.buses[0].strip;
      expect(strip?.inserts[0]).toMatchObject({
        sidechainSourceTrackId: trackId,
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
                { processor: 'made.up.reverb', params: { decaySec: 1.8 } },
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
                { processor: 'made.up.reverb', params: { decaySec: 2 } },
              ],
            },
          ],
        }),
      );

      expect(result).toEqual({ trackCount: 1, busCount: 1, vcaCount: 0 });
      expect(store.mixer.master.inserts).toMatchObject([
        { processor: 'dynamics.compressor', params: { thresholdDb: -18 }, enabled: true },
      ]);
      expect(store.tracks[0].mixer?.inserts).toMatchObject([
        { processor: 'stereo.imager', params: { width: 1.2 }, enabled: true },
      ]);
      expect(store.mixer.buses[0].strip?.inserts).toMatchObject([
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

describe('return solo routing', () => {
  it('silences every other bus while a return is soloed', () => {
    const buses = [
      { id: 'a', name: 'Reverb', gainDb: -3, solo: true },
      { id: 'b', name: 'Delay', gainDb: -6 },
      { id: 'c', name: 'Muted', gainDb: -6, mute: true },
    ];
    const routing = returnSoloRouting(buses);

    expect(routing.active).toBe(true);
    expect(routing.isSoloed('a')).toBe(true);
    expect(routing.busGainDb(buses[0])).toBe(-3);
    expect(routing.busGainDb(buses[1])).toBe(-120);
  });

  it('keeps mute behaviour untouched when nothing is soloed', () => {
    const buses = [
      { id: 'a', name: 'Reverb', gainDb: -3 },
      { id: 'b', name: 'Delay', gainDb: -6, mute: true },
    ];
    const routing = returnSoloRouting(buses);

    expect(routing.active).toBe(false);
    expect(routing.busGainDb(buses[0])).toBe(-3);
    expect(routing.busGainDb(buses[1])).toBe(-120);
  });

  it('needs one free engine bus slot to route the audition', () => {
    expect(canRouteReturnSolo(0, [])).toBe(true);
    expect(canRouteReturnSolo(MAX_MIXER_BUSES, [])).toBe(false);
    expect(canRouteReturnSolo(MAX_MIXER_BUSES - 1, [{ kind: 'group' }])).toBe(false);
  });
});
