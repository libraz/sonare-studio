import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneJson } from '@/project/clone-json';
import { overwriteRecordedMidiClip } from '@/project/command/midi-recording';
import {
  addAudioTrack,
  addRecordedMidiClip,
  clearHistory,
  flattenClipMidiComp,
  redo,
  setActiveClip,
  setClipMidiActiveTake,
  setClipMidiCompSegments,
  trimClip,
  undo,
} from '@/project/commands';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** The MIDI takes of the first track's clip called `name`; throws when it has none. */
function documentTakes(doc: ProjectDocument, name: string) {
  const takes = doc.tracks[0].clips.find((clip) => clip.name === name)?.midiTakes;
  if (!takes) throw new Error(`clip ${name} has no MIDI takes`);
  return takes;
}

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

  it('preserves recorded program-change lanes across refresh and history', () => {
    const trackId = store.tracks[0].id;
    const clipId = addRecordedMidiClip({
      trackId,
      startPpq: 0,
      lengthPpq: 4,
      notes: [],
      programChangeLanes: [{ channel: 2, points: [{ ppq: 1, program: 24 }] }],
    });
    setActiveClip(clipId);
    expect(store.activeClip?.programChangeLanes).toEqual([
      { channel: 2, points: [{ ppq: 1, program: 24 }] },
    ]);

    expect(undo()).toBe(true);
    expect(store.clips.find((clip) => clip.id === clipId)).toBeUndefined();
    expect(redo()).toBe(true);
    setActiveClip(clipId);
    expect(store.activeClip?.programChangeLanes).toEqual([
      { channel: 2, points: [{ ppq: 1, program: 24 }] },
    ]);
  });

  it('switches an independently stored MIDI cycle take, including its expression lanes', () => {
    const trackId = store.tracks[0].id;
    const clipId = addRecordedMidiClip({
      trackId,
      startPpq: 0,
      lengthPpq: 4,
      notes: [{ pitch: 64, velocity: 90, startPpq: 1, durationPpq: 1, channel: 0 }],
      midiTakes: [
        {
          name: 'Take 1',
          notes: [{ pitch: 60, velocity: 80, startPpq: 0, durationPpq: 1, channel: 0 }],
          ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 0, value: 12 }] }],
        },
        {
          name: 'Take 2',
          notes: [{ pitch: 64, velocity: 90, startPpq: 1, durationPpq: 1, channel: 0 }],
          ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 1, value: 99 }] }],
        },
      ],
      activeMidiTakeIndex: 1,
    });

    setClipMidiActiveTake(clipId, 0);
    setActiveClip(clipId);
    expect(store.activeClip?.midiActiveTakeIndex).toBe(0);
    expect(store.notes.map((note) => note.pitch)).toEqual([60]);
    expect(store.activeClip?.ccLanes).toEqual([
      { controller: 1, channel: 0, points: [{ ppq: 0, value: 12 }] },
    ]);

    expect(undo()).toBe(true);
    setActiveClip(clipId);
    expect(store.activeClip?.midiActiveTakeIndex).toBe(1);
    expect(store.activeClip?.midiTakes?.map((take) => take.name)).toEqual(['Take 1', 'Take 2']);
    expect(store.notes.map((note) => note.pitch)).toEqual([64]);
  });

  it('round-trips MIDI cycle takes through the project document', async () => {
    const trackId = store.tracks[0].id;
    const clipId = addRecordedMidiClip({
      trackId,
      startPpq: 0,
      lengthPpq: 4,
      notes: [{ pitch: 67, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
      midiTakes: [
        {
          name: 'Verse',
          notes: [{ pitch: 60, velocity: 80, startPpq: 0, durationPpq: 1, channel: 0 }],
        },
        {
          name: 'Chorus',
          notes: [{ pitch: 67, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
          programChangeLanes: [{ channel: 0, points: [{ ppq: 0, program: 41 }] }],
        },
      ],
      activeMidiTakeIndex: 1,
    });

    expect(
      store.clips.find((clip) => clip.id === clipId)?.midiTakes?.map((take) => take.name),
    ).toEqual(['Verse', 'Chorus']);
    const document = cloneJson(serializeProject());
    const documentClip = document.tracks[0].clips.find((clip) => clip.name === `Clip ${clipId}`);
    expect(documentClip?.midiTakes?.map((take) => take.name)).toEqual(['Verse', 'Chorus']);
    await loadProjectDocument(document);
    const clip = store.clips.find((entry) => entry.name === `Clip ${clipId}`)!;
    expect(clip.midiTakes?.map((take) => take.name)).toEqual(['Verse', 'Chorus']);
    expect(clip.midiActiveTakeIndex).toBe(1);
    expect(clip.notes.map((note) => note.pitch)).toEqual([67]);
    expect(clip.programChangeLanes).toEqual([{ channel: 0, points: [{ ppq: 0, program: 41 }] }]);
  });

  it('retains source-relative take notes beyond a trimmed clip window', async () => {
    const trackId = store.tracks[0].id;
    const clipId = addRecordedMidiClip({
      trackId,
      startPpq: 0,
      lengthPpq: 8,
      notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
      midiTakes: [
        {
          name: 'Pass 1',
          notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 }],
        },
        {
          name: 'Pass 2',
          // This note is valid in the original source-relative take, but lies
          // outside the clip after the user trims its current window.
          notes: [{ pitch: 72, velocity: 100, startPpq: 6, durationPpq: 1, channel: 0 }],
        },
      ],
      activeMidiTakeIndex: 0,
    });
    trimClip(clipId, 0, 4);

    const before = cloneJson(serializeProject());
    const beforeTakeNotes = documentTakes(before, `Clip ${clipId}`)[1].notes;

    await loadProjectDocument(before);

    const after = cloneJson(serializeProject());
    expect(documentTakes(after, `Clip ${clipId}`)[1].notes).toEqual(beforeTakeNotes);
    expect(after).toEqual(before);
  });

  it('comps ranges from MIDI takes into the playable clip', () => {
    const trackId = store.tracks[0].id;
    const clipId = addRecordedMidiClip({
      trackId,
      startPpq: 0,
      lengthPpq: 4,
      notes: [],
      midiTakes: [
        {
          name: 'A',
          notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 4, channel: 0 }],
          ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 0, value: 10 }] }],
        },
        {
          name: 'B',
          notes: [{ pitch: 64, velocity: 90, startPpq: 0, durationPpq: 4, channel: 0 }],
          ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 1, value: 90 }] }],
        },
      ],
    });
    setClipMidiCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
    setActiveClip(clipId);
    expect(store.notes.map((note) => [note.pitch, note.startPpq, note.durationPpq])).toEqual([
      [60, 0, 2],
      [64, 2, 2],
    ]);
    expect(store.activeClip?.ccLanes).toEqual([
      {
        controller: 1,
        channel: 0,
        points: [
          { ppq: 0, value: 10 },
          { ppq: 2, value: 90 },
        ],
      },
    ]);
  });

  it('flattens a MIDI comp without changing its playable notes', () => {
    const trackId = store.tracks[0].id;
    const clipId = addRecordedMidiClip({
      trackId,
      startPpq: 0,
      lengthPpq: 4,
      notes: [],
      midiTakes: [
        {
          name: 'A',
          notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 4, channel: 0 }],
        },
        {
          name: 'B',
          notes: [{ pitch: 64, velocity: 90, startPpq: 0, durationPpq: 4, channel: 0 }],
        },
      ],
    });
    setClipMidiCompSegments(clipId, [{ startPpq: 0, takeIndex: 1 }]);
    flattenClipMidiComp(clipId);
    setActiveClip(clipId);
    expect(store.notes.map((note) => note.pitch)).toEqual([64]);
    expect(store.activeClip?.midiTakes).toBeUndefined();
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

describe('overwriteRecordedMidiClip', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('replaces only the cycle interval and restores the prior material in one undo', () => {
    const trackId = store.tracks[0].id;
    const oldClipId = addRecordedMidiClip({
      trackId,
      startPpq: 0,
      lengthPpq: 12,
      notes: [
        { pitch: 60, velocity: 90, startPpq: 1, durationPpq: 1, channel: 0 },
        { pitch: 64, velocity: 90, startPpq: 5, durationPpq: 1, channel: 0 },
        { pitch: 67, velocity: 90, startPpq: 9, durationPpq: 1, channel: 0 },
      ],
    });
    const before = JSON.parse(JSON.stringify(store.clips));
    clearHistory();

    const replacementId = overwriteRecordedMidiClip({
      trackId,
      startPpq: 4,
      lengthPpq: 4,
      notes: [{ pitch: 72, velocity: 100, startPpq: 0.5, durationPpq: 1, channel: 0 }],
    });
    expect(replacementId).not.toBe(oldClipId);
    const material = store.clips
      .map((clip) => ({
        start: clip.startPpq,
        end: clip.startPpq + clip.lengthPpq,
        pitches: clip.notes.map((note) => note.pitch),
      }))
      .filter((clip) => clip.pitches.length > 0);
    expect(material).toEqual([
      { start: 0, end: 4, pitches: [60] },
      { start: 4, end: 8, pitches: [72] },
      { start: 8, end: 12, pitches: [67] },
    ]);

    expect(undo()).toBe(true);
    expect(store.clips).toEqual(before);
    expect(undo()).toBe(false);
  });
});
