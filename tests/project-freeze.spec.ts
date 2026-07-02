import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineRenderOptions } from '@/export/engine-render';
import type { MixdownResult } from '@/export/mixdown';
import {
  addAudioClip,
  addAudioTrack,
  addGroupTrack,
  clearHistory,
  redo,
  undo,
} from '@/project/commands';
import { bounceTrackRange, freezeTrack, unfreezeTrack } from '@/project/freeze';
import type { ProjectDocument } from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Builds a small MixdownResult-shaped render output. */
function makeRenderResult(frames = 8, fill = 0.5): MixdownResult {
  return {
    channels: [new Float32Array(frames).fill(fill), new Float32Array(frames).fill(fill)],
    sampleRate: 48000,
    totalFrames: frames,
    report: { peakDb: 20 * Math.log10(fill) },
  };
}

describe('track freeze and bounce-in-place', () => {
  let store: ReturnType<typeof useProjectStore>;
  let renderResult: MixdownResult;

  const render = vi.fn(
    async (_doc: ProjectDocument, _options?: EngineRenderOptions): Promise<MixdownResult> =>
      renderResult,
  );
  const ingest = vi.fn(async (_channels: Float32Array[], _sampleRate: number, _name: string) => ({
    id: 'baked-1',
  }));

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    renderResult = makeRenderResult();
    render.mockClear();
    ingest.mockClear();
  });

  describe('freezeTrack', () => {
    it('renders the track in isolation over the whole project and bakes the asset', async () => {
      const voxId = addAudioTrack({ name: 'Vox' });
      const assetId = await freezeTrack(voxId, { render, ingest });

      expect(assetId).toBe('baked-1');
      expect(render).toHaveBeenCalledTimes(1);
      const [doc, options] = render.mock.calls[0];
      // The render input is the serialized project; the freeze index
      // addresses the track positionally in that document.
      expect(doc.tracks.map((track) => track.name)).toEqual(store.tracks.map((t) => t.name));
      expect(doc.tracks[1].name).toBe('Vox');
      // Whole-project freeze: no range, isolated pre-fader pass, default deps
      // disabled (no wasm mastering/metering seams needed for a freeze).
      expect(options).toMatchObject({ freezeTrackIndex: 1, deps: null });
      expect(options?.resolvePreset?.('unknown-preset')).toBe('e-piano');

      expect(ingest).toHaveBeenCalledTimes(1);
      const [channels, sampleRate, name] = ingest.mock.calls[0];
      expect(channels[0]).toBe(renderResult.channels[0]);
      expect(channels[1]).toBe(renderResult.channels[1]);
      expect(sampleRate).toBe(48000);
      expect(name).toBe('Vox (frozen)');

      expect(store.tracks[1].frozen).toEqual({ assetId: 'baked-1' });
      // The other tracks stay unfrozen.
      expect(store.tracks[0].frozen).toBeUndefined();
    });

    it('freezes the first (MIDI) track with index 0', async () => {
      const midiId = store.tracks[0].id;
      await freezeTrack(midiId, { render, ingest });
      expect(render.mock.calls[0][1]).toMatchObject({ freezeTrackIndex: 0, deps: null });
      expect(ingest.mock.calls[0][2]).toBe(`${store.tracks[0].name} (frozen)`);
      expect(store.tracks[0].frozen).toEqual({ assetId: 'baked-1' });
    });

    it('is one undoable edit and unfreezeTrack reverts it', async () => {
      const voxId = addAudioTrack({ name: 'Vox' });
      await freezeTrack(voxId, { render, ingest });
      expect(store.tracks[1].frozen).toEqual({ assetId: 'baked-1' });

      // Undo flips only the frozen flag (the baked asset is not history).
      expect(undo()).toBe(true);
      expect(store.tracks[1].frozen).toBeUndefined();
      expect(store.tracks).toHaveLength(2);
      expect(redo()).toBe(true);
      expect(store.tracks[1].frozen).toEqual({ assetId: 'baked-1' });

      unfreezeTrack(voxId);
      expect(store.tracks[1].frozen).toBeUndefined();
      expect(undo()).toBe(true);
      expect(store.tracks[1].frozen).toEqual({ assetId: 'baked-1' });
    });

    it('rejects unknown and group tracks without rendering or ingesting', async () => {
      await expect(freezeTrack(9999, { render, ingest })).rejects.toThrow(RangeError);
      const groupId = addGroupTrack({ name: 'Bus' });
      await expect(freezeTrack(groupId, { render, ingest })).rejects.toThrow(/cannot be frozen/);
      expect(render).not.toHaveBeenCalled();
      expect(ingest).not.toHaveBeenCalled();
      expect(store.tracks.every((track) => track.frozen === undefined)).toBe(true);
    });
  });

  describe('bounceTrackRange', () => {
    it('renders the range and places it as a clip on a new audio track', async () => {
      const gtrId = addAudioTrack({ name: 'Gtr' });
      const sourceClipId = await addAudioClip({
        trackId: gtrId,
        assetId: 'asset-src',
        startPpq: 0,
        lengthPpq: 16,
      });

      const clipId = await bounceTrackRange(gtrId, 4, 12, { render, ingest });

      expect(render).toHaveBeenCalledTimes(1);
      expect(render.mock.calls[0][1]).toMatchObject({
        freezeTrackIndex: 1,
        deps: null,
        range: { startPpq: 4, endPpq: 12 },
      });
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(ingest.mock.calls[0][2]).toBe('Gtr (bounce)');

      const clip = store.clips.find((entry) => entry.id === clipId);
      expect(clip).toMatchObject({
        kind: 'audio',
        assetId: 'baked-1',
        startPpq: 4,
        lengthPpq: 8,
        name: 'Gtr (bounce)',
      });

      const bounceTrack = store.tracks.find((track) => track.id === clip?.trackId);
      expect(bounceTrack?.kind).toBe('audio');
      expect(bounceTrack?.name).toBe('Gtr (bounce)');
      expect(bounceTrack?.id).not.toBe(gtrId);

      // The source track is untouched: not frozen, clips still in place.
      expect(store.tracks[1].frozen).toBeUndefined();
      expect(store.clips.filter((c) => c.trackId === gtrId).map((c) => c.id)).toEqual([
        sourceClipId,
      ]);
    });

    it('rejects invalid ranges before rendering', async () => {
      const gtrId = addAudioTrack({ name: 'Gtr' });
      await expect(bounceTrackRange(gtrId, -1, 4, { render, ingest })).rejects.toThrow(RangeError);
      await expect(bounceTrackRange(gtrId, Number.NaN, 4, { render, ingest })).rejects.toThrow(
        RangeError,
      );
      await expect(
        bounceTrackRange(gtrId, 0, Number.POSITIVE_INFINITY, { render, ingest }),
      ).rejects.toThrow(RangeError);
      await expect(bounceTrackRange(gtrId, 4, 4, { render, ingest })).rejects.toThrow(
        /must be after/,
      );
      await expect(bounceTrackRange(gtrId, 4, 2, { render, ingest })).rejects.toThrow(
        /must be after/,
      );
      expect(render).not.toHaveBeenCalled();
      expect(ingest).not.toHaveBeenCalled();
      // No bounce track was created.
      expect(store.tracks).toHaveLength(2);
    });

    it('rejects unknown and group tracks', async () => {
      await expect(bounceTrackRange(9999, 0, 4, { render, ingest })).rejects.toThrow(RangeError);
      const groupId = addGroupTrack({ name: 'Bus' });
      await expect(bounceTrackRange(groupId, 0, 4, { render, ingest })).rejects.toThrow(
        /cannot be frozen or bounced/,
      );
      expect(render).not.toHaveBeenCalled();
    });
  });
});
