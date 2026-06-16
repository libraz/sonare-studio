import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import NoteGridCanvas from '@/components/piano-roll/NoteGridCanvas.vue';
import type { NoteInteractions } from '@/components/piano-roll/use-note-interactions';
import type { EditorNote } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

function makeNote(over: Partial<EditorNote> = {}): EditorNote {
  return {
    id: 1,
    pitch: 60,
    velocity: 96,
    startPpq: 1,
    durationPpq: 1,
    channel: 0,
    ...over,
  };
}

function makeInteractions(noteId: number | null): NoteInteractions {
  return {
    marquee: ref(null),
    previewNotes: ref(null),
    cursor: ref('default'),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onDoubleClick: vi.fn(),
    hitNoteAt: vi.fn(() => noteId),
    onKeyDown: vi.fn(() => false),
    cancel: vi.fn(),
  };
}

const painter: Painter = {
  schedule: vi.fn(),
  dispose: vi.fn(),
};

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

function mountGrid(noteId: number | null) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());

  return mount(NoteGridCanvas, {
    props: {
      range: new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight: 10 }),
      revision: 0,
      painter,
      notes: [makeNote()],
      selection: new Set(),
      highlightedPitchClasses: Array.from({ length: 12 }, () => false),
      gridPpq: 0.25,
      clipLengthPpq: 16,
      interactions: makeInteractions(noteId),
    },
  });
}

describe('NoteGridCanvas', () => {
  it('emits note-context and suppresses the native menu on right-click', async () => {
    wrapper = mountGrid(1);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY: 675,
    });

    wrapper.find('.note-grid').element.dispatchEvent(event);
    await wrapper.vm.$nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.emitted('note-context')).toEqual([[{ x: 150, y: 675, noteId: 1, ppq: 1.5 }]]);
  });
});
