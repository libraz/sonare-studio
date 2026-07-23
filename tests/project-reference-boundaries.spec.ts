import { describe, expect, it, vi } from 'vitest';
import { createDefaultStrip } from '@/project/mixer';
import { persistedProjectStateKey } from '@/project/persisted-state';
import {
  pruneStripTrackReferences,
  pruneTrackTargetReferences,
  registerTargetReferenceContributor,
} from '@/project/target-reference-registry';
import { midiLearnInsertTargetId } from '@/ui/midi/midi-learn';

function storeFixture() {
  const strip = createDefaultStrip();
  strip.inserts = [
    {
      id: 'compressor',
      processor: 'dynamics.compressor',
      params: {},
      enabled: true,
      sidechainSourceTrackId: 2,
    },
  ];
  const master = createDefaultStrip();
  master.inserts = [{ ...strip.inserts[0] }];
  return {
    projectName: 'References',
    documentGeneration: 1,
    tracks: [
      {
        id: 1,
        name: 'Dependent',
        color: '#fff',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: 0,
        groupId: 2,
        mixer: strip,
      },
    ],
    clips: [],
    markers: [],
    sections: [],
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    mixer: {
      master,
      buses: [{ id: 'bus-1', name: 'Bus', gainDb: 0, strip: { ...strip } }],
    },
    externalMidiDefault: undefined,
    projectExternalMidi: undefined,
    scoreAnnotations: {},
    displayTransposeSemitones: 0,
    scoreDisplaySettings: {},
    pickupLengthPpq: 0,
    automationLanes: [
      { target: 2, param: 'faderDb', points: [], enabled: true },
      { target: 1, param: 'faderDb', points: [], enabled: true },
    ],
    chords: [],
    midiCcBindings: new Map([
      ['gain:2', { channel: 0, controller: 7 }],
      [midiLearnInsertTargetId(1, 'compressor', 'thresholdDb'), { channel: 1, controller: 1 }],
    ]),
  };
}

describe('project persisted-state and target-reference boundaries', () => {
  it('changes the shared persisted key for a persisted mirror mutation', () => {
    const store = storeFixture();
    const before = persistedProjectStateKey(store as never);
    store.tracks[0].volume = 0.5;

    expect(persistedProjectStateKey(store as never)).not.toBe(before);
  });

  it('does not clone a strip when no sidechain points at the removed track', () => {
    const strip = createDefaultStrip();
    strip.inserts = [
      { processor: 'eq.tilt', params: {}, enabled: true, sidechainSourceTrackId: 4 },
    ];

    expect(pruneStripTrackReferences(strip, 2)).toBe(strip);
    const pruned = pruneStripTrackReferences(strip, 4);
    expect(pruned).not.toBe(strip);
    expect(pruned.inserts[0].sidechainSourceTrackId).toBeUndefined();
  });

  it('prunes every removed-track reference while retaining unrelated stable processor bindings', () => {
    const store = storeFixture();
    const contributed = vi.fn();
    registerTargetReferenceContributor({ pruneTrack: contributed });

    pruneTrackTargetReferences(store as never, 2);

    expect(store.automationLanes).toEqual([
      { target: 1, param: 'faderDb', points: [], enabled: true },
    ]);
    expect(store.tracks[0].groupId).toBeUndefined();
    expect(store.tracks[0].mixer.inserts[0].sidechainSourceTrackId).toBeUndefined();
    expect(store.mixer.master.inserts[0].sidechainSourceTrackId).toBeUndefined();
    expect(store.mixer.buses[0].strip?.inserts[0].sidechainSourceTrackId).toBeUndefined();
    expect([...store.midiCcBindings.keys()]).toEqual([
      midiLearnInsertTargetId(1, 'compressor', 'thresholdDb'),
    ]);
    expect(contributed).toHaveBeenCalledWith(2);
  });
});
