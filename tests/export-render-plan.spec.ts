import { describe, expect, it } from 'vitest';
import { audioExportPreflight } from '@/export/audio-preflight';
import { documentBusStemsBlock } from '@/export/engine-render-context';
import type { ProjectDocument } from '@/project/serialization';

function doc(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Plan',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [],
    markers: [],
    sections: [],
  };
}

const baseClip = {
  startPpq: 0,
  lengthPpq: 4,
  sourceOffsetPpq: 0,
  gain: 1,
  loopEnabled: false,
  loopLengthPpq: 0,
};

const strip = { gainDb: 0, pan: 0, inserts: [], sends: [] };

describe('preflight and render share one contributor set', () => {
  it('checks the media of a muted track that feeds a pre-fader send', async () => {
    const source = doc();
    source.mixer = {
      master: { ...strip },
      buses: [{ id: 'bus-a', name: 'A', gainDb: 0 }],
    };
    source.tracks.push({
      name: 'Muted source',
      color: '#000',
      kind: 'audio',
      mute: true,
      solo: false,
      volume: 1,
      pan: 0,
      mixer: {
        ...strip,
        sends: [{ busId: 'bus-a', levelDb: 0, enabled: true, timing: 'preFader' }],
      },
      clips: [{ ...baseClip, name: 'Loop', kind: 'audio', assetId: 'gone', notes: [] }],
    });
    const result = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 2,
      validateAudioAssetPayload: async () => {
        throw new Error('not found');
      },
    });
    expect(result.blockers).toEqual([
      {
        kind: 'media-missing',
        labels: [{ kind: 'audio-clip', name: 'Loop' }],
        assetId: 'gone',
        reason: 'not found',
      },
    ]);
  });

  it('skips the media of a muted track no send or key reads', async () => {
    const source = doc();
    source.tracks.push({
      name: 'Muted',
      color: '#000',
      kind: 'audio',
      mute: true,
      solo: false,
      volume: 1,
      pan: 0,
      clips: [{ ...baseClip, name: 'Loop', kind: 'audio', assetId: 'gone', notes: [] }],
    });
    const result = await audioExportPreflight(source, {
      range: 'project',
      releaseTailSeconds: 2,
      validateAudioAssetPayload: async () => {
        throw new Error('not found');
      },
    });
    expect(result.blockers).toEqual([]);
  });
});

describe('preflight SoundFont check', () => {
  function sf2Doc(): ProjectDocument {
    const source = doc();
    source.tracks.push({
      name: 'Piano',
      color: '#000',
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      instrument: { kind: 'sf2', fontId: 'font-a' },
      clips: [
        {
          ...baseClip,
          name: 'Notes',
          notes: [{ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
        },
      ],
    });
    return source;
  }

  it('blocks an unresolvable font before any render work', async () => {
    const result = await audioExportPreflight(sf2Doc(), {
      range: 'project',
      releaseTailSeconds: 2,
      loadFont: async () => {
        throw new Error('font gone');
      },
    });
    expect(result.blockers).toEqual([
      { kind: 'soundfont-missing', fontId: 'font-a', reason: 'font gone' },
    ]);
  });

  it('accepts a font that loads and ignores a muted track', async () => {
    const loaded = await audioExportPreflight(sf2Doc(), {
      range: 'project',
      releaseTailSeconds: 2,
      loadFont: async () => new Uint8Array(1),
    });
    expect(loaded.blockers).toEqual([]);

    const muted = sf2Doc();
    muted.tracks[0].mute = true;
    const result = await audioExportPreflight(muted, {
      range: 'project',
      releaseTailSeconds: 2,
      loadFont: async () => {
        throw new Error('font gone');
      },
    });
    expect(result.blockers).toEqual([]);
  });
});

describe('documentBusStemsBlock', () => {
  it('is null without return buses and for a flat return layout', () => {
    expect(documentBusStemsBlock(doc())).toBeNull();
    const source = doc();
    source.mixer = {
      master: { ...strip },
      buses: [{ id: 'bus-a', name: 'A', gainDb: 0 }],
    };
    expect(documentBusStemsBlock(source)).toBeNull();
  });

  it('reports nested return routing', () => {
    const source = doc();
    source.mixer = {
      master: { ...strip },
      buses: [
        { id: 'bus-a', name: 'A', gainDb: 0, strip: { ...strip, outputBusId: 'bus-b' } },
        { id: 'bus-b', name: 'B', gainDb: 0 },
      ],
    };
    expect(documentBusStemsBlock(source)).toBe('nested-routing');
  });
});
