import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LevelMeter from '@/components/LevelMeter.vue';
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
});
