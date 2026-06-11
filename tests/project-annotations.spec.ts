import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationsFromDocument, annotationsToDocument } from '@/project/annotations';
import {
  addNote,
  clearHistory,
  clearNoteAnnotation,
  deleteNotes,
  redo,
  setDisplayTranspose,
  setNoteAnnotation,
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

describe('score annotation commands', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('setNoteAnnotation stores an entry and is undoable', () => {
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(store.clipId, noteId, { dynamics: 'f' });
    expect(store.scoreAnnotations[store.clipId]).toEqual({ [noteId]: { dynamics: 'f' } });

    expect(undo()).toBe(true);
    expect(store.scoreAnnotations).toEqual({});
    expect(redo()).toBe(true);
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({ dynamics: 'f' });
    // The MIDI note itself is untouched by annotation edits.
    expect(store.notes.find((n) => n.id === noteId)).toMatchObject({ pitch: 60, startPpq: 0 });
  });

  it('merges field-wise updates and clears fields with null', () => {
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(store.clipId, noteId, { dynamics: 'mp' });
    setNoteAnnotation(store.clipId, noteId, { articulation: 'staccato' });
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({
      dynamics: 'mp',
      articulation: 'staccato',
    });

    setNoteAnnotation(store.clipId, noteId, { dynamics: null });
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({ articulation: 'staccato' });

    // Clearing the last field drops the entry (and the clip bucket) entirely.
    setNoteAnnotation(store.clipId, noteId, { articulation: null });
    expect(store.scoreAnnotations).toEqual({});
  });

  it('stores slurs between notes of the same clip', () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    setNoteAnnotation(store.clipId, a, { slurToNoteId: b });
    expect(store.scoreAnnotations[store.clipId]?.[a]).toEqual({ slurToNoteId: b });
  });

  it('validates inputs', () => {
    const a = addNote({ pitch: 60, startPpq: 1, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 0, durationPpq: 1 });
    expect(() => setNoteAnnotation(9999, a, { dynamics: 'f' })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, 9999, { dynamics: 'f' })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { dynamics: 'fff' as unknown as 'f' })).toThrow(
      RangeError,
    );
    expect(() =>
      setNoteAnnotation(store.clipId, a, { articulation: 'spiccato' as unknown as 'accent' }),
    ).toThrow(RangeError);
    // Slur targets must exist and start strictly after the source.
    expect(() => setNoteAnnotation(store.clipId, a, { slurToNoteId: 9999 })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { slurToNoteId: a })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { slurToNoteId: b })).toThrow(RangeError);
  });

  it('clearNoteAnnotation removes the whole entry and is undoable', () => {
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(store.clipId, noteId, { dynamics: 'ff', articulation: 'tenuto' });
    clearNoteAnnotation(store.clipId, noteId);
    expect(store.scoreAnnotations).toEqual({});

    expect(undo()).toBe(true);
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({
      dynamics: 'ff',
      articulation: 'tenuto',
    });
  });

  it('clearNoteAnnotation is a no-op without an entry (no history)', () => {
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    expect(undo()).toBe(true); // Undo the note add.
    clearHistory();
    clearNoteAnnotation(store.clipId, noteId);
    expect(undo()).toBe(false);
  });

  it('keeps annotations of deleted notes as undo-restorable orphans', () => {
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(store.clipId, noteId, { dynamics: 'p' });
    deleteNotes([noteId]);
    // The entry survives (display pipelines ignore orphans) so undo restores
    // the note together with its annotation.
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({ dynamics: 'p' });
    expect(undo()).toBe(true);
    expect(store.notes.some((n) => n.id === noteId)).toBe(true);
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({ dynamics: 'p' });
  });

  it('setDisplayTranspose validates, applies and undoes', () => {
    expect(() => setDisplayTranspose(13)).toThrow(RangeError);
    expect(() => setDisplayTranspose(-13)).toThrow(RangeError);
    expect(() => setDisplayTranspose(0.5)).toThrow(RangeError);
    setDisplayTranspose(-12);
    expect(store.displayTransposeSemitones).toBe(-12);
    expect(undo()).toBe(true);
    expect(store.displayTransposeSemitones).toBe(0);
    expect(redo()).toBe(true);
    expect(store.displayTransposeSemitones).toBe(-12);
  });
});

describe('score annotation serialization', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('serializes annotations content-addressed and round-trips through load', async () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 1.5, durationPpq: 0.5, channel: 2 });
    setNoteAnnotation(store.clipId, a, { dynamics: 'mf', articulation: 'accent', slurToNoteId: b });
    setNoteAnnotation(store.clipId, b, { articulation: 'staccato' });
    setDisplayTranspose(12);

    const doc = serializeProject();
    expect(doc.tracks[0].clips[0].scoreAnnotations).toEqual([
      {
        pitch: 60,
        startPpq: 0,
        channel: 0,
        dynamics: 'mf',
        articulation: 'accent',
        slurTo: { pitch: 64, startPpq: 1.5, channel: 2 },
      },
      { pitch: 64, startPpq: 1.5, channel: 2, articulation: 'staccato' },
    ]);
    expect(doc.score).toEqual({ displayTransposeSemitones: 12 });

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    // Fresh editor ids: re-associate by note content.
    const loadedA = store.notes.find((n) => n.pitch === 60);
    const loadedB = store.notes.find((n) => n.pitch === 64);
    expect(loadedA).toBeDefined();
    expect(loadedB).toBeDefined();
    const annotations = store.scoreAnnotations[store.clipId];
    expect(annotations?.[(loadedA as { id: number }).id]).toEqual({
      dynamics: 'mf',
      articulation: 'accent',
      slurToNoteId: (loadedB as { id: number }).id,
    });
    expect(annotations?.[(loadedB as { id: number }).id]).toEqual({ articulation: 'staccato' });
    expect(store.displayTransposeSemitones).toBe(12);

    // Re-serializing yields the same document (annotation order is content-sorted).
    expect(serializeProject()).toEqual(doc);
  });

  it('omits annotation fields entirely when nothing is annotated', () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const doc = serializeProject();
    expect(doc.tracks[0].clips[0].scoreAnnotations).toBeUndefined();
    expect(doc.score).toBeUndefined();
  });

  it('drops orphaned annotations (deleted notes) from the document', () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    setNoteAnnotation(store.clipId, a, { dynamics: 'f', slurToNoteId: b });
    setNoteAnnotation(store.clipId, b, { dynamics: 'p' });
    deleteNotes([b]);
    const doc = serializeProject();
    // b's annotation drops with the note; a keeps its dynamics but the slur
    // (whose target is gone) drops too.
    expect(doc.tracks[0].clips[0].scoreAnnotations).toEqual([
      { pitch: 60, startPpq: 0, channel: 0, dynamics: 'f' },
    ]);
  });

  it('loading ignores document annotations matching no note', async () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(store.clipId, a, { dynamics: 'f' });
    const doc = serializeProject();
    const clip = doc.tracks[0].clips[0];
    clip.scoreAnnotations = [
      ...(clip.scoreAnnotations ?? []),
      { pitch: 99, startPpq: 7, channel: 5, dynamics: 'pp' },
    ];
    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    const entries = Object.values(store.scoreAnnotations[store.clipId] ?? {});
    expect(entries).toEqual([{ dynamics: 'f' }]);
  });
});

describe('annotation document converters', () => {
  const notes = [
    { id: 10, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
    { id: 20, pitch: 64, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 },
  ];

  it('annotationsToDocument skips entries that lose every field', () => {
    // A slur whose target was deleted leaves no payload behind.
    const entries = annotationsToDocument({ 10: { slurToNoteId: 999 } }, notes);
    expect(entries).toEqual([]);
  });

  it('annotationsFromDocument drops self-referential slurs', () => {
    const restored = annotationsFromDocument(
      [
        {
          pitch: 60,
          startPpq: 0,
          channel: 0,
          dynamics: 'f',
          slurTo: { pitch: 60, startPpq: 0, channel: 0 },
        },
      ],
      notes,
    );
    expect(restored).toEqual({ 10: { dynamics: 'f' } });
  });
});
