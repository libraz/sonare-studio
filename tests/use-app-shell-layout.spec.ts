import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppShellLayout } from '@/composables/useAppShellLayout';

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
