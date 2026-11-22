import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import ArrangementCanvas from '@/components/arrangement/ArrangementCanvas.vue';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';
import { useAutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import type { ClipCursor } from '@/ui/arrangement/use-clip-interactions';
import { usePointerRouting } from '@/ui/arrangement/use-pointer-routing';
import { useTakeInteractions } from '@/ui/arrangement/use-take-interactions';
import { TimelineRange } from '@/ui/canvas/timeline-range';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubCanvasEnvironment(): void {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

function mountCanvas(options: {
  rowLayout: ReturnType<typeof buildRowLayout>;
  automation: ReturnType<typeof useAutomationInteractions>;
  takes: ReturnType<typeof useTakeInteractions>;
  automationExpandedIds?: readonly number[];
  takesExpandedIds?: readonly number[];
  clips?: unknown[];
}): ReturnType<typeof mount> {
  stubCanvasEnvironment();
  const wrapper = mount(ArrangementCanvas, {
    props: {
      range: new TimelineRange({ widthPx: 400, heightPx: 240, pxPerPpq: 10, rowHeight: 10 }),
      revision: 0,
      painter: { schedule: () => {}, dispose: () => {} },
      tracks: [{ id: 1, name: 'Piano', color: '#60a5fa' }],
      clips: options.clips ?? [],
      markers: [],
      activeTrackId: 1,
      activeClipId: -1,
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      scrollY: 0,
      laneHeight: 40,
      rowLayout: options.rowLayout,
      loopEnabled: false,
      loopStartPpq: 0,
      loopEndPpq: 4,
      interactions: {
        previewClip: ref(null),
        previewFades: ref(null),
        previewDraft: ref(null),
        previewMarquee: ref(null),
        cursor: ref<ClipCursor>('default'),
        cancel: vi.fn(),
        onPointerDown: vi.fn(),
        onPointerMove: vi.fn(),
        onPointerUp: vi.fn(),
        onDoubleClick: vi.fn(),
        hitClipAt: vi.fn(() => null),
      },
      automationExpandedIds: options.automationExpandedIds ?? [],
      automationParams: { 1: 'pan' },
      automationLanes: [],
      automation: options.automation,
      takesExpandedIds: options.takesExpandedIds ?? [],
      takes: options.takes,
    },
  });
  const element = wrapper.get('.arrangement-canvas').element as HTMLElement;
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0 }),
  });
  Object.defineProperty(element, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  return wrapper;
}

function idleAutomation() {
  return useAutomationInteractions({
    view: {
      ppqToX: (ppq) => ppq * 10,
      xToPpq: (x) => x / 10,
      sublaneAt: () => null,
    },
    getLanePoints: () => [],
    getGridPpq: () => 1,
    commands: { setPoints: vi.fn() },
  });
}

function idleTakes() {
  return useTakeInteractions({
    view: {
      ppqToX: (ppq) => ppq * 10,
      xToPpq: (x) => x / 10,
      takeRowAt: () => null,
    },
    getClips: () => [],
    commands: { setActiveTake: vi.fn(), setCompSegments: vi.fn() },
  });
}

function dispatchPointer(
  element: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { button?: number; clientX: number; clientY: number; pointerId: number },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    pointerId: { value: init.pointerId },
  });
  element.dispatchEvent(event);
}

describe('usePointerRouting double-clicks', () => {
  it('does not pass an expanded take sub-row through to clip creation', () => {
    const onDoubleClick = vi.fn();
    const takes = useTakeInteractions({
      view: {
        ppqToX: (ppq) => ppq,
        xToPpq: (x) => x,
        takeRowAt: (point) => (point.y === 80 ? { trackId: 1, takeIndex: 0 } : null),
      },
      getClips: () => [],
      commands: { setActiveTake: vi.fn(), setCompSegments: vi.fn() },
    });
    const routing = usePointerRouting({
      wrapper: ref({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement),
      range: () => ({ xToPpq: (x: number) => x }) as never,
      automation: {
        cursor: ref(null),
        onDoubleClick: vi.fn(() => false),
      } as never,
      takes,
      interactions: { cursor: ref('default'), onDoubleClick } as never,
      onRulerSeek: vi.fn(),
      onRulerContext: vi.fn(),
      onClipContext: vi.fn(),
    });

    routing.onDoubleClick({ clientX: 20, clientY: 80 } as MouseEvent);

    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('uses the upper ruler band to create a loop range without seeking', () => {
    const onRulerSeek = vi.fn();
    const onRulerLoopRange = vi.fn();
    const routing = usePointerRouting({
      wrapper: ref({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement),
      range: () => ({ xToPpq: (x: number) => x / 10 }) as never,
      automation: { cursor: ref(null) } as never,
      takes: {} as never,
      interactions: { cursor: ref('default') } as never,
      onRulerSeek,
      onRulerLoopRange,
      onRulerContext: vi.fn(),
      onClipContext: vi.fn(),
    });
    const target = { setPointerCapture: vi.fn() } as unknown as HTMLElement;

    routing.onPointerDown({
      button: 0,
      clientX: 80,
      clientY: 4,
      currentTarget: target,
      pointerId: 1,
    } as PointerEvent);
    routing.onPointerUp({ button: 0, clientX: 20, clientY: 4 } as PointerEvent);

    expect(onRulerLoopRange).toHaveBeenCalledWith(2, 8, false);
    expect(onRulerSeek).not.toHaveBeenCalled();
  });
});

describe('ArrangementCanvas cancellation', () => {
  it('cancels an automation drag on Escape before a later pointerup', async () => {
    const setPoints = vi.fn();
    const automation = useAutomationInteractions({
      view: {
        ppqToX: (ppq) => ppq * 10,
        xToPpq: (x) => x / 10,
        sublaneAt: (point) =>
          point.y >= 68 && point.y < 124 ? { trackId: 1, param: 'pan', top: 68, height: 56 } : null,
      },
      getLanePoints: () => [{ ppq: 2, value: 0, curve: 'linear' }],
      getGridPpq: () => 1,
      commands: { setPoints },
    });
    const wrapper = mountCanvas({
      rowLayout: buildRowLayout([true], 40),
      automation,
      takes: idleTakes(),
      automationExpandedIds: [1],
    });
    const canvas = wrapper.get<HTMLElement>('.arrangement-canvas');

    dispatchPointer(canvas.element, 'pointerdown', {
      button: 0,
      clientX: 20,
      clientY: 96,
      pointerId: 1,
    });
    dispatchPointer(canvas.element, 'pointermove', { clientX: 40, clientY: 80, pointerId: 1 });
    expect(automation.preview.value).not.toBeNull();

    canvas.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(automation.preview.value).toBeNull();
    dispatchPointer(canvas.element, 'pointerup', {
      button: 0,
      clientX: 60,
      clientY: 80,
      pointerId: 1,
    });

    expect(setPoints).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('cancels a take drag on Escape before a later pointerup', async () => {
    const setActiveTake = vi.fn();
    const setCompSegments = vi.fn();
    const clips = [
      {
        id: 2,
        trackId: 1,
        name: 'Take clip',
        startPpq: 0,
        lengthPpq: 8,
        takes: [{}, {}],
      },
    ];
    const takes = useTakeInteractions({
      view: {
        ppqToX: (ppq) => ppq * 10,
        xToPpq: (x) => x / 10,
        takeRowAt: (point) =>
          point.y >= 68 && point.y < 108 ? { trackId: 1, takeIndex: 0 } : null,
      },
      getClips: () => clips,
      commands: { setActiveTake, setCompSegments },
    });
    const wrapper = mountCanvas({
      rowLayout: buildRowLayout([false], 40, 56, [2]),
      automation: idleAutomation(),
      takes,
      takesExpandedIds: [1],
      clips,
    });
    const canvas = wrapper.get<HTMLElement>('.arrangement-canvas');

    dispatchPointer(canvas.element, 'pointerdown', {
      button: 0,
      clientX: 20,
      clientY: 88,
      pointerId: 1,
    });
    dispatchPointer(canvas.element, 'pointermove', { clientX: 60, clientY: 88, pointerId: 1 });
    expect(takes.preview.value).not.toBeNull();

    canvas.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(takes.preview.value).toBeNull();
    dispatchPointer(canvas.element, 'pointerup', {
      button: 0,
      clientX: 70,
      clientY: 88,
      pointerId: 1,
    });

    expect(setActiveTake).not.toHaveBeenCalled();
    expect(setCompSegments).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('cancels an upper-ruler loop drag on Escape before a later pointerup', async () => {
    const wrapper = mountCanvas({
      rowLayout: buildRowLayout([false], 40),
      automation: idleAutomation(),
      takes: idleTakes(),
    });
    const canvas = wrapper.get<HTMLElement>('.arrangement-canvas');

    dispatchPointer(canvas.element, 'pointerdown', {
      button: 0,
      clientX: 20,
      clientY: 4,
      pointerId: 1,
    });
    dispatchPointer(canvas.element, 'pointermove', { clientX: 60, clientY: 4, pointerId: 1 });
    canvas.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    dispatchPointer(canvas.element, 'pointerup', {
      button: 0,
      clientX: 80,
      clientY: 4,
      pointerId: 1,
    });

    expect(wrapper.emitted('loop-range')).toBeUndefined();
    expect(wrapper.emitted('ruler-seek')).toBeUndefined();
    wrapper.unmount();
  });
});
