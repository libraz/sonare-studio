import { describe, expect, it, vi } from 'vitest';
import {
  audioExportPreflight,
  estimatedTailSeconds,
  insertTailResolverFromTiming,
} from '@/export/audio-preflight';
import type { LoadedAudioAsset } from '@/persistence/assets';
import type { ProjectDocument } from '@/project/serialization';

function doc(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Preflight',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [],
    markers: [],
    sections: [],
  };
}

function loaded(id: string): LoadedAudioAsset {
  return {
    meta: { id, name: id, sampleRate: 48000, numChannels: 1, numFrames: 1 },
    channels: [new Float32Array([0])],
  };
}

describe('audioExportPreflight', () => {
  it('blocks structural and stored media failures, including frozen tracks', async () => {
    const source = doc();
    source.tracks = [
      {
        name: 'Audio',
        color: '#000',
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips: [
          {
            name: 'No ref',
            startPpq: 0,
            lengthPpq: 1,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            kind: 'audio',
            notes: [],
          },
        ],
      },
      {
        name: 'Frozen keys',
        color: '#000',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        frozen: { assetId: 'gone' },
        clips: [],
      },
    ];
    const result = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 2,
      loadAudioAsset: vi.fn(async () => {
        throw new Error('not found');
      }),
    });
    expect(result.blockers).toEqual([
      { kind: 'audio-clip-no-media', clip: 'No ref', track: 'Audio' },
      {
        kind: 'media-missing',
        labels: [{ kind: 'frozen-track', name: 'Frozen keys' }],
        assetId: 'gone',
        reason: 'not found',
      },
    ]);
  });

  it('warns for external MIDI and an undersized time-effect tail', async () => {
    const source = doc();
    source.tracks.push({
      name: 'Hardware',
      color: '#000',
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      instrument: { kind: 'external-midi', outputPortId: 'port', channel: 0 },
      mixer: {
        gainDb: 0,
        pan: 0,
        sends: [],
        inserts: [{ processor: 'effects.reverb.plate', enabled: true, params: { decaySec: 8 } }],
      },
      clips: [
        {
          name: 'Notes',
          startPpq: 0,
          lengthPpq: 4,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          kind: 'midi',
          notes: [{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
        },
      ],
    });
    const result = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 2,
      insertTail: () => 8,
      loadAudioAsset: async (id) => loaded(id),
    });
    expect(result.warnings).toEqual([
      { kind: 'external-midi-silent', track: 'Hardware' },
      { kind: 'release-tail-short', currentSeconds: 2, suggestedSeconds: 8 },
    ]);
  });

  it('accepts validated media and a sufficiently long tail', async () => {
    const source = doc();
    source.tracks.push({
      name: 'Audio',
      color: '#000',
      kind: 'audio',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      clips: [
        {
          name: 'Take',
          startPpq: 0,
          lengthPpq: 1,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          kind: 'audio',
          assetId: 'ok',
          notes: [],
        },
      ],
    });
    const load = vi.fn(async (id: string) => loaded(id));
    await expect(
      audioExportPreflight(source, {
        range: 'project',
        releaseTailSeconds: 10,
        loadAudioAsset: load,
      }),
    ).resolves.toEqual({ blockers: [], warnings: [] });
    expect(load).toHaveBeenCalledWith('ok');
  });

  it('warns before exporting an active solo or silent project, but not a PFL cue', async () => {
    const source = doc();
    source.tracks.push({
      name: 'Lead',
      color: '#000',
      kind: 'midi',
      mute: false,
      solo: true,
      volume: 1,
      pan: 0,
      clips: [],
    });
    const soloed = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 10,
      loadAudioAsset: async (id) => loaded(id),
    });
    expect(soloed.warnings).toContainEqual({
      kind: 'solo-active',
      tracks: [source.tracks[0].name],
    });

    source.mixer = {
      master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
      buses: [],
      soloMode: 'pfl',
    };
    const pfl = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 10,
      loadAudioAsset: async (id) => loaded(id),
    });
    expect(pfl.warnings).toEqual([]);

    source.tracks[0].solo = false;
    source.tracks[0].mute = true;
    const silent = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 10,
      loadAudioAsset: async (id) => loaded(id),
    });
    expect(silent.warnings).toContainEqual({ kind: 'silent-mixdown' });
  });

  it('warns that an export made with a soloed return contains only that return', async () => {
    const source = doc();
    source.mixer = {
      master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
      buses: [{ id: 'bus-a', name: 'Reverb', gainDb: 0, solo: true }],
    };

    const result = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 10,
      loadAudioAsset: async (id) => loaded(id),
    });

    expect(result.warnings).toContainEqual({ kind: 'return-solo-active', buses: ['Reverb'] });
  });

  it('uses payload validation ahead of the legacy metadata and full-PCM loaders', async () => {
    const source = doc();
    source.tracks.push({
      name: 'Audio',
      color: '#000',
      kind: 'audio',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      clips: [
        {
          name: 'Clip',
          startPpq: 0,
          lengthPpq: 4,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          kind: 'audio',
          notes: [],
          assetId: 'asset-1',
        },
      ],
    });
    const meta = vi.fn(async (id: string) => loaded(id).meta);
    const full = vi.fn(async (id: string) => loaded(id));
    const payload = vi.fn(async (id: string) => loaded(id).meta);
    const result = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 0,
      validateAudioAssetPayload: payload,
      loadAudioAssetMeta: meta,
      loadAudioAsset: full,
    });
    expect(result.blockers).toEqual([]);
    expect(payload).toHaveBeenCalledWith('asset-1');
    expect(meta).not.toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
  });

  it('blocks a valid sidecar whose PCM payload is missing or has the wrong size', async () => {
    const source = doc();
    source.tracks.push({
      name: 'Audio',
      color: '#000',
      kind: 'audio',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      clips: [
        {
          name: 'Clip',
          startPpq: 0,
          lengthPpq: 4,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          kind: 'audio',
          notes: [],
          assetId: 'asset-1',
        },
      ],
    });
    const result = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 0,
      validateAudioAssetPayload: async () => {
        throw new Error('PCM payload is 12 bytes, expected 16');
      },
    });
    expect(result.blockers).toEqual([
      {
        kind: 'media-missing',
        labels: [{ kind: 'audio-clip', name: 'Clip' }],
        assetId: 'asset-1',
        reason: 'PCM payload is 12 bytes, expected 16',
      },
    ]);
  });

  it('ignores missing media on muted, solo-excluded and loop-excluded tracks', async () => {
    const source = doc();
    const audioTrack = (
      name: string,
      assetId: string | undefined,
      startPpq: number,
      state: { mute?: boolean; solo?: boolean } = {},
    ): ProjectDocument['tracks'][number] => ({
      name,
      color: '#000',
      kind: 'audio',
      mute: state.mute ?? false,
      solo: state.solo ?? false,
      volume: 1,
      pan: 0,
      clips: [
        {
          name: `${name} clip`,
          startPpq,
          lengthPpq: 2,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          kind: 'audio',
          ...(assetId ? { assetId } : {}),
          notes: [],
        },
      ],
    });
    source.tracks = [
      audioTrack('Muted missing', 'muted-missing', 0, { mute: true }),
      audioTrack('Solo excluded', 'solo-excluded', 0),
      audioTrack('Outside loop', undefined, 12),
      audioTrack('Audible solo', 'inside', 1, { solo: true }),
    ];
    const load = vi.fn(async (id: string) => loaded(id));

    const result = await audioExportPreflight(source, {
      range: 'loop',
      loopRegion: { startPpq: 0, endPpq: 4 },
      releaseTailSeconds: 0,
      loadAudioAsset: load,
    });

    expect(result).toEqual({
      blockers: [],
      warnings: [{ kind: 'solo-active', tracks: ['Audible solo'] }],
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('inside');
  });

  it('does not warn for empty or range-excluded external MIDI and ignores muted effect tails', async () => {
    const source = doc();
    source.tracks = [
      {
        name: 'External',
        color: '#000',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        instrument: { kind: 'external-midi', outputPortId: 'port', channel: 0 },
        clips: [
          {
            name: 'Outside',
            startPpq: 8,
            lengthPpq: 2,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
          },
        ],
      },
      {
        name: 'Muted reverb',
        color: '#000',
        kind: 'audio',
        mute: true,
        solo: false,
        volume: 1,
        pan: 0,
        mixer: {
          gainDb: 0,
          pan: 0,
          sends: [],
          inserts: [{ processor: 'effects.reverb.plate', enabled: true, params: { decaySec: 20 } }],
        },
        clips: [],
      },
    ];

    await expect(
      audioExportPreflight(source, {
        range: 'loop',
        loopRegion: { startPpq: 0, endPpq: 4 },
        releaseTailSeconds: 0,
      }),
    ).resolves.toEqual({ blockers: [], warnings: [] });
  });

  describe('tail estimate', () => {
    const slot = (processor: string, enabled = true) => ({ processor, enabled, params: {} });
    const strip = (...inserts: ReturnType<typeof slot>[]) => ({
      gainDb: 0,
      pan: 0,
      sends: [],
      inserts,
    });
    const track = (name: string, inserts: ReturnType<typeof slot>[]) =>
      ({
        name,
        color: '#000',
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        mixer: strip(...inserts),
        clips: [],
      }) as ProjectDocument['tracks'][number];
    const seconds: Record<string, number> = { a: 2, b: 3, m: 4 };
    const resolve = (entry: { processor: string }) => seconds[entry.processor] ?? 0;

    it('sums a chain, takes the longest lane and adds the master chain', () => {
      const source = doc();
      source.tracks = [track('One', [slot('a'), slot('b')]), track('Two', [slot('a')])];
      source.mixer = {
        master: strip(slot('m'), slot('a', false)),
      } as unknown as ProjectDocument['mixer'];
      expect(estimatedTailSeconds(source, new Set([0, 1]), resolve)).toBe(2 + 3 + 4);
      expect(estimatedTailSeconds(source, new Set([1]), resolve)).toBe(2 + 4);
      expect(estimatedTailSeconds(source, new Set([0]), resolve, { includeMaster: false })).toBe(5);
    });

    it('asks the engine with every key, then build keys, then the catalog default', () => {
      const timing = vi.fn((_name: string, params: Record<string, number | boolean>) => {
        if ('mix' in params) throw new Error('key not read at build time');
        return { tailSamples: params.feedback === 0.5 ? 96000 : 48000 };
      });
      const catalog = [
        {
          id: 'effects.delay.stereo',
          tailSamples: 24000,
          params: [
            { name: 'feedback', id: null },
            { name: 'mix', id: 7 },
          ],
        },
      ];
      const resolver = insertTailResolverFromTiming(catalog, 48000, timing);
      expect(resolver({ processor: 'effects.delay.stereo', params: { feedback: 0.5 } })).toBe(2);
      expect(
        resolver({ processor: 'effects.delay.stereo', params: { feedback: 0.5, mix: 0.3 } }),
      ).toBe(2);
      expect(resolver({ processor: 'unknown', params: {} })).toBe(0);
      const refusing = insertTailResolverFromTiming(catalog, 48000, () => {
        throw new Error('refused');
      });
      expect(refusing({ processor: 'effects.delay.stereo', params: {} })).toBe(0.5);
    });

    it('caps an unbounded engine answer', () => {
      const resolver = insertTailResolverFromTiming([{ id: 'x' }], 48000, () => ({
        tailSamples: 2147483647,
      }));
      expect(resolver({ processor: 'x', params: {} })).toBe(120);
    });
  });
});
