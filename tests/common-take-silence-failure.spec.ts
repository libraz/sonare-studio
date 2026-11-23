import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { commonTakeSilence } from '@/project/take-silence';
import { normalizeTempoMap } from '@/project/tempo-map';
import type { EditorClip } from '@/project/types';
import { useCommonTakeSilence } from '@/ui/arrangement/use-common-take-silence';

vi.mock('@/project/take-silence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/project/take-silence')>();
  return { ...actual, commonTakeSilence: vi.fn() };
});

afterEach(() => {
  vi.mocked(commonTakeSilence).mockReset();
});

const clip = {
  id: 1,
  trackId: 1,
  kind: 'audio',
  name: 'comp',
  startPpq: 0,
  lengthPpq: 4,
  sourceOffsetPpq: 0,
  loopEnabled: false,
  loopLengthPpq: 0,
  notes: [],
  takes: [
    { id: 1, assetId: 'a' },
    { id: 2, assetId: 'b' },
  ],
} as unknown as EditorClip;

const tempo = normalizeTempoMap([{ startPpq: 0, bpm: 120 }]);

describe('useCommonTakeSilence failures', () => {
  it('scans a clip again after its previous scan failed', async () => {
    const span = { startPpq: 1, endPpq: 2 };
    vi.mocked(commonTakeSilence)
      .mockRejectedValueOnce(new Error('asset busy'))
      .mockResolvedValue([span]);
    const expanded = ref<number[]>([1]);
    const silence = useCommonTakeSilence({
      clips: () => [clip],
      expandedTrackIds: () => expanded.value,
      tempo: () => tempo,
      deps: async () => ({}) as never,
    });
    await vi.waitFor(() => expect(silence.byClip.value.get(1)).toEqual([]));

    // Closing and reopening the take rows refreshes the scan.
    expanded.value = [];
    await nextTick();
    expanded.value = [1];

    await vi.waitFor(() => expect(silence.byClip.value.get(1)).toEqual([span]));
  });

  it('treats a failed dependency load as unavailable instead of rejecting', async () => {
    const failure = vi.fn(async () => {
      throw new Error('wasm failed to load');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const silence = useCommonTakeSilence({
        clips: () => [clip],
        expandedTrackIds: () => [1],
        tempo: () => tempo,
        deps: failure,
      });
      await vi.waitFor(() => expect(failure).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(silence.byClip.value.size).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
