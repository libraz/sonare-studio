import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppSettings } from '@/composables/useAppSettings';
import { useCompositionGuidance } from '@/composables/useCompositionGuidance';
import {
  addMidiClip,
  addNote,
  addTrack,
  clearHistory,
  setActiveClip,
  setClipLoop,
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
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 });
    const guidance = useCompositionGuidance();

    expect(guidance.guidanceSegments.value).toBeDefined();
    expect(guidance.guidanceSegments.value?.[0].endBeat).toBeGreaterThan(0);
    expect(guidance.noteCard.value?.(noteId)).not.toBeNull();
    expect(guidance.resolutionArrows.value).toEqual(expect.any(Array));
  });

  it('drops the background tint when the tint setting is off, keeping the cards', () => {
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 });
    const guidance = useCompositionGuidance();
    expect(guidance.guidanceSegments.value).toBeDefined();

    useAppSettings().set('pianoRollGuidanceTint', false);
    expect(guidance.guidanceSegments.value).toBeUndefined();
    expect(guidance.noteCard.value?.(noteId)).not.toBeNull();
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

    const card = useCompositionGuidance().noteCard.value?.(noteId);
    const counterpoint = card?.lines.find((line) => line.label === 'Counterpoint');
    expect(counterpoint?.text).toBe('perfect 5th above the bass (perfect consonance)');
  });
});
