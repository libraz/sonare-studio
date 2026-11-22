import { type ChordData, type ChordTimeline, makeChord } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import type { GuidanceProfile } from '@/compose/guidance-profile';
import { buildKeyMap, type KeyMap } from '@/compose/key-map';
import {
  clashes,
  classifyApproach,
  evaluatePlacementColumn,
  type HarmonicContext,
  isHarmonicMember,
  type PlacementInput,
  type PlacementLevel,
  type PlacementReason,
  type PlacementVerdict,
  thinsAccompaniment,
} from '@/compose/placement';
import { harmonicNotes } from '@/compose/tracks';
import {
  buildVoiceContext,
  buildVoiceLines,
  type VoiceLine,
  type VoiceRole,
} from '@/compose/voice-context';
import { PITCH_RANGE_PRESETS } from '@/project/pitch-range';
import {
  type EditorClip,
  type EditorNote,
  type EditorTrack,
  MAJOR_MODE_MASK,
  type TimeSignatureSegment,
} from '@/project/types';

type Beat = 'strong' | 'weak';
type Approach = 'none' | 'same' | 'step' | 'leap';
type Dissonance = 'none' | 'voice' | 'chord' | 'avoid' | 'both';
type Partner =
  | 'none'
  | 'melodic'
  | 'accompFollowing'
  | 'accompNotFollowing'
  | 'accompRoot'
  | 'sameClip';
type Motion = 'plain' | 'parallelPerfect' | 'doubling' | 'hiddenOuter';
type ChordTrack = 'present' | 'absent';

/**
 * Covering array over the placement policy, one row per case:
 * beat, approach, dissonance, partner, profile, motion, chordTrack.
 *
 * Constraints: an absent chord track rules out chord/avoid/both dissonance and
 * accompaniment partners; none/same approaches only take plain motion;
 * none/chord/avoid dissonance has no partner and voice/both always has one.
 * Strength 2 over all parameters and 3 over beat x approach x dissonance.
 * The last two columns are the level and reasons derived from the §5 table.
 */
const COVERAGE_CASES: ReadonlyArray<
  readonly [
    Beat,
    Approach,
    Dissonance,
    Partner,
    GuidanceProfile,
    Motion,
    ChordTrack,
    PlacementLevel,
    ReadonlyArray<PlacementReason>,
  ]
> = [
  ['strong', 'none', 'none', 'none', 'counterpoint', 'plain', 'present', 'safe', []],
  [
    'strong',
    'step',
    'voice',
    'melodic',
    'pop',
    'parallelPerfect',
    'absent',
    'warn',
    ['unpreparedDissonance', 'parallelPerfect'],
  ],
  [
    'weak',
    'leap',
    'both',
    'accompFollowing',
    'pop',
    'doubling',
    'present',
    'safe',
    ['accompanimentThinned'],
  ],
  [
    'weak',
    'same',
    'voice',
    'sameClip',
    'counterpoint',
    'plain',
    'absent',
    'warn',
    ['preparedSuspension'],
  ],
  [
    'strong',
    'step',
    'both',
    'accompNotFollowing',
    'counterpoint',
    'hiddenOuter',
    'present',
    'warn',
    ['accompanimentThinnable'],
  ],
  ['weak', 'leap', 'none', 'none', 'pop', 'hiddenOuter', 'absent', 'warn', ['hiddenParallel']],
  [
    'strong',
    'leap',
    'voice',
    'accompRoot',
    'counterpoint',
    'parallelPerfect',
    'present',
    'ng',
    ['accompanimentRootClash', 'parallelPerfect'],
  ],
  ['strong', 'same', 'chord', 'none', 'pop', 'plain', 'present', 'warn', ['preparedSuspension']],
  [
    'strong',
    'step',
    'avoid',
    'none',
    'counterpoint',
    'doubling',
    'present',
    'ng',
    ['steppedNonChordTone', 'avoidNote'],
  ],
  [
    'weak',
    'none',
    'both',
    'melodic',
    'counterpoint',
    'plain',
    'present',
    'ng',
    ['unpreparedDissonance', 'chordDissonance'],
  ],
  [
    'weak',
    'step',
    'both',
    'sameClip',
    'pop',
    'parallelPerfect',
    'present',
    'warn',
    ['steppedNonChordTone', 'parallelPerfect'],
  ],
  [
    'weak',
    'none',
    'voice',
    'accompNotFollowing',
    'pop',
    'plain',
    'present',
    'warn',
    ['accompanimentThinnable'],
  ],
  [
    'weak',
    'same',
    'both',
    'accompRoot',
    'pop',
    'plain',
    'present',
    'warn',
    ['accompanimentRootClash'],
  ],
  [
    'strong',
    'none',
    'voice',
    'accompFollowing',
    'counterpoint',
    'plain',
    'present',
    'safe',
    ['accompanimentThinned'],
  ],
  [
    'weak',
    'step',
    'chord',
    'none',
    'counterpoint',
    'parallelPerfect',
    'present',
    'ng',
    ['steppedNonChordTone', 'parallelPerfect'],
  ],
  ['weak', 'leap', 'avoid', 'none', 'pop', 'plain', 'present', 'warn', ['chordDissonance']],
  [
    'strong',
    'leap',
    'voice',
    'sameClip',
    'counterpoint',
    'doubling',
    'absent',
    'ng',
    ['leapIntoDissonance'],
  ],
  [
    'weak',
    'step',
    'voice',
    'accompFollowing',
    'counterpoint',
    'hiddenOuter',
    'present',
    'safe',
    ['accompanimentThinned'],
  ],
  ['strong', 'step', 'none', 'none', 'counterpoint', 'plain', 'present', 'safe', []],
  [
    'strong',
    'leap',
    'chord',
    'none',
    'counterpoint',
    'doubling',
    'present',
    'ng',
    ['chordDissonance'],
  ],
  [
    'strong',
    'leap',
    'both',
    'melodic',
    'counterpoint',
    'doubling',
    'present',
    'ng',
    ['leapIntoDissonance', 'chordDissonance'],
  ],
  [
    'weak',
    'leap',
    'voice',
    'accompNotFollowing',
    'counterpoint',
    'parallelPerfect',
    'present',
    'ng',
    ['accompanimentThinnable', 'parallelPerfect'],
  ],
  [
    'strong',
    'none',
    'voice',
    'sameClip',
    'counterpoint',
    'plain',
    'absent',
    'ng',
    ['unpreparedDissonance'],
  ],
  [
    'strong',
    'none',
    'chord',
    'none',
    'counterpoint',
    'plain',
    'present',
    'ng',
    ['chordDissonance'],
  ],
  [
    'strong',
    'none',
    'avoid',
    'none',
    'counterpoint',
    'plain',
    'present',
    'ng',
    ['chordDissonance', 'avoidNote'],
  ],
  [
    'strong',
    'none',
    'both',
    'accompRoot',
    'counterpoint',
    'plain',
    'present',
    'warn',
    ['accompanimentRootClash'],
  ],
  ['strong', 'same', 'none', 'none', 'counterpoint', 'plain', 'present', 'safe', []],
  [
    'strong',
    'same',
    'voice',
    'melodic',
    'counterpoint',
    'plain',
    'present',
    'warn',
    ['preparedSuspension'],
  ],
  [
    'strong',
    'same',
    'avoid',
    'none',
    'counterpoint',
    'plain',
    'present',
    'warn',
    ['preparedSuspension'],
  ],
  [
    'strong',
    'same',
    'both',
    'accompFollowing',
    'counterpoint',
    'plain',
    'present',
    'safe',
    ['accompanimentThinned'],
  ],
  [
    'strong',
    'step',
    'voice',
    'accompRoot',
    'counterpoint',
    'doubling',
    'present',
    'warn',
    ['accompanimentRootClash'],
  ],
  [
    'strong',
    'step',
    'chord',
    'none',
    'counterpoint',
    'hiddenOuter',
    'present',
    'warn',
    ['steppedNonChordTone'],
  ],
  [
    'strong',
    'leap',
    'none',
    'none',
    'counterpoint',
    'parallelPerfect',
    'present',
    'ng',
    ['parallelPerfect'],
  ],
  [
    'strong',
    'leap',
    'avoid',
    'none',
    'counterpoint',
    'parallelPerfect',
    'present',
    'ng',
    ['chordDissonance', 'avoidNote', 'parallelPerfect'],
  ],
  ['weak', 'step', 'none', 'none', 'counterpoint', 'doubling', 'present', 'safe', []],
  [
    'weak',
    'step',
    'avoid',
    'none',
    'counterpoint',
    'hiddenOuter',
    'present',
    'warn',
    ['steppedNonChordTone'],
  ],
  [
    'strong',
    'same',
    'voice',
    'accompNotFollowing',
    'counterpoint',
    'plain',
    'present',
    'warn',
    ['accompanimentThinnable'],
  ],
  [
    'strong',
    'step',
    'voice',
    'melodic',
    'counterpoint',
    'hiddenOuter',
    'present',
    'ng',
    ['unpreparedDissonance'],
  ],
  [
    'strong',
    'step',
    'voice',
    'accompFollowing',
    'counterpoint',
    'parallelPerfect',
    'present',
    'ng',
    ['accompanimentThinned', 'parallelPerfect'],
  ],
  [
    'strong',
    'step',
    'voice',
    'accompNotFollowing',
    'counterpoint',
    'doubling',
    'present',
    'warn',
    ['accompanimentThinnable'],
  ],
  [
    'strong',
    'step',
    'voice',
    'accompRoot',
    'counterpoint',
    'hiddenOuter',
    'present',
    'warn',
    ['accompanimentRootClash'],
  ],
  [
    'strong',
    'step',
    'voice',
    'sameClip',
    'counterpoint',
    'hiddenOuter',
    'present',
    'ng',
    ['unpreparedDissonance'],
  ],
  ['weak', 'none', 'none', 'none', 'counterpoint', 'plain', 'present', 'safe', []],
  [
    'weak',
    'none',
    'chord',
    'none',
    'counterpoint',
    'plain',
    'present',
    'warn',
    ['chordDissonance'],
  ],
  [
    'weak',
    'none',
    'avoid',
    'none',
    'counterpoint',
    'plain',
    'present',
    'warn',
    ['chordDissonance'],
  ],
  ['weak', 'same', 'none', 'none', 'counterpoint', 'plain', 'present', 'safe', []],
  [
    'weak',
    'same',
    'chord',
    'none',
    'counterpoint',
    'plain',
    'present',
    'warn',
    ['preparedSuspension'],
  ],
  [
    'weak',
    'same',
    'avoid',
    'none',
    'counterpoint',
    'plain',
    'present',
    'warn',
    ['preparedSuspension'],
  ],
  [
    'weak',
    'leap',
    'chord',
    'none',
    'counterpoint',
    'plain',
    'present',
    'warn',
    ['chordDissonance'],
  ],
];

const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];
const NATURAL_MINOR_MASK = 0b010110101101;
const NO_KEY = buildKeyMap({ enabled: false, rootPc: 0, modeMask: MAJOR_MODE_MASK }, []);
const C_MAJOR_KEY = buildKeyMap({ enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK }, []);
const A_MINOR_KEY = buildKeyMap({ enabled: true, rootPc: 9, modeMask: NATURAL_MINOR_MASK }, []);

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MIDI number of a name like `F#4` or `Bb3` (C4 = 60). */
function p(name: string): number {
  const match = name.match(/^([A-G])(#|b)?(-?\d)$/);
  if (match === null) throw new Error(`bad pitch ${name}`);
  const alter = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  return (Number(match[3]) + 1) * 12 + LETTER_PC[match[1]] + alter;
}

let nextId = 1;
function n(pitch: number, startPpq: number, durationPpq = 1, channel = 0): EditorNote {
  return { id: nextId++, pitch, velocity: 96, startPpq, durationPpq, channel };
}

function line(trackId: number, role: VoiceRole, notes: EditorNote[]): VoiceLine {
  return { trackId, role, notes };
}

function timeline(...segments: Array<[number, number, ChordData]>): ChordTimeline {
  const segs = segments.map(([startBeat, endBeat, chord]) => ({ startBeat, endBeat, chord }));
  return {
    segments: segs,
    at: (beat) => segs.find((s) => beat >= s.startBeat && beat < s.endBeat)?.chord ?? null,
  };
}

const C = makeChord(0, 'maj');
const F = makeChord(5, 'maj');
const CMAJ7 = makeChord(0, 'maj7');
const CADD9 = makeChord(0, 'add9');
const G7 = makeChord(7, 'dom7');

interface Scene {
  startPpq: number;
  lengthPpq?: number;
  lines?: VoiceLine[];
  active?: ReadonlyArray<EditorNote>;
  chords?: ChordTimeline;
  keyMap?: KeyMap;
  profile?: GuidanceProfile;
  followers?: number[];
  pitchRange?: { low: number; high: number };
}

function inputOf(scene: Scene): PlacementInput {
  const lines = scene.lines ?? [];
  return {
    startPpq: scene.startPpq,
    lengthPpq: scene.lengthPpq ?? 1,
    activeNotes: scene.active ?? [],
    voices: buildVoiceContext(lines, [], FOUR_FOUR),
    chords: scene.chords ?? timeline(),
    keyMap: scene.keyMap ?? NO_KEY,
    timeSignatures: FOUR_FOUR,
    profile: scene.profile ?? 'counterpoint',
    followerTrackIds: new Set(scene.followers ?? []),
    ...(scene.pitchRange !== undefined ? { pitchRange: scene.pitchRange } : {}),
  };
}

function verdictAt(scene: Scene, pitch: number): PlacementVerdict {
  return evaluatePlacementColumn(inputOf(scene), pitch, pitch)[0];
}

const ACCOMP = 2;
const MELODIC = 3;
const BASS = 5;

describe('evaluatePlacementColumn — measured fixtures', () => {
  it('a prepared 4-3 suspension stays warn under counterpoint and resolves to E4', () => {
    const scene: Scene = {
      startPpq: 2,
      chords: timeline([0, 2, F], [2, 4, C]),
      lines: [line(BASS, 'bass', [n(p('F3'), 0, 2), n(p('C3'), 2, 2)])],
      active: [n(p('F4'), 0, 2)],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('preparedSuspension');
    expect(verdict.resolveTo).toContain(p('E4'));
  });

  it('the same F4 struck again after a rest is a chord dissonance and a strong avoid note', () => {
    const scene: Scene = {
      startPpq: 2,
      chords: timeline([0, 2, F], [2, 4, C]),
      lines: [line(BASS, 'bass', [n(p('F3'), 0, 2), n(p('C3'), 2, 2)])],
      active: [n(p('F4'), 0, 1.5)],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.level).toBe('ng');
    expect(verdict.reasons).toEqual(expect.arrayContaining(['chordDissonance', 'avoidNote']));
  });

  it('a preparation that itself clashed at its onset does not prepare the suspension', () => {
    const scene: Scene = {
      startPpq: 2,
      chords: timeline([0, 2, F], [2, 4, C]),
      lines: [
        line(BASS, 'bass', [n(p('F3'), 0, 2), n(p('C3'), 2, 2)]),
        line(MELODIC, 'melodic', [n(p('E4'), 0, 2)]),
      ],
      active: [n(p('F4'), 0, 2)],
    };
    expect(verdictAt(scene, p('F4')).level).toBe('ng');
  });

  it('C4 to D4 over a C3 bass on a weak beat is safe: a tension against a chord tone', () => {
    const scene: Scene = {
      startPpq: 1,
      chords: timeline([0, 4, C]),
      lines: [line(BASS, 'bass', [n(p('C3'), 0, 4)])],
      active: [n(p('C4'), 0, 1)],
    };
    expect(verdictAt(scene, p('D4')).level).toBe('safe');
  });

  it('D5 leaping in over a following C-triad accompaniment is safe and thins nothing', () => {
    const scene: Scene = {
      startPpq: 4,
      chords: timeline([0, 8, C]),
      lines: [
        line(ACCOMP, 'accompaniment', [n(p('C4'), 0, 8), n(p('E4'), 0, 8), n(p('G4'), 0, 8)]),
      ],
      active: [n(p('A4'), 3, 1)],
      followers: [ACCOMP],
    };
    const verdict = verdictAt(scene, p('D5'));
    expect(verdict.level).toBe('safe');
    expect(verdict.partners).toEqual([]);
  });

  it('G4 to B4 over a C3 bass under Cmaj7 is safe', () => {
    const scene: Scene = {
      startPpq: 4,
      chords: timeline([0, 8, CMAJ7]),
      lines: [line(BASS, 'bass', [n(p('C3'), 0, 8)])],
      active: [n(p('G4'), 3, 1)],
    };
    expect(verdictAt(scene, p('B4')).level).toBe('safe');
  });

  it('C5 to D5 over a C3 bass under Cadd9 is safe', () => {
    const scene: Scene = {
      startPpq: 4,
      chords: timeline([0, 8, CADD9]),
      lines: [line(BASS, 'bass', [n(p('C3'), 0, 8)])],
      active: [n(p('C5'), 3, 1)],
    };
    expect(verdictAt(scene, p('D5')).level).toBe('safe');
  });

  const steppedAgainstE4 = (startPpq: number, profile: GuidanceProfile): Scene => ({
    startPpq,
    profile,
    chords: timeline([0, 4, C]),
    lines: [line(MELODIC, 'melodic', [n(p('E4'), 0, 4)])],
    active: [n(p('G4'), startPpq - 1, 1)],
  });

  it('G4 stepping to F4 against a melodic E4 on a weak beat is a warned non-chord tone', () => {
    const verdict = verdictAt(steppedAgainstE4(1, 'counterpoint'), p('F4'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('steppedNonChordTone');
  });

  it('the same step on a strong beat is ng under counterpoint and warn under pop', () => {
    expect(verdictAt(steppedAgainstE4(2, 'counterpoint'), p('F4')).level).toBe('ng');
    expect(verdictAt(steppedAgainstE4(2, 'pop'), p('F4')).level).toBe('warn');
  });

  it('A4 leaping to F4 against E4 is a leap into dissonance', () => {
    const scene: Scene = {
      startPpq: 1,
      chords: timeline([0, 4, C]),
      lines: [line(MELODIC, 'melodic', [n(p('E4'), 0, 4)])],
      active: [n(p('A4'), 0, 1)],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.level).toBe('ng');
    expect(verdict.reasons).toContain('leapIntoDissonance');
  });

  const parallelFifths = (profile: GuidanceProfile): Scene => ({
    startPpq: 1,
    profile,
    lines: [line(MELODIC, 'melodic', [n(p('Bb3'), 0, 1), n(p('C4'), 1, 1)])],
    active: [n(p('F4'), 0, 1)],
  });

  it('parallel fifths over Bb3-C4 are ng under counterpoint and warn under pop', () => {
    const strict = verdictAt(parallelFifths('counterpoint'), p('G4'));
    expect(strict.level).toBe('ng');
    expect(strict.reasons).toContain('parallelPerfect');
    const pop = verdictAt(parallelFifths('pop'), p('G4'));
    expect(pop.level).toBe('warn');
    expect(pop.reasons).toContain('parallelPerfect');
  });

  it('octaves continuing a four-beat doubling are not a parallel', () => {
    const scene: Scene = {
      startPpq: 3,
      lines: [
        line(MELODIC, 'melodic', [
          n(p('C3'), 0, 1),
          n(p('D3'), 1, 1),
          n(p('E3'), 2, 1),
          n(p('F3'), 3, 1),
        ]),
      ],
      active: [n(p('C4'), 0, 1), n(p('D4'), 1, 1), n(p('E4'), 2, 1)],
    };
    expect(verdictAt(scene, p('F4')).reasons).not.toContain('parallelPerfect');
  });

  it('F4 leaping in against an E4 held in the same clip is ng with an own-clip partner', () => {
    const scene: Scene = {
      startPpq: 2,
      active: [n(p('E4'), 0, 4), n(p('C5'), 1, 1)],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.level).toBe('ng');
    expect(verdict.partners.map((partner) => partner.trackId)).toContain(null);
  });

  it('inside a held C-E-G clip chord, F4 steps from E4 and still clashes with it', () => {
    const scene: Scene = {
      startPpq: 1,
      active: [n(p('C4'), 0, 4), n(p('E4'), 0, 4), n(p('G4'), 0, 4)],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.reasons).toContain('steppedNonChordTone');
    expect(verdict.partners).toContainEqual(
      expect.objectContaining({ pitch: p('E4'), trackId: null }),
    );
  });

  const triadAccompaniment = (start: number): VoiceLine =>
    line(ACCOMP, 'accompaniment', [
      n(p('C4'), start, 4),
      n(p('E4'), start, 4),
      n(p('G4'), start, 4),
    ]);

  it('F4 over a following accompaniment E4 on a strong beat is safe because E4 is thinned', () => {
    const scene: Scene = {
      startPpq: 4,
      chords: timeline([0, 8, C]),
      lines: [triadAccompaniment(4)],
      followers: [ACCOMP],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.level).toBe('safe');
    expect(verdict.reasons).toContain('accompanimentThinned');
    expect(verdict.partners).toEqual([
      { pitch: p('E4'), trackId: ACCOMP, kind: 'accompNonRoot', thinned: true, following: true },
    ]);
  });

  it('a weak-beat sixteenth stepping from G4 does not thin E4 and warns as a non-chord tone', () => {
    const scene: Scene = {
      startPpq: 5,
      lengthPpq: 0.25,
      chords: timeline([0, 8, C]),
      lines: [triadAccompaniment(4)],
      active: [n(p('G4'), 4, 1)],
      followers: [ACCOMP],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('steppedNonChordTone');
    expect(verdict.partners[0].thinned).toBe(false);
  });

  it('F4 over an accompaniment that does not follow is thinnable', () => {
    const scene: Scene = {
      startPpq: 4,
      chords: timeline([0, 8, C]),
      lines: [triadAccompaniment(4)],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('accompanimentThinnable');
  });

  it('Db4 leaping in against the accompaniment root C4 is a root clash, not a chord dissonance', () => {
    const scene: Scene = {
      startPpq: 4,
      chords: timeline([0, 8, C]),
      lines: [triadAccompaniment(4)],
      active: [n(p('F4'), 3, 1)],
      followers: [ACCOMP],
    };
    const verdict = verdictAt(scene, p('Db4'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('accompanimentRootClash');
    expect(verdict.reasons).not.toContain('chordDissonance');
  });

  it('Db4 leaping in against a bass-track C3 is ng', () => {
    const scene: Scene = {
      startPpq: 4,
      chords: timeline([0, 8, C]),
      lines: [line(BASS, 'bass', [n(p('C3'), 4, 4)])],
      active: [n(p('F4'), 3, 1)],
    };
    expect(verdictAt(scene, p('Db4')).level).toBe('ng');
  });

  it('without a chord an accompaniment E4 is not thinned and reads as a melodic partner', () => {
    const scene: Scene = {
      startPpq: 4,
      lines: [line(ACCOMP, 'accompaniment', [n(p('C4'), 4, 4), n(p('E4'), 4, 4)])],
      followers: [ACCOMP],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.partners).toContainEqual(
      expect.objectContaining({ pitch: p('E4'), kind: 'melodic', thinned: false }),
    );
    expect(verdict.reasons).toContain('unpreparedDissonance');
    expect(verdict.level).toBe('ng');
  });

  it('B4 leaping in over a C3 pedal under G7 is safe', () => {
    const scene: Scene = {
      startPpq: 4,
      chords: timeline([0, 4, C], [4, 8, G7]),
      lines: [line(BASS, 'bass', [n(p('C3'), 0, 8)])],
      active: [n(p('G4'), 3, 1)],
    };
    expect(verdictAt(scene, p('B4')).level).toBe('safe');
  });

  it('swapping order with another voice is a warned voice crossing', () => {
    const scene: Scene = {
      startPpq: 1,
      lines: [line(MELODIC, 'melodic', [n(p('E4'), 0, 1), n(p('G4'), 1, 1)])],
      active: [n(p('G4'), 0, 1)],
    };
    const verdict = verdictAt(scene, p('E4'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('voiceCrossing');
  });

  it('arriving on a unison with another voice is not a crossing', () => {
    const scene: Scene = {
      startPpq: 1,
      lines: [line(MELODIC, 'melodic', [n(p('G4'), 0, 2)])],
      active: [n(p('E4'), 0, 1)],
    };
    expect(verdictAt(scene, p('G4')).reasons).not.toContain('voiceCrossing');
  });

  it('13 semitones above the adjacent upper voice is warned wide spacing', () => {
    const scene: Scene = {
      startPpq: 1,
      lines: [line(BASS, 'bass', [n(p('C3'), 0, 4)]), line(MELODIC, 'melodic', [n(p('C4'), 0, 4)])],
      active: [n(p('D5'), 0, 1)],
    };
    const verdict = verdictAt(scene, p('C#5'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('wideSpacing');
  });

  it('names the voice a parallel fifth is made with', () => {
    expect(verdictAt(parallelFifths('counterpoint'), p('G4')).motionPartners).toEqual([
      { trackId: MELODIC, pitch: p('C4'), kind: 'parallel' },
    ]);
  });

  it('names the voice a crossing swaps with', () => {
    const scene: Scene = {
      startPpq: 1,
      lines: [line(MELODIC, 'melodic', [n(p('E4'), 0, 1), n(p('G4'), 1, 1)])],
      active: [n(p('G4'), 0, 1)],
    };
    expect(verdictAt(scene, p('E4')).motionPartners).toEqual([
      { trackId: MELODIC, pitch: p('G4'), kind: 'crossing' },
    ]);
  });

  it('names the opposite outer voice of a hidden fifth', () => {
    const scene: Scene = {
      startPpq: 1,
      lines: [line(BASS, 'bass', [n(p('C3'), 0, 1), n(p('G3'), 1, 1)])],
      active: [n(p('E4'), 0, 1)],
    };
    const verdict = verdictAt(scene, p('D5'));
    expect(verdict.reasons).toContain('hiddenParallel');
    expect(verdict.motionPartners).toEqual([{ trackId: BASS, pitch: p('G3'), kind: 'hidden' }]);
  });

  it('carries no motion partners when no motion rule fires', () => {
    const scene: Scene = {
      startPpq: 1,
      lines: [line(MELODIC, 'melodic', [n(p('C4'), 0, 2)])],
      active: [n(p('E4'), 0, 1)],
    };
    expect(verdictAt(scene, p('G4')).motionPartners).toBeUndefined();
  });

  it('F4 to G#4 in A minor is a forbidden leap under counterpoint', () => {
    const scene: Scene = { startPpq: 1, keyMap: A_MINOR_KEY, active: [n(p('F4'), 0, 1)] };
    const verdict = verdictAt(scene, p('G#4'));
    expect(verdict.level).toBe('ng');
    expect(verdict.reasons).toContain('forbiddenLeap');
  });

  it('with no key set the spelled leap check is skipped', () => {
    const scene: Scene = { startPpq: 1, keyMap: NO_KEY, active: [n(p('F4'), 0, 1)] };
    expect(verdictAt(scene, p('G#4')).reasons).not.toContain('forbiddenLeap');
  });

  it('C4 to D5 is a warned large leap', () => {
    const scene: Scene = { startPpq: 1, active: [n(p('C4'), 0, 1)] };
    const verdict = verdictAt(scene, p('D5'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('largeLeap');
  });

  const strongAvoid = (profile: GuidanceProfile): Scene => ({
    startPpq: 2,
    profile,
    chords: timeline([0, 4, C]),
    active: [n(p('E4'), 1, 1)],
  });

  it('a strong-beat avoid note is ng under counterpoint and warn under pop', () => {
    const strict = verdictAt(strongAvoid('counterpoint'), p('F4'));
    expect(strict.level).toBe('ng');
    expect(strict.reasons).toContain('avoidNote');
    expect(verdictAt(strongAvoid('pop'), p('F4')).level).toBe('warn');
  });

  it('C6 is out of a soprano range', () => {
    const scene: Scene = { startPpq: 0, pitchRange: PITCH_RANGE_PRESETS.soprano };
    const verdict = verdictAt(scene, p('C6'));
    expect(verdict.level).toBe('ng');
    expect(verdict.reasons).toContain('outOfRange');
  });

  it('F#4 with no chord but a key set is a warned non-scale tone', () => {
    const scene: Scene = {
      startPpq: 0,
      keyMap: C_MAJOR_KEY,
      lines: [line(MELODIC, 'melodic', [n(p('D4'), 0, 4)])],
    };
    const verdict = verdictAt(scene, p('F#4'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('nonScaleNoChord');
  });

  it('F#4 with neither chord nor key is safe', () => {
    expect(verdictAt({ startPpq: 0 }, p('F#4')).level).toBe('safe');
  });

  it('a channel-10 note in the edited clip is not a partner', () => {
    const lead = { id: 1, name: 'Lead', kind: 'midi' } as EditorTrack;
    const scene: Scene = {
      startPpq: 1,
      active: harmonicNotes(lead, [n(p('E4'), 0, 4, 9)]),
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.partners).toEqual([]);
    expect(verdict.level).toBe('safe');
  });

  it('a generated drum track renamed "FX Loop 1" on channel 1 contributes no voice', () => {
    const drums = {
      id: 7,
      name: 'FX Loop 1',
      kind: 'midi',
      generated: { part: 'drums' },
    } as EditorTrack;
    const clip = {
      id: 1,
      trackId: 7,
      name: 'Clip',
      startPpq: 0,
      lengthPpq: 4,
      sourceOffsetPpq: 0,
      gain: 1,
      loopEnabled: false,
      loopLengthPpq: 0,
      notes: [n(p('E4'), 0, 4)],
    } as EditorClip;
    const lines = buildVoiceLines([drums], new Map([[7, [clip]]]), 1);
    expect(lines).toEqual([]);
    const verdict = verdictAt({ startPpq: 0, lines }, p('F4'));
    expect(verdict.partners).toEqual([]);
  });

  it('a passing tone E4-F4 rising on a weak beat under C resolves to G4 or back to E4', () => {
    const scene: Scene = {
      startPpq: 1,
      chords: timeline([0, 4, C]),
      active: [n(p('E4'), 0, 1)],
    };
    const verdict = verdictAt(scene, p('F4'));
    expect(verdict.level).toBe('warn');
    expect(verdict.reasons).toContain('steppedNonChordTone');
    expect(verdict.resolveTo).toEqual(expect.arrayContaining([p('G4'), p('E4')]));
  });
});

describe('evaluatePlacementColumn — rules without a measured fixture', () => {
  it('a stepped passing tone against a voice resolves onward and back', () => {
    const scene: Scene = {
      startPpq: 1,
      lines: [line(MELODIC, 'melodic', [n(p('Eb4'), 0, 4)])],
      active: [n(p('C4'), 0, 1)],
    };
    const verdict = verdictAt(scene, p('D4'));
    expect(verdict.reasons).toContain('steppedNonChordTone');
    expect(verdict.resolveTo).toEqual(expect.arrayContaining([p('E4'), p('C4')]));
  });

  it('a lowest voice held from before the chord region is a pedal, not a partner', () => {
    const pedal: Scene = {
      startPpq: 4,
      chords: timeline([0, 4, C], [4, 8, G7]),
      lines: [line(BASS, 'bass', [n(p('C3'), 0, 8)])],
    };
    expect(verdictAt(pedal, p('Db4')).partners).toEqual([]);
    const struck: Scene = { ...pedal, lines: [line(BASS, 'bass', [n(p('C3'), 4, 4)])] };
    expect(verdictAt(struck, p('Db4')).partners.map((partner) => partner.pitch)).toEqual([p('C3')]);
  });

  it('returns one verdict per pitch from low to high', () => {
    const verdicts = evaluatePlacementColumn(inputOf({ startPpq: 0 }), 60, 71);
    expect(verdicts).toHaveLength(12);
  });
});

describe('shared predicates', () => {
  const ctx = (chord: ChordData | null): HarmonicContext => ({
    chord,
    key: { rootPc: 0, modeMask12: MAJOR_MODE_MASK },
    keySet: true,
    strongBeat: true,
  });

  it('isHarmonicMember covers chord tones and tensions only', () => {
    expect(isHarmonicMember(p('E4'), ctx(C))).toBe(true);
    expect(isHarmonicMember(p('D4'), ctx(C))).toBe(true);
    expect(isHarmonicMember(p('B4'), ctx(C))).toBe(false);
    expect(isHarmonicMember(p('E4'), ctx(null))).toBe(false);
  });

  it('clashes: members clash only a semitone apart; others follow interval class', () => {
    expect(clashes(p('C4'), p('B4'), false, ctx(CMAJ7))).toBe(false);
    expect(clashes(p('B3'), p('C4'), false, ctx(CMAJ7))).toBe(true);
    expect(clashes(p('C3'), p('F3'), true, ctx(null))).toBe(true);
    expect(clashes(p('C3'), p('F3'), false, ctx(null))).toBe(false);
  });

  it('classifyApproach distinguishes held, stepped, leapt and re-struck notes', () => {
    expect(classifyApproach(undefined, 60, 4)).toBe('none');
    expect(classifyApproach({ pitch: 60, endBeat: 4 }, 60, 4)).toBe('same');
    expect(classifyApproach({ pitch: 60, endBeat: 3.5 }, 60, 4)).toBe('leap');
    expect(classifyApproach({ pitch: 62, endBeat: 4 }, 60, 4)).toBe('step');
    expect(classifyApproach({ pitch: 63, endBeat: 4 }, 60, 4)).toBe('leap');
  });

  const env = (lines: VoiceLine[], anchorTrack: number) => {
    const voices = buildVoiceContext(lines, [], FOUR_FOUR);
    return {
      chordAt: timeline([0, 8, C]).at,
      sounding: voices,
      anchors: (ppq: number) => {
        const pitches = voices
          .soundingAt(ppq)
          .filter((s) => s.trackId === anchorTrack)
          .map((s) => s.pitch);
        return new Set(pitches.length > 0 ? [Math.min(...pitches)] : []);
      },
      strongBeatAt: (ppq: number) => ppq % 2 === 0,
      key: C_MAJOR_KEY,
    };
  };

  it('thinsAccompaniment keeps the accompaniment anchor of a rootless voicing', () => {
    const acc = n(p('E4'), 4, 4);
    const lines = [line(ACCOMP, 'accompaniment', [acc, n(p('G4'), 4, 4), n(p('B4'), 4, 4)])];
    const lead = { pitch: p('F4'), startPpq: 4, durationPpq: 1 };
    expect(thinsAccompaniment(acc, lead, env(lines, ACCOMP))).toBe(false);
  });

  it('thinsAccompaniment needs a strong onset or a quarter of the accompaniment note', () => {
    const acc = n(p('E4'), 4, 4);
    const lines = [line(ACCOMP, 'accompaniment', [n(p('C4'), 4, 4), acc])];
    const e = env(lines, ACCOMP);
    expect(thinsAccompaniment(acc, { pitch: p('F4'), startPpq: 4, durationPpq: 0.25 }, e)).toBe(
      true,
    );
    expect(thinsAccompaniment(acc, { pitch: p('F4'), startPpq: 5, durationPpq: 0.5 }, e)).toBe(
      false,
    );
    expect(thinsAccompaniment(acc, { pitch: p('F4'), startPpq: 5, durationPpq: 1 }, e)).toBe(true);
  });
});

describe('evaluatePlacementColumn — covering array', () => {
  const S_STRONG = 8;
  const S_WEAK = 9;
  const MOTION = 4;
  const ANCHOR = p('C3');

  function buildCase(
    beat: Beat,
    approach: Approach,
    dissonance: Dissonance,
    partner: Partner,
    profile: GuidanceProfile,
    motion: Motion,
    chordTrack: ChordTrack,
  ): { scene: Scene; pitch: number } {
    const s = beat === 'strong' ? S_STRONG : S_WEAK;
    const rootPartner = partner === 'accompRoot';
    const candidate =
      dissonance === 'none'
        ? p('C5')
        : dissonance === 'voice'
          ? rootPartner
            ? p('B4')
            : p('C5')
          : dissonance === 'chord'
            ? p('Ab4')
            : dissonance === 'avoid'
              ? p('F5')
              : rootPartner
                ? p('Db5')
                : p('Ab4');
    const partnerPitch = rootPartner ? p('C5') : dissonance === 'voice' ? p('B4') : p('G4');
    const prev =
      approach === 'same' ? candidate : approach === 'step' ? candidate + 2 : candidate + 5;

    const active: EditorNote[] = [];
    if (approach !== 'none') {
      const from = motion === 'doubling' ? s - 4 : s - 1;
      for (let at = from; at < s; at++) active.push(n(prev, at, 1));
    }
    if (partner === 'sameClip') active.push(n(partnerPitch, s, 1));

    const lines: VoiceLine[] = [];
    if (partner === 'accompFollowing' || partner === 'accompNotFollowing' || rootPartner) {
      lines.push(line(ACCOMP, 'accompaniment', [n(ANCHOR, s, 4), n(partnerPitch, s, 4)]));
    }
    if (partner === 'melodic') lines.push(line(MELODIC, 'melodic', [n(partnerPitch, s, 4)]));
    if (motion === 'parallelPerfect') {
      lines.push(line(MOTION, 'melodic', [n(prev - 12, s - 1, 1), n(candidate - 12, s, 1)]));
    } else if (motion === 'doubling') {
      const notes = [s - 4, s - 3, s - 2, s - 1].map((at) => n(prev - 12, at, 1));
      lines.push(line(MOTION, 'melodic', [...notes, n(candidate - 12, s, 1)]));
    } else if (motion === 'hiddenOuter') {
      lines.push(line(MOTION, 'melodic', [n(candidate - 11, s - 1, 1), n(candidate - 12, s, 1)]));
    }

    return {
      pitch: candidate,
      scene: {
        startPpq: s,
        profile,
        lines,
        active,
        chords: chordTrack === 'present' ? timeline([0, 16, CMAJ7]) : timeline(),
        followers: partner === 'accompFollowing' ? [ACCOMP] : [],
      },
    };
  }

  it.each(COVERAGE_CASES)(
    '%s beat, %s approach, %s dissonance, %s partner, %s, %s motion, chord %s',
    (beat, approach, dissonance, partner, profile, motion, chordTrack, level, reasons) => {
      const { scene, pitch } = buildCase(
        beat,
        approach,
        dissonance,
        partner,
        profile,
        motion,
        chordTrack,
      );
      const verdict = verdictAt(scene, pitch);
      expect(verdict.level).toBe(level);
      expect([...verdict.reasons].sort()).toEqual([...reasons].sort());
    },
  );
});

describe('evaluatePlacementColumn — performance', () => {
  it('evaluates a 128-pitch column against four other tracks well under 10ms', () => {
    const bars = 64;
    const beats = bars * 4;
    const lines: VoiceLine[] = [
      line(
        1,
        'bass',
        Array.from({ length: beats }, (_, i) => n(36 + ((i * 5) % 12), i, 1)),
      ),
      line(
        2,
        'accompaniment',
        Array.from({ length: bars }, (_, bar) =>
          [0, 4, 7].map((offset) => n(60 + ((bar * 5) % 12) + offset, bar * 4, 4)),
        ).flat(),
      ),
      line(
        3,
        'melodic',
        Array.from({ length: beats * 2 }, (_, i) => n(67 + ((i * 7) % 12), i / 2, 0.5)),
      ),
      line(
        4,
        'melodic',
        Array.from({ length: beats }, (_, i) => n(55 + ((i * 3) % 12), i, 1)),
      ),
    ];
    const roots = [0, 5, 7, 9];
    const chords = timeline(
      ...Array.from({ length: bars }, (_, bar): [number, number, ChordData] => [
        bar * 4,
        bar * 4 + 4,
        makeChord(roots[bar % roots.length], 'maj'),
      ]),
    );
    const startPpq = 128;
    const active = Array.from({ length: beats }, (_, i) => n(72 + ((i * 2) % 12), i, 1)).filter(
      (note) => note.startPpq !== startPpq,
    );
    const input: PlacementInput = {
      startPpq,
      lengthPpq: 1,
      activeNotes: active,
      voices: buildVoiceContext(lines, [startPpq, startPpq - 1], FOUR_FOUR),
      chords,
      keyMap: C_MAJOR_KEY,
      timeSignatures: FOUR_FOUR,
      profile: 'counterpoint',
      followerTrackIds: new Set([2]),
    };
    evaluatePlacementColumn(input, 0, 127);
    const samples: number[] = [];
    for (let run = 0; run < 20; run++) {
      const t0 = performance.now();
      const verdicts = evaluatePlacementColumn(input, 0, 127);
      samples.push(performance.now() - t0);
      expect(verdicts).toHaveLength(128);
    }
    samples.sort((a, b) => a - b);
    const median = (samples[9] + samples[10]) / 2;
    process.stdout.write(`placement column median: ${median.toFixed(3)}ms over 20 runs\n`);
    expect(median).toBeLessThan(10);
  });
});
