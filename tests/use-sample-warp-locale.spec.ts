import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useSampleWarp } from '@/ui/sample-editor/use-sample-warp';

vi.mock('@/project/commands', () => ({ setClipWarp: () => {} }));

function runAutoWarp(frames: number, beats: number[]): Promise<string[]> {
  const project = reactive({
    clips: [
      {
        id: 7,
        kind: 'audio',
        assetId: 'asset-1',
        lengthPpq: 8,
        sourceOffsetPpq: 0,
        gain: 1,
        loopEnabled: false,
        loopLengthPpq: 0,
        notes: [],
        trackId: 1,
        startPpq: 0,
      },
    ],
    clipId: 7,
    tempoBpm: 120,
    tempoSegments: [],
  });
  const errors: string[] = [];
  const scope = effectScope();
  const warp = scope.run(() =>
    useSampleWarp({
      project: project as never,
      assetId: () => 'asset-1',
      setError: (message) => errors.push(message),
      autoWarp: {
        loadAudioAsset: async () =>
          ({
            meta: { id: 'asset-1', name: 'a.wav', sampleRate: 48_000, numChannels: 1 },
            channels: [new Float32Array(frames).fill(0.5)],
          }) as never,
        detectBeats: () => beats,
        detectDownbeats: () => [],
      },
    }),
  );
  return (warp?.onAutoWarp() ?? Promise.resolve()).then(() => {
    scope.stop();
    return errors;
  });
}

describe('auto-warp errors by language', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;

  beforeEach(() => settings.set('language', 'ja'));
  afterEach(() => settings.set('language', previous));

  it('reports an empty source window in Japanese', async () => {
    expect(await runAutoWarp(0, [])).toEqual(['自動ワープには空でない音声範囲が必要です']);
  });

  it('reports too few beats in Japanese', async () => {
    expect(await runAutoWarp(96_000, [])).toEqual([
      '自動ワープに必要なビートを十分に検出できませんでした',
    ]);
  });
});
