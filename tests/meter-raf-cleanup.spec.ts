import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import LevelMeter from '@/components/LevelMeter.vue';
import MasterMeterReadout from '@/components/mixer/MasterMeterReadout.vue';
import SpectrumAnalyzer from '@/components/mixer/SpectrumAnalyzer.vue';
import StereoGoniometer from '@/components/mixer/StereoGoniometer.vue';
import StripMeter from '@/components/mixer/StripMeter.vue';

function canvasContext(): Partial<CanvasRenderingContext2D> {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
  };
}

describe('meter and analyzer RAF cleanup', () => {
  let nextFrame = 0;

  beforeEach(() => {
    nextFrame = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => {
        nextFrame += 1;
        return nextFrame;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      canvasContext() as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['LevelMeter', LevelMeter, 1],
    ['StripMeter', StripMeter, 1],
    ['SpectrumAnalyzer', SpectrumAnalyzer, 1],
    ['StereoGoniometer', StereoGoniometer, 1],
  ])('%s cancels its animation frame on unmount', (_name, component, frameId) => {
    const wrapper = mount(component, {
      global: {
        directives: {
          tooltip: {},
        },
      },
    });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(frameId);
  });

  it('starts animation when a mounted placeholder receives a live meter', async () => {
    const wrapper = mount(StripMeter, {
      props: { placeholder: true },
      global: { directives: { tooltip: {} } },
    });

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    await wrapper.setProps({ placeholder: false });
    await nextTick();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ placeholder: true });
    await nextTick();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    wrapper.unmount();
  });

  it.each([
    ['StripMeter', StripMeter],
    ['MasterMeterReadout', MasterMeterReadout],
    ['SpectrumAnalyzer', SpectrumAnalyzer],
    ['StereoGoniometer', StereoGoniometer],
  ])('%s does not schedule frames while its mixer dock is hidden', async (_name, component) => {
    const wrapper = mount(component, {
      props: { visible: false },
      global: { directives: { tooltip: {} } },
    });

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    await wrapper.setProps({ visible: true });
    await nextTick();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ visible: false });
    await nextTick();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    wrapper.unmount();
  });
});
