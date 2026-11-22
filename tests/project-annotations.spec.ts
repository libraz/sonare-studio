import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationsFromDocument, annotationsToDocument } from '@/project/annotations';
import {
  addMidiClip,
  addNote,
  clearHistory,
  clearNoteAnnotation,
  deleteNotes,
  duplicateClip,
  glueMidiClips,
  ornamentClipNotes,
  redo,
  setActiveClip,
  setClipLoop,
  setDisplayTranspose,
  setNoteAnnotation,
  splitClip,
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
    setNoteAnnotation(store.clipId, noteId, { ornament: 'trill' });
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({
      dynamics: 'mp',
      articulation: 'staccato',
      ornament: 'trill',
    });

    setNoteAnnotation(store.clipId, noteId, { dynamics: null });
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({
      articulation: 'staccato',
      ornament: 'trill',
    });

    setNoteAnnotation(store.clipId, noteId, { articulation: null });
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({ ornament: 'trill' });

    // Clearing the last field drops the entry (and the clip bucket) entirely.
    setNoteAnnotation(store.clipId, noteId, { ornament: null });
    expect(store.scoreAnnotations).toEqual({});
  });

  it('stores and clears explicit grand-staff overrides', () => {
    const noteId = addNote({ pitch: 55, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(store.clipId, noteId, { staffOverride: 1 });
    expect(store.scoreAnnotations[store.clipId]?.[noteId]).toEqual({ staffOverride: 1 });

    setNoteAnnotation(store.clipId, noteId, { staffOverride: null });
    expect(store.scoreAnnotations).toEqual({});
  });

  it('stores slurs between notes of the same clip', () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    setNoteAnnotation(store.clipId, a, { slurToNoteId: b });
    expect(store.scoreAnnotations[store.clipId]?.[a]).toEqual({ slurToNoteId: b });
  });

  it('stores hairpins between notes of the same clip', () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    setNoteAnnotation(store.clipId, a, { hairpin: 'crescendo', hairpinToNoteId: b });
    expect(store.scoreAnnotations[store.clipId]?.[a]).toEqual({
      hairpin: 'crescendo',
      hairpinToNoteId: b,
    });
    setNoteAnnotation(store.clipId, a, { hairpin: null });
    expect(store.scoreAnnotations).toEqual({});
  });

  it('stores line spans between notes of the same clip', () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    setNoteAnnotation(store.clipId, a, { lineSpan: 'ottava-15-up', lineSpanToNoteId: b });
    expect(store.scoreAnnotations[store.clipId]?.[a]).toEqual({
      lineSpan: 'ottava-15-up',
      lineSpanToNoteId: b,
    });
    setNoteAnnotation(store.clipId, a, { lineSpan: null });
    expect(store.scoreAnnotations).toEqual({});
  });

  it('stores multiple simultaneous line spans from one note', () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    const c = addNote({ pitch: 67, startPpq: 2, durationPpq: 1 });

    setNoteAnnotation(store.clipId, a, {
      addLineSpan: { lineSpan: 'ottava-up', lineSpanToNoteId: b },
    });
    setNoteAnnotation(store.clipId, a, {
      addLineSpan: { lineSpan: 'glissando', lineSpanToNoteId: c },
    });

    expect(store.scoreAnnotations[store.clipId]?.[a]).toEqual({
      lineSpan: 'ottava-up',
      lineSpanToNoteId: b,
      lineSpans: [{ lineSpan: 'glissando', lineSpanToNoteId: c }],
    });
    setNoteAnnotation(store.clipId, a, { lineSpan: null });
    expect(store.scoreAnnotations).toEqual({});
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
    expect(() =>
      setNoteAnnotation(store.clipId, a, { ornament: 'shake' as unknown as 'trill' }),
    ).toThrow(RangeError);
    expect(() =>
      setNoteAnnotation(store.clipId, a, { hairpin: 'swell' as unknown as 'crescendo' }),
    ).toThrow(RangeError);
    expect(() =>
      setNoteAnnotation(store.clipId, a, { lineSpan: 'slide' as unknown as 'glissando' }),
    ).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { staffOverride: 3 as 1 })).toThrow(RangeError);
    // Slur targets must exist and start strictly after the source.
    expect(() => setNoteAnnotation(store.clipId, a, { slurToNoteId: 9999 })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { slurToNoteId: a })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { slurToNoteId: b })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { hairpinToNoteId: 9999 })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { hairpinToNoteId: a })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { hairpinToNoteId: b })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { lineSpanToNoteId: 9999 })).toThrow(
      RangeError,
    );
    expect(() => setNoteAnnotation(store.clipId, a, { lineSpanToNoteId: a })).toThrow(RangeError);
    expect(() => setNoteAnnotation(store.clipId, a, { lineSpanToNoteId: b })).toThrow(RangeError);
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

  /**
   * The decoration pass writes a reading of the passage: many notes, one edit,
   * and nothing but annotations, so the notes it marks play back exactly as
   * before until a track carries an expression map.
   */
  it('ornamentClipNotes marks a run of notes as one undoable edit', () => {
    const ids: number[] = [];
    for (let index = 0; index < 16; index += 1) {
      ids.push(addNote({ pitch: 48 + (index % 4), startPpq: index * 0.5, durationPpq: 0.5 }));
    }
    const before = store.notes.map((note) => ({ ...note }));

    const marked = ornamentClipNotes(store.clipId, { mark: 'ghost', amount: 1 });
    expect(marked).toBeGreaterThan(0);
    const entries = store.scoreAnnotations[store.clipId] ?? {};
    expect(Object.keys(entries)).toHaveLength(marked);
    for (const [noteId, annotation] of Object.entries(entries)) {
      expect(annotation).toEqual({ articulation: 'ghost' });
      expect(ids).toContain(Number(noteId));
    }
    // Notes, onsets and durations are untouched: only the reading was added.
    expect(store.notes.map((note) => ({ ...note }))).toEqual(before);

    expect(undo()).toBe(true);
    expect(store.scoreAnnotations).toEqual({});
    expect(redo()).toBe(true);
    expect(Object.keys(store.scoreAnnotations[store.clipId] ?? {})).toHaveLength(marked);
  });

  it('ornamentClipNotes keeps a mark made by hand and reports when it writes none', () => {
    const ids: number[] = [];
    for (let index = 0; index < 16; index += 1) {
      ids.push(addNote({ pitch: 48 + (index % 4), startPpq: index * 0.5, durationPpq: 0.5 }));
    }
    const written = ornamentClipNotes(store.clipId, { mark: 'ghost', amount: 1 });
    const first = Number(Object.keys(store.scoreAnnotations[store.clipId] ?? {})[0]);
    setNoteAnnotation(store.clipId, first, { articulation: 'marcato' });

    // Re-running the same pass finds every eligible note already marked.
    expect(ornamentClipNotes(store.clipId, { mark: 'ghost', amount: 1 })).toBe(0);
    expect(store.scoreAnnotations[store.clipId]?.[first]).toEqual({ articulation: 'marcato' });
    expect(Object.keys(store.scoreAnnotations[store.clipId] ?? {})).toHaveLength(written);
  });

  it('ornamentClipNotes reports nothing when the technique has no position to sit on', () => {
    for (let index = 0; index < 4; index += 1) {
      addNote({ pitch: 60, startPpq: index * 4, durationPpq: 4 });
    }
    expect(ornamentClipNotes(store.clipId, { mark: 'ghost', amount: 1 })).toBe(0);
    expect(store.scoreAnnotations).toEqual({});
    expect(() => ornamentClipNotes(-1, { mark: 'ghost', amount: 1 })).toThrow(RangeError);
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
    const c = addNote({ pitch: 67, startPpq: 2, durationPpq: 0.5, channel: 2 });
    setNoteAnnotation(store.clipId, a, {
      dynamics: 'mf',
      articulation: 'accent',
      ornament: 'trill',
      staffOverride: 1,
      slurToNoteId: b,
      hairpin: 'crescendo',
      hairpinToNoteId: b,
      lineSpan: 'ottava-15-down',
      lineSpanToNoteId: b,
    });
    setNoteAnnotation(store.clipId, a, {
      addLineSpan: {
        lineSpan: 'glissando',
        lineSpanToNoteId: c,
        glissandoLineType: 'wavy',
        glissandoText: 'slide up',
      },
    });
    setNoteAnnotation(store.clipId, b, { articulation: 'staccato', ornament: 'fermata' });
    setDisplayTranspose(12);

    const doc = serializeProject();
    expect(doc.tracks[0].clips[0].scoreAnnotations).toEqual([
      {
        pitch: 60,
        startPpq: 0,
        channel: 0,
        dynamics: 'mf',
        articulation: 'accent',
        ornament: 'trill',
        staffOverride: 1,
        slurTo: { pitch: 64, startPpq: 1.5, channel: 2 },
        hairpin: 'crescendo',
        hairpinTo: { pitch: 64, startPpq: 1.5, channel: 2 },
        lineSpan: 'ottava-15-down',
        lineSpanTo: { pitch: 64, startPpq: 1.5, channel: 2 },
        lineSpans: [
          {
            lineSpan: 'glissando',
            lineSpanTo: { pitch: 67, startPpq: 2, channel: 2 },
            glissandoLineType: 'wavy',
            glissandoText: 'slide up',
          },
        ],
      },
      { pitch: 64, startPpq: 1.5, channel: 2, articulation: 'staccato', ornament: 'fermata' },
    ]);
    expect(doc.score).toEqual({ displayTransposeSemitones: 12 });

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    // Fresh editor ids: re-associate by note content.
    const loadedA = store.notes.find((n) => n.pitch === 60);
    const loadedB = store.notes.find((n) => n.pitch === 64);
    const loadedC = store.notes.find((n) => n.pitch === 67);
    expect(loadedA).toBeDefined();
    expect(loadedB).toBeDefined();
    expect(loadedC).toBeDefined();
    const annotations = store.scoreAnnotations[store.clipId];
    expect(annotations?.[(loadedA as { id: number }).id]).toEqual({
      dynamics: 'mf',
      articulation: 'accent',
      ornament: 'trill',
      staffOverride: 1,
      slurToNoteId: (loadedB as { id: number }).id,
      hairpin: 'crescendo',
      hairpinToNoteId: (loadedB as { id: number }).id,
      lineSpan: 'ottava-15-down',
      lineSpanToNoteId: (loadedB as { id: number }).id,
      lineSpans: [
        {
          lineSpan: 'glissando',
          lineSpanToNoteId: (loadedC as { id: number }).id,
          glissandoLineType: 'wavy',
          glissandoText: 'slide up',
        },
      ],
    });
    expect(annotations?.[(loadedB as { id: number }).id]).toEqual({
      articulation: 'staccato',
      ornament: 'fermata',
    });
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

  it('round-trips score toolbar, page layout and display settings', async () => {
    store.scoreDisplaySettings = {
      displayQuantizeKey: '8t',
      chordsEnabled: true,
      fullScoreEnabled: true,
      estimateFingering: true,
      pageFormat: 'letter',
      landscape: true,
      pageMarginMm: 18,
      scalePercent: 70,
      spacingStaff: 20,
      barsPerSystem: 3,
      barsPerPage: 12,
      grandStaffSplitPitch: 55,
      viewZoom: 1.44,
    };

    const doc = serializeProject();
    expect(doc.score).toEqual(store.scoreDisplaySettings);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.scoreDisplaySettings).toEqual({
      displayQuantizeKey: '8t',
      chordsEnabled: true,
      fullScoreEnabled: true,
      estimateFingering: true,
      pageFormat: 'letter',
      landscape: true,
      pageMarginMm: 18,
      scalePercent: 70,
      spacingStaff: 20,
      barsPerSystem: 3,
      barsPerPage: 12,
      grandStaffSplitPitch: 55,
      viewZoom: 1.44,
    });
    expect(serializeProject()).toEqual(doc);
  });

  it('accepts the 64th-note display quantize key when loading a document', async () => {
    const doc = serializeProject();
    doc.score = { displayQuantizeKey: '64' };

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);

    expect(store.scoreDisplaySettings.displayQuantizeKey).toBe('64');
    expect(serializeProject().score?.displayQuantizeKey).toBe('64');
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

  it('duplicateClip transfers duplicate-note ordinals and every span endpoint through save/load', async () => {
    const sourceId = store.clipId;
    const first = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 80 });
    const second = addNote({ pitch: 60, startPpq: 0, durationPpq: 2, velocity: 100 });
    const target = addNote({ pitch: 67, startPpq: 2, durationPpq: 1 });
    setNoteAnnotation(sourceId, first, { dynamics: 'p' });
    setNoteAnnotation(sourceId, second, {
      dynamics: 'f',
      slurToNoteId: target,
      hairpin: 'crescendo',
      hairpinToNoteId: target,
      lineSpan: 'glissando',
      lineSpanToNoteId: target,
      glissandoText: 'port.',
      addLineSpan: { lineSpan: 'ottava-up', lineSpanToNoteId: target },
    });

    const copyId = duplicateClip(sourceId, 8);
    const copy = store.clips.find((clip) => clip.id === copyId);
    expect(copy).toBeDefined();
    const [copyFirst, copySecond, copyTarget] = copy?.notes ?? [];
    expect(store.scoreAnnotations[copyId]).toEqual({
      [copyFirst.id]: { dynamics: 'p' },
      [copySecond.id]: {
        dynamics: 'f',
        slurToNoteId: copyTarget.id,
        hairpin: 'crescendo',
        hairpinToNoteId: copyTarget.id,
        lineSpan: 'glissando',
        lineSpanToNoteId: copyTarget.id,
        glissandoText: 'port.',
        lineSpans: [{ lineSpan: 'ottava-up', lineSpanToNoteId: copyTarget.id }],
      },
    });

    expect(undo()).toBe(true);
    expect(store.scoreAnnotations[copyId]).toBeUndefined();
    expect(redo()).toBe(true);
    const redone = store.clips.find((clip) => clip.id === copyId);
    expect(Object.keys(store.scoreAnnotations[copyId] ?? {})).toHaveLength(2);
    expect(redone?.notes).toHaveLength(3);

    const document = serializeProject();
    await loadProjectDocument(JSON.parse(JSON.stringify(document)) as ProjectDocument);
    const loadedCopy = store.clips.find((clip) => clip.startPpq === 8);
    if (!loadedCopy) throw new Error('the copied clip did not load');
    const [loadedFirst, loadedSecond, loadedTarget] = loadedCopy.notes;
    expect(store.scoreAnnotations[loadedCopy.id]).toEqual({
      [loadedFirst.id]: { dynamics: 'p' },
      [loadedSecond.id]: {
        dynamics: 'f',
        slurToNoteId: loadedTarget.id,
        hairpin: 'crescendo',
        hairpinToNoteId: loadedTarget.id,
        lineSpan: 'glissando',
        lineSpanToNoteId: loadedTarget.id,
        glissandoText: 'port.',
        lineSpans: [{ lineSpan: 'ottava-up', lineSpanToNoteId: loadedTarget.id }],
      },
    });
  });

  it('splitClip partitions annotations, preserves ordinals, and removes cross-boundary spans', () => {
    const sourceId = store.clipId;
    const leftFirst = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 80 });
    const leftSecond = addNote({ pitch: 60, startPpq: 0, durationPpq: 1.5, velocity: 100 });
    const rightFirst = addNote({ pitch: 64, startPpq: 3, durationPpq: 1 });
    const rightTarget = addNote({ pitch: 67, startPpq: 4, durationPpq: 1 });
    setNoteAnnotation(sourceId, leftFirst, { dynamics: 'p' });
    setNoteAnnotation(sourceId, leftSecond, {
      dynamics: 'mf',
      slurToNoteId: rightFirst,
      hairpin: 'crescendo',
      hairpinToNoteId: rightFirst,
      lineSpan: 'glissando',
      lineSpanToNoteId: rightFirst,
    });
    setNoteAnnotation(sourceId, rightFirst, {
      dynamics: 'f',
      slurToNoteId: rightTarget,
      lineSpan: 'glissando',
      lineSpanToNoteId: rightTarget,
      addLineSpan: { lineSpan: 'pedal', lineSpanToNoteId: rightTarget },
    });

    const rightId = splitClip(sourceId, 2);
    const left = store.clips.find((clip) => clip.id === sourceId);
    const right = store.clips.find((clip) => clip.id === rightId);
    const [newLeftFirst, newLeftSecond] = left?.notes ?? [];
    const [newRightFirst, newRightTarget] = right?.notes ?? [];
    expect(store.scoreAnnotations[sourceId]).toEqual({
      [newLeftFirst.id]: { dynamics: 'p' },
      [newLeftSecond.id]: { dynamics: 'mf' },
    });
    expect(store.scoreAnnotations[rightId]).toEqual({
      [newRightFirst.id]: {
        dynamics: 'f',
        slurToNoteId: newRightTarget.id,
        lineSpan: 'glissando',
        lineSpanToNoteId: newRightTarget.id,
        lineSpans: [{ lineSpan: 'pedal', lineSpanToNoteId: newRightTarget.id }],
      },
    });

    expect(undo()).toBe(true);
    expect(store.scoreAnnotations[rightId]).toBeUndefined();
    expect(store.scoreAnnotations[sourceId]?.[leftSecond]).toMatchObject({
      dynamics: 'mf',
      slurToNoteId: rightFirst,
      hairpinToNoteId: rightFirst,
      lineSpanToNoteId: rightFirst,
    });
    expect(redo()).toBe(true);
    expect(Object.keys(store.scoreAnnotations[sourceId] ?? {})).toHaveLength(2);
    expect(Object.keys(store.scoreAnnotations[rightId] ?? {})).toHaveLength(1);
  });

  it('glueMidiClips transfers annotations to every audible loop occurrence and removes old keys', () => {
    const trackId = store.tracks[0].id;
    const loopId = store.clipId;
    trimClip(loopId, 0, 5);
    const start = addNote({ pitch: 60, startPpq: 0, durationPpq: 0.5 });
    const end = addNote({ pitch: 62, startPpq: 1, durationPpq: 0.5 });
    setNoteAnnotation(loopId, start, {
      dynamics: 'mp',
      slurToNoteId: end,
      hairpin: 'crescendo',
      hairpinToNoteId: end,
      lineSpan: 'glissando',
      lineSpanToNoteId: end,
    });
    setNoteAnnotation(loopId, end, { articulation: 'accent' });
    setClipLoop(loopId, true, 2);

    const tailId = addMidiClip({ trackId, startPpq: 5, lengthPpq: 1 });
    setActiveClip(tailId);
    const tail = addNote({ pitch: 67, startPpq: 0.25, durationPpq: 0.5 });
    setNoteAnnotation(tailId, tail, { dynamics: 'ff' });

    const joinedId = glueMidiClips([tailId, loopId]);
    const joined = store.clips.find((clip) => clip.id === joinedId);
    expect(store.scoreAnnotations[loopId]).toBeUndefined();
    expect(store.scoreAnnotations[tailId]).toBeUndefined();
    const annotationAt = (startPpq: number) => {
      const note = joined?.notes.find((entry) => entry.startPpq === startPpq);
      return note ? store.scoreAnnotations[joinedId]?.[note.id] : undefined;
    };
    for (const offset of [0, 2]) {
      const targetNote = joined?.notes.find((note) => note.startPpq === offset + 1);
      expect(annotationAt(offset)).toEqual({
        dynamics: 'mp',
        slurToNoteId: targetNote?.id,
        hairpin: 'crescendo',
        hairpinToNoteId: targetNote?.id,
        lineSpan: 'glissando',
        lineSpanToNoteId: targetNote?.id,
      });
      expect(annotationAt(offset + 1)).toEqual({ articulation: 'accent' });
    }
    // The final partial loop contains the start note but not its endpoint.
    expect(annotationAt(4)).toEqual({ dynamics: 'mp' });
    expect(annotationAt(5.25)).toEqual({ dynamics: 'ff' });

    expect(undo()).toBe(true);
    expect(store.scoreAnnotations[joinedId]).toBeUndefined();
    expect(store.scoreAnnotations[loopId]?.[start]).toMatchObject({ slurToNoteId: end });
    expect(store.scoreAnnotations[tailId]?.[tail]).toEqual({ dynamics: 'ff' });
    expect(redo()).toBe(true);
    expect(store.scoreAnnotations[loopId]).toBeUndefined();
    expect(Object.keys(store.scoreAnnotations[joinedId] ?? {})).toHaveLength(6);
  });
});

describe('annotation document converters', () => {
  const notes = [
    { id: 10, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
    { id: 20, pitch: 64, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 },
  ];

  it('annotationsToDocument skips entries that lose every field', () => {
    // A slur whose target was deleted leaves no payload behind.
    const entries = annotationsToDocument(
      {
        10: {
          slurToNoteId: 999,
          hairpin: 'crescendo',
          hairpinToNoteId: 999,
          lineSpan: 'glissando',
          lineSpanToNoteId: 999,
        },
      },
      notes,
    );
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

  it('uses a persisted ordinal to keep identical unison annotations distinct', () => {
    const unison = [
      { id: 10, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
      { id: 11, pitch: 60, velocity: 72, startPpq: 0, durationPpq: 2, channel: 0 },
    ];
    const document = annotationsToDocument(
      {
        10: { dynamics: 'p' },
        11: { articulation: 'accent' },
      },
      unison,
    );
    expect(document).toEqual([
      { pitch: 60, startPpq: 0, channel: 0, dynamics: 'p' },
      { pitch: 60, startPpq: 0, channel: 0, ordinal: 1, articulation: 'accent' },
    ]);

    expect(
      annotationsFromDocument(document, [
        { ...unison[0], id: 101 },
        { ...unison[1], id: 102 },
      ]),
    ).toEqual({
      101: { dynamics: 'p' },
      102: { articulation: 'accent' },
    });
  });
});
