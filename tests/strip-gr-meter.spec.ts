import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
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

function makeMutableSource(levels: Partial<StereoMeterLevels> = {}): {
  source: MeterSource;
  emit: (levels: Partial<StereoMeterLevels>) => void;
  subscribeCount: () => number;
  unsubscribeCount: () => number;
} {
  let latest = sourceWith(levels).latest;
  const listeners = new Set<(levels: StereoMeterLevels) => void>();
  let subscribed = 0;
  let unsubscribed = 0;
  return {
    source: {
      get latest() {
        return latest;
      },
      subscribe(listener) {
        subscribed += 1;
        listeners.add(listener);
        return () => {
          unsubscribed += 1;
          listeners.delete(listener);
        };
      },
    },
    emit(next) {
      latest = { ...latest, ...next };
      for (const listener of listeners) listener(latest);
    },
    subscribeCount: () => subscribed,
    unsubscribeCount: () => unsubscribed,
  };
}

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('StripGrMeter', () => {
  it('shows the gain-reduction amount while the strip is reducing', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({ gainReductionDb: -4.3 }) } });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.strip-gr').exists()).toBe(true);
    expect(wrapper.find('.strip-gr-value').text()).toBe('-4.3');
  });

  it('treats the engine sign convention as a magnitude', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({ gainReductionDb: 6 }) } });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr-value').text()).toBe('-6.0');
  });

  it('stays hidden when there is no meaningful reduction', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({ gainReductionDb: 0 }) } });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr').exists()).toBe(false);
  });

  it('stays hidden for a source that reports no gain reduction', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({}) } });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr').exists()).toBe(false);
  });

  it('stays hidden without a bridge', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: null } });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr').exists()).toBe(false);
  });

  it('exposes an accessible meter role with the live value', async () => {
    wrapper = mount(StripGrMeter, { props: { bridge: sourceWith({ gainReductionDb: -3 }) } });
    await wrapper.vm.$nextTick();
    const meter = wrapper.find('.strip-gr');
    expect(meter.attributes('role')).toBe('meter');
    expect(meter.attributes('aria-valuenow')).toBe('3');
  });

  it('updates from bridge subscriptions and unsubscribes on source changes', async () => {
    const first = makeMutableSource();
    const second = makeMutableSource({ gainReductionDb: -2 });
    wrapper = mount(StripGrMeter, { props: { bridge: first.source } });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr').exists()).toBe(false);

    first.emit({ gainReductionDb: -5 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr-value').text()).toBe('-5.0');

    await wrapper.setProps({ bridge: second.source });
    expect(first.unsubscribeCount()).toBe(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr-value').text()).toBe('-2.0');
  });

  it('does not read or subscribe while the mixer dock is hidden', async () => {
    const source = makeMutableSource({ gainReductionDb: -2 });
    wrapper = mount(StripGrMeter, {
      props: { bridge: source.source, visible: false },
    });
    await wrapper.vm.$nextTick();

    expect(source.subscribeCount()).toBe(0);
    expect(wrapper.find('.strip-gr').exists()).toBe(false);

    await wrapper.setProps({ visible: true });
    await wrapper.vm.$nextTick();
    expect(source.subscribeCount()).toBe(1);
    expect(wrapper.find('.strip-gr-value').text()).toBe('-2.0');

    source.emit({ gainReductionDb: -4 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr-value').text()).toBe('-4.0');

    await wrapper.setProps({ visible: false });
    expect(source.unsubscribeCount()).toBe(1);
    source.emit({ gainReductionDb: -7 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.strip-gr-value').text()).toBe('-4.0');
  });
});
