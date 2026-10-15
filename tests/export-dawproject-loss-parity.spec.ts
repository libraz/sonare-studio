import { describe, expect, it } from 'vitest';
import { inspectDawprojectExportLoss } from '@/export/dawproject/export-loss';
import type { DocumentClip, DocumentTrack, ProjectDocument } from '@/project/serialization';

function track(overrides: Partial<DocumentTrack> = {}): DocumentTrack {
  return {
    name: 'T',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips: [],
    ...overrides,
  };
}

function doc(tracks: DocumentTrack[]): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Loss',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks,
    markers: [],
    sections: [],
  };
}

const panLane = { param: 'pan', enabled: true, points: [{ ppq: 0, value: 0.5 }] } as const;

function audioClip(warp: DocumentClip['warp']): DocumentClip {
  return {
    name: 'A',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    kind: 'audio',
    assetId: 'a',
    notes: [],
    warp,
  };
}

describe('DAWproject export loss parity with the exporter', () => {
  it('counts pan automation on a group track, which the exporter drops', () => {
    const lossy = inspectDawprojectExportLoss(
      doc([track({ kind: 'group', automation: [panLane] })]),
    );
    expect(lossy.entries).toEqual([{ kind: 'automationLanes', count: 1, details: [] }]);
    const kept = inspectDawprojectExportLoss(doc([track({ kind: 'midi', automation: [panLane] })]));
    expect(kept.entries).toEqual([]);
  });

  it('counts an enabled warp without a usable source tempo, which the exporter drops', () => {
    const lossy = inspectDawprojectExportLoss(
      doc([track({ kind: 'audio', clips: [audioClip({ enabled: true, sourceBpm: 0 })] })]),
    );
    expect(lossy.entries).toEqual([{ kind: 'warpedAudioClips', count: 1, details: [] }]);
    const kept = inspectDawprojectExportLoss(
      doc([track({ kind: 'audio', clips: [audioClip({ enabled: true, sourceBpm: 90 })] })]),
    );
    expect(kept.entries).toEqual([]);
  });
});
