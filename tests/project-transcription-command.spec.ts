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

  it('matches the project tempo and bar lines to the recording in one undoable edit', async () => {
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({ trackId, assetId: 'asset-1', lengthPpq: 32, name: 'Take' });
    assetStore.loadAsset.mockResolvedValue({
      meta: {
        id: 'asset-1',
        name: 'Take',
        sampleRate: 48_000,
        numChannels: 1,
        numFrames: 48_000 * 16,
      },
      channels: [new Float32Array(48_000 * 16).fill(0.1)],
    });
    const beforeTempo = store.tempoBpm;
    const beforeClips = store.clips.length;
    // A 128 BPM take whose first downbeat is 0.3 s in, onsets 0.05 beat late.
    const beats = Array.from({ length: 30 }, (_, index) => 0.3 + (index * 60) / 128);
    const downbeatBeats = (0.3 * 128) / 60;
    let tempoSeen: number | undefined;

    const newClipId = await transcribeAudioClipToMidi(clipId, {
      matchTempo: true,
      detectBeats: async () => ({ beats, downbeats: [beats[0], beats[4], beats[8]] }),
      transcribe: async (_clip, tempoBpm) => {
        tempoSeen = tempoBpm;
        return Array.from({ length: 16 }, (_, index) => ({
          ...note(60 + (index % 5)),
          startPpq: downbeatBeats + index * 0.5 + 0.05,
          durationPpq: 0.4,
        }));
      },
    });

    expect(tempoSeen).toBeCloseTo(128, 3);
    expect(store.tempoSegments).toEqual([{ startPpq: 0, bpm: 128 }]);
    const audio = store.clips.find((entry) => entry.id === clipId);
    const midi = store.clips.find((entry) => entry.id === newClipId);
    // The music's downbeat (0.69 beat into the clip) lands on the bar at 4.
    expect(audio?.startPpq).toBeCloseTo(4 - (downbeatBeats + 0.05), 6);
    expect(midi?.startPpq).toBe(audio?.startPpq);
    const firstOnset =
      (midi?.startPpq ?? 0) + Math.min(...(midi?.notes ?? []).map((n) => n.startPpq));
    expect(firstOnset).toBeCloseTo(4, 6);

    expect(undo()).toBe(true);
    expect(store.tempoBpm).toBe(beforeTempo);
    expect(store.clips).toHaveLength(beforeClips);
    expect(store.clips.find((entry) => entry.id === clipId)?.startPpq).toBe(0);
  });

  it('leaves the tempo alone for a warped clip', async () => {
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({ trackId, assetId: 'asset-1', lengthPpq: 8, name: 'Take' });
    store.clips = store.clips.map((entry) =>
      entry.id === clipId ? { ...entry, warp: { enabled: true, sourceBpm: 100 } } : entry,
    );
    const detectBeats = vi.fn();
    const before = store.tempoSegments;
    await transcribeAudioClipToMidi(clipId, {
      matchTempo: true,
      detectBeats,
      transcribe: async () => [note()],
    });
    expect(detectBeats).not.toHaveBeenCalled();
    expect(store.tempoSegments).toEqual(before);
  });

  it('re-times the result by theory only when asked to tidy', async () => {
    const clipId = await sourceClip();
    const fragments = (): RawNote[] => [
      { ...note(72), velocity: 100 },
      { ...note(72), startPpq: 1, velocity: 70 },
      { ...note(74), startPpq: 2 },
    ];
    const durations = (id: number) =>
      store.clips.find((clip) => clip.id === id)?.notes.map((entry) => entry.durationPpq);

    const raw = await transcribeAudioClipToMidi(clipId, { transcribe: async () => fragments() });
    const tidied = await transcribeAudioClipToMidi(clipId, {
      transcribe: async () => fragments(),
      tidy: true,
    });

    expect(durations(raw)).toEqual([1, 1, 1]);
    expect(durations(tidied)?.[0]).toBe(2);
    expect(durations(tidied)).toHaveLength(2);
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
