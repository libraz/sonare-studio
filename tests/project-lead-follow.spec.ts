import { type ChordData, type ChordTimeline, makeChord } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import type { GuidanceProfile } from '@/compose/guidance-profile';
import { buildKeyMap } from '@/compose/key-map';
import { evaluatePlacementColumn, type PlacementInput } from '@/compose/placement';
import { buildVoiceContext, type VoiceLine, type VoiceRole } from '@/compose/voice-context';
import {
  type LeadFollowPlan,
  leadFollowNotes,
  leadFollowPlan,
  restoreLeadFollowStash,
} from '@/project/lead-follow';
import {
  type EditorClip,
  type EditorNote,
  type EditorTrack,
  type LeadFollowStashEntry,
  MAJOR_MODE_MASK,
  type TimeSignatureSegment,
} from '@/project/types';

const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];
const C_MAJOR_KEY = buildKeyMap({ enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK }, []);
const NO_KEY = buildKeyMap({ enabled: false, rootPc: 0, modeMask: MAJOR_MODE_MASK }, []);

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
const CMAJ7 = makeChord(0, 'maj7');

const LEAD = 1;
const ACCOMP = 2;
const MELODIC = 3;
const MOTION = 4;

function track(id: number, extra: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#888888',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
    ...extra,
  };
}

function follower(stash: LeadFollowStashEntry[] = [], extra: Partial<EditorTrack> = {}) {
  return track(ACCOMP, { leadFollow: { leadTrackId: LEAD, stash }, ...extra });
}

function clip(id: number, notes: EditorNote[], extra: Partial<EditorClip> = {}): EditorClip {
  return {
    id,
    trackId: ACCOMP,
    name: 'Clip',
    startPpq: 0,
    lengthPpq: 32,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes,
    ...extra,
  };
}

interface PlanScene {
  track: EditorTrack;
  clips: EditorClip[];
  lead: EditorNote[];
  others?: VoiceLine[];
  chords?: ChordTimeline;
}

/** Runs the plan with a voice context of every line, the follower's parked notes included. */
function planOf(scene: PlanScene): LeadFollowPlan {
  const parked = (scene.track.leadFollow?.stash ?? []).map((entry) => ({ ...entry.note, id: -1 }));
  const followerNotes = scene.clips.flatMap((c) =>
    c.notes.map((note) => ({ ...note, startPpq: note.startPpq + c.startPpq - c.sourceOffsetPpq })),
  );
  const voices = buildVoiceContext(
    [
      line(scene.track.id, 'accompaniment', [...followerNotes, ...parked]),
      line(LEAD, 'melodic', scene.lead),
      ...(scene.others ?? []),
    ],
    [],
    FOUR_FOUR,
  );
  return leadFollowPlan({
    follower: { track: scene.track, clips: scene.clips },
    leadNotes: scene.lead,
    voices,
    chords: scene.chords ?? timeline([0, 32, C]),
    keyMap: C_MAJOR_KEY,
    timeSignatures: FOUR_FOUR,
  });
}

/** Applies a plan to the follower the way the reconciler writes it back. */
function applied(scene: PlanScene, plan: LeadFollowPlan): PlanScene {
  const byClip = new Map(plan.clipEdits.map((edit) => [edit.clipId, edit.notes]));
  return {
    ...scene,
    track: follower(plan.stash, { frozen: scene.track.frozen }),
    clips: scene.clips.map((c) => {
      const notes = byClip.get(c.id);
      return notes === undefined ? c : { ...c, notes: notes.map((note) => ({ ...note })) };
    }),
  };
}

function pitchesOf(c: EditorClip | undefined): number[] {
  return (c?.notes ?? []).map((note) => note.pitch).sort((a, b) => a - b);
}

const triad = (start: number, length = 4) => [
  n(p('C4'), start, length),
  n(p('E4'), start, length),
  n(p('G4'), start, length),
];

describe('leadFollowPlan', () => {
  it('parks a clashing non-root note and keeps the rest of the voicing', () => {
    const scene: PlanScene = {
      track: follower(),
      clips: [clip(10, triad(4))],
      lead: [n(p('F4'), 4)],
    };
    const plan = planOf(scene);
    expect(plan.clipEdits).toHaveLength(1);
    expect(plan.clipEdits[0].notes.map((note) => note.pitch).sort()).toEqual([p('C4'), p('G4')]);
    expect(plan.stash).toEqual([
      {
        clipId: 10,
        note: { pitch: p('E4'), velocity: 96, startPpq: 4, durationPpq: 4, channel: 0 },
      },
    ]);
  });

  it('is idempotent: planning the applied result changes nothing', () => {
    const scene: PlanScene = {
      track: follower(),
      clips: [clip(10, triad(4))],
      lead: [n(p('F4'), 4)],
    };
    const once = applied(scene, planOf(scene));
    const twice = planOf(once);
    expect(twice.clipEdits).toEqual([]);
    expect(twice.stash).toEqual(once.track.leadFollow?.stash);
  });

  it('restores a parked note once nothing clashes with it', () => {
    const scene: PlanScene = {
      track: follower(),
      clips: [clip(10, triad(4))],
      lead: [n(p('F4'), 4)],
    };
    const thinned = applied(scene, planOf(scene));
    const plan = planOf({ ...thinned, lead: [n(p('G4'), 4)] });
    expect(plan.stash).toEqual([]);
    expect(plan.clipEdits[0].notes.map((note) => note.pitch).sort()).toEqual([
      p('C4'),
      p('E4'),
      p('G4'),
    ]);
    // Restored notes carry placeholder ids so the mirror allocates real ones.
    const restored = plan.clipEdits[0].notes.find((note) => note.pitch === p('E4'));
    expect(restored?.id).toBeLessThan(0);
  });

  it('keeps a note parked while a hand-written note of the same pitch overlaps it', () => {
    const scene: PlanScene = {
      track: follower(),
      clips: [clip(10, triad(4))],
      lead: [n(p('F4'), 4)],
    };
    const thinned = applied(scene, planOf(scene));
    const withHandNote: PlanScene = {
      ...thinned,
      clips: [{ ...thinned.clips[0], notes: [...thinned.clips[0].notes, n(p('E4'), 6, 2)] }],
      lead: [],
    };
    const blocked = planOf(withHandNote);
    expect(blocked.clipEdits).toEqual([]);
    expect(blocked.stash).toHaveLength(1);

    const cleared = planOf({
      ...withHandNote,
      clips: [{ ...withHandNote.clips[0], notes: thinned.clips[0].notes }],
    });
    expect(cleared.stash).toEqual([]);
    expect(pitchesOf({ ...thinned.clips[0], notes: cleared.clipEdits[0].notes })).toContain(
      p('E4'),
    );
  });

  it('drops parked notes whose clip no longer exists', () => {
    const scene: PlanScene = {
      track: follower(),
      clips: [clip(10, triad(4))],
      lead: [n(p('F4'), 4)],
    };
    const thinned = applied(scene, planOf(scene));
    const plan = planOf({ ...thinned, clips: [clip(11, triad(0))] });
    expect(plan.stash).toEqual([]);
    expect(plan.clipEdits).toEqual([]);
  });

  it('never thins a looping clip and brings its parked notes back', () => {
    const looping = clip(10, triad(0), { loopEnabled: true, loopLengthPpq: 4 });
    expect(
      planOf({ track: follower(), clips: [looping], lead: [n(p('F4'), 0)] }).clipEdits,
    ).toEqual([]);
    const parked: LeadFollowStashEntry = {
      clipId: 10,
      note: { pitch: p('E4'), velocity: 96, startPpq: 0, durationPpq: 4, channel: 0 },
    };
    const plan = planOf({
      track: follower([parked]),
      clips: [{ ...looping, notes: [n(p('C4'), 0, 4), n(p('G4'), 0, 4)] }],
      lead: [n(p('F4'), 0)],
    });
    expect(plan.stash).toEqual([]);
    expect(plan.clipEdits[0].notes.map((note) => note.pitch)).toContain(p('E4'));
  });

  it('leaves a frozen follower alone', () => {
    const plan = planOf({
      track: follower([], { frozen: { assetId: 'a' } }),
      clips: [clip(10, triad(4))],
      lead: [n(p('F4'), 4)],
    });
    expect(plan).toEqual({ clipEdits: [], stash: [] });
  });

  it('keeps the lowest note of the accompaniment as its anchor', () => {
    // E4 is the voicing's lowest note, so the semitone below F4 stays; B4 (a tritone) goes.
    const plan = planOf({
      track: follower(),
      clips: [clip(10, [n(p('E4'), 4, 4), n(p('G4'), 4, 4), n(p('B4'), 4, 4)])],
      lead: [n(p('F4'), 4)],
    });
    expect(plan.stash.map((entry) => entry.note.pitch)).toEqual([p('B4')]);
    expect(plan.clipEdits[0].notes.map((note) => note.pitch)).toEqual([p('E4'), p('G4')]);
  });

  it('never empties a rootless voicing', () => {
    // Rootless C (E G B D): the lead thins B4 and D5, while the anchor E4 stays.
    const rootless = [n(p('E4'), 4, 4), n(p('G4'), 4, 4), n(p('B4'), 4, 4), n(p('D5'), 4, 4)];
    const plan = planOf({
      track: follower(),
      clips: [clip(10, rootless)],
      lead: [n(p('F4'), 4, 4), n(p('C5'), 4, 4), n(p('Eb5'), 4, 4)],
    });
    const kept = plan.clipEdits[0]?.notes ?? rootless;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.map((note) => note.pitch)).toContain(p('E4'));
  });

  it('does not thin without a chord', () => {
    const plan = planOf({
      track: follower(),
      clips: [clip(10, triad(4))],
      lead: [n(p('F4'), 4)],
      chords: timeline(),
    });
    expect(plan.clipEdits).toEqual([]);
  });

  it('does not thin for a short weak-beat lead note', () => {
    const plan = planOf({
      track: follower(),
      clips: [clip(10, triad(4))],
      lead: [n(p('F4'), 5, 0.25)],
    });
    expect(plan.clipEdits).toEqual([]);
  });

  it('restoreLeadFollowStash brings every parked note back', () => {
    const scene: PlanScene = {
      track: follower(),
      clips: [clip(10, triad(4))],
      lead: [n(p('F4'), 4)],
    };
    const thinned = applied(scene, planOf(scene));
    const restored = restoreLeadFollowStash({ track: thinned.track, clips: thinned.clips });
    expect(restored.stash).toEqual([]);
    expect(restored.clipEdits[0].notes.map((note) => note.pitch).sort()).toEqual([
      p('C4'),
      p('E4'),
      p('G4'),
    ]);
  });
});

describe('leadFollowNotes', () => {
  const leadClip = (notes: EditorNote[], extra: Partial<EditorClip> = {}) =>
    clip(20, notes, { trackId: LEAD, startPpq: 8, ...extra });

  it('projects the lead to the absolute timeline with loops expanded', () => {
    const notes = leadFollowNotes(track(LEAD), [
      leadClip([n(p('F4'), 0, 1)], { lengthPpq: 8, loopEnabled: true, loopLengthPpq: 4 }),
    ]);
    expect(notes.map((note) => note.startPpq)).toEqual([8, 12]);
  });

  it('drops channel-10 notes from a melodic lead, so they thin nothing', () => {
    const lead = track(LEAD);
    const leadNotes = leadFollowNotes(lead, [
      leadClip([n(p('F4'), 0, 1, 9), n(p('C5'), 0, 1), n(p('D5'), 1, 1), n(p('E5'), 2, 1)]),
    ]);
    expect(leadNotes.map((note) => note.pitch)).toEqual([p('C5'), p('D5'), p('E5')]);
    const plan = planOf({
      track: follower(),
      clips: [clip(10, triad(8))],
      lead: leadNotes,
    });
    expect(plan.clipEdits).toEqual([]);
  });

  it('gives no lead notes for a percussion track', () => {
    const drums = track(LEAD, { generated: { part: 'drums', seed: 0, algorithmVersion: 1 } });
    expect(leadFollowNotes(drums, [leadClip([n(p('F4'), 0, 1)])])).toEqual([]);
  });
});

/**
 * The placement column and lead following answer from one predicate: every
 * accompaniment partner the column marks as thinned is exactly what the plan
 * parks for the same input, and nothing else is parked.
 */
describe('placement column and lead following agree', () => {
  interface Scene {
    startPpq: number;
    lengthPpq?: number;
    lines: VoiceLine[];
    active?: EditorNote[];
    chords: ChordTimeline;
    followers?: number[];
    profile?: GuidanceProfile;
  }

  function thinnedByColumn(scene: Scene, pitch: number): string[] {
    const input: PlacementInput = {
      startPpq: scene.startPpq,
      lengthPpq: scene.lengthPpq ?? 1,
      activeNotes: scene.active ?? [],
      voices: buildVoiceContext(scene.lines, [], FOUR_FOUR),
      chords: scene.chords,
      keyMap: NO_KEY,
      timeSignatures: FOUR_FOUR,
      profile: scene.profile ?? 'counterpoint',
      followerTrackIds: new Set(scene.followers ?? []),
    };
    const [verdict] = evaluatePlacementColumn(input, pitch, pitch);
    return verdict.partners
      .filter((partner) => partner.kind === 'accompNonRoot' && partner.thinned)
      .map((partner) => `${partner.trackId}:${partner.pitch}`)
      .sort();
  }

  function parkedByPlan(scene: Scene, pitch: number): string[] {
    const leadNotes = [...(scene.active ?? []), n(pitch, scene.startPpq, scene.lengthPpq ?? 1)];
    const voices = buildVoiceContext(
      [...scene.lines, line(LEAD, 'melodic', leadNotes)],
      [],
      FOUR_FOUR,
    );
    const parked: string[] = [];
    for (const accompaniment of scene.lines.filter((l) => l.role === 'accompaniment')) {
      const plan = leadFollowPlan({
        follower: {
          track: track(accompaniment.trackId, { leadFollow: { leadTrackId: LEAD, stash: [] } }),
          clips: [
            clip(100 + accompaniment.trackId, [...accompaniment.notes], {
              trackId: accompaniment.trackId,
            }),
          ],
        },
        leadNotes,
        voices,
        chords: scene.chords,
        keyMap: NO_KEY,
        timeSignatures: FOUR_FOUR,
      });
      for (const entry of plan.stash) parked.push(`${accompaniment.trackId}:${entry.note.pitch}`);
    }
    return parked.sort();
  }

  const triadAccompaniment = (start: number, length = 4): VoiceLine =>
    line(ACCOMP, 'accompaniment', [
      n(p('C4'), start, length),
      n(p('E4'), start, length),
      n(p('G4'), start, length),
    ]);

  const fixtures: Array<[string, Scene, number]> = [
    [
      'D5 leaping in over a following C triad',
      {
        startPpq: 4,
        chords: timeline([0, 8, C]),
        lines: [triadAccompaniment(0, 8)],
        active: [n(p('A4'), 3, 1)],
        followers: [ACCOMP],
      },
      p('D5'),
    ],
    [
      'F4 over a following E4 on a strong beat',
      {
        startPpq: 4,
        chords: timeline([0, 8, C]),
        lines: [triadAccompaniment(4)],
        followers: [ACCOMP],
      },
      p('F4'),
    ],
    [
      'a weak-beat sixteenth stepping from G4',
      {
        startPpq: 5,
        lengthPpq: 0.25,
        chords: timeline([0, 8, C]),
        lines: [triadAccompaniment(4)],
        active: [n(p('G4'), 4, 1)],
        followers: [ACCOMP],
      },
      p('F4'),
    ],
    [
      'F4 over an accompaniment that does not follow',
      { startPpq: 4, chords: timeline([0, 8, C]), lines: [triadAccompaniment(4)] },
      p('F4'),
    ],
    [
      'Db4 against the accompaniment root C4',
      {
        startPpq: 4,
        chords: timeline([0, 8, C]),
        lines: [triadAccompaniment(4)],
        active: [n(p('F4'), 3, 1)],
        followers: [ACCOMP],
      },
      p('Db4'),
    ],
    [
      'F4 over an accompaniment E4 with no chord',
      {
        startPpq: 4,
        chords: timeline(),
        lines: [line(ACCOMP, 'accompaniment', [n(p('C4'), 4, 4), n(p('E4'), 4, 4)])],
        followers: [ACCOMP],
      },
      p('F4'),
    ],
    [
      'F4 over a rootless E-G-B voicing',
      {
        startPpq: 4,
        chords: timeline([0, 8, C]),
        lines: [
          line(ACCOMP, 'accompaniment', [n(p('E4'), 4, 4), n(p('G4'), 4, 4), n(p('B4'), 4, 4)]),
        ],
        followers: [ACCOMP],
      },
      p('F4'),
    ],
  ];

  it.each(fixtures)('%s', (_name, scene, pitch) => {
    expect(parkedByPlan(scene, pitch)).toEqual(thinnedByColumn(scene, pitch));
  });

  it('the strong-beat F4 fixture thins E4 on both sides', () => {
    const [, scene, pitch] = fixtures[1];
    expect(thinnedByColumn(scene, pitch)).toEqual([`${ACCOMP}:${p('E4')}`]);
    expect(parkedByPlan(scene, pitch)).toEqual([`${ACCOMP}:${p('E4')}`]);
  });

  it('the weak-beat sixteenth thins nothing on either side', () => {
    const [, scene, pitch] = fixtures[2];
    expect(thinnedByColumn(scene, pitch)).toEqual([]);
    expect(parkedByPlan(scene, pitch)).toEqual([]);
  });

  type Beat = 'strong' | 'weak';
  type Approach = 'none' | 'same' | 'step' | 'leap';
  type Dissonance = 'voice' | 'both';
  type Partner = 'accompFollowing' | 'accompNotFollowing' | 'accompRoot';
  type Motion = 'plain' | 'parallelPerfect' | 'doubling' | 'hiddenOuter';

  /** The accompaniment rows of the placement covering array (compose-placement.spec). */
  const ACCOMPANIMENT_CASES: ReadonlyArray<
    readonly [Beat, Approach, Dissonance, Partner, GuidanceProfile, Motion]
  > = [
    ['weak', 'leap', 'both', 'accompFollowing', 'pop', 'doubling'],
    ['strong', 'step', 'both', 'accompNotFollowing', 'counterpoint', 'hiddenOuter'],
    ['strong', 'leap', 'voice', 'accompRoot', 'counterpoint', 'parallelPerfect'],
    ['weak', 'none', 'voice', 'accompNotFollowing', 'pop', 'plain'],
    ['weak', 'same', 'both', 'accompRoot', 'pop', 'plain'],
    ['strong', 'none', 'voice', 'accompFollowing', 'counterpoint', 'plain'],
    ['weak', 'step', 'voice', 'accompFollowing', 'counterpoint', 'hiddenOuter'],
    ['weak', 'leap', 'voice', 'accompNotFollowing', 'counterpoint', 'parallelPerfect'],
    ['strong', 'none', 'both', 'accompRoot', 'counterpoint', 'plain'],
    ['strong', 'same', 'both', 'accompFollowing', 'counterpoint', 'plain'],
    ['strong', 'step', 'voice', 'accompRoot', 'counterpoint', 'doubling'],
    ['strong', 'same', 'voice', 'accompNotFollowing', 'counterpoint', 'plain'],
    ['strong', 'step', 'voice', 'accompFollowing', 'counterpoint', 'parallelPerfect'],
    ['strong', 'step', 'voice', 'accompNotFollowing', 'counterpoint', 'doubling'],
    ['strong', 'step', 'voice', 'accompRoot', 'counterpoint', 'hiddenOuter'],
  ];

  /** Same scene builder as the covering array in compose-placement.spec. */
  function coveringScene(
    beat: Beat,
    approach: Approach,
    dissonance: Dissonance,
    partner: Partner,
    profile: GuidanceProfile,
    motion: Motion,
  ): { scene: Scene; pitch: number } {
    const s = beat === 'strong' ? 8 : 9;
    const rootPartner = partner === 'accompRoot';
    const candidate =
      dissonance === 'voice'
        ? rootPartner
          ? p('B4')
          : p('C5')
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
    const lines: VoiceLine[] = [
      line(ACCOMP, 'accompaniment', [n(p('C3'), s, 4), n(partnerPitch, s, 4)]),
    ];
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
        chords: timeline([0, 16, CMAJ7]),
        followers: partner === 'accompFollowing' ? [ACCOMP] : [],
      },
    };
  }

  it.each(ACCOMPANIMENT_CASES)(
    'covering array: %s beat, %s approach, %s dissonance, %s, %s, %s motion',
    (beat, approach, dissonance, partner, profile, motion) => {
      const { scene, pitch } = coveringScene(beat, approach, dissonance, partner, profile, motion);
      const column = thinnedByColumn(scene, pitch);
      expect(parkedByPlan(scene, pitch)).toEqual(column);
      // Non-root partners clash and thin; root partners never do.
      expect(column.length > 0).toBe(partner !== 'accompRoot');
    },
  );

  it('a melodic partner is never parked', () => {
    const scene: Scene = {
      startPpq: 4,
      chords: timeline([0, 8, C]),
      lines: [line(MELODIC, 'melodic', [n(p('E4'), 4, 4)])],
    };
    expect(parkedByPlan(scene, p('F4'))).toEqual([]);
    expect(thinnedByColumn(scene, p('F4'))).toEqual([]);
  });
});
