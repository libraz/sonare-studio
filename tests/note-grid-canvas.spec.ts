import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  vi.mocked(painter.schedule).mockClear();
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
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
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

  it('repaints only the note layer when selection changes', async () => {
    wrapper = mountGrid(1);
    vi.mocked(painter.schedule).mockClear();

    await wrapper.setProps({ selection: new Set([1]) });

    const layers = vi.mocked(painter.schedule).mock.calls.map(([layer]) => layer);
    expect(layers.some((layer) => layer.startsWith('note-grid-notes-'))).toBe(true);
    expect(layers.some((layer) => layer.startsWith('note-grid-background-'))).toBe(false);
    expect(layers.some((layer) => layer.startsWith('note-grid-overlay-'))).toBe(false);
  });

  it('repaints the background when time signatures change', async () => {
    wrapper = mountGrid(1);
    vi.mocked(painter.schedule).mockClear();

    await wrapper.setProps({ timeSignatures: [{ startPpq: 0, numerator: 3, denominator: 4 }] });

    const layers = vi.mocked(painter.schedule).mock.calls.map(([layer]) => layer);
    expect(layers.some((layer) => layer.startsWith('note-grid-background-'))).toBe(true);
  });

  it('repaints the background when the time-signature origin changes', async () => {
    wrapper = mountGrid(1);
    vi.mocked(painter.schedule).mockClear();

    await wrapper.setProps({ timeSignatureOriginPpq: 8 });

    const layers = vi.mocked(painter.schedule).mock.calls.map(([layer]) => layer);
    expect(layers.some((layer) => layer.startsWith('note-grid-background-'))).toBe(true);
  });

  it('cancels the playhead polling frame on unmount', () => {
    wrapper = mountGrid(1);

    wrapper.unmount();
    wrapper = null;

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });
});
