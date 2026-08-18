import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import NoteGridCanvas from '@/components/piano-roll/NoteGridCanvas.vue';
import type { NoteInteractions } from '@/components/piano-roll/use-note-interactions';
import type { TheoryCard } from '@/compose/explain';
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

function mountGrid(noteId: number | null, noteCard?: (id: number) => TheoryCard | null) {
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
      ...(noteCard ? { noteCard } : {}),
    },
  });
}

describe('NoteGridCanvas', () => {
  it('exposes notes as virtual options with selection, edit, and context actions', async () => {
    wrapper = mountGrid(1);
    const navigator = wrapper.get('[role="listbox"]');
    expect(navigator.attributes('aria-label')).toBe('Piano-roll note navigator');
    expect(wrapper.get('[role="option"]').text()).toContain('C4');
    expect(wrapper.findAll('input[type="range"]')).toHaveLength(4);

    await navigator.trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('note-keyboard-action')?.[0]).toEqual([{ noteId: 1, kind: 'select' }]);
    await navigator.trigger('keydown', { key: 'ArrowRight', ctrlKey: true });
    expect(wrapper.emitted('note-keyboard-action')?.[1]?.[0]).toMatchObject({
      noteId: 1,
      kind: 'adjust',
      adjustment: { direction: 'right' },
    });
    await navigator.trigger('keydown', { key: 'F10', shiftKey: true });
    expect(wrapper.emitted('note-context')?.[0]?.[0]).toMatchObject({ noteId: 1, ppq: 1.5 });
  });

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

describe('NoteGridCanvas theory card', () => {
  function theoryCard(noteId: number): TheoryCard {
    return {
      title: `C4 #${noteId}`,
      lines: [
        {
          label: 'Role',
          text: 'Chord tone',
          term: { term: 'Chord tone', definition: 'A note belonging to the chord.' },
        },
      ],
    };
  }

  /** The card is teleported to the body, so it lives outside the wrapper. */
  function shownCard(): HTMLElement | null {
    return document.querySelector('.note-grid-theory-card');
  }

  function movePointerTo(x: number, y: number): void {
    wrapper
      ?.get('.note-grid')
      .element.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }),
      );
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the card where the hovered note was picked up', async () => {
    wrapper = mountGrid(1, theoryCard);

    movePointerTo(100, 200);
    await nextTick();
    const pinned = shownCard();
    expect(pinned?.textContent).toContain('C4 #1');
    const style = pinned?.getAttribute('style');

    movePointerTo(140, 260);
    await nextTick();

    expect(shownCard()?.getAttribute('style')).toBe(style);
  });

  it('dismisses the card shortly after the pointer leaves the grid', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wrapper = mountGrid(1, theoryCard);
    movePointerTo(100, 200);
    await nextTick();
    expect(shownCard()).not.toBeNull();

    await wrapper.get('.note-grid').trigger('pointerleave');
    expect(shownCard()).not.toBeNull();

    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(shownCard()).toBeNull();
  });

  it('keeps the card up while its glossary affordance holds the pointer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wrapper = mountGrid(1, theoryCard);
    movePointerTo(100, 200);
    await nextTick();

    // Reaching the affordance takes the pointer off the grid, which is exactly
    // the leave that used to dismiss the card before it could be clicked.
    const info = document.querySelector('.theory-card-info');
    info?.dispatchEvent(new PointerEvent('pointerenter'));
    await wrapper.get('.note-grid').trigger('pointerleave');
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(shownCard()).not.toBeNull();

    (info as HTMLElement).click();
    await nextTick();
    expect(shownCard()?.textContent).toContain('A note belonging to the chord.');

    info?.dispatchEvent(new PointerEvent('pointerleave'));
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(shownCard()).toBeNull();
  });
});
