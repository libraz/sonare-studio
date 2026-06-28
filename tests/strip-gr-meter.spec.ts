import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StripGrMeter from '@/components/mixer/StripGrMeter.vue';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';

/** A meter source returning fixed levels. */
function sourceWith(levels: Partial<StereoMeterLevels>): MeterSource {
  const full: StereoMeterLevels = {
    frame: 0,
    peakDbL: -6,
    peakDbR: -6,
    rmsDbL: -12,
    rmsDbR: -12,
    correlation: 0,
    ...levels,
  };
  return { latest: full, subscribe: () => () => {} };
}

let rafCallbacks: FrameRequestCallback[] = [];
let wrapper: VueWrapper | null = null;

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

/** Drives the readout's rAF loop once with a timestamp past the throttle. */
async function tick(w: VueWrapper, ts = 200): Promise<void> {
  const cb = rafCallbacks.at(-1);
  rafCallbacks.length = 0;
  cb?.(ts);
  await w.vm.$nextTick();
}

describe('StripGrMeter', () => {
  it('shows the gain-reduction amount while the strip is reducing', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({ gainReductionDb: -4.3 }) } });
    // Nothing renders before the first throttled frame.
    expect(wrapper.find('.strip-gr').exists()).toBe(false);

    await tick(wrapper);

    expect(wrapper.find('.strip-gr').exists()).toBe(true);
    expect(wrapper.find('.strip-gr-value').text()).toBe('-4.3');
  });

  it('treats the engine sign convention as a magnitude', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({ gainReductionDb: 6 }) } });
    await tick(wrapper);
    expect(wrapper.find('.strip-gr-value').text()).toBe('-6.0');
  });

  it('stays hidden when there is no meaningful reduction', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({ gainReductionDb: 0 }) } });
    await tick(wrapper);
    expect(wrapper.find('.strip-gr').exists()).toBe(false);
  });

  it('stays hidden for a source that reports no gain reduction', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({}) } });
    await tick(wrapper);
    expect(wrapper.find('.strip-gr').exists()).toBe(false);
  });

  it('stays hidden without a bridge', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: null } });
    await tick(wrapper);
    expect(wrapper.find('.strip-gr').exists()).toBe(false);
  });

  it('exposes an accessible meter role with the live value', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({ gainReductionDb: -3 }) } });
    await tick(wrapper);
    const meter = wrapper.find('.strip-gr');
    expect(meter.attributes('role')).toBe('meter');
    expect(meter.attributes('aria-valuenow')).toBe('3');
  });
});
