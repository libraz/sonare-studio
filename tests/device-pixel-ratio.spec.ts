import { describe, expect, it, vi } from 'vitest';
import {
  type DevicePixelRatioEnvironment,
  observeDevicePixelRatio,
} from '@/ui/canvas/device-pixel-ratio';

describe('observeDevicePixelRatio', () => {
  it('re-arms at the new ratio and detaches on dispose', () => {
    let ratio = 1;
    let listener: (() => void) | null = null;
    const remove = vi.fn();
    const queries: string[] = [];
    const environment: DevicePixelRatioEnvironment = {
      get devicePixelRatio() {
        return ratio;
      },
      matchMedia(query) {
        queries.push(query);
        return {
          addEventListener: (_type: string, next: EventListenerOrEventListenerObject) => {
            listener = next as () => void;
          },
          removeEventListener: remove,
        } as unknown as MediaQueryList;
      },
    };
    const callback = vi.fn();

    const dispose = observeDevicePixelRatio(callback, environment);
    expect(queries).toEqual(['(resolution: 1dppx)']);

    ratio = 2;
    listener?.();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(queries).toEqual(['(resolution: 1dppx)', '(resolution: 2dppx)']);

    dispose();
    expect(remove).toHaveBeenCalled();
  });
});
