import { describe, expect, it } from 'vitest';
import { estimateChordsFromTracks } from '@/compose/estimate-chords';
import type { TrackWithNotes } from '@/compose/tracks';
import type { EditorNote, EditorTrack } from '@/project/types';
import { MAJOR_MODE_MASK } from '@/project/types';

const C_MAJOR = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

/** Minimal editor note (only the fields the estimator reads). */
function note(pitch: number, startPpq: number, durationPpq: number, channel = 0): EditorNote {
  return { id: 0, pitch, startPpq, durationPpq, velocity: 96, channel };
}

/** Minimal editor track carrying a name and id. */
function track(id: number, name: string): EditorTrack {
  return { id, name } as EditorTrack;
}

describe('estimateChordsFromTracks', () => {
  it('infers chord symbols over the note span', () => {
    // Two bars of C then G triads, one chord per bar (4 beats).
    const notes: EditorNote[] = [
      note(60, 0, 4),
      note(64, 0, 4),
      note(67, 0, 4),
      note(67, 4, 4),
      note(71, 4, 4),
      note(74, 4, 4),
    ];
    const tracks: TrackWithNotes[] = [{ track: track(1, 'Piano'), notes }];
    const result = estimateChordsFromTracks(tracks, { key: C_MAJOR });
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.confidence.length).toBe(result.symbols.length);
    // The first inferred chord is a C major triad rooted at pitch class 0.
    expect(result.symbols[0].rootPc).toBe(0);
    for (const symbol of result.symbols) {
      expect(symbol.endPpq).toBeGreaterThan(symbol.startPpq);
    }
  });

  it('excludes percussion tracks from the estimate', () => {
    const harmonic: EditorNote[] = [note(60, 0, 4), note(64, 0, 4), note(67, 0, 4)];
    const drums: EditorNote[] = [note(36, 0, 1, 9), note(42, 1, 1, 9)];
    const tracks: TrackWithNotes[] = [
      { track: track(1, 'Piano'), notes: harmonic },
      { track: track(2, 'Drums'), notes: drums },
    ];
    const result = estimateChordsFromTracks(tracks, { key: C_MAJOR });
    expect(result.excludedTrackNames).toContain('Drums');
    // The C-major triad survives; no drum-derived chord appears.
    expect(result.symbols[0].rootPc).toBe(0);
  });

  it('splits a batch estimate at meter changes instead of carrying the first bar length forward', () => {
    const tracks: TrackWithNotes[] = [
      {
        track: track(1, 'Piano'),
        notes: [
          note(60, 0, 4),
          note(64, 0, 4),
          note(67, 0, 4),
          note(62, 4, 3),
          note(65, 4, 3),
          note(69, 4, 3),
        ],
      },
    ];
    const result = estimateChordsFromTracks(tracks, {
      key: C_MAJOR,
      timeSignatures: [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 4, numerator: 3, denominator: 4 },
      ],
    });

    expect(result.symbols.some((symbol) => symbol.startPpq < 4 && symbol.endPpq > 4)).toBe(false);
    expect(result.symbols.some((symbol) => symbol.startPpq >= 4 && symbol.endPpq <= 7)).toBe(true);
  });

  it('does not reclassify a globally harmonic track in a meter-range subset', () => {
    const tracks: TrackWithNotes[] = [
      {
        track: track(1, 'Hybrid'),
        notes: [
          // G and B survive the channel-10 filter, so the first range still names a chord.
          note(60, 0, 3, 9),
          note(64, 0, 3, 9),
          note(62, 0, 3, 9),
          note(67, 0, 3),
          note(71, 0, 3),
          note(62, 4, 3),
          note(65, 4, 3),
          note(69, 4, 3),
        ],
      },
    ];
    const result = estimateChordsFromTracks(tracks, {
      key: C_MAJOR,
      timeSignatures: [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 4, numerator: 3, denominator: 4 },
      ],
    });

    expect(result.excludedTrackNames).toEqual([]);
    expect(result.symbols.some((symbol) => symbol.startPpq < 4)).toBe(true);
  });

  it('infers the first non-empty meter range and seeds later ranges when no key is set', () => {
    const tracks: TrackWithNotes[] = [
      {
        track: track(1, 'Piano'),
        notes: [
          note(64, 0, 3),
          note(68, 0, 3),
          note(71, 0, 3),
          note(64, 3, 3),
          note(68, 3, 3),
          note(71, 3, 3),
        ],
      },
    ];
    const result = estimateChordsFromTracks(tracks, {
      timeSignatures: [
        { startPpq: 0, numerator: 3, denominator: 4 },
        { startPpq: 3, numerator: 6, denominator: 8 },
      ],
    });

    expect(result.key.rootPc).toBe(4);
    expect(result.symbols.some((symbol) => symbol.startPpq >= 3)).toBe(true);
  });

  it('starts an estimate with an opening rest on its first note and changes on the bar line', () => {
    const tracks: TrackWithNotes[] = [
      {
        track: track(1, 'Piano'),
        notes: [
          ...[60, 64, 67].map((pitch) => note(pitch, 1, 3)),
          ...[65, 69, 72].map((pitch) => note(pitch, 4, 4)),
        ],
      },
    ];
    const result = estimateChordsFromTracks(tracks, {
      key: C_MAJOR,
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    });

    expect(result.symbols).toMatchObject([
      { startPpq: 1, endPpq: 4, rootPc: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 5 },
    ]);
  });

  it('returns nothing for an empty (or drums-only) arrangement', () => {
    const tracks: TrackWithNotes[] = [{ track: track(1, 'Drums'), notes: [note(36, 0, 1, 9)] }];
    const result = estimateChordsFromTracks(tracks, { key: C_MAJOR });
    expect(result.symbols).toEqual([]);
    expect(result.confidence).toEqual([]);
    expect(result.excludedTrackNames).toContain('Drums');
  });
});
