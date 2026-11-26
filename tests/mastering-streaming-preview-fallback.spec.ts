import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import type { MasteringChainState } from '@/project/mixer';
import type { MasteringPreview } from '@/ui/mastering/use-mastering-preview';

const ensureWasmMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/wasm', () => ({ ensureWasm: ensureWasmMock }));

import { useMasteringPreviewAnalysis } from '@/ui/mastering/use-mastering-preview-analysis';

describe('mastering streaming preview fallback', () => {
  it('measures true peak when the processed report has no dBTP value', async () => {
    const left = new Float32Array([0.25, 0.5]);
    const right = new Float32Array([0.125, 0.25]);
    const previewStereo = vi.fn(() => ({
      platforms: [
        {
          name: 'Spotify',
          integratedLufs: -14,
          truePeakDbtp: -0.75,
          normalizationGainDb: 0,
          ceilingRisk: false,
        },
      ],
    }));
    ensureWasmMock.mockResolvedValueOnce({ masteringStreamingPreviewStereo: previewStereo });

    const preview = {
      previewState: ref({
        processed: {
          channels: [left, right],
          sampleRate: 48000,
          report: { peakDb: -6, lufs: -14 },
        },
      }),
      previewStale: ref(false),
      previewRevision: ref(1),
      projectRevision: ref(1),
      onPreview: vi.fn(async () => undefined),
    } as unknown as MasteringPreview;
    const analysis = useMasteringPreviewAnalysis({
      props: { decodeReference: null },
      chain: computed(() => ({ preset: 'streaming' }) as unknown as MasteringChainState),
      error: ref(''),
      runCommand: (action) => action(),
      preview,
    });

    await analysis.onCheckTargets();

    expect(previewStereo).toHaveBeenCalledTimes(1);
    expect(previewStereo).toHaveBeenCalledWith({
      left,
      right,
      sampleRate: 48000,
      platforms: analysis.streamingPlatforms.value,
    });
    expect(analysis.streamingTargets.value).toEqual([
      {
        name: 'Spotify',
        integratedLufs: -14,
        truePeakDbtp: -0.75,
        normalizationGainDb: 0,
        ceilingRisk: false,
      },
    ]);
  });
});
