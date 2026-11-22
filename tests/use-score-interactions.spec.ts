import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scoreNoteXmlId } from '@/notation/source-identity';
import { setActiveClip, setSelection } from '@/project/commands';
import { useScoreInteractions } from '@/ui/score/use-score-interactions';

vi.mock('@/project/commands', () => ({
  setActiveClip: vi.fn(),
  setSelection: vi.fn(),
}));

function fixtureDom(): { host: HTMLElement; note: SVGGElement; path: SVGPathElement } {
  const host = document.createElement('div');
  host.innerHTML = '<svg><g class="note" id="note-1"><path d="M0 0h1v1z"/></g></svg>';
  document.body.append(host);
  const note = host.querySelector('g.note') as SVGGElement;
  const path = host.querySelector('path') as SVGPathElement;
  return { host, note, path };
}

function pointerEvent(
  type: string,
  target: EventTarget,
  init: { clientY: number; pointerId?: number; button?: number },
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY: init.clientY,
    button: init.button ?? 0,
  }) as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

function clickEvent(target: EventTarget): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

function doubleClickEvent(target: EventTarget, clientX: number): MouseEvent {
  const event = new MouseEvent('dblclick', {
    bubbles: true,
    cancelable: true,
    clientX,
  });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

function interactions(overrides: Partial<Parameters<typeof useScoreInteractions>[0]> = {}) {
  return useScoreInteractions({
    store: {
      clipStartPpq: 0,
      clipLengthPpq: 8,
      pickupLengthPpq: 0,
      timeSignatures: [],
      notes: [{ id: 11, startPpq: 0, durationPpq: 1 }],
    } as never,
    getTimemap: () => [{ tstamp: 0, qstamp: 0, on: ['note-1'] }],
    getDivisionPpq: () => 0.25,
    seek: vi.fn(),
    isAnnotateEnabled: () => true,
    ...overrides,
  });
}

describe('useScoreInteractions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('commits an upper-staff override when an annotated note is dragged upward', () => {
    const { path } = fixtureDom();
    const onAnnotateStaffDrag = vi.fn();
    const score = interactions({ onAnnotateStaffDrag });

    score.onSvgPointerDown(pointerEvent('pointerdown', path, { clientY: 120 }));
    score.onSvgPointerMove(pointerEvent('pointermove', path, { clientY: 80 }));
    score.onSvgPointerUp(pointerEvent('pointerup', path, { clientY: 80 }));

    expect(onAnnotateStaffDrag).toHaveBeenCalledWith([11], 1);
  });

  it('commits a lower-staff override when an annotated note is dragged downward', () => {
    const { path } = fixtureDom();
    const onAnnotateStaffDrag = vi.fn();
    const score = interactions({ onAnnotateStaffDrag });

    score.onSvgPointerDown(pointerEvent('pointerdown', path, { clientY: 80 }));
    score.onSvgPointerMove(pointerEvent('pointermove', path, { clientY: 120 }));
    score.onSvgPointerUp(pointerEvent('pointerup', path, { clientY: 120 }));

    expect(onAnnotateStaffDrag).toHaveBeenCalledWith([11], 2);
  });

  it('keeps small pointer movement as a normal click', () => {
    const { path } = fixtureDom();
    const onAnnotateStaffDrag = vi.fn();
    const seek = vi.fn();
    const score = interactions({ onAnnotateStaffDrag, seek });

    score.onSvgPointerDown(pointerEvent('pointerdown', path, { clientY: 80 }));
    score.onSvgPointerMove(pointerEvent('pointermove', path, { clientY: 90 }));
    score.onSvgPointerUp(pointerEvent('pointerup', path, { clientY: 90 }));
    score.onSvgClick(clickEvent(path));

    expect(onAnnotateStaffDrag).not.toHaveBeenCalled();
    expect(seek).toHaveBeenCalledWith(0);
    expect(setSelection).toHaveBeenCalledWith([11]);
  });

  it('suppresses the click emitted after a committed staff drag', () => {
    const { path } = fixtureDom();
    const onAnnotateStaffDrag = vi.fn();
    const seek = vi.fn();
    const score = interactions({ onAnnotateStaffDrag, seek });

    score.onSvgPointerDown(pointerEvent('pointerdown', path, { clientY: 80 }));
    score.onSvgPointerMove(pointerEvent('pointermove', path, { clientY: 120 }));
    score.onSvgPointerUp(pointerEvent('pointerup', path, { clientY: 120 }));
    score.onSvgClick(clickEvent(path));

    expect(onAnnotateStaffDrag).toHaveBeenCalledWith([11], 2);
    expect(seek).not.toHaveBeenCalled();
    expect(setSelection).not.toHaveBeenCalled();
  });

  it('writes a semitone delta for a normal-mode vertical drag', () => {
    const { path } = fixtureDom();
    const onAnnotateStaffDrag = vi.fn();
    const onNotePitchDrag = vi.fn();
    const score = interactions({
      isAnnotateEnabled: () => false,
      onAnnotateStaffDrag,
      onNotePitchDrag,
    });

    score.onSvgPointerDown(pointerEvent('pointerdown', path, { clientY: 120 }));
    score.onSvgPointerMove(pointerEvent('pointermove', path, { clientY: 80 }));
    score.onSvgPointerUp(pointerEvent('pointerup', path, { clientY: 80 }));

    expect(onAnnotateStaffDrag).not.toHaveBeenCalled();
    expect(onNotePitchDrag).toHaveBeenCalledWith([11], [2]);
  });

  it('resolves the note ids under an engraved note from an event target', () => {
    const { path } = fixtureDom();
    const score = interactions();
    expect(score.noteIdsAtEvent(clickEvent(path))).toEqual([11]);
  });

  it('returns no note ids for an event off any engraved note', () => {
    const { host } = fixtureDom();
    const score = interactions();
    expect(score.noteIdsAtEvent(clickEvent(host))).toEqual([]);
  });

  it('resolves a full-score click to its clip-scoped identity before selection', () => {
    const xmlId = scoreNoteXmlId([{ clipId: 22, noteId: 7, occurrence: 1 }], 10, 0);
    if (!xmlId) throw new Error('missing score note id');
    const host = document.createElement('div');
    host.innerHTML = `<svg><g class="note" id="${xmlId}"><path/></g></svg>`;
    document.body.append(host);
    const path = host.querySelector('path') as SVGPathElement;
    const seek = vi.fn();
    const onAnnotateClick = vi.fn();
    const score = interactions({
      store: {
        clipId: 1,
        clipStartPpq: 8,
        clipLengthPpq: 8,
        pickupLengthPpq: 0,
        timeSignatures: [],
        notes: [],
      } as never,
      getTimemap: () => [{ tstamp: 0, qstamp: 2, on: [xmlId] }],
      seek,
      onAnnotateClick,
    });

    score.onSvgClick(clickEvent(path));

    expect(setActiveClip).toHaveBeenCalledWith(22);
    expect(onAnnotateClick).toHaveBeenCalledWith(expect.any(MouseEvent), [7]);
    expect(setSelection).toHaveBeenCalledWith([7]);
    expect(seek).toHaveBeenCalledWith(10);
  });

  it('converts a moved and trimmed double-click to active-clip source PPQ', () => {
    const host = document.createElement('div');
    host.innerHTML = '<svg><g class="note" id="note-1"><path/></g></svg>';
    document.body.append(host);
    const note = host.querySelector('g.note') as SVGGElement;
    const path = host.querySelector('path') as SVGPathElement;
    Object.defineProperty(note, 'getBoundingClientRect', {
      value: () => ({ left: 100, width: 20 }),
    });
    const onInsertAt = vi.fn();
    const score = interactions({
      store: {
        clipStartPpq: 12,
        clipLengthPpq: 4,
        pickupLengthPpq: 0,
        timeSignatures: [],
        activeClip: {
          startPpq: 12,
          lengthPpq: 4,
          sourceOffsetPpq: 3,
          loopEnabled: false,
          loopLengthPpq: 0,
          kind: 'midi',
        },
        notes: [],
      } as never,
      getTimemap: () => [{ tstamp: 0, qstamp: 1.5, on: ['note-1'] }],
      onInsertAt,
    });

    score.onSvgDoubleClick(doubleClickEvent(path, 110));

    expect(onInsertAt).toHaveBeenCalledWith(4.5);
  });

  it('folds a looped double-click to its first source window', () => {
    const host = document.createElement('div');
    host.innerHTML = '<svg><g class="note" id="note-1"><path/></g></svg>';
    document.body.append(host);
    const note = host.querySelector('g.note') as SVGGElement;
    const path = host.querySelector('path') as SVGPathElement;
    Object.defineProperty(note, 'getBoundingClientRect', {
      value: () => ({ left: 100, width: 20 }),
    });
    const onInsertAt = vi.fn();
    const score = interactions({
      store: {
        clipStartPpq: 8,
        clipLengthPpq: 5,
        pickupLengthPpq: 0,
        timeSignatures: [],
        activeClip: {
          startPpq: 8,
          lengthPpq: 5,
          sourceOffsetPpq: 2,
          loopEnabled: true,
          loopLengthPpq: 2,
          kind: 'midi',
        },
        notes: [],
      } as never,
      getTimemap: () => [{ tstamp: 0, qstamp: 2.25, on: ['note-1'] }],
      onInsertAt,
    });

    score.onSvgDoubleClick(doubleClickEvent(path, 110));

    expect(onInsertAt).toHaveBeenCalledWith(2.25);
  });

  it('rejects a double-click at or beyond the audible clip end', () => {
    const host = document.createElement('div');
    host.innerHTML = '<svg><g class="note" id="note-1"><path/></g></svg>';
    document.body.append(host);
    const note = host.querySelector('g.note') as SVGGElement;
    const path = host.querySelector('path') as SVGPathElement;
    Object.defineProperty(note, 'getBoundingClientRect', {
      value: () => ({ left: 100, width: 20 }),
    });
    const onInsertAt = vi.fn();
    const score = interactions({
      store: {
        clipStartPpq: 8,
        clipLengthPpq: 5,
        pickupLengthPpq: 0,
        timeSignatures: [],
        activeClip: {
          startPpq: 8,
          lengthPpq: 5,
          sourceOffsetPpq: 2,
          loopEnabled: true,
          loopLengthPpq: 2,
          kind: 'midi',
        },
        notes: [],
      } as never,
      getTimemap: () => [{ tstamp: 0, qstamp: 5, on: ['note-1'] }],
      onInsertAt,
    });

    score.onSvgDoubleClick(doubleClickEvent(path, 110));

    expect(onInsertAt).not.toHaveBeenCalled();
  });
});
