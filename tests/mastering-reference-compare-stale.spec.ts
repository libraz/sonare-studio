import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import type { MasteringChainState } from '@/project/mixer';
import type { MasteringReferenceAudio } from '@/ui/mastering/reference-audio';
import type { MasteringPreview } from '@/ui/mastering/use-mastering-preview';

vi.mock('@/lib/wasm', () => ({ ensureWasm: async () => ({}) }));
vi.mock('@/ui/sample-editor/wasm-ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  analyzeMatchEqToReference: () => ({ compared: true }),
}));

const { useMasteringPreviewAnalysis } = await import(
  '@/ui/mastering/use-mastering-preview-analysis'
);

function reference(tag: number): MasteringReferenceAudio {
  return { channels: [new Float32Array([tag])], sampleRate: 48000 } as MasteringReferenceAudio;
}

function fileEvent(name: string): Event {
  return { target: { files: [new File([], name)] } } as unknown as Event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeAnalysis(
  decodeReference: (file: File) => Promise<MasteringReferenceAudio>,
  onPreview: () => Promise<void> = async () => undefined,
) {
  const previewState = ref<unknown>({
    processed: {
      channels: [new Float32Array(4)],
      sampleRate: 48000,
      report: { lufs: -14, truePeakDbtp: -1, peakDb: -1 },
    },
  });
  const previewStale = ref(false);
  const preview = {
    previewState,
    previewStale,
    previewRevision: ref(0),
    projectRevision: ref(1),
    onPreview: async () => {
      await onPreview();
      previewStale.value = false;
    },
  } as unknown as MasteringPreview;
  const analysis = useMasteringPreviewAnalysis({
    props: { decodeReference },
    chain: computed(() => ({ preset: 'streaming' }) as unknown as MasteringChainState),
    error: ref(''),
    runCommand: (action) => action(),
    preview,
  });
  return { analysis, previewStale };
}

describe('mastering reference comparison', () => {
  it('keeps the latest picked reference when an earlier decode finishes last', async () => {
    const decodes = new Map<string, ReturnType<typeof deferred<MasteringReferenceAudio>>>();
    const { analysis } = makeAnalysis((file) => {
      const pending = deferred<MasteringReferenceAudio>();
      decodes.set(file.name, pending);
      return pending.promise;
    });
    const first = analysis.onReferenceFile(fileEvent('a.wav'));
    const second = analysis.onReferenceFile(fileEvent('b.wav'));
    const b = reference(2);
    decodes.get('b.wav')?.resolve(b);
    await second;
    decodes.get('a.wav')?.resolve(reference(1));
    await first;
    expect(analysis.referenceAudio.value).toBe(b);
  });

  it('drops a comparison whose reference was replaced while the preview rendered', async () => {
    let made!: ReturnType<typeof makeAnalysis>;
    made = makeAnalysis(
      async () => reference(1),
      async () => {
        await made.analysis.onReferenceFile(fileEvent('replacement.wav'));
      },
    );
    await made.analysis.onReferenceFile(fileEvent('original.wav'));
    made.previewStale.value = true;
    await made.analysis.onCompareReference();
    expect(made.analysis.referenceAnalysis.value).toBeNull();
  });
});
