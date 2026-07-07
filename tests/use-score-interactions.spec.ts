import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSelection } from '@/project/commands';
import { useScoreInteractions } from '@/ui/score/use-score-interactions';

vi.mock('@/project/commands', () => ({
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

function interactions(overrides: Partial<Parameters<typeof useScoreInteractions>[0]> = {}) {
  return useScoreInteractions({
    store: {
      clipStartPpq: 0,
      clipLengthPpq: 8,
      notes: [{ id: 11, startPpq: 0, durationPpq: 1 }],
    } as never,
    getTimemap: () => [{ qstamp: 0, on: ['note-1'] }],
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

  it('does not start staff drags outside annotate mode', () => {
    const { path } = fixtureDom();
    const onAnnotateStaffDrag = vi.fn();
    const score = interactions({ isAnnotateEnabled: () => false, onAnnotateStaffDrag });

    score.onSvgPointerDown(pointerEvent('pointerdown', path, { clientY: 80 }));
    score.onSvgPointerMove(pointerEvent('pointermove', path, { clientY: 120 }));
    score.onSvgPointerUp(pointerEvent('pointerup', path, { clientY: 120 }));

    expect(onAnnotateStaffDrag).not.toHaveBeenCalled();
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
});
