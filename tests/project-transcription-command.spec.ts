import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioAssetMeta } from '@/persistence/assets';
import type { AudioTranscriptionClip } from '@/project/audio-transcription';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  transcribeAudioClipToMidi,
  undo,
} from '@/project/commands';
import type { RawNote } from '@/project/midi-events';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const assetStore = vi.hoisted(() => ({
  loadAssetMeta: vi.fn<(id: string) => Promise<AudioAssetMeta>>(),
  loadAsset: vi.fn(),
  audioAssetUri: (assetId: string) => `asset:${assetId}`,
}));
vi.mock('@/persistence/assets', () => assetStore);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function note(pitch = 60): RawNote {
  return { pitch, startPpq: 0, durationPpq: 1, velocity: 100, channel: 0 };
}

describe('transcribeAudioClipToMidi', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    assetStore.loadAssetMeta.mockImplementation(async (id) => ({
      id,
      name: id,
      sampleRate: 48_000,
      numChannels: 1,
      numFrames: 48_000,
    }));
    await store.init();
  });

  async function sourceClip(): Promise<number> {
    const trackId = addAudioTrack({ name: 'Audio' });
    return addAudioClip({ trackId, assetId: 'asset-1', lengthPpq: 4, name: 'Source' });
  }

  it('writes one MIDI track/clip atomically and undo removes both', async () => {
    const clipId = await sourceClip();
    const beforeTracks = store.tracks.length;
    const beforeClips = store.clips.length;
    const transcribe = vi.fn(async (clip: AudioTranscriptionClip) => {
      expect(clip.assetId).toBe('asset-1');
      return [note()];
    });

    const newClipId = await transcribeAudioClipToMidi(clipId, { transcribe });

    expect(newClipId).toBeGreaterThan(0);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(store.tracks).toHaveLength(beforeTracks + 1);
    expect(store.clips).toHaveLength(beforeClips + 1);
    expect(store.clips.find((clip) => clip.id === newClipId)?.notes).toHaveLength(1);
    expect(undo()).toBe(true);
    expect(store.tracks).toHaveLength(beforeTracks);
    expect(store.clips).toHaveLength(beforeClips);
  });

  it('does not commit when the source identity changes while the adapter runs', async () => {
    const clipId = await sourceClip();
    const pending = deferred<RawNote[]>();
    const transcribe = vi.fn(() => pending.promise);
    const beforeTracks = store.tracks.length;
    const operation = transcribeAudioClipToMidi(clipId, { transcribe });
    store.clips = store.clips.map((clip) =>
      clip.id === clipId ? { ...clip, assetId: 'replacement-asset' } : clip,
    );
    pending.resolve([note(64)]);

    await expect(operation).resolves.toBe(-1);
    expect(store.tracks).toHaveLength(beforeTracks);
  });

  it('does not commit when the time-signature map changes while snapping is pending', async () => {
    const clipId = await sourceClip();
    const pending = deferred<RawNote[]>();
    const transcribe = vi.fn(() => pending.promise);
    const beforeTracks = store.tracks.length;
    const operation = transcribeAudioClipToMidi(clipId, { transcribe });
    store.timeSignatures = [{ startPpq: 0, numerator: 3, denominator: 4 }];
    pending.resolve([note(65)]);

    await expect(operation).resolves.toBe(-1);
    expect(store.tracks).toHaveLength(beforeTracks);
  });

  it('propagates user cancellation and leaves the project unchanged', async () => {
    const clipId = await sourceClip();
    const controller = new AbortController();
    const pending = deferred<RawNote[]>();
    const transcribe = vi.fn(
      (
        _clip: AudioTranscriptionClip,
        _tempo: number,
        _deps: unknown,
        options: { signal?: AbortSignal },
      ) => {
        options.signal?.addEventListener('abort', () => pending.resolve([note(67)]), {
          once: true,
        });
        return pending.promise;
      },
    );
    const beforeTracks = store.tracks.length;
    const operation = transcribeAudioClipToMidi(clipId, { signal: controller.signal, transcribe });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.tracks).toHaveLength(beforeTracks);
  });
});
