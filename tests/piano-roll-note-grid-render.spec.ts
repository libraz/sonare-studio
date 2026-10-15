import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import AccessibleObjectNavigator from '@/components/accessibility/AccessibleObjectNavigator.vue';
import NoteGridCanvas from '@/components/piano-roll/NoteGridCanvas.vue';
import type { NoteInteractions } from '@/components/piano-roll/use-note-interactions';
import type { EditorNote } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

function makeNote(over: Partial<EditorNote> = {}): EditorNote {
  return { id: 1, pitch: 60, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0, ...over };
}

function makeInteractions(): NoteInteractions {
  return {
    marquee: ref(null),
    previewNotes: ref(null),
    cursor: ref('default'),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onDoubleClick: vi.fn(),
    hitNoteAt: vi.fn(() => null),
    drawCellAt: vi.fn(() => ({ startPpq: 0, lengthPpq: 0.25 })),
    onKeyDown: vi.fn(() => false),
    cancel: vi.fn(),
  } as unknown as NoteInteractions;
}

const painter: Painter = { schedule: vi.fn(), dispose: vi.fn() };
let wrapper: VueWrapper | null = null;
let fontSets = 0;
let baselineSets = 0;

function fakeContext(): CanvasRenderingContext2D {
  const ctx: Record<string, unknown> = { strokeStyle: '', fillStyle: '', lineWidth: 1 };
  Object.defineProperty(ctx, 'font', {
    get: () => '',
    set: () => {
      fontSets++;
    },
  });
  Object.defineProperty(ctx, 'textBaseline', {
    get: () => '',
    set: () => {
      baselineSets++;
    },
  });
  for (const name of [
    'setTransform',
    'clearRect',
    'fillRect',
    'strokeRect',
    'beginPath',
    'moveTo',
    'lineTo',
    'closePath',
    'fill',
    'stroke',
    'save',
    'restore',
    'rect',
    'clip',
    'fillText',
    'roundRect',
    'setLineDash',
  ]) {
    ctx[name] = vi.fn();
  }
  ctx.measureText = vi.fn(() => ({ width: 10 }));
  return ctx as unknown as CanvasRenderingContext2D;
}

function mountGrid(notes: EditorNote[]) {
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
      range: new TimelineRange({ widthPx: 800, heightPx: 1800, pxPerPpq: 100, rowHeight: 14 }),
      revision: 0,
      painter,
      notes,
      selection: new Set<number>(),
      highlightedPitchClasses: Array.from({ length: 12 }, () => false),
      gridPpq: 0.25,
      clipLengthPpq: 16,
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      interactions: makeInteractions(),
    },
  });
}

function paintLayer(prefix: string): void {
  const calls = vi.mocked(painter.schedule).mock.calls.filter(([l]) => l.startsWith(prefix));
  calls[calls.length - 1]?.[1]();
}

beforeEach(() => {
  vi.mocked(painter.schedule).mockClear();
  fontSets = 0;
  baselineSets = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(fakeContext as never);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NoteGridCanvas live region', () => {
  it('does not announce the pointer position while the mouse moves', async () => {
    wrapper = mountGrid([makeNote()]);
    const before = wrapper.get('.note-grid-live').text();
    wrapper
      .get('.note-grid')
      .element.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 400 }),
      );
    await nextTick();
    expect(wrapper.get('.note-grid-live').text()).toBe(before);
  });
});

describe('NoteGridCanvas accessible items', () => {
  it('keeps per-note controls stable when only the selection changes', async () => {
    wrapper = mountGrid([makeNote({ id: 1 }), makeNote({ id: 2, startPpq: 3 })]);
    const items = () => wrapper?.findComponent(AccessibleObjectNavigator).props('items') ?? [];
    const before = items();
    await wrapper.setProps({ selection: new Set([2]) });
    const after = items();
    expect(after[1].selected).toBe(true);
    expect(after[0].selected).toBe(false);
    expect(after[0].controls).toBe(before[0].controls);
    expect(after[1].controls).toBe(before[1].controls);
  });
});

describe('NoteGridCanvas note layer', () => {
  it('sets the label font once per paint', async () => {
    wrapper = mountGrid([
      makeNote({ id: 1, startPpq: 1 }),
      makeNote({ id: 2, startPpq: 3 }),
      makeNote({ id: 3, startPpq: 5 }),
    ]);
    await wrapper.setProps({ revision: 1 });
    fontSets = 0;
    baselineSets = 0;
    paintLayer('note-grid-notes-');
    expect(fontSets).toBe(1);
    expect(baselineSets).toBe(1);
  });

  it('reuses the overlap analysis while the note list is unchanged', async () => {
    wrapper = mountGrid([
      makeNote({ id: 1, startPpq: 1, durationPpq: 2 }),
      makeNote({ id: 2, startPpq: 2, durationPpq: 2 }),
    ]);
    await wrapper.setProps({ revision: 1 });
    paintLayer('note-grid-notes-');
    const add = vi.spyOn(Set.prototype, 'add');
    paintLayer('note-grid-notes-');
    expect(add).not.toHaveBeenCalled();
  });
});
