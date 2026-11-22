import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import { usePianoRollScrollbar } from '@/ui/piano-roll/use-piano-roll-scrollbar';
import { usePianoRollZoom, ZOOM_BUTTON_STEP } from '@/ui/piano-roll/use-piano-roll-zoom';

function elementWithSize(width: number, height: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperties(element, {
    clientHeight: { value: height },
    clientWidth: { value: width },
  });
  return element;
}

function pointerEvent(currentTarget: HTMLElement, values: Partial<PointerEvent>): PointerEvent {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    currentTarget,
    pointerId: 1,
    ...values,
  } as PointerEvent;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('piano-roll viewport controls', () => {
  it('zooms around the wheel pointer and pans along the intended axis', () => {
    const range = new TimelineRange({ widthPx: 200, heightPx: 80, pxPerPpq: 20, startPpq: 4 });
    const grid = elementWithSize(200, 80);
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
    const bump = vi.fn();
    const zoom = usePianoRollZoom({ range, gridCell: ref(grid), bump });

    zoom.onWheel({ clientX: 200, ctrlKey: true, deltaY: -100 } as WheelEvent);
    expect(range.pxPerPpq).toBeGreaterThan(20);
    expect(range.xToPpq(100)).toBeCloseTo(9, 6);

    const start = range.startPpq;
    zoom.onWheel({ shiftKey: true, deltaX: 3, deltaY: 20 } as WheelEvent);
    expect(range.startPpq).toBeGreaterThan(start);
    expect(bump).toHaveBeenCalledTimes(2);
  });

  it('keeps vertical zoom centered and clamps its row height', () => {
    const range = new TimelineRange({ widthPx: 200, heightPx: 80, rowHeight: 10, scrollY: 500 });
    const zoom = usePianoRollZoom({
      range,
      gridCell: ref(document.createElement('div')),
      bump: vi.fn(),
    });
    const centerRow = (range.scrollY + range.heightPx / 2) / range.rowHeight;

    zoom.zoomVertical(ZOOM_BUTTON_STEP);
    expect(range.rowHeight).toBe(12);
    expect((range.scrollY + range.heightPx / 2) / range.rowHeight).toBeCloseTo(centerRow, 6);
    zoom.zoomVertical(100);
    expect(range.rowHeight).toBe(40);
    zoom.zoomVertical(0.001);
    expect(range.rowHeight).toBe(5);
  });

  it('maps custom scrollbar drags to bounded timeline coordinates', () => {
    const range = new TimelineRange({
      widthPx: 100,
      heightPx: 100,
      pxPerPpq: 10,
      startPpq: 10,
      scrollY: 100,
    });
    const hTrack = elementWithSize(200, 10);
    const vTrack = elementWithSize(10, 200);
    const bump = vi.fn();
    const scrollbar = usePianoRollScrollbar({
      range,
      revision: ref(0),
      hTrack: ref(hTrack),
      vTrack: ref(vTrack),
      contentPpq: () => 40,
      bump,
    });
    const thumb = elementWithSize(1, 1);
    const capture = vi.fn();
    Object.assign(thumb, { setPointerCapture: capture });

    scrollbar.onHScrollDown(pointerEvent(thumb, { clientX: 10 }));
    scrollbar.onScrollMove(pointerEvent(thumb, { clientX: 210 }));
    expect(range.startPpq).toBe(30);
    scrollbar.onScrollUp();
    scrollbar.onScrollMove(pointerEvent(thumb, { clientX: 0 }));
    expect(range.startPpq).toBe(30);

    scrollbar.onVScrollDown(pointerEvent(thumb, { clientY: 0 }));
    scrollbar.onScrollMove(pointerEvent(thumb, { clientY: 1_000 }));
    expect(range.scrollY).toBeLessThanOrEqual(range.contentHeightPx - range.heightPx);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(bump).toHaveBeenCalledTimes(2);
  });
});
