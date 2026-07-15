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
      'audio clip "No ref" on "Audio" has no media reference',
      'frozen track "Frozen keys" references missing or unreadable media "gone": not found',
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
          notes: [],
        },
      ],
    });
    const result = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 2,
      loadAudioAsset: async (id) => loaded(id),
    });
    expect(result.warnings).toEqual([
      'external MIDI track "Hardware" is silent in audio export',
      'release tail is 2s, but active reverb/delay settings suggest at least 8s',
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
});
