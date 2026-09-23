import {
  createsHiddenParallelPerfect,
  createsParallelPerfect,
  isForbiddenMelodicLeap,
} from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import {
  buildVoiceContext,
  buildVoiceLines,
  DOUBLING_RUN_SLOTS,
  doublingRunOf,
  motionFindings,
  type OuterVoice,
  spellForLeapCheck,
  type VoiceLine,
  voiceChain,
} from '@/compose/voice-context';
import type { EditorClip, EditorNote, EditorTrack, TimeSignatureSegment } from '@/project/types';

function note(partial: Partial<EditorNote>): EditorNote {
  return {
    id: 1,
    pitch: 60,
    velocity: 96,
    startPpq: 0,
    durationPpq: 1,
    channel: 0,
    ...partial,
  };
}

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

function clip(partial: Partial<EditorClip>): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Clip',
    startPpq: 0,
    lengthPpq: 16,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    ...partial,
  };
}

/** One onset per entry: [startPpq, ...pitches], each a quarter long. */
function line(trackId: number, onsets: ReadonlyArray<ReadonlyArray<number>>): VoiceLine {
  let id = trackId * 1000;
  return {
    trackId,
    role: 'melodic',
    notes: onsets.flatMap(([startPpq, ...pitches]) =>
      pitches.map((pitch) => note({ id: id++, pitch, startPpq, durationPpq: 1 })),
    ),
  };
}

const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];
const A_MINOR = { rootPc: 9, modeMask12: 0b010110101101 };
const C_MAJOR = { rootPc: 0, modeMask12: 0b101010110101 };

describe('voiceChain', () => {
  it('picks the pitch nearest the candidate in the latest onset group', () => {
    const active = [60, 64, 67].map((pitch, id) => note({ id, pitch, startPpq: 0 }));
    expect(voiceChain(active, 65, 1, 1, FOUR_FOUR)).toEqual([{ beat: 0, pitch: 64, endBeat: 1 }]);
  });

  it('breaks an equal-distance tie toward the lower pitch', () => {
    const active = [63, 67].map((pitch, id) => note({ id, pitch, startPpq: 0 }));
    expect(voiceChain(active, 65, 1, 1, FOUR_FOUR)[0].pitch).toBe(63);
  });

  it('follows each further group from the pitch chosen before it', () => {
    const active = [
      note({ id: 1, pitch: 60, startPpq: 0 }),
      note({ id: 2, pitch: 72, startPpq: 0 }),
      note({ id: 3, pitch: 62, startPpq: 1 }),
      note({ id: 4, pitch: 70, startPpq: 1 }),
    ];
    expect(voiceChain(active, 71, 2, 3, FOUR_FOUR)).toEqual([
      { beat: 1, pitch: 70, endBeat: 2 },
      { beat: 0, pitch: 72, endBeat: 1 },
    ]);
  });

  it('ignores notes at or after the candidate beat', () => {
    const active = [
      note({ id: 1, pitch: 60, startPpq: 2 }),
      note({ id: 2, pitch: 62, startPpq: 3 }),
    ];
    expect(voiceChain(active, 61, 2, 4, FOUR_FOUR)).toEqual([]);
  });

  it('stops at a group more than one bar before the one after it', () => {
    const active = [
      note({ id: 1, pitch: 60, startPpq: 0 }),
      note({ id: 2, pitch: 62, startPpq: 5 }),
    ];
    expect(voiceChain(active, 64, 9, 4, FOUR_FOUR)).toEqual([{ beat: 5, pitch: 62, endBeat: 6 }]);
    expect(voiceChain(active, 64, 10, 4, FOUR_FOUR)).toEqual([]);
  });

  it('returns at most depth entries', () => {
    const active = [0, 1, 2, 3].map((startPpq) => note({ id: startPpq, pitch: 60, startPpq }));
    expect(voiceChain(active, 60, 4, 2, FOUR_FOUR).map((entry) => entry.beat)).toEqual([3, 2]);
  });
});

describe('buildVoiceContext', () => {
  it('reports every sounding pitch with its track and role', () => {
    const ctx = buildVoiceContext(
      [line(1, [[0, 48, 55, 64]]), { ...line(2, [[0, 70]]), role: 'accompaniment' }],
      [0],
      FOUR_FOUR,
    );
    expect(
      ctx
        .soundingAt(0)
        .map(({ pitch, trackId, role, startPpq }) => [pitch, trackId, role, startPpq])
        .sort((a, b) => Number(a[0]) - Number(b[0])),
    ).toEqual([
      [48, 1, 'melodic', 0],
      [55, 1, 'melodic', 0],
      [64, 1, 'melodic', 0],
      [70, 2, 'accompaniment', 0],
    ]);
    expect(ctx.soundingAt(1)).toEqual([]);
  });

  it('gives each track its top voice and, when different, its bottom voice', () => {
    const ctx = buildVoiceContext([line(1, [[0, 48, 55, 64]]), line(2, [[0, 70]])], [0], FOUR_FOUR);
    expect(ctx.outerVoicesAt(0, undefined)).toEqual([
      { trackId: 1, edge: 'top', pitch: 64 },
      { trackId: 1, edge: 'bottom', pitch: 48 },
      { trackId: 2, edge: 'top', pitch: 70 },
    ]);
  });

  it('carries each edge its own pitch at the previous beat', () => {
    const ctx = buildVoiceContext(
      [
        line(1, [
          [0, 48, 64],
          [1, 50, 65],
        ]),
      ],
      [0, 1],
      FOUR_FOUR,
    );
    expect(ctx.outerVoicesAt(1, 0)).toEqual([
      { trackId: 1, edge: 'top', pitch: 65, prevPitch: 64 },
      { trackId: 1, edge: 'bottom', pitch: 50, prevPitch: 48 },
    ]);
  });

  it('drops the previous pitch when the previous beat is more than a bar back', () => {
    const ctx = buildVoiceContext(
      [
        line(1, [
          [0, 60],
          [4, 62],
          [5, 64],
        ]),
      ],
      [0, 4, 5],
      FOUR_FOUR,
    );
    expect(ctx.outerVoicesAt(4, 0)).toEqual([
      { trackId: 1, edge: 'top', pitch: 62, prevPitch: 60 },
    ]);
    expect(ctx.outerVoicesAt(5, 0)).toEqual([{ trackId: 1, edge: 'top', pitch: 64 }]);
  });

  it('answers beats outside the indexed ones', () => {
    const ctx = buildVoiceContext([line(1, [[0, 60, 67]])], [], FOUR_FOUR);
    expect(ctx.outerVoicesAt(0.5, undefined)).toEqual([
      { trackId: 1, edge: 'top', pitch: 67 },
      { trackId: 1, edge: 'bottom', pitch: 60 },
    ]);
    expect(ctx.soundingAt(0.5).map((entry) => entry.pitch)).toEqual([60, 67]);
  });

  it('carries the length of the note behind each sounding pitch', () => {
    const notes = [note({ id: 1, pitch: 60, startPpq: 0, durationPpq: 4 })];
    const ctx = buildVoiceContext([{ trackId: 1, role: 'melodic', notes }], [2], FOUR_FOUR);
    expect(ctx.soundingAt(2)).toEqual([
      { pitch: 60, trackId: 1, role: 'melodic', startPpq: 0, durationPpq: 4 },
    ]);
  });
});

describe('motionFindings', () => {
  const noRun = () => 0;

  it('reports parallel fifths against the voice that moves with the candidate', () => {
    const other: OuterVoice = { trackId: 2, edge: 'top', pitch: 60, prevPitch: 58 };
    expect(motionFindings(67, 65, [other], noRun).parallelPerfect).toEqual([other]);
  });

  it('dismisses a parallel that continues a long enough doubling run', () => {
    const other: OuterVoice = { trackId: 2, edge: 'top', pitch: 60, prevPitch: 58 };
    const atThreshold = () => DOUBLING_RUN_SLOTS - 1;
    const below = () => DOUBLING_RUN_SLOTS - 2;
    expect(motionFindings(67, 65, [other], atThreshold).parallelPerfect).toEqual([]);
    expect(motionFindings(67, 65, [other], below).parallelPerfect).toEqual([other]);
  });

  it('dismisses octave classes reached by contrary motion', () => {
    expect(createsParallelPerfect(55, 60, 67, 48)).toBe(true);
    const other: OuterVoice = { trackId: 2, edge: 'top', pitch: 48, prevPitch: 67 };
    expect(motionFindings(60, 55, [other], noRun).parallelPerfect).toEqual([]);
  });

  it('finds nothing without a previous pitch', () => {
    const other: OuterVoice = { trackId: 2, edge: 'top', pitch: 60, prevPitch: 58 };
    expect(motionFindings(67, undefined, [other], noRun)).toEqual({
      parallelPerfect: [],
      hiddenOuter: false,
      crossing: [],
    });
  });

  it('reports a hidden fifth only between the outer voices', () => {
    expect(createsHiddenParallelPerfect(72, 79, 43, 48)).toBe(true);
    const bass: OuterVoice = { trackId: 2, edge: 'bottom', pitch: 48, prevPitch: 43 };
    const inner: OuterVoice = { trackId: 3, edge: 'top', pitch: 64, prevPitch: 64 };
    expect(motionFindings(79, 72, [bass, inner], noRun).hiddenOuter).toBe(true);
    const lower: OuterVoice = { trackId: 4, edge: 'bottom', pitch: 36, prevPitch: 36 };
    expect(motionFindings(79, 72, [bass, inner, lower], noRun).hiddenOuter).toBe(false);
  });

  it('reports voices whose order swapped, but not a unison arrival', () => {
    const crossed: OuterVoice = { trackId: 2, edge: 'top', pitch: 67, prevPitch: 64 };
    expect(motionFindings(64, 67, [crossed], noRun).crossing).toEqual([crossed]);
    expect(motionFindings(67, 64, [crossed], noRun).crossing).toEqual([]);
  });
});

describe('doublingRunOf', () => {
  const active = [69, 71, 72].map((pitch, index) => note({ id: index, pitch, startPpq: index }));
  const chain = voiceChain(active, 74, 3, DOUBLING_RUN_SLOTS, FOUR_FOUR);

  it('counts the earlier beats holding the candidate perfect separation', () => {
    const ctx = buildVoiceContext(
      [
        line(2, [
          [0, 57],
          [1, 59],
          [2, 60],
          [3, 62],
        ]),
      ],
      [0, 1, 2, 3],
      FOUR_FOUR,
    );
    const runOf = doublingRunOf(chain, ctx, 74, 3);
    expect(runOf({ trackId: 2, edge: 'top', pitch: 62 })).toBe(3);
  });

  it('stops at the first beat with a different separation', () => {
    const ctx = buildVoiceContext(
      [
        line(2, [
          [0, 55],
          [1, 59],
          [2, 60],
          [3, 62],
        ]),
      ],
      [0, 1, 2, 3],
      FOUR_FOUR,
    );
    expect(doublingRunOf(chain, ctx, 74, 3)({ trackId: 2, edge: 'top', pitch: 62 })).toBe(2);
  });

  it('counts nothing when the candidate separation is not perfect', () => {
    const ctx = buildVoiceContext(
      [
        line(2, [
          [0, 65],
          [1, 67],
          [2, 68],
          [3, 70],
        ]),
      ],
      [0, 1, 2, 3],
      FOUR_FOUR,
    );
    expect(doublingRunOf(chain, ctx, 74, 3)({ trackId: 2, edge: 'top', pitch: 70 })).toBe(0);
  });

  it('matches the same track and edge only', () => {
    const ctx = buildVoiceContext(
      [
        line(2, [
          [0, 45, 57],
          [1, 47, 59],
          [2, 48, 60],
          [3, 50, 62],
        ]),
      ],
      [0, 1, 2, 3],
      FOUR_FOUR,
    );
    const runOf = doublingRunOf(chain, ctx, 74, 3);
    expect(runOf({ trackId: 2, edge: 'top', pitch: 62 })).toBe(3);
    expect(runOf({ trackId: 2, edge: 'bottom', pitch: 50 })).toBe(3);
    expect(runOf({ trackId: 3, edge: 'top', pitch: 62 })).toBe(0);
  });
});

describe('spellForLeapCheck', () => {
  it('spells F4 to G#4 in A minor as the forbidden augmented second', () => {
    const spelled = spellForLeapCheck(65, 68, A_MINOR);
    expect(spelled).toBeDefined();
    const [prev, candidate] = spelled!;
    expect(candidate.alter).toBe(1);
    expect(isForbiddenMelodicLeap(prev, candidate)).toBe(true);
  });

  it('spells the same pitches in C major as a plain minor third', () => {
    const [prev, candidate] = spellForLeapCheck(65, 68, C_MAJOR)!;
    expect(isForbiddenMelodicLeap(prev, candidate)).toBe(false);
  });
});

describe('buildVoiceLines', () => {
  it('assigns roles and skips the excluded and percussion tracks', () => {
    const tracks = [
      track({ id: 1, name: 'Lead' }),
      track({ id: 2, name: 'Keys', generated: { part: 'backing' } as EditorTrack['generated'] }),
      track({ id: 3, name: 'Low', generated: { part: 'bass' } as EditorTrack['generated'] }),
      track({ id: 4, name: 'Strings' }),
      { ...track({ id: 5, name: 'Pad' }), leadFollow: { leadTrackId: 1, stash: [] } },
      track({ id: 6, name: 'Hits', percussion: true }),
    ];
    const clipsByTrack = new Map(
      tracks.map((entry) => [
        entry.id,
        [clip({ id: entry.id, trackId: entry.id, notes: [note({ id: 1, pitch: 60 })] })],
      ]),
    );
    const lines = buildVoiceLines(tracks, clipsByTrack, 1);
    expect(lines.map((entry) => [entry.trackId, entry.role])).toEqual([
      [2, 'accompaniment'],
      [3, 'bass'],
      [4, 'melodic'],
      [5, 'accompaniment'],
    ]);
  });

  it('projects notes to absolute PPQ and expands loops', () => {
    const tracks = [track({ id: 2, name: 'Strings' })];
    const looped = clip({
      id: 7,
      trackId: 2,
      startPpq: 8,
      lengthPpq: 6,
      loopEnabled: true,
      loopLengthPpq: 2,
      notes: [note({ id: 1, pitch: 62, startPpq: 0, durationPpq: 1 })],
    });
    const [voice] = buildVoiceLines(tracks, new Map([[2, [looped]]]), 1);
    expect(voice.notes.map((entry) => [entry.startPpq, entry.pitch])).toEqual([
      [8, 62],
      [10, 62],
      [12, 62],
    ]);
    expect(new Set(voice.notes.map((entry) => entry.id)).size).toBe(3);
  });

  it('drops channel-10 notes from a melodic track', () => {
    const tracks = [track({ id: 2, name: 'Strings' })];
    const mixed = clip({
      trackId: 2,
      notes: [
        note({ id: 1, pitch: 60 }),
        note({ id: 2, pitch: 61 }),
        note({ id: 3, pitch: 36, channel: 9 }),
      ],
    });
    const [voice] = buildVoiceLines(tracks, new Map([[2, [mixed]]]), 1);
    expect(voice.notes.map((entry) => entry.pitch).sort((a, b) => a - b)).toEqual([60, 61]);
  });
});
