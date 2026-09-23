import { ReasonFlag } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import {
  analyzeArrangementTracks,
  analyzeArrangementWithTension,
  arrangementTensionCurve,
  conflictReason,
} from '@/compose/arrangement';
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

  /**
   * The piece goes to the library whole rather than cut into one-signature
   * pieces, so a melodic relation that spans a signature change is still a
   * relation. Read range by range, the lead's two notes fall in different calls
   * and nothing relates them.
   */
  it('sees a leap that spans a meter change', () => {
    // A C major triad held right through the change, so the harmony itself goes
    // nowhere; the lead alone moves, and only across the change. Both its notes
    // are chord tones in the key, so the leap is the one thing left to flag.
    const harmony: TrackWithNotes = {
      track: track({ id: 1, name: 'Piano' }),
      notes: [48, 52, 55].map((pitch, index) =>
        note({ id: index + 1, pitch, startPpq: 0, durationPpq: 7 }),
      ),
    };
    const lead: TrackWithNotes = {
      track: track({ id: 2, name: 'Lead' }),
      notes: [
        note({ id: 10, pitch: 60, startPpq: 3, durationPpq: 1 }),
        note({ id: 11, pitch: 84, startPpq: 4, durationPpq: 1 }),
      ],
    };
    const report = analyzeArrangementTracks([harmony, lead], undefined, [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 4, numerator: 3, denominator: 4 },
    ]);

    const leap = report.conflicts.find((conflict) => conflict.trackName === 'Lead');
    expect(leap).toBeDefined();
    expect(leap?.ppq).toBe(4);
    expect(leap?.pitch).toBe(84);
    expect(conflictReason(leap?.reasons ?? 0)).toBe('largeLeap');
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

  it('anchors meter-aware analysis to the enclosing bar rather than the first note', () => {
    const upbeat: TrackWithNotes = {
      track: track({ id: 1, name: 'Lead' }),
      notes: [note({ id: 1, pitch: 60, startPpq: 2.5, durationPpq: 1 })],
    };
    const curve = arrangementTensionCurve([upbeat], 1, C_MAJOR, [
      { startPpq: 0, numerator: 4, denominator: 4 },
    ]);
    // Sampling opens where the note sounds, then steps on the bar's beat grid.
    expect(curve.map((point) => point.beat)).toEqual([2.5, 3]);
  });

  it('hears the music before a meter change as context for the music after it', () => {
    const melody: TrackWithNotes = {
      track: track({ id: 1, name: 'Lead' }),
      notes: [
        // The opening establishes C major.
        note({ id: 1, pitch: 60, startPpq: 0, durationPpq: 2 }),
        note({ id: 2, pitch: 64, startPpq: 0, durationPpq: 2 }),
        note({ id: 3, pitch: 67, startPpq: 0, durationPpq: 2 }),
        // D minor alone would infer D minor; heard after the opening it is ii
        // in C major, and therefore has the higher tension value.
        note({ id: 4, pitch: 62, startPpq: 4, durationPpq: 1 }),
        note({ id: 5, pitch: 65, startPpq: 4, durationPpq: 1 }),
        note({ id: 6, pitch: 69, startPpq: 4, durationPpq: 1 }),
      ],
    };
    const meters = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 4, numerator: 3, denominator: 4 },
    ];

    const inferred = arrangementTensionCurve([melody], 1, undefined, meters);
    const explicit = arrangementTensionCurve([melody], 1, C_MAJOR, meters);
    const laterAlone = arrangementTensionCurve(
      [
        {
          ...melody,
          notes: melody.notes
            .filter((item) => item.startPpq >= 4)
            .map((item) => ({ ...item, startPpq: item.startPpq - 4 })),
        },
      ],
      1,
      undefined,
      [{ startPpq: 0, numerator: 3, denominator: 4 }],
    );
    const inferredLater = inferred.find((point) => point.beat === 4);
    const explicitLater = explicit.find((point) => point.beat === 4);
    const aloneLater = laterAlone.find((point) => point.beat === 0);

    expect(inferredLater).toBeDefined();
    expect(explicitLater).toBeDefined();
    expect(aloneLater).toBeDefined();
    expect(inferredLater).toEqual({ beat: 4, tension: explicitLater?.tension });
    expect(inferredLater?.tension).toBeGreaterThan(aloneLater?.tension ?? -1);
  });

  // Sampled range by range, the curve restarted at each signature change and
  // stopped at the last note of the range before it, leaving a hole over the
  // rest that the reader would draw straight through.
  it('samples straight through a meter change without a hole', () => {
    const melody: TrackWithNotes = {
      track: track({ id: 1, name: 'Lead' }),
      notes: [
        note({ id: 1, pitch: 60, startPpq: 0, durationPpq: 2 }),
        note({ id: 2, pitch: 64, startPpq: 0, durationPpq: 2 }),
        note({ id: 3, pitch: 67, startPpq: 0, durationPpq: 2 }),
        // Nothing sounds over beats 2 and 3, which is where the hole opened.
        note({ id: 4, pitch: 62, startPpq: 4, durationPpq: 1 }),
        note({ id: 5, pitch: 65, startPpq: 4, durationPpq: 1 }),
        note({ id: 6, pitch: 69, startPpq: 4, durationPpq: 1 }),
      ],
    };
    const curve = arrangementTensionCurve([melody], 1, undefined, [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 4, numerator: 3, denominator: 4 },
    ]);

    const beats = curve.map((point) => point.beat);
    expect(beats.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('is empty without harmonic tracks', () => {
    const drums: TrackWithNotes = {
      track: track({ id: 1, name: 'Drums' }),
      notes: [note({ id: 1, pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 })],
    };
    expect(arrangementTensionCurve([drums])).toEqual([]);
  });
});

/**
 * The Analyze action wants both readings, and the analysis behind them is the
 * expensive part, so they are read off one sweep. These pin that the combined
 * entry point never says anything the two separate calls would not.
 */
describe('analyzeArrangementWithTension', () => {
  /** A melody plus a clashing line, so there is something in both readings. */
  function pieceWithAClash(): TrackWithNotes[] {
    return [
      { track: track({ id: 1, name: 'Melody' }), notes: cMajorMelody() },
      {
        track: track({ id: 2, name: 'Lead' }),
        notes: [
          note({ id: 10, pitch: 61, startPpq: 0, durationPpq: 1 }),
          note({ id: 11, pitch: 66, startPpq: 4, durationPpq: 1 }),
        ],
      },
      {
        track: track({ id: 3, name: 'Drums' }),
        notes: [note({ id: 20, pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 })],
      },
    ];
  }

  it.each([
    ['no key, one meter', undefined, undefined],
    ['a pinned key, one meter', C_MAJOR, [{ startPpq: 0, numerator: 4, denominator: 4 }]],
    [
      'no key, a meter change',
      undefined,
      [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 4, numerator: 3, denominator: 4 },
      ],
    ],
    [
      'a pinned key and a meter change',
      C_MAJOR,
      [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 4, numerator: 3, denominator: 4 },
      ],
    ],
  ])('agrees with the separate calls given %s', (_label, key, timeSignatures) => {
    const tracks = pieceWithAClash();
    const combined = analyzeArrangementWithTension(tracks, 1, key, timeSignatures);
    const report = analyzeArrangementTracks(tracks, key, timeSignatures);
    const tension = arrangementTensionCurve(tracks, 1, key, timeSignatures);

    expect(combined.conflicts).toEqual(report.conflicts);
    expect(combined.key).toEqual(report.key);
    expect(combined.excludedTrackNames).toEqual(report.excludedTrackNames);
    expect(combined.tension).toEqual(tension);
  });

  // A pinned key is held across the whole arrangement, so a modulation cannot
  // pull the reading away from it. If the library ever stops holding it, this
  // is where that shows up.
  it('holds a pinned key across a modulating piece and a meter change', () => {
    const notes: EditorNote[] = [];
    let id = 100;
    // Four bars of emphatic F-sharp major, then four of C major.
    for (let bar = 0; bar < 4; bar += 1) {
      for (const [beat, pitch] of [66, 70, 73, 78].entries()) {
        notes.push(note({ id: id++, pitch, startPpq: bar * 4 + beat, durationPpq: 1 }));
      }
    }
    for (let bar = 0; bar < 4; bar += 1) {
      for (const [beat, pitch] of [60, 64, 67, 72].entries()) {
        notes.push(note({ id: id++, pitch, startPpq: 16 + bar * 3 + (beat % 3), durationPpq: 1 }));
      }
    }
    const tracks: TrackWithNotes[] = [{ track: track({ id: 1, name: 'Melody' }), notes }];
    const meters = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 16, numerator: 3, denominator: 4 },
    ];

    // Left to itself the piece reads as F-sharp major; pinned, it stays C.
    expect(analyzeArrangementTracks(tracks, undefined, meters).key.rootPc).toBe(6);
    expect(analyzeArrangementTracks(tracks, C_MAJOR, meters).key).toEqual(C_MAJOR);

    const combined = analyzeArrangementWithTension(tracks, 1, C_MAJOR, meters);
    expect(combined.conflicts).toEqual(analyzeArrangementTracks(tracks, C_MAJOR, meters).conflicts);
    expect(combined.tension).toEqual(arrangementTensionCurve(tracks, 1, C_MAJOR, meters));
  });

  it('is empty in both readings without harmonic tracks', () => {
    const drums: TrackWithNotes = {
      track: track({ id: 1, name: 'Drums' }),
      notes: [note({ id: 1, pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 })],
    };
    const combined = analyzeArrangementWithTension([drums]);
    expect(combined.conflicts).toEqual([]);
    expect(combined.tension).toEqual([]);
    expect(combined.excludedTrackNames).toEqual(['Drums']);
  });
});

/**
 * The library states why a note was flagged in English prose, which an editor
 * running in more than one language cannot show. The same reasoning is in the
 * bitmask, so the reason is read from there and named in the display's own
 * language. These pin the reading, not the wording.
 */
describe('conflictReason', () => {
  it('names nothing when no flag explains the verdict', () => {
    expect(conflictReason(0)).toBeUndefined();
    // A chord tone is never the reason a chord tone was flagged.
    expect(conflictReason(ReasonFlag.ChordTone)).toBeUndefined();
  });

  it('lets a vertical clash outrank the intervals that make it up', () => {
    const clash = ReasonFlag.VerticalDissonance | ReasonFlag.NonScale | ReasonFlag.Tritone;
    expect(conflictReason(clash)).toBe('verticalDissonance');
    expect(conflictReason(clash | ReasonFlag.VoiceCrossing)).toBe('verticalDissonance');
  });

  it('lets a counterpoint fault outrank the plain scale reading of the same note', () => {
    expect(conflictReason(ReasonFlag.ScaleTone | ReasonFlag.VoiceCrossing)).toBe('voiceCrossing');
    expect(conflictReason(ReasonFlag.ChordTone | ReasonFlag.LargeLeap)).toBe('largeLeap');
    // Nothing sharper applies: in the scale, out of the chord.
    expect(conflictReason(ReasonFlag.ScaleTone)).toBe('nonChordTone');
    expect(conflictReason(ReasonFlag.NonScale)).toBe('outOfKey');
  });

  // A flag with no reading would show a conflict with no explanation at all.
  it('names every flag that can explain a conflict', () => {
    const unexplaining = new Set([ReasonFlag.ChordTone, ReasonFlag.Tension]);
    for (const value of Object.values(ReasonFlag)) {
      if (typeof value !== 'number' || unexplaining.has(value)) continue;
      expect(conflictReason(value)).toBeDefined();
    }
  });
});
