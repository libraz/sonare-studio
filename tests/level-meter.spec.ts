import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LevelMeter from '@/components/LevelMeter.vue';
import type { MeterBridge, MeterSource, StereoMeterLevels } from '@/engine/meters';
import {
  advanceMeterChannel,
  createMeterChannel,
  METER_MIN_DB,
  meterFraction,
} from '@/ui/mixer/meter-model';
import { fakeMeterSource } from './fakes/engine';

function levels(overrides: Partial<StereoMeterLevels> = {}): StereoMeterLevels {
  return {
    frame: 0,
    peakDbL: -18,
    peakDbR: -18,
    rmsDbL: -24,
    rmsDbR: -24,
    correlation: 0,
    ...overrides,
  };
}

function mutableBridge(initial: StereoMeterLevels): {
  bridge: MeterBridge;
  setLevels: (next: Partial<StereoMeterLevels>) => void;
} {
  let latest = initial;
  const source: MeterSource = {
    ...fakeMeterSource(),
    get latest() {
      return latest;
    },
  };
  return {
    bridge: {
      get latest() {
        return source.latest;
      },
      subscribe: source.subscribe,
      subscribeInsertGainReduction: source.subscribeInsertGainReduction,
      forTarget: () => source,
      dispose: () => {},
    },
    setLevels(next) {
      latest = { ...latest, ...next };
    },
  };
}

function canvasContext(): Partial<CanvasRenderingContext2D> {
  return {
    fillRect: vi.fn(),
    fillText: vi.fn(),
    setTransform: vi.fn(),
  };
}

let rafCallbacks: FrameRequestCallback[] = [];
let context: Partial<CanvasRenderingContext2D>;
let wrapper: VueWrapper | null = null;

beforeEach(() => {
  rafCallbacks = [];
  context = canvasContext();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function tick(ts: number): Promise<void> {
  const callback = rafCallbacks.shift();
  callback?.(ts);
  await wrapper?.vm.$nextTick();
}

describe('LevelMeter', () => {
  it('follows the shared channel ballistics for each snapshot step', async () => {
    const source = mutableBridge(levels({ peakDbL: -6, peakDbR: -12, rmsDbL: -12, rmsDbR: -18 }));
    wrapper = mount(LevelMeter, { props: { bridge: source.bridge, width: 64, height: 180 } });

    const expectedLeft = createMeterChannel(METER_MIN_DB);
    advanceMeterChannel(expectedLeft, { peakDb: -6, rmsDb: -12 }, 0, 16, METER_MIN_DB);
    const firstPeakY = (1 - meterFraction(expectedLeft.peakDb, METER_MIN_DB)) * 180 - 1;
    await tick(16);
    source.setLevels({ peakDbL: METER_MIN_DB, rmsDbL: METER_MIN_DB });
    advanceMeterChannel(
      expectedLeft,
      { peakDb: METER_MIN_DB, rmsDb: METER_MIN_DB },
      0.1,
      116,
      METER_MIN_DB,
    );
    await tick(116);

    const peakCalls = (context.fillRect as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[3] === 1.5,
    );
    expect(peakCalls[0]?.[1]).toBeCloseTo(firstPeakY);
    expect(peakCalls[2]?.[1]).toBeCloseTo(
      (1 - meterFraction(expectedLeft.peakDb, METER_MIN_DB)) * 180 - 1,
    );
  });

  it('latches clipping and resets it on click like the strip meter', async () => {
    const source = mutableBridge(levels({ peakDbL: 1, peakDbR: -3 }));
    wrapper = mount(LevelMeter, { props: { bridge: source.bridge } });

    await tick(16);
    const canvas = wrapper.get('canvas');
    expect(canvas.attributes('aria-label')).toBe('Clipped - click to reset');

    await canvas.trigger('click');
    expect(canvas.attributes('aria-label')).toBe('Stereo level meter');

    source.setLevels({ peakDbL: METER_MIN_DB, peakDbR: METER_MIN_DB });
    await tick(32);
    expect(canvas.attributes('aria-label')).toBe('Stereo level meter');
  });
});
