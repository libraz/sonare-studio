import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useMasteringPresetStage } from '@/ui/mastering/use-mastering-preset-stage';

vi.mock('@/project/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/project/runtime')>()),
  getWasmModule: () => ({ masteringPresetNames: () => ['warm'] }),
}));

describe('mastering preset stage by language', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;

  beforeEach(() => settings.set('language', 'ja'));
  afterEach(() => settings.set('language', previous));

  it('rejects an unknown preset with a Japanese message', () => {
    const thrown: unknown[] = [];
    const scope = effectScope();
    const stage = scope.run(() =>
      useMasteringPresetStage({
        chain: ref({}) as never,
        error: ref(''),
        runCommand: (action) => {
          try {
            action();
          } catch (err) {
            thrown.push(err);
          }
        },
      }),
    );
    stage?.onSelectPreset('missing');
    scope.stop();
    expect(thrown).toHaveLength(1);
    expect((thrown[0] as Error).message).toBe('不明なマスタリングプリセット: missing');
  });
});
