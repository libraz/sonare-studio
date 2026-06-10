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
  undo,
  updateNotes,
} from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', () => {
  /** Packs a UMP MIDI 1.0 channel-voice word with the real binding layout. */
  const pack = (
    group: number,
    status: number,
    channel: number,
    data1: number,
    data2: number,
  ): number =>
    ((0x2 << 28) | (group << 24) | (status << 20) | (channel << 16) | (data1 << 8) | data2) >>> 0;

  interface FakeEvent {
    ppq: number;
    data0: number;
    data1: number;
  }

  /** In-memory stand-in for the wasm Project: per-clip event lists + history. */
  class FakeProject {
    private static nextClipId = 1;
    private sampleRate = 48000;
    private tempoSegments: Array<{ startPpq: number; bpm: number }> = [];
    private clips = new Map<number, FakeEvent[]>();
    private history: Array<Map<number, FakeEvent[]>> = [];
    private future: Array<Map<number, FakeEvent[]>> = [];
    private deleted = false;

    static midiNoteOn(
      ppq: number,
      group: number,
      channel: number,
      note: number,
      velocity: number,
    ): FakeEvent {
      return { ppq, data0: pack(group, 0x9, channel, note, velocity), data1: 0 };
    }

    static midiNoteOff(
      ppq: number,
      group: number,
      channel: number,
      note: number,
      velocity = 0,
    ): FakeEvent {
      return { ppq, data0: pack(group, 0x8, channel, note, velocity), data1: 0 };
    }

    setSampleRate(sampleRate: number): void {
      this.sampleRate = sampleRate;
    }

    getSampleRate(): number {
      return this.sampleRate;
    }

    setTempoSegments(segments: ReadonlyArray<{ startPpq: number; bpm: number }>): void {
      this.tempoSegments = segments.map((s) => ({ startPpq: s.startPpq, bpm: s.bpm }));
    }

    addMidiClip(_startPpq: number, _lengthPpq: number): { trackId: number; clipId: number } {
      const clipId = FakeProject.nextClipId++;
      this.clips.set(clipId, []);
      return { trackId: clipId, clipId };
    }

    private snapshot(): Map<number, FakeEvent[]> {
      return new Map([...this.clips].map(([id, events]) => [id, events.map((e) => ({ ...e }))]));
    }

    setMidiEvents(clipId: number, events: ReadonlyArray<FakeEvent>): void {
      if (!this.clips.has(clipId)) throw new Error(`unknown clip ${clipId}`);
      this.history.push(this.snapshot());
      this.future.length = 0;
      this.clips.set(
        clipId,
        events.map((e) => ({ ppq: e.ppq, data0: e.data0, data1: e.data1 ?? 0 })),
      );
    }

    undo(): void {
      const previous = this.history.pop();
      if (!previous) return;
      this.future.push(this.snapshot());
      this.clips = previous;
    }

    redo(): void {
      const next = this.future.pop();
      if (!next) return;
      this.history.push(this.snapshot());
      this.clips = next;
    }

    snapToGrid(ppq: number, strength = 1): number {
      const target = Math.round(ppq);
      return ppq + (target - ppq) * strength;
    }

    toJson(): string {
      return JSON.stringify({
        sample_rate: this.sampleRate,
        tempo_segments: this.tempoSegments.map((s) => ({ start_ppq: s.startPpq, bpm: s.bpm })),
        midi_content: Object.fromEntries(
          [...this.clips].map(([id, events]) => [String(id), events.map((e) => ({ ...e }))]),
        ),
      });
    }

    delete(): void {
      if (this.deleted) throw new Error('Project deleted twice');
      this.deleted = true;
    }
  }

  const scalePitchClassEnabled = (root: number, modeMask: number, pitchClass: number): boolean =>
    ((modeMask >> ((((pitchClass - root) % 12) + 12) % 12)) & 1) === 1;

  const fakeModule = {
    Project: FakeProject,
    scalePitchClassEnabled,
    init: async () => {},
  } as unknown as typeof import('@/wasm/index.js');

  return { ensureWasm: async () => fakeModule };
});

/** Returns the fake project's event list for the store's clip, via toJson. */
function clipEvents(clipId: number): Array<{ ppq: number; data0: number; data1: number }> {
  const doc = JSON.parse(getProject().toJson());
  return doc.midi_content[String(clipId)] ?? [];
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
      wasm.Project.midiNoteOn(1, 0, 2, 64, 100),
      wasm.Project.midiNoteOff(2.5, 0, 2, 64, 30),
      wasm.Project.midiNoteOn(0, 0, 0, 60, 80),
      wasm.Project.midiNoteOff(1, 0, 0, 60),
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

  it('quantizeSelection delegates to Project.snapToGrid on the beat grid', () => {
    const id = addNote({ pitch: 60, startPpq: 1.3, durationPpq: 1 });
    setSelection([id]);
    store.snapDivision = 4; // quarter-note grid = the project beat grid
    const spy = vi.spyOn(getProject(), 'snapToGrid');
    quantizeSelection();
    expect(spy).toHaveBeenCalledWith(1.3, 1);
    expect(store.notes[0].startPpq).toBe(1);
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
