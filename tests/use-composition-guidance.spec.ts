import { NoteSafety } from '@libraz/libcantus';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useCompositionGuidance } from '@/composables/useCompositionGuidance';
import {
  addMidiClip,
  addNote,
  addTrack,
  clearHistory,
  clearProjectChords,
  setActiveClip,
  setClipLoop,
  setProjectChords,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('useCompositionGuidance', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    useAppSettings().reset();
  });

  it('derives a grid segment and a theory-card resolver from the active clip', () => {
    setProjectChords([{ startPpq: 0, endPpq: 32, rootPc: 0, quality: 0 }]);
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 });
    const guidance = useCompositionGuidance();

    expect(guidance.guidanceSegments.value).toBeDefined();
    expect(guidance.guidanceSegments.value?.[0].endBeat).toBeGreaterThan(0);
    expect(guidance.noteCard.value?.(noteId)).not.toBeNull();
    expect(guidance.resolutionArrows.value).toEqual(expect.any(Array));
  });

  it('drops the background tint when the tint setting is off, keeping the cards', () => {
    setProjectChords([{ startPpq: 0, endPpq: 32, rootPc: 0, quality: 0 }]);
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 });
    const guidance = useCompositionGuidance();
    expect(guidance.guidanceSegments.value).toBeDefined();

    useAppSettings().set('pianoRollGuidanceTint', false);
    expect(guidance.guidanceSegments.value).toBeUndefined();
    expect(guidance.noteCard.value?.(noteId)).not.toBeNull();
  });

  it('skips the expensive guidance pass while its editor surface is hidden', () => {
    setProjectChords([{ startPpq: 0, endPpq: 8, rootPc: 0, quality: 0 }]);
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 });
    const enabled = ref(false);
    const guidance = useCompositionGuidance({ enabled: () => enabled.value });

    expect(guidance.noteCard.value).toBeUndefined();
    expect(guidance.guidanceSegments.value).toBeUndefined();

    enabled.value = true;
    expect(guidance.noteCard.value?.(noteId)).not.toBeNull();
  });

  it('does not paint a green background when no chord covers the clip', () => {
    clearProjectChords();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 });

    const guidance = useCompositionGuidance();

    expect(guidance.guidanceSegments.value).toBeUndefined();
    expect(guidance.noteSafety.value.size).toBe(0);
  });

  it('keeps percussion tracks out of harmonic tint, cards, and arrows', () => {
    const store = useProjectStore();
    const drumTrack = addTrack({ name: 'Drums' });
    const drumClip = addMidiClip({ trackId: drumTrack, startPpq: 0, lengthPpq: 8 });
    setActiveClip(drumClip);
    const noteId = addNote({ pitch: 36, startPpq: 0, durationPpq: 1, velocity: 96 });

    const guidance = useCompositionGuidance();

    expect(store.activeTrack?.name).toBe('Drums');
    expect(guidance.guidanceSegments.value).toBeUndefined();
    expect(guidance.noteCard.value).toBeUndefined();
    expect(guidance.resolutionArrows.value).toBeUndefined();
    expect(guidance.unresolvedNoteIds.value.has(noteId)).toBe(false);
    expect(guidance.noteSafety.value.size).toBe(0);
  });

  it('updates existing-note harmonic severity after a secondary-dominant edit', () => {
    const noteId = addNote({ pitch: 66, startPpq: 0, durationPpq: 1, velocity: 96 });
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 2, quality: 4 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
    ]);
    const guidance = useCompositionGuidance();
    const beforeResolver = guidance.noteCard.value;

    expect(guidance.noteSafety.value.get(noteId)).toBeUndefined();

    setProjectChords([{ startPpq: 0, endPpq: 8, rootPc: 0, quality: 0 }]);

    expect(guidance.noteCard.value).not.toBe(beforeResolver);
    expect(guidance.noteSafety.value.get(noteId)).toBe(NoteSafety.Dissonant);
  });

  it('uses applied Roman numerals in the theory card', () => {
    const noteId = addNote({ pitch: 66, startPpq: 0, durationPpq: 1, velocity: 96 });
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 2, quality: 4 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
    ]);

    const card = useCompositionGuidance().noteCard.value?.(noteId);
    expect(card?.lines.some((line) => line.text.includes('V7/V'))).toBe(true);
  });

  it('keeps a held note warning reactive through chord edits and undo', () => {
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 8, velocity: 96 });
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
    ]);
    const guidance = useCompositionGuidance();

    expect(guidance.noteSafety.value.get(noteId)).toBe(NoteSafety.Warning);
    expect(
      guidance.noteCard.value?.(noteId)?.lines.some((line) => line.text.includes('bar 2, beat 1')),
    ).toBe(true);

    setProjectChords([{ startPpq: 0, endPpq: 8, rootPc: 0, quality: 0 }]);
    expect(guidance.noteSafety.value.get(noteId)).toBeUndefined();

    expect(undo()).toBe(true);
    expect(guidance.noteSafety.value.get(noteId)).toBe(NoteSafety.Warning);
  });

  it('keeps an onset dissonance red when a later boundary is only a warning', () => {
    const noteId = addNote({ pitch: 66, startPpq: 0, durationPpq: 8, velocity: 96 });
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
    ]);

    expect(useCompositionGuidance().noteSafety.value.get(noteId)).toBe(NoteSafety.Dissonant);
  });

  it('aggregates a looped source note against chords in later occurrences', () => {
    const store = useProjectStore();
    const clipId = store.activeClip?.id;
    if (clipId === undefined) throw new Error('no active clip');
    setClipLoop(clipId, true, 4);
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 });
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 11, quality: 0 },
    ]);

    const guidance = useCompositionGuidance();
    expect(guidance.noteSafety.value.get(noteId)).toBe(NoteSafety.Dissonant);
    // The resolver still describes the source note's first onset in the editor.
    expect(guidance.noteCard.value?.(noteId)?.title.startsWith('C4')).toBe(true);
  });

  it('reads other tracks through every repeat of a looping clip', () => {
    const store = useProjectStore();
    const melodyClipId = store.activeClip?.id;
    if (melodyClipId === undefined) throw new Error('no active clip');
    const bassTrack = addTrack({ name: 'Low' });
    const bassClip = addMidiClip({ trackId: bassTrack, startPpq: 0, lengthPpq: 8 });
    setActiveClip(bassClip);
    addNote({ pitch: 55, startPpq: 0, durationPpq: 2, velocity: 96 });
    setClipLoop(bassClip, true, 2);
    setActiveClip(melodyClipId);
    // Beat 4 is heard only through the third repeat of the loop.
    const noteId = addNote({ pitch: 62, startPpq: 4, durationPpq: 1, velocity: 96 });

    useAppSettings().set('explainLevel', 'normal');
    const card = useCompositionGuidance().noteCard.value?.(noteId);
    const counterpoint = card?.lines.find((line) => line.label === 'Counterpoint');
    expect(counterpoint?.text).toBe('perfect 5th above the bass (perfect consonance)');
  });
});
