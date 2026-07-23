import { describe, expect, it, vi } from 'vitest';
import { audioExportPreflight } from '@/export/audio-preflight';
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

  it('uses metadata validation ahead of the legacy full-PCM loader', async () => {
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
    const result = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 0,
      loadAudioAssetMeta: meta,
      loadAudioAsset: full,
    });
    expect(result.blockers).toEqual([]);
    expect(meta).toHaveBeenCalledWith('asset-1');
    expect(full).not.toHaveBeenCalled();
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

    expect(result).toEqual({ blockers: [], warnings: [] });
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
});
