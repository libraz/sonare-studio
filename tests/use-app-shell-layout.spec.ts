import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampArrangementHeight,
  maximumArrangementHeight,
  useAppShellLayout,
} from '@/composables/useAppShellLayout';
import { applyLayoutState } from '@/ui/settings/layouts';

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
    expect(maximumArrangementHeight(1000)).toBe(510);
    expect(maximumArrangementHeight(300)).toBe(120);
    expect(maximumArrangementHeight(5000)).toBe(2000);
    expect(clampArrangementHeight(1200, 600)).toBe(120);
  });

  it('clamps a stored arrangement height on load', () => {
    window.localStorage.setItem('sonare-studio.arrangeHeightPx', '1600');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });

    const layout = useAppShellLayout();

    expect(layout.arrangeHeight.value).toBe(120);
    layout.disposeLayout();
  });

  it('restores the selected dock tab and score panel visibility', () => {
    window.localStorage.setItem('sonare-studio.dockTab', 'mixer');
    window.localStorage.setItem('sonare-studio.scoreVisible', '1');

    const restored = useAppShellLayout();
    expect(restored.dockTab.value).toBe('mixer');
    expect(restored.scoreVisible.value).toBe(true);
    restored.disposeLayout();

    const layout = useAppShellLayout();
    layout.selectDockTab('media');
    layout.toggleScorePanel();
    expect(window.localStorage.getItem('sonare-studio.dockTab')).toBe('media');
    expect(window.localStorage.getItem('sonare-studio.scoreVisible')).toBe('0');
    layout.disposeLayout();
  });

  it('clamps a named layout when applied', () => {
    const layout = useAppShellLayout();

    layout.layoutBindings.arrangeHeightPx.value = 1800;

    expect(layout.arrangeHeight.value).toBe(510);
    expect(window.localStorage.getItem('sonare-studio.arrangeHeightPx')).toBe('510');
    layout.disposeLayout();
  });

  it('persists every field an applied layout writes, so it survives a reload', () => {
    const layout = useAppShellLayout();

    applyLayoutState(
      {
        arrangeHeightPx: 300,
        dockTab: 'mixer',
        deviceRackOpen: true,
        scoreOpen: true,
        dockCollapsed: true,
      },
      layout.layoutBindings,
    );
    layout.disposeLayout();

    const reloaded = useAppShellLayout();
    expect(reloaded.arrangeHeight.value).toBe(300);
    expect(reloaded.dockTab.value).toBe('mixer');
    expect(reloaded.deviceRackOpen.value).toBe(true);
    expect(reloaded.scoreVisible.value).toBe(true);
    expect(reloaded.dockCollapsed.value).toBe(true);
    reloaded.disposeLayout();
  });

  it('reclamps the active layout after a viewport resize', () => {
    const layout = useAppShellLayout();
    layout.arrangeHeight.value = 700;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 520 });

    window.dispatchEvent(new Event('resize'));

    expect(layout.arrangeHeight.value).toBe(120);
    expect(window.localStorage.getItem('sonare-studio.arrangeHeightPx')).toBe('120');
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

  it('supports Home and End for both keyboard-resizable splitters', () => {
    const layout = useAppShellLayout();
    const arrangeHome = { key: 'Home', shiftKey: false, preventDefault: vi.fn() } as KeyboardEvent;
    const arrangeEnd = { key: 'End', shiftKey: false, preventDefault: vi.fn() } as KeyboardEvent;
    layout.onDividerKeydown(arrangeHome);
    expect(layout.arrangeHeight.value).toBe(layout.arrangeHeightMin);
    layout.onDividerKeydown(arrangeEnd);
    expect(layout.arrangeHeight.value).toBe(maximumArrangementHeight(window.innerHeight));

    const scoreHome = { key: 'Home', shiftKey: false, preventDefault: vi.fn() } as KeyboardEvent;
    const scoreEnd = { key: 'End', shiftKey: false, preventDefault: vi.fn() } as KeyboardEvent;
    layout.onScoreDividerKeydown(scoreHome);
    expect(layout.scoreHeight.value).toBe(layout.scoreHeightMin);
    layout.onScoreDividerKeydown(scoreEnd);
    expect(layout.scoreHeight.value).toBe(layout.scoreHeightMax.value);
    layout.disposeLayout();
  });
});
