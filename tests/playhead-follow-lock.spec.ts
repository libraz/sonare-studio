import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { usePlayheadFollow } from '@/ui/arrangement/use-playhead-follow';
import { TimelineRange } from '@/ui/canvas/timeline-range';

const PX_PER_PPQ = 100;
const PPQ_PER_FRAME = 0.5;

describe('playhead follow lock', () => {
  let frames: Array<(now: number) => void> = [];

  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the content under the pinned line at the transport position', () => {
    const range = new TimelineRange({
      widthPx: 1200,
      heightPx: 100,
      pxPerPpq: PX_PER_PPQ,
      rowHeight: 10,
    });
    let ppq = 20;
    const anchor = 360 - 60;
    const Harness = defineComponent({
      setup() {
        usePlayheadFollow({
          range,
          bump: () => {},
          isPlaying: () => true,
          followEnabled: () => true,
          positionPpq: () => ppq,
          leadingColumnWidthPx: 60,
        });
        return () => h('div');
      },
    });
    mount(Harness);
    let now = 0;
    for (let i = 0; i < 60; i++) {
      now += 40;
      ppq += PPQ_PER_FRAME;
      const batch = frames;
      frames = [];
      for (const cb of batch) cb(now);
    }
    const lagPx = (ppq - (range.startPpq + anchor / PX_PER_PPQ)) * PX_PER_PPQ;
    expect(lagPx).toBeLessThanOrEqual(1);
  });
});
