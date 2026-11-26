import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MasterMeterReadout from '@/components/mixer/MasterMeterReadout.vue';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';
import { fakeMeterSource } from './fakes/engine';

/** A meter source returning fixed levels (a frame-by-frame stream is not needed). */
function sourceWith(levels: Partial<StereoMeterLevels>): MeterSource {
  const full: StereoMeterLevels = {
    frame: 0,
    peakDbL: -6,
    peakDbR: -6,
    rmsDbL: -12,
    rmsDbR: -12,
    ...levels,
  };
  return fakeMeterSource(full);
}

let rafCallbacks: FrameRequestCallback[] = [];
let wrapper: VueWrapper | null = null;
let cancelAnimationFrameMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  cancelAnimationFrameMock = vi.fn();
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);
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
          truePeakDbtpL: -3,
          truePeakDbtpR: -1.5,
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
      props: { bridge: sourceWith({ momentaryLufs: -9, truePeakDbtpL: -0.1, truePeakDbtpR: -2 }) },
    });
    await tick(wrapper);
    expect(wrapper.find('.mm-tp').classes()).toContain('risk');
  });

  it('shows the gain-reduction row only while the master is reducing', async () => {
    const reducing = mount(MasterMeterReadout, {
      props: {
        bridge: sourceWith({ momentaryLufs: -9, truePeakDbtpL: -3, gainReductionDb: -4.3 }),
      },
    });
    await tick(reducing);
    expect(reducing.find('.mm-gr').exists()).toBe(true);
    expect(reducing.find('.mm-gr .mm-value').text()).toBe('-4.3');
    reducing.unmount();

    wrapper = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ momentaryLufs: -9, truePeakDbtpL: -3, gainReductionDb: 0 }) },
    });
    await tick(wrapper);
    expect(wrapper.find('.master-meter').exists()).toBe(true);
    expect(wrapper.find('.mm-gr').exists()).toBe(false);
  });

  it('shows the loudness delta against the target and flags going over', async () => {
    const over = mount(MasterMeterReadout, {
      props: {
        bridge: sourceWith({ momentaryLufs: -9, integratedLufs: -11, truePeakDbtpL: -3 }),
        targetLufs: -14,
      },
    });
    await tick(over);
    expect(over.find('.mm-target .mm-value').text()).toBe('+3.0');
    expect(over.find('.mm-target').classes()).toContain('over');
    over.unmount();

    wrapper = mount(MasterMeterReadout, {
      props: {
        bridge: sourceWith({ momentaryLufs: -9, integratedLufs: -16, truePeakDbtpL: -3 }),
        targetLufs: -14,
      },
    });
    await tick(wrapper);
    expect(wrapper.find('.mm-target .mm-value').text()).toBe('-2.0');
    expect(wrapper.find('.mm-target').classes()).not.toContain('over');
  });

  it('hides the loudness delta until an integrated reading exists', async () => {
    wrapper = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ momentaryLufs: -9, truePeakDbtpL: -3 }), targetLufs: -14 },
    });
    await tick(wrapper);
    expect(wrapper.find('.master-meter').exists()).toBe(true);
    expect(wrapper.find('.mm-target').exists()).toBe(false);
  });

  it('marks an out-of-phase correlation', async () => {
    wrapper = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ momentaryLufs: -9, truePeakDbtpL: -3, correlation: -0.7 }) },
    });
    await tick(wrapper);
    expect(wrapper.find('.mm-corr-fill').classes()).toContain('neg');
  });

  it('shows measured silence and waits for a correlation reading', async () => {
    wrapper = mount(MasterMeterReadout, {
      props: { bridge: sourceWith({ integratedLufs: -Infinity }) },
    });
    await tick(wrapper);
    expect(wrapper.findAll('.mm-lufs .mm-value').map((cell) => cell.text())).toEqual([
      '—',
      '—',
      '-∞',
    ]);
    expect(wrapper.find('.mm-corr').exists()).toBe(false);

    await wrapper.setProps({ bridge: sourceWith({ integratedLufs: -Infinity, correlation: 0 }) });
    await tick(wrapper, 400);
    expect(wrapper.find('.mm-corr').attributes('aria-valuenow')).toBe('0');
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

  it('cancels the polling frame on unmount', () => {
    wrapper = mount(MasterMeterReadout, { props: { bridge: null } });
    expect(rafCallbacks).toHaveLength(1);

    wrapper.unmount();
    wrapper = null;

    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(1);
  });
});
