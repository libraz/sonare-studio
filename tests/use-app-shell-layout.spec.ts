import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampArrangementHeight,
  maximumArrangementHeight,
  useAppShellLayout,
} from '@/composables/useAppShellLayout';

describe('useAppShellLayout', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    rafCallbacks = new Map();
    nextRafId = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextRafId++;
        rafCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        rafCallbacks.delete(id);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('computes a viewport-aware arrangement bound', () => {
    expect(maximumArrangementHeight(1000)).toBe(760);
    expect(maximumArrangementHeight(300)).toBe(120);
    expect(maximumArrangementHeight(5000)).toBe(2000);
    expect(clampArrangementHeight(1200, 600)).toBe(360);
  });

  it('clamps a stored arrangement height on load', () => {
    window.localStorage.setItem('sonare-studio.arrangeHeightPx', '1600');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });

    const layout = useAppShellLayout();

    expect(layout.arrangeHeight.value).toBe(360);
    layout.disposeLayout();
  });

  it('clamps a named layout when applied', () => {
    const layout = useAppShellLayout();

    layout.layoutBindings.arrangeHeightPx.value = 1800;

    expect(layout.arrangeHeight.value).toBe(760);
    expect(window.localStorage.getItem('sonare-studio.arrangeHeightPx')).toBe('760');
    layout.disposeLayout();
  });

  it('reclamps the active layout after a viewport resize', () => {
    const layout = useAppShellLayout();
    layout.arrangeHeight.value = 700;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 520 });

    window.dispatchEvent(new Event('resize'));

    expect(layout.arrangeHeight.value).toBe(280);
    expect(window.localStorage.getItem('sonare-studio.arrangeHeightPx')).toBe('280');
    layout.disposeLayout();
  });

  it('cancels a pending arrange divider frame on dispose', () => {
    const layout = useAppShellLayout();
    layout.onDividerPointerDown({
      button: 0,
      clientY: 100,
      currentTarget: { setPointerCapture: vi.fn() },
      pointerId: 1,
    } as unknown as PointerEvent);
    layout.onDividerPointerMove({ clientY: 220 } as PointerEvent);
    expect(rafCallbacks.size).toBe(1);

    layout.disposeLayout();

    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(rafCallbacks.size).toBe(0);
    expect(layout.arrangeHeight.value).toBe(440);
  });

  it('cancels a pending score divider frame on dispose', () => {
    const layout = useAppShellLayout();
    const scoreEl = { getBoundingClientRect: () => ({ height: 300 }) };
    layout.onScoreDividerPointerDown({
      button: 0,
      clientY: 500,
      currentTarget: { nextElementSibling: scoreEl, setPointerCapture: vi.fn() },
      pointerId: 1,
    } as unknown as PointerEvent);
    layout.onScoreDividerPointerMove({ clientY: 360 } as PointerEvent);
    expect(rafCallbacks.size).toBe(1);

    layout.disposeLayout();

    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(rafCallbacks.size).toBe(0);
    expect(layout.scoreHeight.value).toBe(300);
  });
});
