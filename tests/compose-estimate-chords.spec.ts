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

  it('returns nothing for an empty (or drums-only) arrangement', () => {
    const tracks: TrackWithNotes[] = [{ track: track(1, 'Drums'), notes: [note(36, 0, 1, 9)] }];
    const result = estimateChordsFromTracks(tracks, { key: C_MAJOR });
    expect(result.symbols).toEqual([]);
    expect(result.confidence).toEqual([]);
    expect(result.excludedTrackNames).toContain('Drums');
  });
});
