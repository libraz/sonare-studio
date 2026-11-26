import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureWasm } from '@/lib/wasm';
import {
  addNote,
  canRedo,
  canUndo,
  clearHistory,
  deleteNotes,
  quantizeSelection,
  redo,
  setSelection,
  setTimeSignatures,
  undo,
  updateNotes,
} from '@/project/commands';
import { getProject, PROJECT_MAX_UNDO_DEPTH, useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';
import { FakeProject } from './fake-wasm';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Returns the fake project's event list for the store's clip, via toJson. */
function clipEvents(clipId: number): Array<{ ppq: number; word0: number; word1: number }> {
  const doc = JSON.parse(getProject().toJson());
  return doc.midiContent[String(clipId)] ?? [];
}

describe('project store', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('init creates a Project with default tempo and one empty 8-bar clip', () => {
    expect(store.initialized).toBe(true);
    expect(store.clipId).toBeGreaterThanOrEqual(0);
    expect(store.clipStartPpq).toBe(0);
    expect(store.clipLengthPpq).toBe(32);
    expect(store.tempoBpm).toBe(120);
    expect(store.notes).toEqual([]);
    expect(store.selection.size).toBe(0);
  });

  it('configures the bounded wasm undo depth for every new project', async () => {
    const setMaxUndoDepth = vi.spyOn(FakeProject.prototype, 'setMaxUndoDepth');
    store.dispose();

    await store.init();

    expect(setMaxUndoDepth).toHaveBeenCalledWith(PROJECT_MAX_UNDO_DEPTH);
  });

  it('makes the fake project evict undo entries at the configured depth', () => {
    const project = new FakeProject();
    project.setMaxUndoDepth(2);
    project.setTempoSegments([{ startPpq: 0, bpm: 100 }]);
    project.setTempoSegments([{ startPpq: 0, bpm: 110 }]);
    project.setTempoSegments([{ startPpq: 0, bpm: 120 }]);

    expect(() => Reflect.apply(project.setMaxUndoDepth, project, [undefined])).toThrowError(
      new TypeError('depth must be an integer'),
    );
    expect(() => project.setMaxUndoDepth(0)).toThrow(RangeError);
    expect(() => project.setMaxUndoDepth(500_000_001)).toThrow(RangeError);

    project.undo();
    project.undo();
    project.undo();

    expect(JSON.parse(project.toJson()).tempoSegments).toEqual([
      { startPpq: 0, bpm: 100, endBpm: 0, startSample: 0 },
    ]);
  });

  it('leaves a live Project and its native undo untouched when init runs again', async () => {
    const project = getProject();
    const nativeBefore = project.toJson();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });

    await store.init();

    expect(getProject()).toBe(project);
    expect(undo()).toBe(true);
    expect(project.toJson()).toBe(nativeBefore);
    expect(JSON.parse(nativeBefore).sampleRate).toBe(48000);
  });

  it('addNote writes a note-on/note-off pair through to the Project', () => {
    const id = addNote({ pitch: 60, startPpq: 1, durationPpq: 0.5, velocity: 100 });
    expect(store.notes).toHaveLength(1);
    expect(store.notes[0]).toMatchObject({
      id,
      pitch: 60,
      velocity: 100,
      startPpq: 1,
      durationPpq: 0.5,
      channel: 0,
    });
    expect(clipEvents(store.clipId)).toHaveLength(2);
  });

  it('addNote applies velocity/channel defaults and validates ranges', () => {
    const id = addNote({ pitch: 64, startPpq: 0, durationPpq: 1 });
    const note = store.notes.find((n) => n.id === id);
    expect(note?.velocity).toBe(96);
    expect(note?.channel).toBe(0);
    expect(() => addNote({ pitch: 128, startPpq: 0, durationPpq: 1 })).toThrow(RangeError);
    expect(() => addNote({ pitch: 60, startPpq: -1, durationPpq: 1 })).toThrow(RangeError);
    expect(() => addNote({ pitch: 60, startPpq: 0, durationPpq: 0 })).toThrow(RangeError);
  });

  it('updateNotes moves, resizes, and revoices notes while keeping ids stable', () => {
    const id = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 90 });
    updateNotes([{ id, startPpq: 2, durationPpq: 0.25, velocity: 40, pitch: 62 }]);
    expect(store.notes).toHaveLength(1);
    expect(store.notes[0]).toMatchObject({
      id,
      pitch: 62,
      velocity: 40,
      startPpq: 2,
      durationPpq: 0.25,
    });
    // No-op when no update matches an existing id.
    updateNotes([{ id: 9999, startPpq: 5 }]);
    expect(store.notes[0].startPpq).toBe(2);
  });

  it('deleteNotes removes notes and prunes the selection', () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    setSelection([a, b]);
    deleteNotes([a]);
    expect(store.notes.map((n) => n.id)).toEqual([b]);
    expect([...store.selection]).toEqual([b]);
    expect(clipEvents(store.clipId)).toHaveLength(2);
  });

  it('setSelection keeps only ids of existing notes', () => {
    const id = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setSelection([id, 12345]);
    expect([...store.selection]).toEqual([id]);
    expect(store.selectedNotes.map((n) => n.id)).toEqual([id]);
  });

  it('undo/redo delegate to the Project history and keep note ids stable', () => {
    const id = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 90 });
    updateNotes([{ id, startPpq: 2 }]);
    expect(store.notes[0].startPpq).toBe(2);

    expect(undo()).toBe(true);
    expect(store.notes[0]).toMatchObject({ id, startPpq: 0 });
    expect(canRedo()).toBe(true);

    expect(undo()).toBe(true);
    expect(store.notes).toEqual([]);
    expect(canUndo()).toBe(false);
    expect(undo()).toBe(false);

    expect(redo()).toBe(true);
    expect(store.notes[0]).toMatchObject({ id, startPpq: 0 });
    expect(redo()).toBe(true);
    expect(store.notes[0]).toMatchObject({ id, startPpq: 2 });
    expect(redo()).toBe(false);
  });

  it('a new edit clears the redo history', () => {
    const id = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    undo();
    expect(canRedo()).toBe(true);
    addNote({ pitch: 62, startPpq: 0, durationPpq: 1 });
    expect(canRedo()).toBe(false);
    expect(redo()).toBe(false);
    expect(store.notes.some((n) => n.id === id)).toBe(false);
  });

  it('refresh round-trips events written directly to the Project', async () => {
    const wasm = await ensureWasm();
    getProject().setMidiEvents(store.clipId, [
      wasm.midiNoteOn({ ppq: 1, group: 0, channel: 2, note: 64, velocity: 100 }),
      wasm.midiNoteOff({ ppq: 2.5, group: 0, channel: 2, note: 64, velocity: 30 }),
      wasm.midiNoteOn({ ppq: 0, group: 0, channel: 0, note: 60, velocity: 80 }),
      wasm.midiNoteOff({ ppq: 1, group: 0, channel: 0, note: 60 }),
    ]);
    store.refresh();
    expect(store.notes).toHaveLength(2);
    expect(store.notes[0]).toMatchObject({
      pitch: 60,
      velocity: 80,
      startPpq: 0,
      durationPpq: 1,
      channel: 0,
    });
    expect(store.notes[0].offVelocity).toBeUndefined();
    expect(store.notes[1]).toMatchObject({
      pitch: 64,
      velocity: 100,
      startPpq: 1,
      durationPpq: 1.5,
      channel: 2,
      offVelocity: 30,
    });
    // A second refresh re-associates the same ids by content.
    const ids = store.notes.map((n) => n.id);
    store.refresh();
    expect(store.notes.map((n) => n.id)).toEqual(ids);
  });

  it('quantizeSelection snaps to the local grid for sub-beat divisions', () => {
    const id = addNote({ pitch: 60, startPpq: 1.13, durationPpq: 1 });
    setSelection([id]);
    store.snapDivision = 16; // sixteenth-note grid = 0.25 PPQ
    quantizeSelection();
    expect(store.notes[0].startPpq).toBeCloseTo(1.25, 10);
  });

  it('quantizeSelection snaps the beat grid without delegating to WASM', () => {
    const id = addNote({ pitch: 60, startPpq: 1.3, durationPpq: 1 });
    setSelection([id]);
    store.snapDivision = 4; // quarter-note grid = the project beat grid
    quantizeSelection();
    expect(store.notes[0].startPpq).toBe(1);
  });

  it('quantizeSelection follows actual bar starts when Bar snap is selected', () => {
    setTimeSignatures([
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 6, numerator: 5, denominator: 8 },
    ]);
    store.snapBar = true;
    const id = addNote({ pitch: 60, startPpq: 7.1, durationPpq: 0.5 });
    setSelection([id]);

    quantizeSelection();

    expect(store.notes.find((note) => note.id === id)?.startPpq).toBe(6);
  });

  it('quantizeSelection supports partial strength and is undoable', () => {
    const id = addNote({ pitch: 60, startPpq: 1.1, durationPpq: 1 });
    setSelection([id]);
    store.snapDivision = 16;
    quantizeSelection(0.5);
    expect(store.notes[0].startPpq).toBeCloseTo(1.05, 10);
    undo();
    expect(store.notes[0].startPpq).toBeCloseTo(1.1, 10);
  });

  it('uses the selected swing and strength for selection quantize', () => {
    store.snapDivision = 8; // 1/8 straight grid
    store.quantizeSwing = 100;
    store.quantizeStrength = 0.5;
    const id = addNote({ pitch: 60, startPpq: 0.5, durationPpq: 1 });
    setSelection([id]);

    quantizeSelection();

    // The swung offbeat is 0.5 + 0.5 / 3; at 50% strength, move half way.
    expect(store.notes.find((note) => note.id === id)?.startPpq).toBeCloseTo(0.5 + 0.5 / 6, 12);
  });

  it('keeps triplet grids ternary when swing is enabled', () => {
    store.snapDivision = 12; // 1/8T = 1/3 PPQ
    store.quantizeSwing = 100;
    const id = addNote({ pitch: 60, startPpq: 0.62, durationPpq: 1 });
    setSelection([id]);

    quantizeSelection();

    expect(store.notes.find((note) => note.id === id)?.startPpq).toBeCloseTo(2 / 3, 12);
  });

  it('quantizes to the selected dotted grid', () => {
    store.snapDivision = 16 / 3; // dotted eighth-note grid = 0.75 PPQ
    const id = addNote({ pitch: 60, startPpq: 0.82, durationPpq: 1 });
    setSelection([id]);

    quantizeSelection();

    expect(store.notes.find((note) => note.id === id)?.startPpq).toBeCloseTo(0.75, 12);
  });

  it('highlightedPitchClasses delegates to scalePitchClassEnabled', () => {
    // C major: C D E F G A B.
    expect(store.highlightedPitchClasses).toEqual([
      true,
      false,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    store.scaleHighlight = { enabled: true, rootPc: 2, modeMask: MAJOR_MODE_MASK };
    expect(store.highlightedPitchClasses[2]).toBe(true); // D
    expect(store.highlightedPitchClasses[5]).toBe(false); // F is not in D major
    expect(store.highlightedPitchClasses[6]).toBe(true); // F#
    store.scaleHighlight = { enabled: false, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    expect(store.highlightedPitchClasses.every((on) => on === false)).toBe(true);
  });
});
