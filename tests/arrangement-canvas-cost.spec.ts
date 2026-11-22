import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import ArrangementCanvas from '@/components/arrangement/ArrangementCanvas.vue';
import * as tempoMapModule from '@/project/tempo-map';
import { buildRowLayout } from '@/ui/arrangement/automation-rows';
import { useAutomationInteractions } from '@/ui/arrangement/use-automation-interactions';
import type { ClipCursor } from '@/ui/arrangement/use-clip-interactions';
import { useTakeInteractions } from '@/ui/arrangement/use-take-interactions';
import { TimelineRange } from '@/ui/canvas/timeline-range';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubEnvironment(): void {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => {}),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
}

function mountCanvas(overrides: Record<string, unknown> = {}) {
  stubEnvironment();
  const draws: Array<() => void> = [];
  const schedule = vi.fn((layer: string, draw: () => void) => {
    if (layer.startsWith('arrangement-base')) draws.push(draw);
  });
  const tracks = (overrides.tracks as unknown[]) ?? [{ id: 1, name: 'Piano', color: '#60a5fa' }];
  const wrapper = mount(ArrangementCanvas, {
    props: {
      range: new TimelineRange({ widthPx: 400, heightPx: 240, pxPerPpq: 10, rowHeight: 10 }),
      revision: 0,
      painter: { schedule, dispose: () => {} },
      tracks,
      clips: [],
      markers: [],
      activeTrackId: 1,
      activeClipId: -1,
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      scrollY: 0,
      laneHeight: 40,
      rowLayout: buildRowLayout([false], 40),
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
      },
      automationExpandedIds: [],
      automationParams: {},
      automationLanes: [],
      automation: useAutomationInteractions({
        view: { ppqToX: (ppq) => ppq * 10, xToPpq: (x) => x / 10, sublaneAt: () => null },
        getLanePoints: () => [],
        getGridPpq: () => 1,
        commands: { setPoints: vi.fn() },
      }),
      takesExpandedIds: [],
      takes: useTakeInteractions({
        view: { ppqToX: (ppq) => ppq * 10, xToPpq: (x) => x / 10, takeRowAt: () => null },
        getClips: () => [],
        commands: { setActiveTake: vi.fn(), setCompSegments: vi.fn() },
      }),
      ...overrides,
    },
  });
  return { wrapper, schedule, draws };
}

describe('ArrangementCanvas repaint triggers', () => {
  it.each([
    ['tempoSegments', { tempoSegments: [{ startPpq: 0, bpm: 90 }] }],
    ['laneHeight', { laneHeight: 56 }],
    ['rowLayout', { rowLayout: buildRowLayout([false], 40) }],
  ])('repaints when %s changes', async (_name, change) => {
    const { wrapper, schedule } = mountCanvas();
    await wrapper.vm.$nextTick();
    schedule.mockClear();
    await wrapper.setProps(change as never);
    expect(schedule).toHaveBeenCalled();
  });
});

describe('ArrangementCanvas tempo map', () => {
  it('normalizes the tempo map once across repeated base repaints', async () => {
    const spy = vi.spyOn(tempoMapModule, 'normalizeTempoMap');
    const { wrapper, draws } = mountCanvas({ tempoSegments: [{ startPpq: 0, bpm: 100 }] });
    await wrapper.setProps({ revision: 1 });
    const draw = draws[draws.length - 1];
    spy.mockClear();
    draw();
    draw();
    draw();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('ArrangementCanvas accessible clips', () => {
  it('resolves tracks through a map instead of a scan per clip', () => {
    let idReads = 0;
    const tracks = Array.from({ length: 20 }, (_, i) => {
      const track = { name: `T${i}`, color: '#fff' } as { id: number; name: string; color: string };
      Object.defineProperty(track, 'id', {
        enumerable: true,
        get() {
          idReads++;
          return i + 1;
        },
      });
      return track;
    });
    const clips = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      trackId: 20,
      name: `c${i}`,
      startPpq: i,
      lengthPpq: 1,
    }));
    mountCanvas({ tracks, clips, activeTrackId: 99 });
    expect(idReads).toBeLessThan(200);
  });
});
