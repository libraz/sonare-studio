import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import StripMeter from '@/components/mixer/StripMeter.vue';
import { FADER_HEIGHT } from '@/ui/mixer/db-scale';
import { drawMeterBar } from '@/ui/mixer/meter-draw';
import { createMeterChannel } from '@/ui/mixer/meter-model';
import { fakeMeterSource } from './fakes/engine';

function recordingContext() {
  const rects: Array<[number, number, number, number]> = [];
  const ctx = {
    fillStyle: '',
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      rects.push([x, y, w, h]);
    }),
    setTransform: vi.fn(),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}

describe('drawMeterBar', () => {
  it('keeps every rect inside [top, top + height]', () => {
    const { ctx, rects } = recordingContext();
    const model = createMeterChannel(-60);
    model.rmsDb = -20;
    model.peakDb = -3;
    model.holdDb = 0;
    drawMeterBar(ctx, model, 0, 5, 7, 100, -60);
    expect(rects.length).toBeGreaterThan(0);
    for (const [, y, , h] of rects) {
      expect(y).toBeGreaterThanOrEqual(7);
      expect(y + h).toBeLessThanOrEqual(107 + 1.5);
    }
  });

  it('starts at the top edge when the offset is zero', () => {
    const { ctx, rects } = recordingContext();
    const model = createMeterChannel(-60);
    model.rmsDb = 0;
    drawMeterBar(ctx, model, 0, 5, 0, 100, -60);
    expect(Math.min(...rects.map((r) => r[1]))).toBe(0);
  });
});

describe('StripMeter peak readout rendering', () => {
  let rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafCallbacks.push(cb));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recordingContext().ctx);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not re-render the component while the hold readout decays', async () => {
    const bridge = fakeMeterSource({
      frame: 0,
      peakDbL: -6,
      peakDbR: -6,
      rmsDbL: -20,
      rmsDbR: -20,
      correlation: 0,
    });
    let updates = 0;
    const wrapper = mount(StripMeter, {
      props: { bridge },
      global: { directives: { tooltip: {} }, mixins: [{ updated: () => (updates += 1) }] },
    });
    const run = async (ts: number) => {
      rafCallbacks.pop()?.(ts);
      await nextTick();
    };
    await run(100);
    expect(wrapper.get('.strip-meter-peak').text()).toBe('-6.0');
    (bridge as { latest: unknown }).latest = {
      frame: 1,
      peakDbL: -60,
      peakDbR: -60,
      rmsDbL: -60,
      rmsDbR: -60,
      correlation: 0,
    };
    updates = 0;
    // Past the hold time, then several decaying frames.
    for (let i = 0; i < 10; i += 1) await run(1300 + i * 16);
    expect(Number(wrapper.get('.strip-meter-peak').text())).toBeLessThan(-6);
    expect(updates).toBe(0);
    wrapper.unmount();
  });

  it('defaults the meter height to the shared fader height', () => {
    const wrapper = mount(StripMeter, { global: { directives: { tooltip: {} } } });
    expect(wrapper.get('canvas').element.style.height).toBe(`${FADER_HEIGHT}px`);
    wrapper.unmount();
  });
});
