import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMidiClip,
  addNote,
  addTrack,
  bakeClipMidiFx,
  canRedo,
  canUndo,
  clearHistory,
  clearProjectChords,
  deleteClip,
  detectChordsForClip,
  duplicateClip,
  humanizeSelectionVelocity,
  moveClip,
  nudgeSelectionVelocity,
  quantizeSelectionLengths,
  redo,
  removeAutomationLane,
  removeMarker,
  removeTrack,
  renameClip,
  renameTrack,
  reorderTracks,
  setActiveClip,
  setActiveTrack,
  setAutomationLaneEnabled,
  setAutomationLanePoints,
  setClipCcLane,
  setClipChannelPressure,
  setClipGain,
  setClipLoop,
  setClipPitchBend,
  setClipPolyPressure,
  setMarker,
  setProjectChords,
  setSections,
  setSelection,
  setTempoSegments,
  setTimeSignatures,
  setTrackColor,
  setTrackMute,
  setTrackPan,
  setTrackSolo,
  setTrackVolume,
  snapSelectionToScale,
  splitClip,
  splitNote,
  transposeSelection,
  trimClip,
  undo,
} from '@/project/commands';
import { sanitizeMidiFxConfig } from '@/project/midi-fx';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('project commands (tracks, clips, markers, sections, tempo)', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  describe('track commands', () => {
    it('addTrack appends a track with palette defaults and is undoable', () => {
      const trackId = addTrack({ name: 'Bass' });
      expect(store.tracks).toHaveLength(2);
      const track = store.tracks.find((t) => t.id === trackId);
      expect(track).toMatchObject({
        name: 'Bass',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: 1,
      });
      expect(track?.color.length).toBeGreaterThan(0);

      expect(undo()).toBe(true);
      expect(store.tracks).toHaveLength(1);
      expect(redo()).toBe(true);
      expect(store.tracks.find((t) => t.id === trackId)?.name).toBe('Bass');
    });

    it('addTrack honors an explicit color', () => {
      const trackId = addTrack({ name: 'Lead', color: '#123456' });
      expect(store.tracks.find((t) => t.id === trackId)?.color).toBe('#123456');
    });

    it('removeTrack drops the track and its clips; undo restores app metadata and note ids', () => {
      const trackId = store.tracks[0].id;
      const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      setTrackColor(trackId, '#abcdef');
      setTrackMute(trackId, true);

      removeTrack(trackId);
      expect(store.tracks).toHaveLength(0);
      expect(store.clips).toHaveLength(0);
      expect(store.clipId).toBe(-1);
      expect(store.activeTrackId).toBe(-1);
      expect(store.notes).toEqual([]);

      expect(undo()).toBe(true);
      const restored = store.tracks.find((t) => t.id === trackId);
      expect(restored).toMatchObject({ color: '#abcdef', mute: true });
      expect(store.notes.map((n) => n.id)).toEqual([noteId]);
    });

    it('removing the active track makes the first remaining track and clip active', () => {
      const firstTrackId = store.tracks[0].id;
      const firstClipId = store.clipId;
      const secondTrackId = addTrack({ name: 'Second' });
      const secondClipId = addMidiClip({ trackId: secondTrackId, lengthPpq: 8 });
      setActiveClip(secondClipId);
      removeTrack(secondTrackId);
      expect(store.activeTrackId).toBe(firstTrackId);
      expect(store.clipId).toBe(firstClipId);
    });

    it('renameTrack delegates to the Project and is undoable', () => {
      const trackId = store.tracks[0].id;
      renameTrack(trackId, 'Keys');
      expect(store.tracks[0].name).toBe('Keys');
      expect(undo()).toBe(true);
      expect(store.tracks[0].name).toBe('Piano');
      expect(() => renameTrack(trackId, '')).toThrow(RangeError);
    });

    it('rename to the same name is a no-op that pushes no history', () => {
      const trackId = store.tracks[0].id;
      const depth = canUndo();
      renameTrack(trackId, store.tracks[0].name);
      expect(canUndo()).toBe(depth);
    });

    it('setTrackColor / mute / solo / volume / pan are app-level and undoable', () => {
      const trackId = store.tracks[0].id;
      setTrackColor(trackId, '#ff0000');
      setTrackMute(trackId, true);
      setTrackSolo(trackId, true);
      setTrackVolume(trackId, 0.5);
      setTrackPan(trackId, -0.25);
      expect(store.tracks[0]).toMatchObject({
        color: '#ff0000',
        mute: true,
        solo: true,
        volume: 0.5,
        pan: -0.25,
      });

      undo(); // pan
      undo(); // volume
      undo(); // solo
      expect(store.tracks[0]).toMatchObject({ mute: true, solo: false, volume: 1, pan: 0 });
      undo(); // mute
      undo(); // color
      expect(store.tracks[0].mute).toBe(false);
      expect(store.tracks[0].color).not.toBe('#ff0000');
    });

    it('setTrackVolume and setTrackPan validate their ranges', () => {
      const trackId = store.tracks[0].id;
      expect(() => setTrackVolume(trackId, -0.1)).toThrow(RangeError);
      expect(() => setTrackVolume(trackId, Number.NaN)).toThrow(RangeError);
      expect(() => setTrackPan(trackId, 1.5)).toThrow(RangeError);
      expect(() => setTrackPan(trackId, -2)).toThrow(RangeError);
    });

    it('setting the same mute/solo value pushes no history entry', () => {
      const trackId = store.tracks[0].id;
      setTrackMute(trackId, false);
      setTrackSolo(trackId, false);
      expect(canUndo()).toBe(false);
    });

    it('reorderTracks permutes the mirror order and is undoable', () => {
      const a = store.tracks[0].id;
      const b = addTrack({ name: 'B' });
      const c = addTrack({ name: 'C' });
      reorderTracks([c, a, b]);
      expect(store.tracks.map((t) => t.id)).toEqual([c, a, b]);
      expect(store.tracks.map((t) => t.order)).toEqual([0, 1, 2]);
      expect(undo()).toBe(true);
      expect(store.tracks.map((t) => t.id)).toEqual([a, b, c]);
    });

    it('reorderTracks rejects non-permutations', () => {
      const a = store.tracks[0].id;
      const b = addTrack({ name: 'B' });
      expect(() => reorderTracks([a])).toThrow(RangeError);
      expect(() => reorderTracks([a, a])).toThrow(RangeError);
      expect(() => reorderTracks([a, 9999])).toThrow(RangeError);
      expect(() => reorderTracks([b, a, 9999])).toThrow(RangeError);
    });

    it('commands targeting an unknown track throw RangeError', () => {
      expect(() => removeTrack(9999)).toThrow(RangeError);
      expect(() => renameTrack(9999, 'X')).toThrow(RangeError);
      expect(() => setTrackMute(9999, true)).toThrow(RangeError);
    });
  });

  describe('clip commands', () => {
    it('addMidiClip places a named clip and one undo removes it entirely', () => {
      const trackId = store.tracks[0].id;
      const clipId = addMidiClip({ trackId, startPpq: 8, lengthPpq: 16, name: 'Verse' });
      const clip = store.clips.find((c) => c.id === clipId);
      expect(clip).toMatchObject({
        trackId,
        name: 'Verse',
        startPpq: 8,
        lengthPpq: 16,
        gain: 1,
        loopEnabled: false,
      });

      expect(undo()).toBe(true);
      expect(store.clips.some((c) => c.id === clipId)).toBe(false);
      expect(redo()).toBe(true);
      expect(store.clips.find((c) => c.id === clipId)?.name).toBe('Verse');
    });

    it('addMidiClip validates placement and the owning track', () => {
      const trackId = store.tracks[0].id;
      expect(() => addMidiClip({ trackId: 9999, lengthPpq: 8 })).toThrow(RangeError);
      expect(() => addMidiClip({ trackId, startPpq: -1, lengthPpq: 8 })).toThrow(RangeError);
      expect(() => addMidiClip({ trackId, lengthPpq: 0 })).toThrow(RangeError);
    });

    it('deleteClip removes the clip and falls back to the next clip of the track', () => {
      const trackId = store.tracks[0].id;
      const firstClipId = store.clipId;
      const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      const secondClipId = addMidiClip({ trackId, startPpq: 32, lengthPpq: 8 });

      deleteClip(firstClipId);
      expect(store.clips.map((c) => c.id)).toEqual([secondClipId]);
      expect(store.clipId).toBe(secondClipId);
      expect(store.notes).toEqual([]);

      expect(undo()).toBe(true);
      expect(store.clips.map((c) => c.id)).toEqual([firstClipId, secondClipId]);
      expect(store.clipId).toBe(firstClipId);
      expect(store.notes.map((n) => n.id)).toEqual([noteId]);
    });

    it('renameClip is app-level metadata and undoable', () => {
      const clipId = store.clipId;
      renameClip(clipId, 'Chorus');
      expect(store.activeClip?.name).toBe('Chorus');
      expect(undo()).toBe(true);
      expect(store.activeClip?.name).not.toBe('Chorus');
      expect(() => renameClip(clipId, '')).toThrow(RangeError);
    });

    it('moveClip changes the start position and optionally the track', () => {
      const clipId = store.clipId;
      const otherTrackId = addTrack({ name: 'Other' });
      moveClip(clipId, 4);
      expect(store.activeClip?.startPpq).toBe(4);
      moveClip(clipId, 8, otherTrackId);
      expect(store.activeClip).toMatchObject({ startPpq: 8, trackId: otherTrackId });
      expect(undo()).toBe(true);
      expect(store.activeClip).toMatchObject({ startPpq: 4 });
      expect(() => moveClip(clipId, -1)).toThrow(RangeError);
      expect(() => moveClip(clipId, 0, 9999)).toThrow(RangeError);
    });

    it('duplicateClip copies notes and the display name; undo removes the copy', () => {
      const clipId = store.clipId;
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      renameClip(clipId, 'Riff');
      setClipCcLane(clipId, 1, 0, [{ ppq: 0.5, value: 64 }]);
      store.clips = store.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              pitchBendLanes: [{ channel: 0, points: [{ ppq: 0.5, value: 8192 }] }],
              channelPressureLanes: [{ channel: 0, points: [{ ppq: 0.75, value: 32 }] }],
              polyPressureLanes: [{ channel: 0, pitch: 60, points: [{ ppq: 0.25, value: 40 }] }],
            }
          : clip,
      );
      const copyId = duplicateClip(clipId, 32);
      const copy = store.clips.find((c) => c.id === copyId);
      expect(copy).toMatchObject({ name: 'Riff', startPpq: 32 });
      expect(copy?.notes).toHaveLength(1);
      expect(copy?.notes[0]).toMatchObject({ pitch: 60 });
      expect(copy?.ccLanes).toEqual([
        { controller: 1, channel: 0, points: [{ ppq: 0.5, value: 64 }] },
      ]);
      expect(copy?.pitchBendLanes).toEqual([{ channel: 0, points: [{ ppq: 0.5, value: 8192 }] }]);
      expect(copy?.channelPressureLanes).toEqual([
        { channel: 0, points: [{ ppq: 0.75, value: 32 }] },
      ]);
      expect(copy?.polyPressureLanes).toEqual([
        { channel: 0, pitch: 60, points: [{ ppq: 0.25, value: 40 }] },
      ]);
      // The copy's notes get fresh editor ids.
      expect(copy?.notes[0].id).not.toBe(store.notes[0].id);

      expect(undo()).toBe(true);
      expect(store.clips.some((c) => c.id === copyId)).toBe(false);
    });

    it('splitClip partitions notes between the halves and is undoable', () => {
      const clipId = store.clipId;
      const leftNoteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      addNote({ pitch: 64, startPpq: 4, durationPpq: 1 });
      renameClip(clipId, 'Phrase');
      setClipCcLane(clipId, 1, 0, [
        { ppq: 1, value: 32 },
        { ppq: 4, value: 96 },
      ]);
      store.clips = store.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              pitchBendLanes: [
                {
                  channel: 0,
                  points: [
                    { ppq: 1, value: 4096 },
                    { ppq: 4, value: 8192 },
                  ],
                },
              ],
            }
          : clip,
      );

      const rightId = splitClip(clipId, 2);
      const left = store.clips.find((c) => c.id === clipId);
      const right = store.clips.find((c) => c.id === rightId);
      expect(left).toMatchObject({ startPpq: 0, lengthPpq: 2 });
      expect(right).toMatchObject({ name: 'Phrase', startPpq: 2, lengthPpq: 30 });
      expect(right?.sourceOffsetPpq).toBe(2);
      expect(left?.notes.map((n) => n.pitch)).toEqual([60]);
      expect(right?.notes.map((n) => n.pitch)).toEqual([64]);
      expect(left?.ccLanes).toEqual([
        { controller: 1, channel: 0, points: [{ ppq: 1, value: 32 }] },
      ]);
      expect(right?.ccLanes).toEqual([
        {
          controller: 1,
          channel: 0,
          points: [
            { ppq: 0, value: 32 },
            { ppq: 2, value: 96 },
          ],
        },
      ]);
      expect(left?.pitchBendLanes).toEqual([{ channel: 0, points: [{ ppq: 1, value: 4096 }] }]);
      expect(right?.pitchBendLanes).toEqual([
        {
          channel: 0,
          points: [
            { ppq: 0, value: 4096 },
            { ppq: 2, value: 8192 },
          ],
        },
      ]);

      expect(undo()).toBe(true);
      const whole = store.clips.find((c) => c.id === clipId);
      expect(whole?.lengthPpq).toBe(32);
      expect(whole?.notes.map((n) => n.pitch)).toEqual([60, 64]);
      expect(whole?.notes[0].id).toBe(leftNoteId);
    });

    it('splitClip rejects positions outside the clip body', () => {
      const clipId = store.clipId;
      expect(() => splitClip(clipId, 0)).toThrow(RangeError);
      expect(() => splitClip(clipId, 32)).toThrow(RangeError);
      expect(() => splitClip(clipId, 100)).toThrow(RangeError);
    });

    it('trimClip adjusts start, length and source offset and is undoable', () => {
      const clipId = store.clipId;
      setClipCcLane(clipId, 1, 0, [
        { ppq: 1, value: 32 },
        { ppq: 4, value: 96 },
        { ppq: 20, value: 127 },
      ]);
      trimClip(clipId, 2, 16);
      expect(store.activeClip).toMatchObject({
        startPpq: 2,
        lengthPpq: 16,
        sourceOffsetPpq: 2,
      });
      expect(store.activeClip?.ccLanes).toEqual([
        {
          controller: 1,
          channel: 0,
          points: [
            { ppq: 0, value: 32 },
            { ppq: 2, value: 96 },
          ],
        },
      ]);
      expect(undo()).toBe(true);
      expect(store.activeClip).toMatchObject({ startPpq: 0, lengthPpq: 32, sourceOffsetPpq: 0 });
      expect(() => trimClip(clipId, -1, 16)).toThrow(RangeError);
      expect(() => trimClip(clipId, 0, 0)).toThrow(RangeError);
    });

    it('setClipLoop defaults the loop length to the clip length and is undoable', () => {
      const clipId = store.clipId;
      setClipLoop(clipId, true);
      expect(store.activeClip).toMatchObject({ loopEnabled: true, loopLengthPpq: 32 });
      setClipLoop(clipId, true, 8);
      expect(store.activeClip).toMatchObject({ loopEnabled: true, loopLengthPpq: 8 });
      setClipLoop(clipId, false);
      expect(store.activeClip).toMatchObject({ loopEnabled: false, loopLengthPpq: 0 });
      undo();
      expect(store.activeClip?.loopEnabled).toBe(true);
      expect(() => setClipLoop(clipId, true, 0)).toThrow(RangeError);
    });

    it('setClipGain validates and writes through to the Project', () => {
      const clipId = store.clipId;
      setClipGain(clipId, 0.25);
      expect(store.activeClip?.gain).toBe(0.25);
      expect(undo()).toBe(true);
      expect(store.activeClip?.gain).toBe(1);
      expect(() => setClipGain(clipId, -1)).toThrow(RangeError);
      expect(() => setClipGain(clipId, Number.NaN)).toThrow(RangeError);
    });

    it('commands targeting an unknown clip throw RangeError', () => {
      expect(() => deleteClip(9999)).toThrow(RangeError);
      expect(() => moveClip(9999, 0)).toThrow(RangeError);
      expect(() => setClipGain(9999, 1)).toThrow(RangeError);
    });

    it('setClipCcLane sanitizes points, sorts lanes and is undoable', () => {
      const clipId = store.clipId;
      setClipCcLane(clipId, 11, 0, [
        { ppq: 2, value: 200 },
        { ppq: 0, value: -5 },
      ]);
      setClipCcLane(clipId, 1, 0, [{ ppq: 1, value: 64 }]);
      setClipCcLane(clipId, 1, 1, [{ ppq: 1.5, value: 96 }]);
      const lanes = store.activeClip?.ccLanes;
      // Lanes sort by controller/channel; points sort by ppq and clamp to [0, 127].
      expect(lanes).toEqual([
        { controller: 1, channel: 0, points: [{ ppq: 1, value: 64 }] },
        { controller: 1, channel: 1, points: [{ ppq: 1.5, value: 96 }] },
        {
          controller: 11,
          channel: 0,
          points: [
            { ppq: 0, value: 0 },
            { ppq: 2, value: 127 },
          ],
        },
      ]);
      // Empty points remove just that lane.
      setClipCcLane(clipId, 11, 0, []);
      expect(store.activeClip?.ccLanes).toEqual([
        { controller: 1, channel: 0, points: [{ ppq: 1, value: 64 }] },
        { controller: 1, channel: 1, points: [{ ppq: 1.5, value: 96 }] },
      ]);
      expect(undo()).toBe(true);
      expect(store.activeClip?.ccLanes?.map((l) => `${l.controller}:${l.channel}`)).toEqual([
        '1:0',
        '1:1',
        '11:0',
      ]);
    });

    it('setClipCcLane validates the controller, channel and clip', () => {
      const clipId = store.clipId;
      expect(() => setClipCcLane(clipId, 128, 0, [])).toThrow(RangeError);
      expect(() => setClipCcLane(clipId, 1, 16, [])).toThrow(RangeError);
      expect(() => setClipCcLane(9999, 1, 0, [])).toThrow(RangeError);
    });

    it('setClipPitchBend sanitizes 14-bit points, sorts lanes, removes and is undoable', () => {
      const clipId = store.clipId;
      setClipPitchBend(clipId, 1, [{ ppq: 1.5, value: 4096 }]);
      setClipPitchBend(clipId, 0, [
        { ppq: 2, value: 99999 },
        { ppq: 0, value: -5 },
      ]);
      // Lanes sort by channel; points sort by ppq and clamp to the 14-bit range.
      expect(store.activeClip?.pitchBendLanes).toEqual([
        {
          channel: 0,
          points: [
            { ppq: 0, value: 0 },
            { ppq: 2, value: 16383 },
          ],
        },
        { channel: 1, points: [{ ppq: 1.5, value: 4096 }] },
      ]);
      // Empty points remove just that channel's lane.
      setClipPitchBend(clipId, 0, []);
      expect(store.activeClip?.pitchBendLanes).toEqual([
        { channel: 1, points: [{ ppq: 1.5, value: 4096 }] },
      ]);
      expect(undo()).toBe(true);
      expect(store.activeClip?.pitchBendLanes?.map((l) => l.channel)).toEqual([0, 1]);
    });

    it('setClipPitchBend validates the channel and clip', () => {
      const clipId = store.clipId;
      expect(() => setClipPitchBend(clipId, 16, [])).toThrow(RangeError);
      expect(() => setClipPitchBend(9999, 0, [])).toThrow(RangeError);
    });

    it('setClipChannelPressure sanitizes 7-bit points, sorts lanes, removes and is undoable', () => {
      const clipId = store.clipId;
      setClipChannelPressure(clipId, 1, [{ ppq: 1.5, value: 50 }]);
      setClipChannelPressure(clipId, 0, [
        { ppq: 2, value: 999 },
        { ppq: 0, value: -5 },
      ]);
      // Lanes sort by channel; points sort by ppq and clamp to the 7-bit range.
      expect(store.activeClip?.channelPressureLanes).toEqual([
        {
          channel: 0,
          points: [
            { ppq: 0, value: 0 },
            { ppq: 2, value: 127 },
          ],
        },
        { channel: 1, points: [{ ppq: 1.5, value: 50 }] },
      ]);
      // Empty points remove just that channel's lane.
      setClipChannelPressure(clipId, 0, []);
      expect(store.activeClip?.channelPressureLanes).toEqual([
        { channel: 1, points: [{ ppq: 1.5, value: 50 }] },
      ]);
      expect(undo()).toBe(true);
      expect(store.activeClip?.channelPressureLanes?.map((l) => l.channel)).toEqual([0, 1]);
    });

    it('setClipChannelPressure validates the channel and clip', () => {
      const clipId = store.clipId;
      expect(() => setClipChannelPressure(clipId, 16, [])).toThrow(RangeError);
      expect(() => setClipChannelPressure(9999, 0, [])).toThrow(RangeError);
    });

    it('setClipPolyPressure keys lanes by channel/pitch, sorts, removes and is undoable', () => {
      const clipId = store.clipId;
      setClipPolyPressure(clipId, 0, 64, [{ ppq: 1, value: 999 }]);
      setClipPolyPressure(clipId, 0, 60, [
        { ppq: 2, value: 80 },
        { ppq: 0, value: -5 },
      ]);
      // Lanes sort by channel then pitch; points sort by ppq and clamp to 7-bit.
      expect(store.activeClip?.polyPressureLanes).toEqual([
        {
          channel: 0,
          pitch: 60,
          points: [
            { ppq: 0, value: 0 },
            { ppq: 2, value: 80 },
          ],
        },
        { channel: 0, pitch: 64, points: [{ ppq: 1, value: 127 }] },
      ]);
      // Empty points remove just that channel/pitch lane.
      setClipPolyPressure(clipId, 0, 60, []);
      expect(store.activeClip?.polyPressureLanes).toEqual([
        { channel: 0, pitch: 64, points: [{ ppq: 1, value: 127 }] },
      ]);
      expect(undo()).toBe(true);
      expect(store.activeClip?.polyPressureLanes?.map((l) => l.pitch)).toEqual([60, 64]);
    });

    it('setClipPolyPressure validates the channel, pitch and clip', () => {
      const clipId = store.clipId;
      expect(() => setClipPolyPressure(clipId, 16, 60, [])).toThrow(RangeError);
      expect(() => setClipPolyPressure(clipId, 0, 128, [])).toThrow(RangeError);
      expect(() => setClipPolyPressure(9999, 0, 60, [])).toThrow(RangeError);
    });

    it('bakeClipMidiFx transposes the clip notes as one undoable edit', () => {
      const clipId = store.clipId;
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
      const changed = bakeClipMidiFx(clipId, sanitizeMidiFxConfig({ transposeSemitones: 12 }));
      expect(changed).toBe(true);
      expect(store.notes.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([72, 76]);
      expect(undo()).toBe(true);
      expect(store.notes.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([60, 64]);
    });

    it('bakeClipMidiFx harmonizes each note into a chord', () => {
      const clipId = store.clipId;
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      const changed = bakeClipMidiFx(clipId, sanitizeMidiFxConfig({ chordIntervals: [0, 4, 7] }));
      expect(changed).toBe(true);
      expect(store.notes.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67]);
      expect(undo()).toBe(true);
      expect(store.notes.map((n) => n.pitch)).toEqual([60]);
    });

    it('bakeClipMidiFx skips a no-op transform without touching history', () => {
      const clipId = store.clipId;
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      clearHistory();
      const changed = bakeClipMidiFx(clipId, sanitizeMidiFxConfig({}));
      expect(changed).toBe(false);
      expect(store.notes.map((n) => n.pitch)).toEqual([60]);
      expect(canUndo()).toBe(false);
    });

    it('bakeClipMidiFx rejects an unknown clip', () => {
      expect(() => bakeClipMidiFx(9999, sanitizeMidiFxConfig({ transposeSemitones: 1 }))).toThrow(
        RangeError,
      );
    });
  });

  describe('chord track commands', () => {
    it('setProjectChords writes the annotation stream and is undoable', () => {
      setProjectChords([
        { startPpq: 4, endPpq: 8, rootPc: 7, quality: 4 },
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, bassPc: 4 },
      ]);
      // Sorted by position and read back from the Project annotation stream.
      expect(store.chords).toEqual([
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, bassPc: 4 },
        { startPpq: 4, endPpq: 8, rootPc: 7, quality: 4 },
      ]);
      expect(undo()).toBe(true);
      expect(store.chords).toEqual([]);
      expect(redo()).toBe(true);
      expect(store.chords).toHaveLength(2);
    });

    it('setProjectChords drops invalid roots and empty regions', () => {
      setProjectChords([
        { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
        { startPpq: 4, endPpq: 4, rootPc: 2, quality: 1 }, // zero-length
        { startPpq: 8, endPpq: 12, rootPc: 99, quality: 0 }, // bad root
      ]);
      expect(store.chords).toEqual([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
    });

    it('clearProjectChords empties the stream undoably and no-ops when empty', () => {
      setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
      clearProjectChords();
      expect(store.chords).toEqual([]);
      expect(undo()).toBe(true);
      expect(store.chords).toHaveLength(1);

      clearProjectChords();
      clearHistory();
      clearProjectChords();
      expect(canUndo()).toBe(false);
    });

    it('detectChordsForClip estimates chords from the clip notes and is idempotent', () => {
      const clipId = store.clipId;
      // A C major triad sounding through the first bar (4 PPQ in 4/4).
      addNote({ pitch: 60, startPpq: 0, durationPpq: 4 });
      addNote({ pitch: 64, startPpq: 0, durationPpq: 4 });
      addNote({ pitch: 67, startPpq: 0, durationPpq: 4 });

      const count = detectChordsForClip(clipId);
      expect(count).toBeGreaterThan(0);
      expect(store.chords[0]).toMatchObject({ startPpq: 0, rootPc: 0, quality: 0 });

      // Re-running replaces the clip-region chords rather than duplicating them.
      const before = store.chords.length;
      detectChordsForClip(clipId);
      expect(store.chords.length).toBe(before);
    });

    it('detectChordsForClip rejects a non-MIDI clip', () => {
      expect(() => detectChordsForClip(9999)).toThrow(RangeError);
    });
  });

  describe('splitNote', () => {
    it('splits a note into two halves as one undoable edit and returns the right id', () => {
      const leftId = addNote({ pitch: 60, startPpq: 0, durationPpq: 4, velocity: 80, channel: 2 });
      const rightId = splitNote(leftId, 1);

      const left = store.notes.find((n) => n.id === leftId);
      const right = store.notes.find((n) => n.id === rightId);
      expect(left).toMatchObject({ startPpq: 0, durationPpq: 1 });
      expect(right).toMatchObject({
        startPpq: 1,
        durationPpq: 3,
        pitch: 60,
        velocity: 80,
        channel: 2,
      });
      expect(store.notes).toHaveLength(2);

      // One history entry: undo restores the single original note.
      expect(undo()).toBe(true);
      expect(store.notes).toHaveLength(1);
      expect(store.notes[0]).toMatchObject({ id: leftId, startPpq: 0, durationPpq: 4 });
    });

    it('rejects a split position outside the note', () => {
      const id = addNote({ pitch: 60, startPpq: 1, durationPpq: 2 });
      expect(() => splitNote(id, 1)).toThrow(RangeError);
      expect(() => splitNote(id, 3)).toThrow(RangeError);
      expect(() => splitNote(9999, 1)).toThrow();
    });
  });

  describe('selection note operations', () => {
    /** Adds three notes and selects the first two; returns all three ids. */
    function threeNotesSelectFirstTwo(): number[] {
      const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 2, velocity: 80 });
      const b = addNote({ pitch: 64, startPpq: 4, durationPpq: 3, velocity: 80 });
      const c = addNote({ pitch: 67, startPpq: 8, durationPpq: 2, velocity: 80 });
      setSelection([a, b]);
      return [a, b, c];
    }

    function noteById(id: number) {
      return store.notes.find((n) => n.id === id);
    }

    it('transposes the selection and leaves unselected notes alone', () => {
      const [a, b, c] = threeNotesSelectFirstTwo();
      transposeSelection(12);
      expect(noteById(a)?.pitch).toBe(72);
      expect(noteById(b)?.pitch).toBe(76);
      expect(noteById(c)?.pitch).toBe(67);
      undo();
      expect(noteById(a)?.pitch).toBe(60);
    });

    it('clamps the whole block so intervals are preserved at the edges', () => {
      const high = addNote({ pitch: 126, startPpq: 0, durationPpq: 1 });
      const low = addNote({ pitch: 120, startPpq: 4, durationPpq: 1 });
      setSelection([high, low]);
      // +12 would push 126 past 127, so the block only rises by 1.
      transposeSelection(12);
      expect(noteById(high)?.pitch).toBe(127);
      expect(noteById(low)?.pitch).toBe(121);
    });

    it('quantizes note lengths to the snap grid', () => {
      const [a] = threeNotesSelectFirstTwo();
      store.snapDivision = 1; // grid = 4 PPQ
      quantizeSelectionLengths();
      // duration 2 -> nearest multiple of 4, min one grid step = 4.
      expect(noteById(a)?.durationPpq).toBe(4);
    });

    it('nudges and clamps selection velocity', () => {
      const [a, , c] = threeNotesSelectFirstTwo();
      nudgeSelectionVelocity(20);
      expect(noteById(a)?.velocity).toBe(100);
      expect(noteById(c)?.velocity).toBe(80);
      nudgeSelectionVelocity(40);
      expect(noteById(a)?.velocity).toBe(127);
    });

    it('humanizes velocity within the requested range using an injected RNG', () => {
      const [a, b] = threeNotesSelectFirstTwo();
      // RNG 1 -> +amount, RNG 0 -> -amount.
      const values = [1, 0];
      humanizeSelectionVelocity(10, () => values.shift() ?? 0.5);
      expect(noteById(a)?.velocity).toBe(90);
      expect(noteById(b)?.velocity).toBe(70);
    });

    it('is a no-op with an empty selection', () => {
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 80 });
      setSelection([]);
      transposeSelection(12);
      nudgeSelectionVelocity(10);
      quantizeSelectionLengths();
      snapSelectionToScale();
      expect(store.notes[0].pitch).toBe(60);
      expect(store.notes[0].velocity).toBe(80);
    });

    it('snaps the selection to the active scale and leaves the rest alone', () => {
      // C minor pentatonic (C, Eb, F, G, Bb): unambiguous nearest snaps.
      store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: 0b10010101001 };
      const inScale = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 }); // C, already in scale
      const sharp = addNote({ pitch: 61, startPpq: 4, durationPpq: 1 }); // C# -> C (60)
      const d = addNote({ pitch: 62, startPpq: 8, durationPpq: 1 }); // D -> Eb (63)
      const unselected = addNote({ pitch: 61, startPpq: 12, durationPpq: 1 }); // C#, not selected
      setSelection([inScale, sharp, d]);

      snapSelectionToScale();
      expect(noteById(inScale)?.pitch).toBe(60);
      expect(noteById(sharp)?.pitch).toBe(60);
      expect(noteById(d)?.pitch).toBe(63);
      expect(noteById(unselected)?.pitch).toBe(61);

      undo();
      expect(noteById(sharp)?.pitch).toBe(61);
      expect(noteById(d)?.pitch).toBe(62);
    });

    it('does not push an undo entry when every selected note is already in scale', () => {
      store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: 0b10010101001 };
      const c = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 }); // C
      const g = addNote({ pitch: 67, startPpq: 4, durationPpq: 1 }); // G
      setSelection([c, g]);
      snapSelectionToScale();
      // The snap was a no-op, so the only undoable step is adding g (not a snap):
      // undoing once removes g and leaves c untouched.
      undo();
      expect(noteById(g)).toBeUndefined();
      expect(noteById(c)?.pitch).toBe(60);
    });

    it('is a no-op when the scale mask is empty', () => {
      store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: 0 };
      const note = addNote({ pitch: 61, startPpq: 0, durationPpq: 1 });
      setSelection([note]);
      snapSelectionToScale();
      expect(noteById(note)?.pitch).toBe(61);
    });
  });

  describe('active track / clip selection', () => {
    it('setActiveClip retargets the note mirror without touching the history', () => {
      const trackId = store.tracks[0].id;
      const firstClipId = store.clipId;
      const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      const secondClipId = addMidiClip({ trackId, startPpq: 32, lengthPpq: 8 });
      clearHistory();

      setActiveClip(secondClipId);
      expect(canUndo()).toBe(false);
      expect(store.clipId).toBe(secondClipId);
      expect(store.notes).toEqual([]);
      expect(store.selection.size).toBe(0);

      // Non-active clip content stays mirrored on the clip entry.
      expect(store.clips.find((c) => c.id === firstClipId)?.notes.map((n) => n.id)).toEqual([
        noteId,
      ]);

      // Edits now land in the newly active clip.
      addNote({ pitch: 72, startPpq: 0, durationPpq: 1 });
      expect(store.clips.find((c) => c.id === secondClipId)?.notes).toHaveLength(1);
      expect(store.clips.find((c) => c.id === firstClipId)?.notes).toHaveLength(1);
    });

    it('setActiveTrack activates the first clip of the track (or none)', () => {
      const firstTrackId = store.tracks[0].id;
      const firstClipId = store.clipId;
      const emptyTrackId = addTrack({ name: 'Empty' });

      setActiveTrack(emptyTrackId);
      expect(store.activeTrackId).toBe(emptyTrackId);
      expect(store.clipId).toBe(-1);
      expect(store.notes).toEqual([]);

      setActiveTrack(firstTrackId);
      expect(store.clipId).toBe(firstClipId);
      expect(() => setActiveTrack(9999)).toThrow(RangeError);
    });
  });

  describe('marker and section commands', () => {
    it('setMarker creates, updates and sorts markers; removeMarker deletes; both undoable', () => {
      const a = setMarker(null, 8, 'Chorus');
      const b = setMarker(0, 0, 'Intro');
      expect(store.markers.map((m) => m.name)).toEqual(['Intro', 'Chorus']);

      setMarker(a, 16, 'Chorus 2');
      expect(store.markers.find((m) => m.id === a)).toMatchObject({ ppq: 16, name: 'Chorus 2' });

      removeMarker(b);
      expect(store.markers.map((m) => m.id)).toEqual([a]);

      undo(); // removeMarker
      expect(store.markers).toHaveLength(2);
      undo(); // marker update
      expect(store.markers.find((m) => m.id === a)).toMatchObject({ ppq: 8, name: 'Chorus' });

      expect(() => setMarker(9999, 0, 'X')).toThrow(RangeError);
      expect(() => setMarker(null, -1, 'X')).toThrow(RangeError);
    });

    it('removeMarker is a silent no-op for unknown ids', () => {
      removeMarker(9999);
      expect(canUndo()).toBe(false);
    });

    it('setSections replaces the sorted list, keeps explicit ids, and is undoable', () => {
      setSections([
        { name: 'Chorus', startPpq: 16, endPpq: 32 },
        { name: 'Verse', startPpq: 0, endPpq: 16, color: '#112233' },
      ]);
      expect(store.sections.map((s) => s.name)).toEqual(['Verse', 'Chorus']);
      expect(store.sections[0].color).toBe('#112233');
      const keepId = store.sections[1].id;

      setSections([{ id: keepId, name: 'Drop', startPpq: 8, endPpq: 24 }]);
      expect(store.sections).toHaveLength(1);
      expect(store.sections[0]).toMatchObject({ id: keepId, name: 'Drop' });

      undo();
      expect(store.sections.map((s) => s.name)).toEqual(['Verse', 'Chorus']);
      undo();
      expect(store.sections).toEqual([]);

      expect(() => setSections([{ name: 'Bad', startPpq: 4, endPpq: 4 }])).toThrow(RangeError);
      expect(() => setSections([{ name: 'Bad', startPpq: -1, endPpq: 4 }])).toThrow(RangeError);
    });
  });

  describe('automation commands', () => {
    it('setAutomationLanePoints creates a lane with sanitized, sorted points', () => {
      const trackId = store.tracks[0].id;
      setAutomationLanePoints(trackId, 'faderDb', [
        { ppq: 8, value: 999 },
        { ppq: -1, value: 0 },
        { ppq: 0, value: -6, curve: 'hold' },
      ]);
      expect(store.automationLanes).toEqual([
        {
          target: trackId,
          param: 'faderDb',
          points: [
            { ppq: 0, value: -6, curve: 'hold' },
            { ppq: 8, value: 24 },
          ],
          enabled: true,
        },
      ]);
    });

    it('keeps one lane per (target, param) and preserves enabled on replace', () => {
      const trackId = store.tracks[0].id;
      setAutomationLanePoints(trackId, 'pan', [{ ppq: 0, value: -0.5 }]);
      setAutomationLanePoints('master', 'pan', [{ ppq: 0, value: 0.5 }]);
      setAutomationLaneEnabled(trackId, 'pan', false);

      setAutomationLanePoints(trackId, 'pan', [{ ppq: 4, value: 1 }]);
      expect(store.automationLanes).toHaveLength(2);
      expect(store.automationLanes.find((l) => l.target === trackId)).toEqual({
        target: trackId,
        param: 'pan',
        points: [{ ppq: 4, value: 1 }],
        enabled: false,
      });
    });

    it('an empty sanitized point list removes the lane entirely', () => {
      const trackId = store.tracks[0].id;
      setAutomationLanePoints(trackId, 'pan', [{ ppq: 0, value: 0 }]);
      setAutomationLanePoints(trackId, 'pan', [{ ppq: -1, value: Number.NaN }]);
      expect(store.automationLanes).toEqual([]);
      // No lane and no points is a no-op that pushes no history.
      clearHistory();
      setAutomationLanePoints(trackId, 'pan', []);
      expect(canUndo()).toBe(false);
    });

    it('setAutomationLanePoints validates numeric targets against the tracks', () => {
      expect(() => setAutomationLanePoints(9999, 'pan', [{ ppq: 0, value: 0 }])).toThrow(
        RangeError,
      );
      setAutomationLanePoints('master', 'faderDb', [{ ppq: 0, value: 0 }]);
      expect(store.automationLanes[0].target).toBe('master');
    });

    it('setAutomationLaneEnabled toggles and is a no-op for missing lanes', () => {
      const trackId = store.tracks[0].id;
      setAutomationLaneEnabled(trackId, 'pan', false);
      expect(canUndo()).toBe(false);

      setAutomationLanePoints(trackId, 'pan', [{ ppq: 0, value: 0 }]);
      setAutomationLaneEnabled(trackId, 'pan', true); // unchanged: no history
      setAutomationLaneEnabled(trackId, 'pan', false);
      expect(store.automationLanes[0].enabled).toBe(false);

      expect(undo()).toBe(true); // the enabled toggle
      expect(store.automationLanes[0].enabled).toBe(true);
      expect(undo()).toBe(true); // the lane creation
      expect(store.automationLanes).toEqual([]);
    });

    it('removeAutomationLane removes the lane; unknown lanes are a silent no-op', () => {
      const trackId = store.tracks[0].id;
      setAutomationLanePoints(trackId, 'faderDb', [{ ppq: 0, value: 0 }]);
      removeAutomationLane(trackId, 'faderDb');
      expect(store.automationLanes).toEqual([]);

      clearHistory();
      removeAutomationLane(trackId, 'faderDb');
      expect(canUndo()).toBe(false);
    });

    it('undo/redo restores the lane list', () => {
      const trackId = store.tracks[0].id;
      setAutomationLanePoints(trackId, 'pan', [{ ppq: 0, value: -1 }]);
      setAutomationLanePoints(trackId, 'pan', [
        { ppq: 0, value: -1 },
        { ppq: 8, value: 1 },
      ]);

      undo();
      expect(store.automationLanes[0].points).toEqual([{ ppq: 0, value: -1 }]);
      undo();
      expect(store.automationLanes).toEqual([]);
      redo();
      redo();
      expect(store.automationLanes[0].points).toEqual([
        { ppq: 0, value: -1 },
        { ppq: 8, value: 1 },
      ]);
    });

    it('removeTrack drops the track lanes in the same undo step', () => {
      const trackId = store.tracks[0].id;
      setAutomationLanePoints(trackId, 'faderDb', [{ ppq: 0, value: -12 }]);
      setAutomationLanePoints(trackId, 'pan', [{ ppq: 0, value: 0.5 }]);
      setAutomationLanePoints('master', 'faderDb', [{ ppq: 0, value: 0 }]);

      removeTrack(trackId);
      expect(store.automationLanes.map((l) => l.target)).toEqual(['master']);

      expect(undo()).toBe(true);
      expect(store.automationLanes).toHaveLength(3);
      expect(store.automationLanes.filter((l) => l.target === trackId)).toHaveLength(2);
    });
  });

  describe('tempo and meter commands', () => {
    it('setTempoSegments replaces the tempo map and mirrors the first BPM', () => {
      setTempoSegments([
        { startPpq: 0, bpm: 90 },
        { startPpq: 16, bpm: 140, endBpm: 160 },
      ]);
      expect(store.tempoBpm).toBe(90);
      expect(store.tempoSegments).toEqual([
        { startPpq: 0, bpm: 90 },
        { startPpq: 16, bpm: 140, endBpm: 160 },
      ]);
      expect(undo()).toBe(true);
      expect(store.tempoBpm).toBe(120);
    });

    it('setTempoSegments validates its input', () => {
      expect(() => setTempoSegments([])).toThrow(RangeError);
      expect(() => setTempoSegments([{ startPpq: 0, bpm: 0 }])).toThrow(RangeError);
      expect(() =>
        setTempoSegments([
          { startPpq: 8, bpm: 100 },
          { startPpq: 8, bpm: 120 },
        ]),
      ).toThrow(RangeError);
    });

    it('setTimeSignatures replaces the meter map and is undoable', () => {
      setTimeSignatures([
        { startPpq: 0, numerator: 3, denominator: 4 },
        { startPpq: 12, numerator: 7, denominator: 8 },
      ]);
      expect(store.timeSignatures).toEqual([
        { startPpq: 0, numerator: 3, denominator: 4 },
        { startPpq: 12, numerator: 7, denominator: 8 },
      ]);
      expect(undo()).toBe(true);
      expect(store.timeSignatures).toEqual([]);
    });

    it('setTimeSignatures validates its input', () => {
      expect(() => setTimeSignatures([])).toThrow(RangeError);
      expect(() => setTimeSignatures([{ startPpq: 0, numerator: 0, denominator: 4 }])).toThrow(
        RangeError,
      );
      expect(() => setTimeSignatures([{ startPpq: 0, numerator: 4, denominator: 0 }])).toThrow(
        RangeError,
      );
      expect(() =>
        setTimeSignatures([
          { startPpq: 4, numerator: 4, denominator: 4 },
          { startPpq: 4, numerator: 3, denominator: 4 },
        ]),
      ).toThrow(RangeError);
    });
  });

  describe('mixed undo across project-backed and app-only commands', () => {
    it('replays each command kind in reverse order', () => {
      const trackId = store.tracks[0].id;
      const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 }); // project edit
      setTrackColor(trackId, '#aa0000'); // app-only edit
      renameTrack(trackId, 'Grand'); // project edit
      setMarker(null, 4, 'Hit'); // app-only edit

      undo();
      expect(store.markers).toEqual([]);
      expect(store.tracks[0].name).toBe('Grand');
      undo();
      expect(store.tracks[0].name).toBe('Piano');
      expect(store.tracks[0].color).toBe('#aa0000');
      undo();
      expect(store.tracks[0].color).not.toBe('#aa0000');
      expect(store.notes.map((n) => n.id)).toEqual([noteId]);
      undo();
      expect(store.notes).toEqual([]);
      expect(canUndo()).toBe(false);

      redo();
      redo();
      redo();
      redo();
      expect(canRedo()).toBe(false);
      expect(store.notes.map((n) => n.id)).toEqual([noteId]);
      expect(store.tracks[0]).toMatchObject({ name: 'Grand', color: '#aa0000' });
      expect(store.markers.map((m) => m.name)).toEqual(['Hit']);
    });
  });
});
