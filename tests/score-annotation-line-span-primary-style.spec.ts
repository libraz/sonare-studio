import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scoreAnnotationLineSpans } from '@/project/annotations';
import { addNote, clearHistory, setNoteAnnotation } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('setNoteAnnotation addLineSpan primary style', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('keeps the style of a span that becomes the primary on a bare note', () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 67, startPpq: 1, durationPpq: 1 });

    setNoteAnnotation(store.clipId, a, {
      addLineSpan: {
        lineSpan: 'glissando',
        lineSpanToNoteId: b,
        glissandoLineType: 'wavy',
        glissandoText: ' gliss. ',
      },
    });

    const annotation = store.scoreAnnotations[store.clipId]?.[a];
    expect(annotation).toEqual({
      lineSpan: 'glissando',
      lineSpanToNoteId: b,
      glissandoLineType: 'wavy',
      glissandoText: 'gliss.',
    });
    expect(scoreAnnotationLineSpans(annotation ?? {})).toEqual([
      {
        lineSpan: 'glissando',
        lineSpanToNoteId: b,
        glissandoLineType: 'wavy',
        glissandoText: 'gliss.',
      },
    ]);
  });

  it('keeps an existing primary and its style when another span is added', () => {
    const a = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const b = addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    const c = addNote({ pitch: 67, startPpq: 2, durationPpq: 1 });

    setNoteAnnotation(store.clipId, a, {
      addLineSpan: { lineSpan: 'pedal', lineSpanToNoteId: b, pedalStyle: 'bracket' },
    });
    setNoteAnnotation(store.clipId, a, {
      addLineSpan: { lineSpan: 'glissando', lineSpanToNoteId: c, glissandoText: 'gliss.' },
    });

    expect(store.scoreAnnotations[store.clipId]?.[a]).toEqual({
      lineSpan: 'pedal',
      lineSpanToNoteId: b,
      pedalStyle: 'bracket',
      lineSpans: [{ lineSpan: 'glissando', lineSpanToNoteId: c, glissandoText: 'gliss.' }],
    });
  });
});
