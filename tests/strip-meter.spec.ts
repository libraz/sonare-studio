import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import StripMeter from '@/components/mixer/StripMeter.vue';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';
import { fakeMeterSource } from './fakes/engine';

function canvasContext(): Partial<CanvasRenderingContext2D> {
  return {
    fillRect: vi.fn(),
    setTransform: vi.fn(),
  };
}

function sourceWith(levels: Partial<StereoMeterLevels>): MeterSource {
  return fakeMeterSource({ peakDbL: -18, peakDbR: -18, rmsDbL: -24, rmsDbR: -24, ...levels });
}

let rafCallbacks: FrameRequestCallback[] = [];
let wrapper: VueWrapper | null = null;

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    canvasContext() as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function tick(ts = 0): Promise<void> {
  const callback = rafCallbacks.at(-1);
  rafCallbacks.length = 0;
  callback?.(ts);
  await nextTick();
}

describe('StripMeter peak readout', () => {
  it('shows -inf at the silence floor and numeric values above it', async () => {
    wrapper = mount(StripMeter, {
      props: { bridge: sourceWith({}) },
      global: { directives: { tooltip: {} } },
    });

    expect(wrapper.find('.strip-meter-peak').text()).toBe('-inf');
    await tick();
    expect(wrapper.find('.strip-meter-peak').text()).toBe('-18.0');
  });
});
