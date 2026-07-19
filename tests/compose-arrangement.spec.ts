import { describe, expect, it } from 'vitest';
import { analyzeArrangementTracks, arrangementTensionCurve } from '@/compose/arrangement';
import type { TrackWithNotes } from '@/compose/tracks';
import type { EditorNote, EditorTrack } from '@/project/types';
import { MAJOR_MODE_MASK } from '@/project/types';

const C_MAJOR = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

function track(partial: Partial<EditorTrack>): EditorTrack {
  return {
    id: 1,
    name: 'Track',
    color: '#fff',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...partial,
  } as EditorTrack;
}

function note(partial: Partial<EditorNote>): EditorNote {
  return { id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0, ...partial };
}

/** A simple C-major arpeggio melody across two bars (all chord tones). */
function cMajorMelody(): EditorNote[] {
  return [
    note({ id: 1, pitch: 60, startPpq: 0, durationPpq: 1 }),
    note({ id: 2, pitch: 64, startPpq: 1, durationPpq: 1 }),
    note({ id: 3, pitch: 67, startPpq: 2, durationPpq: 1 }),
    note({ id: 4, pitch: 72, startPpq: 3, durationPpq: 1 }),
  ];
}

describe('analyzeArrangementTracks', () => {
  it('excludes percussion tracks and never lets them become conflicts', () => {
    const melodyTrack: TrackWithNotes = {
      track: track({ id: 1, name: 'Lead' }),
      notes: cMajorMelody(),
    };
    // A drum track whose GM pitches would read as harsh dissonance if pooled
    // into the harmony. It must be dropped, not flagged.
    const drumTrack: TrackWithNotes = {
      track: track({ id: 2, name: 'Drums' }),
      notes: [
        note({ id: 10, pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 }),
        note({ id: 11, pitch: 42, startPpq: 1, durationPpq: 1, channel: 9 }),
        note({ id: 12, pitch: 49, startPpq: 2, durationPpq: 1, channel: 9 }),
      ],
    };

    const withDrums = analyzeArrangementTracks([melodyTrack, drumTrack], C_MAJOR);
    const melodyOnly = analyzeArrangementTracks([melodyTrack], C_MAJOR);

    expect(withDrums.excludedTrackNames).toContain('Drums');
    // No conflict is ever attributed to the drum track.
    expect(withDrums.conflicts.every((c) => c.trackName !== 'Drums')).toBe(true);
    // Adding the drums changes nothing about the harmonic analysis.
    expect(withDrums.conflicts.length).toBe(melodyOnly.conflicts.length);
  });

  it('excludes a drum track detected by channel even without a drum name', () => {
    const perc: TrackWithNotes = {
      track: track({ id: 3, name: 'Kit A' }),
      notes: [
        note({ id: 20, pitch: 38, startPpq: 0, durationPpq: 1, channel: 9 }),
        note({ id: 21, pitch: 46, startPpq: 1, durationPpq: 1, channel: 9 }),
      ],
    };
    const report = analyzeArrangementTracks([perc], C_MAJOR);
    expect(report.excludedTrackNames).toContain('Kit A');
    expect(report.conflicts).toEqual([]);
  });

  it('falls back to a valid key when no harmonic material remains and none is given', () => {
    const perc: TrackWithNotes = {
      track: track({ id: 3, name: 'Kit A' }),
      notes: [note({ id: 20, pitch: 38, startPpq: 0, durationPpq: 1, channel: 9 })],
    };
    const report = analyzeArrangementTracks([perc]);
    // A default C-major scale, never an empty (degree-less) mask of 0.
    expect(report.key).toEqual({ rootPc: 0, modeMask12: MAJOR_MODE_MASK });
    expect(report.key.modeMask12).not.toBe(0);
  });

  it('flags a note that clashes with the inferred harmony', () => {
    // A held C-major triad plus a sustained C# that clashes against it.
    const harmony: TrackWithNotes = {
      track: track({ id: 1, name: 'Piano' }),
      notes: [
        note({ id: 1, pitch: 60, startPpq: 0, durationPpq: 4 }),
        note({ id: 2, pitch: 64, startPpq: 0, durationPpq: 4 }),
        note({ id: 3, pitch: 67, startPpq: 0, durationPpq: 4 }),
      ],
    };
    const clash: TrackWithNotes = {
      track: track({ id: 2, name: 'Lead' }),
      notes: [note({ id: 4, pitch: 61, startPpq: 0, durationPpq: 4 })],
    };
    const report = analyzeArrangementTracks([harmony, clash], C_MAJOR);
    expect(report.conflicts.length).toBeGreaterThan(0);
    for (const conflict of report.conflicts) {
      expect(conflict.ppq).toBeGreaterThanOrEqual(0);
      expect(conflict.pitch).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns an empty report when only percussion tracks are present', () => {
    const drums: TrackWithNotes = {
      track: track({ id: 1, name: 'Drums' }),
      notes: [note({ id: 1, pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 })],
    };
    const report = analyzeArrangementTracks([drums]);
    expect(report.conflicts).toEqual([]);
    expect(report.excludedTrackNames).toEqual(['Drums']);
  });
});

describe('arrangementTensionCurve', () => {
  it('samples one tension point per step across the piece', () => {
    const melody: TrackWithNotes = {
      track: track({ id: 1, name: 'Lead' }),
      notes: cMajorMelody(),
    };
    const curve = arrangementTensionCurve([melody], 1, C_MAJOR);
    expect(curve.length).toBeGreaterThan(0);
    for (const point of curve) {
      expect(point.tension).toBeGreaterThanOrEqual(0);
      expect(point.tension).toBeLessThanOrEqual(1);
    }
  });

  it('is empty without harmonic tracks', () => {
    const drums: TrackWithNotes = {
      track: track({ id: 1, name: 'Drums' }),
      notes: [note({ id: 1, pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 })],
    };
    expect(arrangementTensionCurve([drums])).toEqual([]);
  });
});
