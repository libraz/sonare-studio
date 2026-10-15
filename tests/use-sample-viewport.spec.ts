import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  LANE_HEIGHT_PX,
  MAX_VISIBLE_PEAK_CACHE_ENTRIES,
  peakBucketForDisplayColumn,
  useSampleViewport,
  VisiblePeaksCache,
  visiblePeakBucketCount,
} from '@/ui/sample-editor/use-sample-viewport';
import { type ChannelPeaks, computePeaks } from '@/ui/waveform/peaks';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useSampleViewport', () => {
  it('maps every max-zoom display column to a real non-empty peak bucket', () => {
    const widthPx = 800;
    const frameCount = 40;
    const bucketCount = visiblePeakBucketCount(widthPx, frameCount);
    const peaks = computePeaks([new Float32Array(frameCount).fill(1)], bucketCount)[0];
    const buckets = Array.from({ length: widthPx }, (_, column) =>
      peakBucketForDisplayColumn(column, widthPx, bucketCount),
    );

    expect(bucketCount).toBe(frameCount);
    expect(Math.min(...buckets)).toBe(0);
    expect(Math.max(...buckets)).toBe(frameCount - 1);
    expect(buckets.every((bucket) => peaks.min[bucket] !== 0 || peaks.max[bucket] !== 0)).toBe(
      true,
    );
  });

  it('draws max-zoom columns from source peaks instead of synthetic center-line buckets', async () => {
    const fillRect = vi.fn();
    const context = {
      fillRect,
      drawImage: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);

    let nextFrame = 1;
    const pendingFrames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        pendingFrames.push(callback);
        return nextFrame++;
      }),
    );

    const asset = ref<LoadedAudioAsset | null>(null);
    const selection = ref<null | { startFrame: number; endFrame: number }>(null);
    const Host = defineComponent({
      setup() {
        const viewport = useSampleViewport({
          asset,
          selection,
          onsetFrames: ref([]),
          noteRegions: ref([]),
          formatNote: (midi: number) => String(Math.round(midi)),
          selRange: () => null,
        });
        viewport.syncViewportToFrames(40);
        return () =>
          h('div', { ref: viewport.wrapRef }, [h('canvas', { ref: viewport.canvasRef })]);
      },
    });

    const wrapper = mount(Host);
    asset.value = {
      meta: {
        id: 'max-zoom',
        name: 'max-zoom',
        sampleRate: 48000,
        numChannels: 1,
        numFrames: 40,
      },
      channels: [new Float32Array(40).fill(1)],
    };
    await wrapper.vm.$nextTick();

    expect(pendingFrames).toHaveLength(1);
    pendingFrames.shift()?.(0);

    const waveformRects = fillRect.mock.calls.filter(([, , rectWidth]) => rectWidth === 1);
    expect(waveformRects).toHaveLength(800);
    expect(waveformRects.every(([, y]) => y < LANE_HEIGHT_PX / 2)).toBe(true);

    wrapper.unmount();
  });

  it('caches repeated visible-window peak scans and evicts the oldest window', () => {
    const cache = new VisiblePeaksCache();
    const make = vi.fn((): ChannelPeaks[] => [
      { min: new Float32Array([0]), max: new Float32Array([0]) },
    ]);
    const first = cache.getOrCompute('same-window', make);
    expect(cache.getOrCompute('same-window', make)).toBe(first);
    expect(make).toHaveBeenCalledOnce();

    for (let index = 0; index < MAX_VISIBLE_PEAK_CACHE_ENTRIES; index += 1) {
      cache.getOrCompute(`window-${index}`, make);
    }
    cache.getOrCompute('same-window', make);
    expect(make).toHaveBeenCalledTimes(MAX_VISIBLE_PEAK_CACHE_ENTRIES + 2);
  });

  it('cancels a queued draw frame on unmount', async () => {
    const requestAnimationFrame = vi.fn(() => 42);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

    const selection = ref<null | { startFrame: number; endFrame: number }>(null);
    const Host = defineComponent({
      setup() {
        const viewport = useSampleViewport({
          asset: ref(null),
          selection,
          onsetFrames: ref([]),
          noteRegions: ref([]),
          formatNote: (midi: number) => String(Math.round(midi)),
          selRange: () => null,
        });
        return () =>
          h('div', { ref: viewport.wrapRef }, [h('canvas', { ref: viewport.canvasRef })]);
      },
    });

    const wrapper = mount(Host);
    selection.value = { startFrame: 0, endFrame: 128 };
    await wrapper.vm.$nextTick();

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    wrapper.unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
  });

  it('keeps the backing store and cached waveform layer across selection-only redraws', async () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const context = {
      fillRect,
      drawImage,
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const widthSets = vi.fn();
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
      configurable: true,
      get: widthDescriptor?.get,
      set(value: number) {
        widthSets(this, value);
        widthDescriptor?.set?.call(this, value);
      },
    });

    const pendingFrames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => pendingFrames.push(callback)),
    );

    const asset = ref<LoadedAudioAsset | null>(null);
    const selection = ref<null | { startFrame: number; endFrame: number }>(null);
    const Host = defineComponent({
      setup() {
        const viewport = useSampleViewport({
          asset,
          selection,
          onsetFrames: ref([]),
          noteRegions: ref([]),
          formatNote: (midi: number) => String(Math.round(midi)),
          selRange: () => selection.value,
        });
        viewport.syncViewportToFrames(40);
        return () =>
          h('div', { ref: viewport.wrapRef }, [h('canvas', { ref: viewport.canvasRef })]);
      },
    });

    const wrapper = mount(Host);
    try {
      asset.value = {
        meta: { id: 'sel', name: 'sel', sampleRate: 48000, numChannels: 1, numFrames: 40 },
        channels: [new Float32Array(40).fill(1)],
      };
      await wrapper.vm.$nextTick();
      pendingFrames.shift()?.(0);
      const mainWidthSets = widthSets.mock.calls.filter(
        ([el]) => el === wrapper.find('canvas').element,
      ).length;
      fillRect.mockClear();

      selection.value = { startFrame: 4, endFrame: 20 };
      await wrapper.vm.$nextTick();
      pendingFrames.shift()?.(0);

      expect(
        widthSets.mock.calls.filter(([el]) => el === wrapper.find('canvas').element),
      ).toHaveLength(mainWidthSets);
      expect(fillRect.mock.calls.length).toBeLessThan(10);
      expect(drawImage).toHaveBeenCalled();
    } finally {
      if (widthDescriptor) {
        Object.defineProperty(HTMLCanvasElement.prototype, 'width', widthDescriptor);
      }
      wrapper.unmount();
    }
  });
});
