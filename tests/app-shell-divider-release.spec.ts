import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppShellLayout } from '@/composables/useAppShellLayout';

describe('app shell divider release', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    // Frames never run on their own: a move and its release land in the same frame.
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies and persists the last arrange divider sample on release', () => {
    const layout = useAppShellLayout();
    const start = layout.arrangeHeight.value;
    layout.onDividerPointerDown({
      button: 0,
      clientY: 100,
      currentTarget: { setPointerCapture: vi.fn() },
      pointerId: 1,
    } as unknown as PointerEvent);
    layout.onDividerPointerMove({ clientY: 160 } as PointerEvent);
    layout.onDividerPointerUp();

    expect(layout.arrangeHeight.value).toBe(start + 60);
    expect(window.localStorage.getItem('sonare-studio.arrangeHeightPx')).toBe(String(start + 60));
    layout.disposeLayout();
  });

  it('applies and persists the last score divider sample on release', () => {
    const layout = useAppShellLayout();
    layout.onScoreDividerPointerDown({
      button: 0,
      clientY: 500,
      currentTarget: {
        nextElementSibling: { getBoundingClientRect: () => ({ height: 300 }) },
        setPointerCapture: vi.fn(),
      },
      pointerId: 1,
    } as unknown as PointerEvent);
    layout.onScoreDividerPointerMove({ clientY: 440 } as PointerEvent);
    layout.onScoreDividerPointerUp();

    expect(layout.scoreHeight.value).toBe(360);
    expect(window.localStorage.getItem('sonare-studio.scoreHeightPx')).toBe('360');
    layout.disposeLayout();
  });
});
