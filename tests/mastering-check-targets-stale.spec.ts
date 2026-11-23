import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import type { MasteringChainState } from '@/project/mixer';
import type { MasteringPreview } from '@/ui/mastering/use-mastering-preview';
import { useMasteringPreviewAnalysis } from '@/ui/mastering/use-mastering-preview-analysis';

function processedPreview(lufs: number) {
  return {
    processed: {
      channels: [new Float32Array(4), new Float32Array(4)],
      sampleRate: 48000,
      report: { lufs, truePeakDbtp: -1, peakDb: -1 },
    },
  };
}

function makeAnalysis(onPreview: (state: ReturnType<typeof ref>) => Promise<void>) {
  const previewState = ref<unknown>(processedPreview(-20));
  const previewStale = ref(true);
  const error = ref('');
  const preview = {
    previewState,
    previewStale,
    previewRevision: ref(0),
    projectRevision: ref(1),
    onPreview: () => onPreview(previewState),
  } as unknown as MasteringPreview;
  const analysis = useMasteringPreviewAnalysis({
    props: { decodeReference: null },
    chain: computed(() => ({ preset: 'streaming' }) as unknown as MasteringChainState),
    error,
    runCommand: (action) => action(),
    preview,
  });
  return { analysis, error, previewState, previewStale };
}

describe('streaming target check against a stale preview', () => {
  it('measures nothing when the preview is still stale after re-rendering', async () => {
    // The re-render does not complete (the project moved on), so the old render stays stale.
    const { analysis, error } = makeAnalysis(async () => undefined);

    await analysis.onCheckTargets();

    expect(analysis.streamingTargets.value).toBeNull();
    expect(error.value).not.toBe('');
  });

  it('measures against the platform list as it is when the render finishes', async () => {
    let analysis!: ReturnType<typeof makeAnalysis>['analysis'];
    const made = makeAnalysis(async (state) => {
      analysis.onUpdateStreamingPlatform(0, 'targetLufs', '-9');
      state.value = processedPreview(-20);
      made.previewStale.value = false;
    });
    analysis = made.analysis;

    await analysis.onCheckTargets();

    expect(analysis.streamingTargets.value?.[0]?.normalizationGainDb).toBe(11);
  });
});
