import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SpectrumAnalyzer from '@/components/mixer/SpectrumAnalyzer.vue';
import StereoGoniometer from '@/components/mixer/StereoGoniometer.vue';
import type { ScopeFrame, ScopeSource } from '@/engine/scope';

function makeContext() {
  return {
    beginPath: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
  };
}

function scopeWith(frame: ScopeFrame): { scope: ScopeSource; set: (next: ScopeFrame) => void } {
  let latest = frame;
  return {
    scope: {
      available: true,
      sampleRate: 48000,
      get latest() {
        return latest;
      },
      subscribe: () => () => {},
    },
    set: (next) => {
      latest = next;
    },
  };
}

function activeFrame(frame: number): ScopeFrame {
  return {
    frame,
    bands: new Float32Array(16).fill(-30),
    points: new Float32Array([0.5, 0.2, -0.3, 0.4]),
  };
}

describe('scope canvases skip unchanged frames', () => {
  let ctx: ReturnType<typeof makeContext>;
  let callbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    ctx = makeContext();
    callbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => callbacks.push(cb));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const tick = () => callbacks.pop()?.(0);

  it.each([
    ['StereoGoniometer', StereoGoniometer],
    ['SpectrumAnalyzer', SpectrumAnalyzer],
  ])('%s repaints only when the engine frame advances', (_name, component) => {
    const { scope, set } = scopeWith(activeFrame(10));
    const wrapper = mount(component, {
      props: { scope },
      global: { directives: { tooltip: {} } },
    });
    tick();
    const afterFirst = ctx.fillRect.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    tick();
    expect(ctx.fillRect.mock.calls.length).toBe(afterFirst);
    set(activeFrame(11));
    tick();
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(afterFirst);
    wrapper.unmount();
  });
});
