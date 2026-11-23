import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppSettings } from '@/composables/useAppSettings';
import { decodeMasteringReference } from '@/ui/mastering/reference-audio';

/** A plain double: `decodeAudioData` resolves with the supplied decoded buffer. */
function offlineContextReturning(decoded: Record<string, unknown>): typeof OfflineAudioContext {
  return class {
    decodeAudioData(): Promise<unknown> {
      return Promise.resolve(decoded);
    }
  } as unknown as typeof OfflineAudioContext;
}

function fileOf(name: string): File {
  return new File([new Uint8Array(4)], name);
}

describe('mastering reference decoding by language', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;

  beforeEach(() => settings.set('language', 'ja'));
  afterEach(() => {
    settings.set('language', previous);
    vi.unstubAllGlobals();
  });

  it('reports a missing OfflineAudioContext in Japanese', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined);
    await expect(decodeMasteringReference(fileOf('ref.wav'))).rejects.toThrow(
      '音声をデコードできません: OfflineAudioContext に対応していません',
    );
  });

  it('reports an empty decode in Japanese', async () => {
    vi.stubGlobal(
      'OfflineAudioContext',
      offlineContextReturning({ numberOfChannels: 1, length: 0, sampleRate: 48000 }),
    );
    await expect(decodeMasteringReference(fileOf('ref.wav'))).rejects.toThrow(
      '参照音源には 1 サンプル以上の音声が必要です',
    );
  });

  it('names an unnamed file in Japanese', async () => {
    vi.stubGlobal(
      'OfflineAudioContext',
      offlineContextReturning({
        numberOfChannels: 1,
        length: 2,
        sampleRate: 48000,
        getChannelData: () => new Float32Array(2),
      }),
    );
    const decoded = await decodeMasteringReference(fileOf(''));
    expect(decoded.name).toBe('参照音源');
  });
});
