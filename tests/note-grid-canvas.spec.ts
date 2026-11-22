import { NoteSafety } from '@libraz/libcantus';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import NoteGridCanvas from '@/components/piano-roll/NoteGridCanvas.vue';
import { PIANO_ROLL_COLORS } from '@/components/piano-roll/theme';
import type { NoteInteractions } from '@/components/piano-roll/use-note-interactions';
import type { PlacementColumn } from '@/composables/usePlacementGuidance';
import type { TheoryCard } from '@/compose/explain';
import type { GuidanceSegment } from '@/compose/guidance';
import type { PlacementLevel, PlacementVerdict } from '@/compose/placement';
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
    gestureReadout: ref(null),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onDoubleClick: vi.fn(),
    hitNoteAt: vi.fn(() => noteId),
    drawCellAt: vi.fn(() => ({ startPpq: 0, lengthPpq: 0.25 })),
    onKeyDown: vi.fn(() => false),
    cancel: vi.fn(),
  };
}

const painter: Painter = {
  schedule: vi.fn(),
  dispose: vi.fn(),
};

let wrapper: ReturnType<typeof mountGrid> | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.mocked(painter.schedule).mockClear();
});

function mountGrid(
  noteId: number | null,
  noteCard?: (id: number) => TheoryCard | null,
  guidanceSegments?: GuidanceSegment[],
  noteSafety?: ReadonlyMap<number, NoteSafety.Warning | NoteSafety.Dissonant>,
) {
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
      selection: new Set<number>(),
      highlightedPitchClasses: Array.from({ length: 12 }, () => false),
      gridPpq: 0.25,
      clipLengthPpq: 16,
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      interactions: makeInteractions(noteId),
      ...(noteCard ? { noteCard } : {}),
      ...(guidanceSegments ? { guidanceSegments } : {}),
      ...(noteSafety ? { noteSafety } : {}),
    },
  });
}

describe('NoteGridCanvas', () => {
  it('lets the draw tool place notes over accompaniment ghosts without switching tracks', async () => {
    wrapper = mountGrid(null);
    await wrapper.setProps({
      ghostNotes: [
        {
          noteId: 9,
          clipId: 12,
          trackId: 4,
          pitch: 74,
          startPpq: 6,
          durationPpq: 1,
          color: '#888888',
          trackName: 'Backing',
        },
      ],
      activeTool: 'select',
    });
    const grid = wrapper.get('.note-grid').element as HTMLElement;
    grid.setPointerCapture = vi.fn();
    const pressGhost = () =>
      grid.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 650,
          clientY: 535,
        }),
      );

    pressGhost();
    expect(wrapper.emitted('ghost-activate')).toHaveLength(1);
    const interactions = wrapper.props('interactions');
    expect(interactions.onPointerDown).not.toHaveBeenCalled();

    await wrapper.setProps({ activeTool: 'draw' });
    pressGhost();
    expect(wrapper.emitted('ghost-activate')).toHaveLength(1);
    expect(interactions.onPointerDown).toHaveBeenCalledTimes(1);
  });

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
    expect(style).toContain('--theory-card-reach: 14px');

    movePointerTo(140, 260);
    await nextTick();

    expect(shownCard()?.getAttribute('style')).toBe(style);
  });

  it('refreshes the pinned card when the guidance resolver changes in place', async () => {
    wrapper = mountGrid(1, (id) => theoryCard(id));
    movePointerTo(100, 200);
    await nextTick();
    expect(shownCard()?.textContent).toContain('C4 #1');

    await wrapper.setProps({
      noteCard: (id: number) => ({ ...theoryCard(id), title: `D4 #${id}` }),
    });
    await nextTick();

    expect(shownCard()?.textContent).toContain('D4 #1');
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
    const card = document.querySelector('.note-grid-theory-card');
    const info = card?.querySelector('.theory-card-info');
    card?.dispatchEvent(new PointerEvent('pointerenter'));
    await wrapper.get('.note-grid').trigger('pointerleave');
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(shownCard()).not.toBeNull();

    (info as HTMLElement).click();
    await nextTick();
    expect(shownCard()?.textContent).toContain('A note belonging to the chord.');

    card?.dispatchEvent(new PointerEvent('pointerleave'));
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(shownCard()).toBeNull();
  });
});

describe('NoteGridCanvas placement column', () => {
  /** Minimal 2d context: records the stroke colour of every stroke() and the dash patterns. */
  function fakeContext() {
    const strokes: string[] = [];
    const dashes: number[][] = [];
    const fills: string[] = [];
    const ctx: Record<string, unknown> = { strokeStyle: '', fillStyle: '', lineWidth: 1, font: '' };
    for (const name of [
      'setTransform',
      'clearRect',
      'strokeRect',
      'beginPath',
      'moveTo',
      'lineTo',
      'closePath',
      'fill',
      'save',
      'restore',
      'rect',
      'clip',
      'fillText',
      'roundRect',
    ]) {
      ctx[name] = vi.fn();
    }
    ctx.fillRect = vi.fn(() => fills.push(String(ctx.fillStyle)));
    ctx.stroke = vi.fn(() => strokes.push(String(ctx.strokeStyle)));
    ctx.setLineDash = vi.fn((pattern: number[]) => dashes.push([...pattern]));
    ctx.measureText = vi.fn(() => ({ width: 10 }));
    return { ctx, strokes, dashes, fills };
  }

  function column(
    levels: Record<number, PlacementLevel>,
    extra: Partial<PlacementVerdict> = {},
  ): PlacementColumn {
    const verdicts: PlacementVerdict[] = Array.from({ length: 128 }, (_, pitch) => ({
      level: levels[pitch] ?? 'safe',
      reasons: [],
      partners: [],
      ...(levels[pitch] !== undefined ? extra : {}),
    }));
    return { startPpq: 1, endPpq: 1.25, verdicts };
  }

  function mountColumn(placementColumn: PlacementColumn, rowHeight: number) {
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
        range: new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight }),
        revision: 0,
        painter,
        notes: [],
        selection: new Set<number>(),
        highlightedPitchClasses: Array.from({ length: 12 }, () => false),
        gridPpq: 0.25,
        clipLengthPpq: 16,
        timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
        interactions: makeInteractions(null),
        placementColumn,
      },
    });
  }

  /** Runs the most recently scheduled overlay paint against the fake context. */
  function paintOverlay(): void {
    const calls = vi
      .mocked(painter.schedule)
      .mock.calls.filter(([layer]) => layer.startsWith('note-grid-overlay-'));
    calls[calls.length - 1]?.[1]();
  }

  function paintBackground(): void {
    const calls = vi
      .mocked(painter.schedule)
      .mock.calls.filter(([layer]) => layer.startsWith('note-grid-background-'));
    calls[calls.length - 1]?.[1]();
  }

  let fake: ReturnType<typeof fakeContext>;
  let getContextSpy: { mockRestore(): void } | null = null;

  beforeEach(() => {
    fake = fakeContext();
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => fake.ctx as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    getContextSpy?.mockRestore();
    getContextSpy = null;
  });

  it('hatches an ng row on top of its tint', async () => {
    wrapper = mountColumn(column({}), 10);
    await wrapper.setProps({ placementColumn: column({ 60: 'ng' }) });
    paintOverlay();
    expect(fake.fills).toContain(PIANO_ROLL_COLORS.guidanceDissonant);
    expect(fake.strokes).toContain(PIANO_ROLL_COLORS.placementHatch);
  });

  it('skips the hatch when rows are shorter than 5px', async () => {
    wrapper = mountColumn(column({}), 4);
    await wrapper.setProps({ placementColumn: column({ 60: 'ng' }) });
    paintOverlay();
    expect(fake.fills).toContain(PIANO_ROLL_COLORS.guidanceDissonant);
    expect(fake.strokes).not.toContain(PIANO_ROLL_COLORS.placementHatch);
  });

  it('draws no hatch on a column without ng rows', async () => {
    wrapper = mountColumn(column({}), 10);
    await wrapper.setProps({ placementColumn: column({ 60: 'warn' }) });
    paintOverlay();
    expect(fake.fills).toContain(PIANO_ROLL_COLORS.guidanceWarning);
    expect(fake.strokes).not.toContain(PIANO_ROLL_COLORS.placementHatch);
  });

  it('tints safe pitch rows when a chord guidance segment is present', async () => {
    const safetyByPc = new Uint8Array(12).fill(NoteSafety.Safe);
    wrapper = mountGrid(1, undefined, [{ startBeat: 0, endBeat: 2, safetyByPc }]);
    await wrapper.setProps({ revision: 1 });
    fake.fills.length = 0;

    paintBackground();

    expect(fake.fills).toContain(PIANO_ROLL_COLORS.guidanceSafe);
  });

  it('underlines a row that thins a following accompaniment with a dotted line', async () => {
    wrapper = mountColumn(column({}), 10);
    await wrapper.setProps({
      placementColumn: column({ 60: 'safe' }, { reasons: ['accompanimentThinned'] }),
    });
    paintOverlay();
    expect(fake.strokes).toContain(PIANO_ROLL_COLORS.placementThinned);
    expect(fake.dashes.some((pattern) => pattern.length > 0)).toBe(true);
  });

  it('draws a dotted arrow from the hovered warn row to its resolution', async () => {
    wrapper = mountColumn(column({ 60: 'warn' }, { resolveTo: [59] }), 10);
    // Pitch 60 sits at y [670, 680) with 10px rows and no scroll.
    wrapper
      .get('.note-grid')
      .element.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 120, clientY: 675 }),
      );
    await nextTick();
    paintOverlay();
    expect(fake.strokes).toContain(PIANO_ROLL_COLORS.resolutionArrow);
    expect(fake.dashes.some((pattern) => pattern.length > 0)).toBe(true);
  });

  it('draws the crosshair after the column', async () => {
    wrapper = mountColumn(column({ 60: 'ng' }), 10);
    wrapper
      .get('.note-grid')
      .element.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 120, clientY: 675 }),
      );
    await nextTick();
    paintOverlay();
    const hatch = fake.strokes.indexOf(PIANO_ROLL_COLORS.placementHatch);
    const crosshair = fake.strokes.lastIndexOf(PIANO_ROLL_COLORS.rulerBeat);
    expect(hatch).toBeGreaterThanOrEqual(0);
    expect(crosshair).toBeGreaterThan(hatch);
  });

  /** Runs the most recently scheduled note-layer paint against the fake context. */
  function paintNotes(): void {
    const calls = vi
      .mocked(painter.schedule)
      .mock.calls.filter(([layer]) => layer.startsWith('note-grid-notes-'));
    calls[calls.length - 1]?.[1]();
  }

  it('bands a note left unresolved with the warning stripe', async () => {
    wrapper = mountColumn(column({}), 10);
    await wrapper.setProps({ notes: [makeNote({ id: 7 })], unresolvedNoteIds: new Set<number>() });
    fake.fills.length = 0;
    paintNotes();
    expect(fake.fills).not.toContain(PIANO_ROLL_COLORS.noteWarning);

    await wrapper.setProps({ unresolvedNoteIds: new Set([7]) });
    fake.fills.length = 0;
    paintNotes();
    expect(fake.fills).toContain(PIANO_ROLL_COLORS.noteWarning);
  });

  it('uses harmonic severity for the note stripe and repaints when it changes', async () => {
    wrapper = mountColumn(column({}), 10);
    await wrapper.setProps({
      notes: [makeNote({ id: 7 })],
      noteSafety: new Map([[7, NoteSafety.Warning]]),
      unresolvedNoteIds: new Set<number>(),
    });
    fake.fills.length = 0;
    paintNotes();
    expect(fake.fills).toContain(PIANO_ROLL_COLORS.noteWarning);
    expect(fake.fills).not.toContain(PIANO_ROLL_COLORS.noteError);

    await wrapper.setProps({ noteSafety: new Map([[7, NoteSafety.Dissonant]]) });
    fake.fills.length = 0;
    paintNotes();
    expect(fake.fills).toContain(PIANO_ROLL_COLORS.noteError);
  });

  it('repaints only the overlay when the column changes', async () => {
    wrapper = mountColumn(column({}), 10);
    vi.mocked(painter.schedule).mockClear();
    await wrapper.setProps({ placementColumn: column({ 61: 'warn' }) });
    const layers = vi.mocked(painter.schedule).mock.calls.map(([layer]) => layer);
    expect(layers.some((layer) => layer.startsWith('note-grid-overlay-'))).toBe(true);
    expect(layers.some((layer) => layer.startsWith('note-grid-background-'))).toBe(false);
  });
});
