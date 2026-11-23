import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import PreviewPane from '@/components/mastering/PreviewPane.vue';
import type { MasteringChainState } from '@/project/mixer';
import { invalidStreamingPlatformCount } from '@/ui/mastering/streaming';
import type { MasteringPreview } from '@/ui/mastering/use-mastering-preview';
import { useMasteringPreviewAnalysis } from '@/ui/mastering/use-mastering-preview-analysis';

function makeAnalysis() {
  const preview = {
    previewState: ref(null),
    previewStale: ref(false),
    previewRevision: ref(0),
    projectRevision: ref(0),
    onPreview: async () => {},
  } as unknown as MasteringPreview;
  return useMasteringPreviewAnalysis({
    props: { decodeReference: null },
    chain: computed(() => ({ preset: 'streaming' }) as unknown as MasteringChainState),
    error: ref(''),
    runCommand: (action) => action(),
    preview,
  });
}

describe('streaming target number editing', () => {
  it.each(['', '-', ' '])('counts a %j entry as an invalid row', (text) => {
    const analysis = makeAnalysis();
    expect(invalidStreamingPlatformCount(analysis.streamingPlatforms.value)).toBe(0);
    analysis.onUpdateStreamingPlatform(0, 'targetLufs', text);
    expect(invalidStreamingPlatformCount(analysis.streamingPlatforms.value)).toBe(1);
    analysis.onUpdateStreamingPlatform(0, 'ceilingDbtp', text);
    expect(invalidStreamingPlatformCount(analysis.streamingPlatforms.value)).toBe(1);
  });

  it('accepts a valid number again after a blank entry', () => {
    const analysis = makeAnalysis();
    analysis.onUpdateStreamingPlatform(0, 'targetLufs', '');
    analysis.onUpdateStreamingPlatform(0, 'targetLufs', '-12');
    expect(analysis.streamingPlatforms.value[0]?.targetLufs).toBe(-12);
    expect(invalidStreamingPlatformCount(analysis.streamingPlatforms.value)).toBe(0);
  });
});

function mountPane(platforms: Array<{ name: string; targetLufs: number; ceilingDbtp: number }>) {
  return mount(PreviewPane, {
    props: {
      rendering: false,
      progress: 0,
      hasProcessed: false,
      hasBypassed: false,
      canPlay: false,
      playing: false,
      variant: 'processed',
      levelMatchEnabled: false,
      levelMatchAvailable: false,
      processedLevelMatchDb: 0,
      bypassedLevelMatchDb: 0,
      stale: false,
      checkingTargets: false,
      streamingPlatforms: platforms,
      loudnessRows: [],
      clipWarning: false,
      clipCensus: '',
      targetLimited: '',
      monoCompatibility: null,
      streamingTargets: null,
    } as never,
  });
}

describe('PreviewPane streaming target inputs', () => {
  it('renders a non-finite target as an empty field', async () => {
    const wrapper = mountPane([{ name: 'A', targetLufs: Number.NaN, ceilingDbtp: -1 }]);
    const inputs = wrapper.findAll<HTMLInputElement>('.targets-number-input');
    expect(inputs[0]?.element.value).toBe('');
    expect(inputs[1]?.element.value).toBe('-1');
  });

  it('keeps the name input mounted while its text changes', async () => {
    const wrapper = mountPane([{ name: 'A', targetLufs: -14, ceilingDbtp: -1 }]);
    const before = wrapper.find<HTMLInputElement>('.targets-name-input').element;
    await wrapper.setProps({
      streamingPlatforms: [{ name: 'AB', targetLufs: -14, ceilingDbtp: -1 }],
    });
    await nextTick();
    expect(wrapper.find<HTMLInputElement>('.targets-name-input').element).toBe(before);
  });
});
