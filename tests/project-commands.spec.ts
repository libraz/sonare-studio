import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { busAutomationTarget } from '@/project/automation';
import { executeApp } from '@/project/command/history';
import {
  addAudioClip,
  addMidiClip,
  addMixerBus,
  addNote,
  addNotes,
  addTrack,
  applyNoteEdits,
  bakeClipMidiFx,
  canRedo,
  canUndo,
  cleanupOverlaps,
  clearHistory,
  clearProjectChords,
  clearTrackMidiFx,
  collectHistoryReferencedMediaIds,
  configureHistoryByteBudget,
  deleteClip,
  detectChordsForClip,
  duplicateClip,
  duplicateSelection,
  fadeSelectionVelocity,
  glueMidiClips,
  historyBudgetStats,
  humanizeSelectionVelocity,
  legatoSelection,
  mergeSelection,
  moveClip,
  normalizeSelectionVelocity,
  nudgeSelectionVelocity,
  quantizeSelectionEnds,
  quantizeSelectionLengths,
  redo,
  removeAutomationLane,
  removeMarker,
  removeMixerBus,
  removeTrack,
  renameClip,
  renameTrack,
  reorderTracks,
  repeatSelection,
  scaleSelectionVelocityDynamics,
  selectOutOfScale,
  selectOverlaps,
  selectSameChannel,
  selectSamePitch,
  selectVelocityRange,
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
  setClipPolyPressureForPitches,
  setMarker,
  setProjectChords,
  setProjectExternalMidiDefault,
  setProjectExternalMidiDefaultForTracks,
  setSections,
  setSelection,
  setTempoSegments,
  setTimeSignatures,
  setTrackColor,
  setTrackFrozen,
  setTrackInstrument,
  setTrackMidiFx,
  setTrackMute,
  setTrackPan,
  setTrackSolo,
  setTrackVolume,
  snapSelectionToScale,
  splitClip,
  splitNote,
  transposeSelection,
  transposeSelectionDiatonic,
  trimClip,
  undo,
} from '@/project/commands';
import { sanitizeMidiFxConfig } from '@/project/midi-fx';
import { getProject, useProjectStore } from '@/project/store';

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

    it('setTrackMidiFx stores a non-destructive transform and is undoable', () => {
      const trackId = store.tracks[0].id;
      expect(setTrackMidiFx(trackId, sanitizeMidiFxConfig({ transposeSemitones: 12 }))).toBe(true);
      expect(store.tracks[0].midiFx?.transposeSemitones).toBe(12);
      expect(undo()).toBe(true);
      expect(store.tracks[0].midiFx).toBeUndefined();
    });

    it('setTrackMidiFx with a no-op transform clears instead of storing identity', () => {
      const trackId = store.tracks[0].id;
      setTrackMidiFx(trackId, sanitizeMidiFxConfig({ transposeSemitones: 7 }));
      // Re-applying an identity transform removes the stored entry.
      expect(setTrackMidiFx(trackId, sanitizeMidiFxConfig({}))).toBe(true);
      expect(store.tracks[0].midiFx).toBeUndefined();
    });

    it('re-applying the same MIDI-FX transform pushes no history entry', () => {
      const trackId = store.tracks[0].id;
      setTrackMidiFx(trackId, sanitizeMidiFxConfig({ transposeSemitones: 5 }));
      clearHistory();
      expect(setTrackMidiFx(trackId, sanitizeMidiFxConfig({ transposeSemitones: 5 }))).toBe(false);
      expect(canUndo()).toBe(false);
    });

    it('clearTrackMidiFx removes the transform and is undoable, no-op when absent', () => {
      const trackId = store.tracks[0].id;
      expect(clearTrackMidiFx(trackId)).toBe(false);
      setTrackMidiFx(trackId, sanitizeMidiFxConfig({ velocityScale: 1.5 }));
      expect(clearTrackMidiFx(trackId)).toBe(true);
      expect(store.tracks[0].midiFx).toBeUndefined();
      expect(undo()).toBe(true);
      expect(store.tracks[0].midiFx?.velocityScale).toBe(1.5);
    });

    it('setTrackMidiFx throws for an unknown track', () => {
      expect(() => setTrackMidiFx(9999, sanitizeMidiFxConfig({ transposeSemitones: 1 }))).toThrow(
        RangeError,
      );
    });

    it('restores the shared External MIDI route on undo and redo', () => {
      const trackId = store.tracks[0].id;
      const routeA = {
        kind: 'external-midi' as const,
        outputPortId: 'port-a',
        channel: 0,
        name: 'Port A',
      };
      const routeB = {
        kind: 'external-midi' as const,
        outputPortId: 'port-b',
        channel: 3,
        name: 'Port B',
      };

      setProjectExternalMidiDefaultForTracks(routeA, [trackId]);
      expect(store.projectExternalMidi).toEqual(routeA);
      expect(store.tracks[0].externalMidiMode).toBe('project');

      setProjectExternalMidiDefault(routeB);
      expect(store.projectExternalMidi).toEqual(routeB);
      expect(undo()).toBe(true);
      expect(store.projectExternalMidi).toEqual(routeA);
      expect(store.tracks[0].externalMidiMode).toBe('project');
      expect(redo()).toBe(true);
      expect(store.projectExternalMidi).toEqual(routeB);
      expect(store.tracks[0].externalMidiMode).toBe('project');
    });

    it('keeps frozen asset ids reachable while unfreeze is undoable', () => {
      const trackId = store.tracks[0].id;
      setTrackFrozen(trackId, { assetId: 'frozen-audio' });
      setTrackFrozen(trackId, null);

      const refs = collectHistoryReferencedMediaIds();
      expect([...refs.assetIds]).toContain('frozen-audio');
      expect(undo()).toBe(true);
      expect(store.tracks[0].frozen?.assetId).toBe('frozen-audio');
    });

    it('keeps redo-only frozen assets and SF2 fonts reachable after undo', () => {
      const trackId = store.tracks[0].id;
      setTrackFrozen(trackId, { assetId: 'frozen-redo' });
      setTrackInstrument(trackId, { kind: 'sf2', fontId: 'font-redo', bank: 1, program: 42 });

      expect(undo()).toBe(true); // instrument assignment now lives only in redo history
      expect(undo()).toBe(true); // frozen render now lives only in redo history
      expect(store.tracks[0].frozen).toBeUndefined();
      expect(store.tracks[0].instrument).toBeUndefined();

      const refs = collectHistoryReferencedMediaIds();
      expect([...refs.assetIds]).toContain('frozen-redo');
      expect([...refs.fontIds]).toContain('font-redo');

      expect(redo()).toBe(true);
      expect(store.tracks[0].frozen?.assetId).toBe('frozen-redo');
      expect(redo()).toBe(true);
      expect(store.tracks[0].instrument).toMatchObject({ kind: 'sf2', fontId: 'font-redo' });
    });

    it('keeps redo-only audio clip and take assets reachable after undo', async () => {
      const trackId = store.tracks[0].id;
      const clipId = await addAudioClip({
        trackId,
        assetId: 'active-redo',
        lengthPpq: 4,
        takes: [
          { assetId: 'active-redo', name: 'Main' },
          { assetId: 'inactive-take-redo', name: 'Alt' },
        ],
        activeTakeIndex: 0,
      });

      expect(undo()).toBe(true);
      expect(store.clips.some((clip) => clip.id === clipId)).toBe(false);

      const refs = collectHistoryReferencedMediaIds();
      expect([...refs.assetIds]).toEqual(
        expect.arrayContaining(['active-redo', 'inactive-take-redo']),
      );

      expect(redo()).toBe(true);
      const restored = store.clips.find((clip) => clip.id === clipId);
      expect(restored?.assetId).toBe('active-redo');
      expect(restored?.takes?.map((take) => take.assetId)).toEqual([
        'active-redo',
        'inactive-take-redo',
      ]);
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

    it('undoing an unrelated command keeps the current active clip', () => {
      const trackId = store.tracks[0].id;
      const firstClipId = store.clipId;
      const secondClipId = addMidiClip({ trackId, startPpq: 32, lengthPpq: 8 });
      setActiveClip(firstClipId);

      // A command that does not touch the active clip, then the user navigates
      // the piano roll to another clip (editor-only, not recorded in history).
      setTrackVolume(trackId, 0.5);
      setActiveClip(secondClipId);
      expect(store.clipId).toBe(secondClipId);

      // Undo/redo of the volume change must leave the current view in place,
      // not yank it back to whichever clip was active when the command ran.
      expect(undo()).toBe(true);
      expect(store.tracks[0].volume).toBe(1);
      expect(store.clipId).toBe(secondClipId);
      expect(redo()).toBe(true);
      expect(store.tracks[0].volume).toBe(0.5);
      expect(store.clipId).toBe(secondClipId);
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

    it('moveClip rejects MIDI clips on non-MIDI tracks without mutating history', () => {
      const clipId = store.clipId;
      const audioTrackId = addTrack({ name: 'Audio', kind: 'audio' });
      const auxTrackId = addTrack({ name: 'Return', kind: 'aux' });
      const groupTrackId = addTrack({ name: 'Group', kind: 'group' });
      clearHistory();

      expect(() => moveClip(clipId, 4, audioTrackId)).toThrow(/Cannot move midi clip/);
      expect(() => moveClip(clipId, 4, auxTrackId)).toThrow(/Cannot move midi clip/);
      expect(() => moveClip(clipId, 4, groupTrackId)).toThrow(/Cannot move midi clip/);
      expect(store.clips.find((clip) => clip.id === clipId)).toMatchObject({
        trackId: store.tracks[0].id,
        startPpq: 0,
      });
      expect(canUndo()).toBe(false);
    });

    it('moveClip rejects a frozen destination without mutating the source clip', () => {
      const clipId = store.clipId;
      const destinationId = addTrack({ name: 'Frozen destination' });
      setTrackFrozen(destinationId, { assetId: 'frozen-destination' });
      clearHistory();
      const nativeBefore = getProject().toJson();

      expect(() => moveClip(clipId, 4, destinationId)).toThrow(/unfreeze/i);
      expect(getProject().toJson()).toBe(nativeBefore);
      expect(store.clips.find((clip) => clip.id === clipId)).toMatchObject({
        trackId: store.tracks[0].id,
        startPpq: 0,
      });
      expect(canUndo()).toBe(false);
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
      expect(store.clipId).toBe(copyId);
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
      expect(store.clipId).toBe(clipId);
    });

    it('keeps frozen track content read-only until it is unfrozen', () => {
      const trackId = store.tracks[0].id;
      const clipId = store.clipId;
      addNote({ pitch: 59, startPpq: 0, durationPpq: 1 });
      setTrackMidiFx(trackId, sanitizeMidiFxConfig({ transposeSemitones: 5 }));
      setTrackFrozen(trackId, { assetId: 'frozen-render' });
      clearHistory();
      const nativeBefore = getProject().toJson();
      const mirrorBefore = JSON.stringify({ tracks: store.tracks, clips: store.clips });

      expect(() => addNote({ pitch: 60, startPpq: 0, durationPpq: 1 })).toThrow(/unfreeze/i);
      expect(() => moveClip(clipId, 4)).toThrow(/unfreeze/i);
      expect(() => duplicateClip(clipId, 8)).toThrow(/unfreeze/i);
      expect(() => deleteClip(clipId)).toThrow(/unfreeze/i);
      expect(() => addMidiClip({ trackId, startPpq: 8, lengthPpq: 4 })).toThrow(/unfreeze/i);
      expect(() => renameTrack(trackId, 'Frozen rename')).toThrow(/unfreeze/i);
      expect(() =>
        setTrackMidiFx(trackId, sanitizeMidiFxConfig({ transposeSemitones: 7 })),
      ).toThrow(/unfreeze/i);
      expect(() => clearTrackMidiFx(trackId)).toThrow(/unfreeze/i);
      expect(() =>
        bakeClipMidiFx(clipId, sanitizeMidiFxConfig({ transposeSemitones: 12 })),
      ).toThrow(/unfreeze/i);
      expect(getProject().toJson()).toBe(nativeBefore);
      expect(JSON.stringify({ tracks: store.tracks, clips: store.clips })).toBe(mirrorBefore);
      expect(canUndo()).toBe(false);

      setTrackFrozen(trackId, null);
      expect(() => moveClip(clipId, 4)).not.toThrow();
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

    it('rejects partial-repeat loop clips before native mutation and allows split after unlooping', () => {
      const clipId = store.clipId;
      setClipLoop(clipId, true, 3);
      clearHistory();
      const nativeBefore = getProject().toJson();
      const mirrorBefore = JSON.stringify(store.clips);

      expect(() => splitClip(clipId, 7)).toThrow(/Turn Loop off/);
      expect(() => getProject().splitClip(clipId, 7)).toThrow(/Turn Loop off/);
      expect(getProject().toJson()).toBe(nativeBefore);
      expect(JSON.stringify(store.clips)).toBe(mirrorBefore);
      expect(canUndo()).toBe(false);

      setClipLoop(clipId, false);
      expect(splitClip(clipId, 7)).toBeGreaterThan(clipId);
    });

    it('glueMidiClips consolidates MIDI clips, notes and expression lanes', () => {
      const trackId = store.tracks[0].id;
      const firstId = store.clipId;
      trimClip(firstId, 0, 2);
      renameClip(firstId, 'Joined');
      addNote({ pitch: 60, startPpq: 0.25, durationPpq: 0.5 });
      setClipCcLane(firstId, 1, 0, [{ ppq: 0.5, value: 32 }]);

      const secondId = addMidiClip({ trackId, startPpq: 2, lengthPpq: 2, name: 'Second' });
      setActiveClip(secondId);
      addNote({ pitch: 64, startPpq: 0.5, durationPpq: 0.75 });
      setClipCcLane(secondId, 1, 0, [{ ppq: 1, value: 96 }]);
      setClipPitchBend(secondId, 0, [{ ppq: 0.25, value: 9000 }]);

      const joinedId = glueMidiClips([secondId, firstId]);
      const joined = store.clips.find((clip) => clip.id === joinedId);
      expect(joined).toMatchObject({ trackId, name: 'Joined', startPpq: 0, lengthPpq: 4 });
      expect(joined?.notes.map((note) => ({ pitch: note.pitch, startPpq: note.startPpq }))).toEqual(
        [
          { pitch: 60, startPpq: 0.25 },
          { pitch: 64, startPpq: 2.5 },
        ],
      );
      expect(joined?.ccLanes).toEqual([
        {
          controller: 1,
          channel: 0,
          points: [
            { ppq: 0.5, value: 32 },
            { ppq: 3, value: 96 },
          ],
        },
      ]);
      expect(joined?.pitchBendLanes).toEqual([
        { channel: 0, points: [{ ppq: 2.25, value: 9000 }] },
      ]);
      expect(store.clips.some((clip) => clip.id === firstId || clip.id === secondId)).toBe(false);

      expect(undo()).toBe(true);
      expect(store.clips.some((clip) => clip.id === firstId)).toBe(true);
      expect(store.clips.some((clip) => clip.id === secondId)).toBe(true);
      expect(store.clips.some((clip) => clip.id === joinedId)).toBe(false);
    });

    it('glueMidiClips projects trimmed source notes into the audible clip window', () => {
      const trackId = store.tracks[0].id;
      const firstId = store.clipId;
      addNote({ pitch: 48, startPpq: 0.5, durationPpq: 0.25 });
      addNote({ pitch: 60, startPpq: 2.5, durationPpq: 0.5 });
      trimClip(firstId, 2, 2);

      const secondId = addMidiClip({ trackId, startPpq: 4, lengthPpq: 2 });
      setActiveClip(secondId);
      addNote({ pitch: 64, startPpq: 0.5, durationPpq: 0.5 });

      const joinedId = glueMidiClips([firstId, secondId]);
      expect(
        store.clips
          .find((clip) => clip.id === joinedId)
          ?.notes.map((note) => ({ pitch: note.pitch, startPpq: note.startPpq })),
      ).toEqual([
        { pitch: 60, startPpq: 0.5 },
        { pitch: 64, startPpq: 2.5 },
      ]);
    });

    it('glueMidiClips flattens looping MIDI clips into explicit repeats', () => {
      const trackId = store.tracks[0].id;
      const loopId = store.clipId;
      trimClip(loopId, 0, 5);
      renameClip(loopId, 'Flattened');
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      addNote({ pitch: 62, startPpq: 1.5, durationPpq: 1 });
      setClipCcLane(loopId, 11, 0, [{ ppq: 0.5, value: 64 }]);
      setClipLoop(loopId, true, 2);

      const tailId = addMidiClip({ trackId, startPpq: 5, lengthPpq: 1, name: 'Tail' });
      setActiveClip(tailId);
      addNote({ pitch: 67, startPpq: 0.25, durationPpq: 0.5 });

      const joinedId = glueMidiClips([loopId, tailId]);
      const joined = store.clips.find((clip) => clip.id === joinedId);
      expect(joined).toMatchObject({
        trackId,
        name: 'Flattened',
        startPpq: 0,
        lengthPpq: 6,
        loopEnabled: false,
        loopLengthPpq: 0,
      });
      expect(
        joined?.notes.map((note) => ({
          pitch: note.pitch,
          startPpq: note.startPpq,
          durationPpq: note.durationPpq,
        })),
      ).toEqual([
        { pitch: 60, startPpq: 0, durationPpq: 1 },
        { pitch: 62, startPpq: 1.5, durationPpq: 0.5 },
        { pitch: 60, startPpq: 2, durationPpq: 1 },
        { pitch: 62, startPpq: 3.5, durationPpq: 0.5 },
        { pitch: 60, startPpq: 4, durationPpq: 1 },
        { pitch: 67, startPpq: 5.25, durationPpq: 0.5 },
      ]);
      expect(joined?.ccLanes).toEqual([
        {
          controller: 11,
          channel: 0,
          points: [
            { ppq: 0.5, value: 64 },
            { ppq: 2.5, value: 64 },
            { ppq: 4.5, value: 64 },
          ],
        },
      ]);
    });

    it('glueMidiClips validates clip count, kind and track', () => {
      const firstId = store.clipId;
      const otherTrackId = addTrack({ name: 'Other' });
      const otherTrackClipId = addMidiClip({ trackId: otherTrackId, startPpq: 2, lengthPpq: 2 });

      expect(() => glueMidiClips([firstId])).toThrow(RangeError);
      expect(() => glueMidiClips([firstId, otherTrackClipId])).toThrow(RangeError);
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

    it('setClipPolyPressureForPitches updates several keys as one undoable edit', () => {
      const clipId = store.clipId;
      setClipPolyPressureForPitches(
        clipId,
        2,
        [64, 60, 64],
        [
          { ppq: 0.5, value: 80 },
          { ppq: 1, value: 200 },
        ],
      );
      expect(store.activeClip?.polyPressureLanes).toEqual([
        {
          channel: 2,
          pitch: 60,
          points: [
            { ppq: 0.5, value: 80 },
            { ppq: 1, value: 127 },
          ],
        },
        {
          channel: 2,
          pitch: 64,
          points: [
            { ppq: 0.5, value: 80 },
            { ppq: 1, value: 127 },
          ],
        },
      ]);

      setClipPolyPressureForPitches(clipId, 2, [60, 64], []);
      expect(store.activeClip?.polyPressureLanes).toBeUndefined();
      expect(undo()).toBe(true);
      expect(store.activeClip?.polyPressureLanes?.map((lane) => lane.pitch)).toEqual([60, 64]);
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

    it('commits update + delete + 16 additions as one validated undo entry', () => {
      const [updateId, deleteId] = addNotes([
        { pitch: 60, startPpq: 0, durationPpq: 1 },
        { pitch: 62, startPpq: 1, durationPpq: 1 },
      ]);
      clearHistory();
      const additions = Array.from({ length: 16 }, (_, index) => ({
        pitch: 64 + (index % 12),
        startPpq: 2 + index * 0.25,
        durationPpq: 0.25,
      }));

      const addedIds = applyNoteEdits({
        updates: [{ id: updateId, velocity: 48 }],
        deleteIds: [deleteId],
        additions,
      });

      expect(addedIds).toHaveLength(16);
      expect(store.notes).toHaveLength(17);
      expect(noteById(updateId)?.velocity).toBe(48);
      expect(undo()).toBe(true);
      expect(store.notes).toHaveLength(2);
      expect(noteById(updateId)?.velocity).toBe(96);
      expect(noteById(deleteId)).toBeDefined();
      expect(canUndo()).toBe(false);
      expect(redo()).toBe(true);
      expect(store.notes).toHaveLength(17);
    });

    it('validates every bulk note before changing the clip', () => {
      const [id] = addNotes([{ pitch: 60, startPpq: 0, durationPpq: 1 }]);
      clearHistory();
      const before = store.notes.map((note) => ({ ...note }));
      const additions = Array.from({ length: 16 }, (_, index) => ({
        pitch: index === 15 ? 128 : 64,
        startPpq: index,
        durationPpq: 0.25,
      }));

      expect(() =>
        applyNoteEdits({ updates: [{ id, velocity: 40 }], deleteIds: [id], additions }),
      ).toThrow(/pitch/);
      expect(store.notes).toEqual(before);
      expect(undo()).toBe(false);
    });

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

    it('quantizes sub-PPQ note lengths without rounding them up to one PPQ', () => {
      const id = addNote({ pitch: 60, startPpq: 0, durationPpq: 0.3 });
      setSelection([id]);
      store.snapDivision = 16; // grid = 0.25 PPQ
      quantizeSelectionLengths();
      expect(noteById(id)?.durationPpq).toBe(0.25);
    });

    it('quantizes note ends to the snap grid', () => {
      const a = addNote({ pitch: 60, startPpq: 0.1, durationPpq: 1.7 });
      setSelection([a]);
      store.snapDivision = 4; // grid = 1 PPQ
      quantizeSelectionEnds();
      expect(noteById(a)?.startPpq).toBe(0.1);
      expect(noteById(a)?.durationPpq).toBeCloseTo(1.9, 9);
    });

    it('duplicates and repeats the selection as one undoable edit', () => {
      const [a, b] = threeNotesSelectFirstTwo();
      const copies = duplicateSelection(1);
      expect(copies).toHaveLength(2);
      expect(store.selection).toEqual(new Set(copies));
      expect(store.notes.map((n) => n.startPpq).sort((x, y) => x - y)).toContain(1);
      undo();
      expect(noteById(a)).toBeDefined();
      expect(store.notes).toHaveLength(3);
      setSelection([a, b]);
      const repeated = repeatSelection(2, 4);
      expect(repeated).toHaveLength(4);
      expect(store.notes).toHaveLength(7);
    });

    it('applies legato, merge, and overlap cleanup', () => {
      const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      const b = addNote({ pitch: 60, startPpq: 2, durationPpq: 1 });
      setSelection([a, b]);
      legatoSelection();
      expect(noteById(a)?.durationPpq).toBe(2);
      mergeSelection();
      expect(store.notes).toHaveLength(1);
    });

    it('cleans up overlapping notes', () => {
      addNote({ pitch: 64, startPpq: 0, durationPpq: 4 });
      addNote({ pitch: 64, startPpq: 2, durationPpq: 1 });
      cleanupOverlaps();
      expect(
        store.notes.find((note) => note.pitch === 64 && note.startPpq === 0)?.durationPpq,
      ).toBe(2);
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

    it('fades, normalizes, and scales selected velocity dynamics', () => {
      const [a, b] = threeNotesSelectFirstTwo();
      fadeSelectionVelocity(20, 100);
      expect(noteById(a)?.velocity).toBe(20);
      expect(noteById(b)?.velocity).toBe(100);
      normalizeSelectionVelocity(120);
      expect(noteById(b)?.velocity).toBe(120);
      scaleSelectionVelocityDynamics(0);
      expect(noteById(a)?.velocity).toBe(noteById(b)?.velocity);
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

    it('selects by pitch, channel, velocity range, out-of-scale notes, and overlaps', () => {
      store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: 0b101011010101 };
      const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 2, velocity: 50, channel: 1 });
      const b = addNote({ pitch: 60, startPpq: 1, durationPpq: 1, velocity: 80, channel: 1 });
      const c = addNote({ pitch: 61, startPpq: 4, durationPpq: 1, velocity: 70, channel: 2 });
      setSelection([a]);
      selectSamePitch();
      expect(store.selection).toEqual(new Set([a, b]));
      setSelection([c]);
      selectSameChannel();
      expect(store.selection).toEqual(new Set([c]));
      setSelection([a, c]);
      selectVelocityRange();
      expect(store.selection).toEqual(new Set([a, c]));
      selectOutOfScale();
      expect(store.selection).toEqual(new Set([c]));
      selectOverlaps();
      expect(store.selection).toEqual(new Set([a, b]));
    });

    it('transposes diatonically within the active scale', () => {
      store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: 0b101011010101 };
      const c = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      setSelection([c]);
      transposeSelectionDiatonic(1);
      expect(noteById(c)?.pitch).toBe(62);
      transposeSelectionDiatonic(-1);
      expect(noteById(c)?.pitch).toBe(60);
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

    it('setActiveTrack keeps the timeline window when switching tracks', () => {
      // The outgoing active clip sits late in the timeline (as during playback);
      // switching tracks should land on the new track's clip that overlaps that
      // window, not its first clip, so the score/piano-roll stays aligned.
      const otherTrackId = addTrack({ name: 'Other' });
      addMidiClip({ trackId: otherTrackId, startPpq: 0, lengthPpq: 16 });
      const lateClipId = addMidiClip({ trackId: otherTrackId, startPpq: 64, lengthPpq: 16 });

      const originTrackId = store.tracks[0].id;
      const windowClipId = addMidiClip({ trackId: originTrackId, startPpq: 64, lengthPpq: 16 });
      setActiveClip(windowClipId);
      expect(store.clipStartPpq).toBe(64);

      setActiveTrack(otherTrackId);
      expect(store.clipId).toBe(lateClipId);
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

    it('setMarker does not consume an undo slot when nothing changes', () => {
      const id = setMarker(null, 8, 'Chorus');
      // A redo target to confirm the no-op leaves the redo stack intact.
      setMarker(id, 16, 'Chorus 2');
      undo();
      expect(store.markers.find((m) => m.id === id)).toMatchObject({ ppq: 8, name: 'Chorus' });
      expect(canRedo()).toBe(true);

      // Re-confirming the current fields is a no-op: no history entry pushed,
      // so the redo stack survives.
      const result = setMarker(id, 8, 'Chorus');
      expect(result).toBe(id);
      expect(canRedo()).toBe(true);
      redo();
      expect(store.markers.find((m) => m.id === id)).toMatchObject({ ppq: 16, name: 'Chorus 2' });
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

    it('supports fader automation on mixer buses and rejects bus pan automation', () => {
      const busId = addMixerBus({ name: 'FX' });
      const target = busAutomationTarget(busId);

      setAutomationLanePoints(target, 'faderDb', [{ ppq: 0, value: -9 }]);

      expect(store.automationLanes).toEqual([
        { target, param: 'faderDb', points: [{ ppq: 0, value: -9 }], enabled: true },
      ]);
      expect(() => setAutomationLanePoints(target, 'pan', [{ ppq: 0, value: 0 }])).toThrow(
        /buses only support fader/i,
      );
      expect(() => setAutomationLanePoints(busAutomationTarget('missing'), 'faderDb', [])).toThrow(
        RangeError,
      );
    });

    it('removes bus automation lanes when the bus is removed', () => {
      const busId = addMixerBus({ name: 'FX' });
      const target = busAutomationTarget(busId);
      setAutomationLanePoints(target, 'faderDb', [{ ppq: 0, value: -9 }]);

      removeMixerBus(busId);

      expect(store.automationLanes).toEqual([]);
      undo();
      expect(store.automationLanes[0]?.target).toBe(target);
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

    it('unfreezes tracks when the tempo map changes and restores them on undo', () => {
      const trackId = addTrack({ name: 'Frozen Vox', kind: 'audio' });
      setTrackFrozen(trackId, { assetId: 'baked-before-tempo-change' });

      setTempoSegments([
        { startPpq: 0, bpm: 100 },
        { startPpq: 8, bpm: 140 },
      ]);

      expect(store.tempoSegments).toEqual([
        { startPpq: 0, bpm: 100 },
        { startPpq: 8, bpm: 140 },
      ]);
      expect(store.tracks.find((track) => track.id === trackId)?.frozen).toBeUndefined();

      expect(undo()).toBe(true);
      expect(store.tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
      expect(store.tracks.find((track) => track.id === trackId)?.frozen).toEqual({
        assetId: 'baked-before-tempo-change',
      });
    });

    it('keeps frozen tracks when setTempoSegments re-applies the same map', () => {
      const trackId = addTrack({ name: 'Frozen Vox', kind: 'audio' });
      setTrackFrozen(trackId, { assetId: 'still-current' });

      setTempoSegments([{ startPpq: 0, bpm: 120 }]);

      expect(store.tracks.find((track) => track.id === trackId)?.frozen).toEqual({
        assetId: 'still-current',
      });
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
    it('subtracts redo bytes when a non-commit gesture makes redo stale', () => {
      const track = store.tracks[0];
      executeApp(() => {
        track.color = '#112233';
      });
      undo();
      const withRedo = historyBudgetStats();
      expect(withRedo).toMatchObject({ undoEntries: 0, redoEntries: 1 });
      expect(withRedo.bytes).toBe(withRedo.accountedBytes);

      executeApp(
        () => {
          track.color = '#445566';
        },
        { key: 'color-drag', commit: false },
      );
      const duringGesture = historyBudgetStats();
      expect(duringGesture).toMatchObject({ undoEntries: 0, redoEntries: 0, bytes: 0 });
      expect(duringGesture.bytes).toBe(duringGesture.accountedBytes);

      executeApp(
        () => {
          track.color = '#778899';
        },
        { key: 'color-drag', commit: true },
      );
      const committed = historyBudgetStats();
      expect(committed).toMatchObject({ undoEntries: 1, redoEntries: 0 });
      expect(committed.bytes).toBe(committed.accountedBytes);
    });

    it('structurally shares large unchanged note mirrors and enforces the byte budget', () => {
      addNotes(
        Array.from({ length: 10_000 }, (_, index) => ({
          pitch: 48 + (index % 24),
          velocity: 96,
          startPpq: index * 0.25,
          durationPpq: 0.2,
          channel: 0,
        })),
      );
      clearHistory();
      setTrackColor(store.tracks[0].id, '#112233');
      const oneEntry = historyBudgetStats();
      expect(oneEntry.undoEntries).toBe(1);
      // The unchanged 10k-note list is retained once across before/after.
      expect(oneEntry.bytes).toBeLessThan(4 * 1024 * 1024);

      clearHistory();
      configureHistoryByteBudget(oneEntry.bytes * 2);
      for (let index = 0; index < 10; index++) {
        setTrackColor(store.tracks[0].id, `#${(index + 1).toString(16).padStart(6, '0')}`);
      }
      const bounded = historyBudgetStats();
      expect(bounded.bytes).toBeLessThanOrEqual(bounded.budgetBytes);
      expect(bounded.undoEntries).toBeLessThan(10);
      clearHistory();
    });

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

    it('dispose() drops the undo/redo history so snapshots cannot dangle', () => {
      addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
      setMarker(null, 4, 'Hit');
      undo();
      expect(canUndo()).toBe(true);
      expect(canRedo()).toBe(true);

      // Disposing the store must clear history on its own (no separate
      // clearHistory call), or later undo()/redo() would replay against a
      // deleted Project.
      store.dispose();
      expect(canUndo()).toBe(false);
      expect(canRedo()).toBe(false);
    });
  });
});
