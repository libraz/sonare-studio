import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MasterMeterReadout from '@/components/mixer/MasterMeterReadout.vue';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';

/** A meter source returning fixed levels (a frame-by-frame stream is not needed). */
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

/**
 * Drives the readout's rAF loop once with a timestamp past the throttle.
 * Uses the most recently registered callback (the mounted component re-arms
 * the loop each frame) and drops any stale ones from prior mounts, since the
 * stubbed cancelAnimationFrame cannot remove them.
 */
async function tick(w: VueWrapper, ts = 200): Promise<void> {
  const cb = rafCallbacks.at(-1);
  rafCallbacks.length = 0;
  cb?.(ts);
  await w.vm.$nextTick();
}

describe('MasterMeterReadout', () => {
  it('shows LUFS, true peak and correlation once data arrives', async () => {
    wrapper = mount(MasterMeterReadout, {
      props: {
        bridge: sourceWith({
          momentaryLufs: -14.2,
          shortTermLufs: -13.8,
          integratedLufs: -12,
          truePeakDbL: -3,
          truePeakDbR: -1.5,
          correlation: 0.5,
        }),
      },
    });
    // Nothing renders before the first throttled frame.
    expect(wrapper.find('.master-meter').exists()).toBe(false);

    await tick(wrapper);

    const text = wrapper.find('.master-meter').text();
    expect(text).toContain('-14.2');
    expect(text).toContain('-13.8');
    expect(text).toContain('-12.0');
    // True peak shows the louder channel.
    expect(wrapper.find('.mm-tp .mm-value').text()).toBe('-1.5');
    expect(wrapper.find('.mm-corr').exists()).toBe(true);
  });

  it('flags a true-peak clipping risk', async () => {
    wrapper = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ momentaryLufs: -9, truePeakDbL: -0.1, truePeakDbR: -2 }) },
    });
    await tick(wrapper);
    expect(wrapper.find('.mm-tp').classes()).toContain('risk');
  });

  it('shows the gain-reduction row only while the master is reducing', async () => {
    const reducing = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ momentaryLufs: -9, truePeakDbL: -3, gainReductionDb: -4.3 }) },
    });
    await tick(reducing);
    expect(reducing.find('.mm-gr').exists()).toBe(true);
    expect(reducing.find('.mm-gr .mm-value').text()).toBe('-4.3');
    reducing.unmount();

    wrapper = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ momentaryLufs: -9, truePeakDbL: -3, gainReductionDb: 0 }) },
    });
    await tick(wrapper);
    expect(wrapper.find('.master-meter').exists()).toBe(true);
    expect(wrapper.find('.mm-gr').exists()).toBe(false);
  });

  it('shows the loudness delta against the target and flags going over', async () => {
    const over = mount(MasterMeterReadout, {
      props: {
        bridge: sourceWith({ momentaryLufs: -9, integratedLufs: -11, truePeakDbL: -3 }),
        targetLufs: -14,
      },
    });
    await tick(over);
    expect(over.find('.mm-target .mm-value').text()).toBe('+3.0');
    expect(over.find('.mm-target').classes()).toContain('over');
    over.unmount();

    wrapper = mount(MasterMeterReadout, {
      props: {
        bridge: sourceWith({ momentaryLufs: -9, integratedLufs: -16, truePeakDbL: -3 }),
        targetLufs: -14,
      },
    });
    await tick(wrapper);
    expect(wrapper.find('.mm-target .mm-value').text()).toBe('-2.0');
    expect(wrapper.find('.mm-target').classes()).not.toContain('over');
  });

  it('hides the loudness delta until an integrated reading exists', async () => {
    wrapper = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ momentaryLufs: -9, truePeakDbL: -3 }), targetLufs: -14 },
    });
    await tick(wrapper);
    expect(wrapper.find('.master-meter').exists()).toBe(true);
    expect(wrapper.find('.mm-target').exists()).toBe(false);
  });

  it('marks an out-of-phase correlation', async () => {
    wrapper = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ momentaryLufs: -9, truePeakDbL: -3, correlation: -0.7 }) },
    });
    await tick(wrapper);
    expect(wrapper.find('.mm-corr-fill').classes()).toContain('neg');
  });

  it('stays hidden for a source without loudness data', async () => {
    wrapper = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ peakDbL: -3, peakDbR: -3 }) },
    });
    await tick(wrapper);
    expect(wrapper.find('.master-meter').exists()).toBe(false);
  });

  it('stays hidden without a bridge', async () => {
    wrapper = mount(MasterMeterReadout, { props: { bridge: null } });
    await tick(wrapper);
    expect(wrapper.find('.master-meter').exists()).toBe(false);
  });
});
