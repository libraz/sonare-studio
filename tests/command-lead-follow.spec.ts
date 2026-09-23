import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTracksBatchCommand } from '@/project/command/generate-batch';
import { setTrackLeadFollow } from '@/project/command/lead-follow';
import {
  addMidiClip,
  addNote,
  addNotes,
  addTrack,
  applyNoteEdits,
  bakeClipMidiFx,
  clearHistory,
  deleteClip,
  moveClip,
  redo,
  removeTrack,
  setActiveClip,
  setProjectChords,
  setTrackChordFollow,
  trimClip,
  undo,
} from '@/project/commands';
import { sanitizeMidiFxConfig } from '@/project/midi-fx';
import { getProject, useProjectStore } from '@/project/store';

const undoDepth = vi.hoisted(() => ({ value: 512 }));

vi.mock('@/project/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/project/runtime')>();
  return {
    ...actual,
    get PROJECT_MAX_UNDO_DEPTH() {
      return undoDepth.value;
    },
  };
});

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const C4 = 60;
const E4 = 64;
const F4 = 65;
const G4 = 67;
const A4 = 69;
const C5 = 72;
const F_SHARP4 = 66;

const C_MAJOR = { startPpq: 0, endPpq: 16, rootPc: 0, quality: 0 };

describe('lead follow commands', () => {
  let store: ReturnType<typeof useProjectStore>;
  let leadTrackId: number;
  let leadClipId: number;
  let backingTrackId: number;
  let backingClipId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    undoDepth.value = 512;
  });

  afterEach(() => {
    undoDepth.value = 512;
    vi.restoreAllMocks();
  });

  /** A lead track and a C-triad backing track over one C major bar region. */
  function arrange(options: { follow?: boolean } = {}): void {
    setProjectChords([C_MAJOR]);
    leadTrackId = addTrack({ name: 'Lead' });
    leadClipId = addMidiClip({ trackId: leadTrackId, lengthPpq: 16 });
    backingTrackId = addTrack({ name: 'Backing' });
    backingClipId = addMidiClip({ trackId: backingTrackId, lengthPpq: 16 });
    setActiveClip(backingClipId);
    addNotes([C4, E4, G4].map((pitch) => ({ pitch, startPpq: 4, durationPpq: 4 })));
    if (options.follow !== false) setTrackLeadFollow(backingTrackId, leadTrackId);
    setActiveClip(leadClipId);
  }

  function clipPitches(clipId: number): number[] {
    return (store.clips.find((clip) => clip.id === clipId)?.notes ?? [])
      .map((note) => note.pitch)
      .sort((a, b) => a - b);
  }

  function stashPitches(trackId = backingTrackId): number[] {
    const track = store.tracks.find((entry) => entry.id === trackId);
    return (track?.leadFollow?.stash ?? []).map((entry) => entry.note.pitch).sort((a, b) => a - b);
  }

  function thinned(): void {
    expect(clipPitches(backingClipId)).toEqual([C4, G4]);
    expect(stashPitches()).toEqual([E4]);
  }

  function full(): void {
    expect(clipPitches(backingClipId)).toEqual([C4, E4, G4]);
    expect(stashPitches()).toEqual([]);
  }

  it('a pencil note thins the backing in the same step, and one undo restores both', () => {
    arrange();
    addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    expect(clipPitches(leadClipId)).toEqual([F4]);
    thinned();

    expect(undo()).toBe(true);
    expect(clipPitches(leadClipId)).toEqual([]);
    full();

    expect(redo()).toBe(true);
    expect(clipPitches(leadClipId)).toEqual([F4]);
    thinned();
  });

  it('a note edit that removes the clash brings the note back in one step', () => {
    arrange();
    const id = addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    applyNoteEdits({ updates: [{ id, pitch: G4 }] });
    full();
    expect(undo()).toBe(true);
    thinned();
  });

  it('a MIDI FX bake that creates the clash thins in the same step', () => {
    arrange();
    addNote({ pitch: E4, startPpq: 4, durationPpq: 1 });
    full();
    bakeClipMidiFx(leadClipId, sanitizeMidiFxConfig({ transposeSemitones: 1 }));
    expect(clipPitches(leadClipId)).toEqual([F4]);
    thinned();
    expect(undo()).toBe(true);
    expect(clipPitches(leadClipId)).toEqual([E4]);
    full();
  });

  it('moving the lead clip away restores the backing, and undo thins it again', () => {
    arrange();
    addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    moveClip(leadClipId, 16);
    full();
    expect(undo()).toBe(true);
    thinned();
  });

  it('trimming the clashing note out of the lead clip restores the backing', () => {
    arrange();
    addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    trimClip(leadClipId, 0, 4);
    full();
    expect(undo()).toBe(true);
    thinned();
  });

  it('deleting the lead clip restores the backing, and undo thins it again', () => {
    arrange();
    addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    deleteClip(leadClipId);
    full();
    expect(undo()).toBe(true);
    thinned();
  });

  it('a chord change re-voices the parked note, so it returns at the new pitch', () => {
    arrange();
    setTrackChordFollow(backingTrackId, 'chordTones');
    addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    thinned();

    // C -> F: the backing moves up a fourth and the parked E4 comes back as A4.
    setProjectChords([{ ...C_MAJOR, rootPc: 5 }]);
    expect(clipPitches(backingClipId)).toEqual([F4, A4, C5]);
    expect(stashPitches()).toEqual([]);

    expect(undo()).toBe(true);
    thinned();
  });

  it('editing only the backing does not re-thin it', () => {
    arrange();
    addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    setActiveClip(backingClipId);
    addNote({ pitch: F_SHARP4, startPpq: 4, durationPpq: 4 });
    expect(clipPitches(backingClipId)).toEqual([C4, F_SHARP4, G4]);
    expect(stashPitches()).toEqual([E4]);
  });

  it('enabling thins at once and disabling restores everything, one undo each', () => {
    arrange({ follow: false });
    addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    full();

    setTrackLeadFollow(backingTrackId, leadTrackId);
    thinned();
    expect(undo()).toBe(true);
    full();
    expect(store.tracks.find((track) => track.id === backingTrackId)?.leadFollow).toBeUndefined();
    expect(redo()).toBe(true);
    thinned();

    setTrackLeadFollow(backingTrackId, null);
    full();
    expect(store.tracks.find((track) => track.id === backingTrackId)?.leadFollow).toBeUndefined();
    expect(undo()).toBe(true);
    thinned();
  });

  it('removing the lead track restores the backing and drops the follow', () => {
    arrange();
    addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    removeTrack(leadTrackId);
    full();
    expect(store.tracks.find((track) => track.id === backingTrackId)?.leadFollow).toBeUndefined();
    expect(undo()).toBe(true);
    thinned();
    expect(store.tracks.find((track) => track.id === backingTrackId)?.leadFollow?.leadTrackId).toBe(
      leadTrackId,
    );
  });

  it('rejects following itself, percussion, chains and cycles', () => {
    arrange();
    const padTrackId = addTrack({ name: 'Pad' });
    const drumsTrackId = addTrack({ name: 'Drums' });

    expect(() => setTrackLeadFollow(padTrackId, padTrackId)).toThrow(RangeError);
    expect(() => setTrackLeadFollow(drumsTrackId, leadTrackId)).toThrow(/percussion/);
    expect(() => setTrackLeadFollow(padTrackId, drumsTrackId)).toThrow(/percussion/);
    // Backing already follows Lead, so neither may take part in another follow.
    expect(() => setTrackLeadFollow(padTrackId, backingTrackId)).toThrow(RangeError);
    expect(() => setTrackLeadFollow(leadTrackId, padTrackId)).toThrow(RangeError);
    expect(() => setTrackLeadFollow(leadTrackId, backingTrackId)).toThrow(RangeError);
    expect(store.tracks.find((track) => track.id === padTrackId)?.leadFollow).toBeUndefined();
  });

  it('defers only the follow when it would exceed the undo budget, and says so', () => {
    arrange();
    undoDepth.value = 1;
    addNote({ pitch: F4, startPpq: 4, durationPpq: 1 });
    expect(clipPitches(leadClipId)).toEqual([F4]);
    full();
    expect(store.leadFollowDeferred).toBe(true);

    undoDepth.value = 512;
    addNote({ pitch: C5, startPpq: 8, durationPpq: 1 });
    thinned();
    expect(store.leadFollowDeferred).toBe(false);
  });

  it('rolls back a partly applied follow when a write throws, keeping the edit', () => {
    setProjectChords([C_MAJOR]);
    leadTrackId = addTrack({ name: 'Lead' });
    leadClipId = addMidiClip({ trackId: leadTrackId, lengthPpq: 16 });
    backingTrackId = addTrack({ name: 'Backing' });
    const firstClipId = addMidiClip({ trackId: backingTrackId, lengthPpq: 8 });
    setActiveClip(firstClipId);
    addNotes([C4, E4, G4].map((pitch) => ({ pitch, startPpq: 0, durationPpq: 4 })));
    const secondClipId = addMidiClip({ trackId: backingTrackId, startPpq: 8, lengthPpq: 8 });
    setActiveClip(secondClipId);
    addNotes([C4, E4, G4].map((pitch) => ({ pitch, startPpq: 0, durationPpq: 4 })));
    setTrackLeadFollow(backingTrackId, leadTrackId);
    setActiveClip(leadClipId);

    const project = getProject();
    const write = project.setMidiEvents.bind(project);
    vi.spyOn(project, 'setMidiEvents').mockImplementation((clipId, events) => {
      if (clipId === secondClipId) throw new Error('native write failed');
      write(clipId, events);
    });
    addNote({ pitch: F4, startPpq: 0, durationPpq: 16 });
    vi.restoreAllMocks();

    expect(clipPitches(leadClipId)).toEqual([F4]);
    expect(store.leadFollowDeferred).toBe(true);
    store.refresh();
    expect(clipPitches(firstClipId)).toEqual([C4, E4, G4]);
    expect(clipPitches(secondClipId)).toEqual([C4, E4, G4]);
    expect(stashPitches()).toEqual([]);

    // The native history stayed aligned: one undo removes exactly the edit.
    expect(undo()).toBe(true);
    expect(clipPitches(leadClipId)).toEqual([]);
    expect(clipPitches(firstClipId)).toEqual([C4, E4, G4]);
  });

  it('a batch that writes a motif and a backing makes the backing follow the motif', () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
    ]);
    const trackCount = store.tracks.length;
    generateTracksBatchCommand([
      { part: 'motif', params: {}, target: { kind: 'new' } },
      { part: 'backing', params: {}, target: { kind: 'new' } },
    ]);
    const motif = store.tracks.find((track) => track.generated?.part === 'motif');
    const backing = store.tracks.find((track) => track.generated?.part === 'backing');
    expect(motif).toBeDefined();
    expect(backing?.leadFollow?.leadTrackId).toBe(motif?.id);
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount);
  });
});
