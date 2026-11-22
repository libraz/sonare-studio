import { describe, expect, it } from 'vitest';
import { documentAudibleTrackIndices } from '@/export/engine-render-context';
import type { ProjectDocument } from '@/project/serialization';

type DocTrack = ProjectDocument['tracks'][number];

/** Builds a minimal document from partial track entries. */
function makeDoc(tracks: Array<Partial<DocTrack>>): ProjectDocument {
  return {
    tracks: tracks.map((track) => ({ kind: 'audio', mute: false, solo: false, ...track })),
  } as unknown as ProjectDocument;
}

describe('documentAudibleTrackIndices', () => {
  it('reads each track’s group membership a linear number of times', () => {
    const count = 64;
    let groupIndexReads = 0;
    const doc = makeDoc(Array.from({ length: count }, (_, index) => ({ solo: index === 0 })));
    for (const track of doc.tracks) {
      Object.defineProperty(track, 'groupIndex', {
        get: () => {
          groupIndexReads++;
          return undefined;
        },
      });
    }

    expect([...documentAudibleTrackIndices(doc)]).toEqual([0]);
    // One read for solo expansion plus one for the muted-group bus check per
    // track; recomputing the expansion per track read it count * count times.
    expect(groupIndexReads).toBeLessThanOrEqual(2 * count);
  });

  it('applies mute, solo, solo-safe and group expansion', () => {
    const doc = makeDoc([
      { solo: false },
      { solo: false, groupIndex: 2 },
      { kind: 'group', solo: true } as Partial<DocTrack>,
      { solo: false, soloSafe: true },
      { solo: true, mute: true },
      { solo: false, soloSafe: true, mute: true },
      { solo: true },
      { kind: 'group', mute: true } as Partial<DocTrack>,
      { solo: true, groupIndex: 7 },
    ]);
    expect([...documentAudibleTrackIndices(doc)].sort((a, b) => a - b)).toEqual([1, 2, 3, 6]);

    const noSolo = makeDoc([{ mute: true }, {}, { soloSafe: true }]);
    expect([...documentAudibleTrackIndices(noSolo)].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
