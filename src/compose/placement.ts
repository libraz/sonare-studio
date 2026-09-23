/**
 * Placement verdicts for the cell a pencil click would write, and the vertical
 * predicates they share with accompaniment following, resolution tracking and
 * the note cards (clash, thinning, approach).
 *
 * libcantus contributes harmonic flags only; the three-level policy is the
 * studio's own table (safe / warn / ng per rule and profile), because the
 * library's verdict cannot say which voice a reason came from and treats a
 * prepared suspension as dissonant.
 *
 * A candidate is read against every pitch of every other non-percussion track
 * plus the notes sounding in its own clip (vertical), and against each other
 * track's outer voices (motion). Accompaniment clashes that following would
 * thin are reported apart from real clashes so the column and the thinning
 * itself answer from the same predicate.
 *
 * Pure module (no Vue/Pinia).
 */

import {
  type ChordData,
  type ChordTimeline,
  ConsonanceClass,
  classifyInterval,
  evaluateSafety,
  exceedsSpacing,
  isForbiddenMelodicLeap,
  isScaleTone,
  type KeyScale,
  ReasonFlag,
  type SafetyResult,
} from '@libraz/libcantus';
import type { EditorNote, TimeSignatureSegment } from '@/project/types';
import { type GuidanceProfile, toSafetyProfile } from './guidance-profile';
import { DEFAULT_KEY_SCALE } from './key';
import type { KeyMap } from './key-map';
import { strongBeatAt } from './meter';
import {
  DOUBLING_RUN_SLOTS,
  doublingRunOf,
  type MotionFindings,
  motionFindings,
  type OuterVoice,
  type SoundingPitch,
  spellForLeapCheck,
  type VoiceChainEntry,
  type VoiceContext,
  voiceChain,
} from './voice-context';

/** Harmonic setting of one instant. */
export interface HarmonicContext {
  chord: ChordData | null;
  key: KeyScale;
  keySet: boolean;
  strongBeat: boolean;
}

/** A note span on the absolute timeline. */
interface TimedPitch {
  pitch: number;
  startPpq: number;
  durationPpq: number;
}

/** Everything the thinning predicate reads besides the two notes. */
export interface ThinningEnv {
  chordAt: (ppq: number) => ChordData | null;
  /** Every sounding voice, used to find the lowest pitch of the texture. */
  sounding: VoiceContext;
  /** Lowest pitch the accompaniment track sounds at a position. */
  anchors: (ppq: number) => ReadonlySet<number>;
  strongBeatAt: (ppq: number) => boolean;
  key: KeyMap;
}

export type PlacementLevel = 'safe' | 'warn' | 'ng';

export type PlacementReason =
  | 'preparedSuspension'
  | 'steppedNonChordTone'
  | 'unpreparedDissonance'
  | 'leapIntoDissonance'
  | 'chordDissonance'
  | 'nonScaleNoChord'
  | 'accompanimentThinned'
  | 'accompanimentThinnable'
  | 'accompanimentRootClash'
  | 'parallelPerfect'
  | 'hiddenParallel'
  | 'voiceCrossing'
  | 'wideSpacing'
  | 'forbiddenLeap'
  | 'largeLeap'
  | 'avoidNote'
  | 'outOfRange';

/** A pitch the candidate clashes with; `trackId` is null for the edited clip. */
export interface ClashPartner {
  pitch: number;
  trackId: number | null;
  kind: 'melodic' | 'bass' | 'accompRoot' | 'accompNonRoot';
  thinned: boolean;
  following: boolean;
}

/** A voice a motion rule (parallel, hidden, crossing) was read against. */
export interface MotionPartner {
  trackId: number;
  pitch: number;
  kind: 'parallel' | 'hidden' | 'crossing';
}

export interface PlacementVerdict {
  level: PlacementLevel;
  /** Every rule that fired, heaviest first. */
  reasons: PlacementReason[];
  partners: ClashPartner[];
  /** Voices behind the motion rules; absent when none fired. */
  motionPartners?: MotionPartner[];
  resolveTo?: number[];
}

export interface PlacementInput {
  /** Absolute PPQ of the cell to place. */
  startPpq: number;
  lengthPpq: number;
  /** Edited clip notes in absolute PPQ, already passed through `harmonicNotes`. */
  activeNotes: ReadonlyArray<EditorNote>;
  voices: VoiceContext;
  chords: ChordTimeline;
  keyMap: KeyMap;
  timeSignatures: ReadonlyArray<TimeSignatureSegment>;
  profile: GuidanceProfile;
  pitchRange?: { low: number; high: number };
  /** Accompaniment tracks following the edited track. */
  followerTrackIds: ReadonlySet<number>;
}

type Approach = 'none' | 'same' | 'step' | 'leap';

const LEVEL_RANK: Record<PlacementLevel, number> = { safe: 0, warn: 1, ng: 2 };

/** Harmonic flags read from evaluateSafety; the verdict itself is not used. */
const HARMONIC_MEMBER = ReasonFlag.ChordTone | ReasonFlag.Tension;

function pitchClass(pitch: number): number {
  return ((pitch % 12) + 12) % 12;
}

function tryEval<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Membership per chord object, then per key and pitch. */
const memberCache = new WeakMap<ChordData, Map<string, boolean>>();

/** Whether a pitch is a chord tone or tension of the context's chord. */
export function isHarmonicMember(pitch: number, ctx: HarmonicContext): boolean {
  const chord = ctx.chord;
  if (chord === null) return false;
  let byPitch = memberCache.get(chord);
  if (byPitch === undefined) {
    byPitch = new Map();
    memberCache.set(chord, byPitch);
  }
  const cacheKey = `${ctx.key.rootPc}:${ctx.key.modeMask12}:${pitch}`;
  const cached = byPitch.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = tryEval(() =>
    evaluateSafety(
      {
        profile: 'pop',
        candidatePitch: pitch,
        chord,
        key: ctx.key,
        otherVoices: [],
        strongBeat: ctx.strongBeat,
      },
      { suggestions: false },
    ),
  );
  const member = result !== undefined && (result.reasons & HARMONIC_MEMBER) !== 0;
  byPitch.set(cacheKey, member);
  return member;
}

/**
 * Whether two sounding pitches clash. Two chord members clash only a semitone
 * class apart; anything else follows the interval class, with a fourth
 * dissonant when the lower pitch is the bass.
 */
export function clashes(a: number, b: number, lowerIsBass: boolean, ctx: HarmonicContext): boolean {
  const distance = Math.abs(a - b);
  if (ctx.chord !== null && isHarmonicMember(a, ctx) && isHarmonicMember(b, ctx)) {
    return distance % 12 === 1;
  }
  return classifyInterval(distance, lowerIsBass) === ConsonanceClass.Dissonance;
}

/**
 * Whether the accompaniment note `acc` is thinned by the lead note `lead`: a
 * chord sounds where they meet, `acc` is neither its root, its bass nor its
 * track's lowest note, the two clash, and the lead starts on a strong beat or
 * overlaps at least a quarter of `acc`. A pedal is always its track's lowest
 * note, so the anchor test also covers the pedal exclusion.
 */
export function thinsAccompaniment(acc: TimedPitch, lead: TimedPitch, env: ThinningEnv): boolean {
  const at = Math.max(lead.startPpq, acc.startPpq);
  const overlap = Math.min(acc.startPpq + acc.durationPpq, lead.startPpq + lead.durationPpq) - at;
  if (overlap <= 0) return false;
  const chord = env.chordAt(at);
  if (chord === null) return false;
  const pc = pitchClass(acc.pitch);
  if (pc === pitchClass(chord.rootPc)) return false;
  if (chord.bassPc !== undefined && pc === pitchClass(chord.bassPc)) return false;
  if (env.anchors(at).has(acc.pitch)) return false;
  let lowest = lead.pitch;
  for (const sounding of env.sounding.soundingAt(at)) lowest = Math.min(lowest, sounding.pitch);
  const ctx: HarmonicContext = {
    chord,
    key: env.key.at(at) ?? DEFAULT_KEY_SCALE,
    keySet: env.key.keySetAt(at),
    strongBeat: env.strongBeatAt(at),
  };
  if (!clashes(acc.pitch, lead.pitch, Math.min(acc.pitch, lead.pitch) === lowest, ctx)) {
    return false;
  }
  return env.strongBeatAt(lead.startPpq) || overlap >= acc.durationPpq / 4;
}

/**
 * How the candidate is reached from the previous note of its own line. A
 * repeated pitch counts as held only when the previous note lasts up to
 * `beat`; after a rest it is re-struck and reads as a leap.
 */
export function classifyApproach(
  prev: { pitch: number; endBeat: number } | undefined,
  candidate: number,
  beat: number,
): Approach {
  if (prev === undefined) return 'none';
  const distance = Math.abs(candidate - prev.pitch);
  if (distance === 0) return prev.endBeat >= beat ? 'same' : 'leap';
  return distance <= 2 ? 'step' : 'leap';
}

/** A pitch sounding with the candidate, from another track or the edited clip. */
interface Neighbour extends Omit<SoundingPitch, 'trackId'> {
  trackId: number | null;
}

/** Track id standing in for the edited clip where a `SoundingPitch` needs one. */
const EDITED_CLIP_TRACK_ID = -1;

/** The edited clip's notes sounding at `beat`, minus `skip`. */
function clipNeighboursAt(
  activeNotes: ReadonlyArray<EditorNote>,
  beat: number,
  skip?: { pitch: number; startPpq: number },
): Neighbour[] {
  const out: Neighbour[] = [];
  for (const note of activeNotes) {
    if (note.startPpq > beat || note.startPpq + note.durationPpq <= beat) continue;
    if (skip !== undefined && note.pitch === skip.pitch && note.startPpq === skip.startPpq) {
      continue;
    }
    out.push({
      pitch: note.pitch,
      startPpq: note.startPpq,
      durationPpq: note.durationPpq,
      trackId: null,
      role: 'melodic',
    });
  }
  return out;
}

/** Other tracks' pitches plus the edited clip's notes sounding at `beat`. */
function neighboursAt(
  voices: VoiceContext,
  activeNotes: ReadonlyArray<EditorNote>,
  beat: number,
  skip?: { pitch: number; startPpq: number },
): Neighbour[] {
  return [...voices.soundingAt(beat), ...clipNeighboursAt(activeNotes, beat, skip)];
}

/** Start of the chord segment covering `beat`, when one does. */
function chordStartAt(chords: ChordTimeline, beat: number): number | undefined {
  return chords.segments.find((s) => beat >= s.startBeat && beat < s.endBeat)?.startBeat;
}

/** Neighbours that clash with `pitch`, minus a pedal held from before the chord region. */
function clashingNeighbours(
  pitch: number,
  neighbours: ReadonlyArray<Neighbour>,
  lowestOthers: number,
  chordStart: number | undefined,
  ctx: HarmonicContext,
): Neighbour[] {
  const lowest = Math.min(lowestOthers, pitch);
  return neighbours.filter((other) => {
    const pedal = chordStart !== undefined && other.pitch === lowest && other.startPpq < chordStart;
    if (pedal) return false;
    return clashes(pitch, other.pitch, Math.min(pitch, other.pitch) === lowest, ctx);
  });
}

function lowestPitch(neighbours: ReadonlyArray<Neighbour>): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const other of neighbours) lowest = Math.min(lowest, other.pitch);
  return lowest;
}

/** The nearest scale tone one or two semitones from `pitch` in `direction`. */
function scaleStep(pitch: number, direction: 1 | -1, key: KeyScale): number | undefined {
  for (const size of [1, 2]) {
    const target = pitch + direction * size;
    if (target >= 0 && target < 128 && isScaleTone(target, key)) return target;
  }
  return undefined;
}

/**
 * Verdicts for every pitch from `pitchLow` to `pitchHigh` (inclusive) placed
 * as the cell `input.startPpq` + `input.lengthPpq`, ordered low to high.
 */
export function evaluatePlacementColumn(
  input: PlacementInput,
  pitchLow: number,
  pitchHigh: number,
): PlacementVerdict[] {
  const start = input.startPpq;
  const strict = input.profile === 'counterpoint';
  const safetyProfile = toSafetyProfile(input.profile);
  const tsAt = (ppq: number) => strongBeatAt(input.timeSignatures, ppq);
  const ctxAt = (beat: number): HarmonicContext => ({
    chord: input.chords.at(beat),
    key: input.keyMap.at(beat) ?? DEFAULT_KEY_SCALE,
    keySet: input.keyMap.keySetAt(beat),
    strongBeat: tsAt(beat),
  });
  const ctx = ctxAt(start);
  const { chord, key, keySet, strongBeat } = ctx;
  const chordStart = chordStartAt(input.chords, start);

  const neighbours = neighboursAt(input.voices, input.activeNotes, start);
  const lowestOthers = lowestPitch(neighbours);
  const outersNow = input.voices.outerVoicesAt(start, undefined);
  const outersByPrev = new Map<number | undefined, OuterVoice[]>();
  const outersFrom = (prevBeat: number | undefined): OuterVoice[] => {
    let outers = outersByPrev.get(prevBeat);
    if (outers === undefined) {
      outers = input.voices.outerVoicesAt(start, prevBeat);
      outersByPrev.set(prevBeat, outers);
    }
    return outers;
  };

  // The thinning test sees the edited clip too, as lead following does.
  const soundingWithClip: VoiceContext = {
    soundingAt: (beat) => [
      ...input.voices.soundingAt(beat),
      ...clipNeighboursAt(input.activeNotes, beat).map((note) => ({
        ...note,
        trackId: EDITED_CLIP_TRACK_ID,
      })),
    ],
    outerVoicesAt: input.voices.outerVoicesAt,
  };
  const envFor = (trackId: number): ThinningEnv => ({
    chordAt: (ppq) => input.chords.at(ppq),
    sounding: soundingWithClip,
    anchors: (ppq) => {
      let lowest = Number.POSITIVE_INFINITY;
      for (const s of input.voices.soundingAt(ppq)) {
        if (s.trackId === trackId) lowest = Math.min(lowest, s.pitch);
      }
      return new Set(Number.isFinite(lowest) ? [lowest] : []);
    },
    strongBeatAt: tsAt,
    key: input.keyMap,
  });
  const envs = new Map<number, ThinningEnv>();

  // Whether a held note's own onset already clashed, which voids it as a preparation.
  const prepClashCache = new Map<string, boolean>();
  const preparationClashed = (prev: VoiceChainEntry): boolean => {
    const cacheKey = `${prev.beat}:${prev.pitch}`;
    const cached = prepClashCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const around = neighboursAt(input.voices, input.activeNotes, prev.beat, {
      pitch: prev.pitch,
      startPpq: prev.beat,
    });
    const clashed =
      clashingNeighbours(
        prev.pitch,
        around,
        lowestPitch(around),
        chordStartAt(input.chords, prev.beat),
        ctxAt(prev.beat),
      ).length > 0;
    prepClashCache.set(cacheKey, clashed);
    return clashed;
  };

  const verdicts: PlacementVerdict[] = [];
  for (let pitch = pitchLow; pitch <= pitchHigh; pitch++) {
    const chain = voiceChain(
      input.activeNotes,
      pitch,
      start,
      DOUBLING_RUN_SLOTS,
      input.timeSignatures,
    );
    const prev = chain[0];
    const safety: SafetyResult | undefined = tryEval(() =>
      evaluateSafety(
        {
          profile: safetyProfile,
          candidatePitch: pitch,
          ...(prev !== undefined ? { prevPitch: prev.pitch } : {}),
          chord,
          key,
          otherVoices: [],
          strongBeat,
          ...(input.pitchRange !== undefined
            ? { vocalLow: input.pitchRange.low, vocalHigh: input.pitchRange.high }
            : {}),
        },
        { suggestions: false },
      ),
    );
    const flags = safety?.reasons ?? 0;

    let approach = classifyApproach(prev, pitch, start);
    if (approach === 'same' && preparationClashed(prev)) approach = 'leap';

    const partners: ClashPartner[] = clashingNeighbours(
      pitch,
      neighbours,
      lowestOthers,
      chordStart,
      ctx,
    ).map((other) => {
      const following = other.trackId !== null && input.followerTrackIds.has(other.trackId);
      if (other.trackId === null || other.role === 'melodic' || chord === null) {
        return {
          pitch: other.pitch,
          trackId: other.trackId,
          kind: 'melodic',
          thinned: false,
          following,
        };
      }
      if (other.role === 'bass') {
        return {
          pitch: other.pitch,
          trackId: other.trackId,
          kind: 'bass',
          thinned: false,
          following,
        };
      }
      const pc = pitchClass(other.pitch);
      const isRoot =
        pc === pitchClass(chord.rootPc) ||
        (chord.bassPc !== undefined && pc === pitchClass(chord.bassPc));
      if (isRoot) {
        return {
          pitch: other.pitch,
          trackId: other.trackId,
          kind: 'accompRoot',
          thinned: false,
          following,
        };
      }
      let env = envs.get(other.trackId);
      if (env === undefined) {
        env = envFor(other.trackId);
        envs.set(other.trackId, env);
      }
      const thinned = thinsAccompaniment(
        { pitch: other.pitch, startPpq: other.startPpq, durationPpq: other.durationPpq },
        { pitch, startPpq: start, durationPpq: input.lengthPpq },
        env,
      );
      return {
        pitch: other.pitch,
        trackId: other.trackId,
        kind: 'accompNonRoot',
        thinned,
        following,
      };
    });

    const hits: Array<{ level: PlacementLevel; reason: PlacementReason }> = [];
    const hit = (level: PlacementLevel, reason: PlacementReason) => hits.push({ level, reason });
    const byProfile = (strictLevel: PlacementLevel, popLevel: PlacementLevel) =>
      strict ? strictLevel : popLevel;
    const resolveTo: number[] = [];
    const suspensionTarget = () => {
      const target = safety?.resolveTo ?? scaleStep(pitch, -1, key);
      if (target !== undefined) resolveTo.push(target);
    };
    const passingTargets = () => {
      if (prev === undefined) return;
      const onward = scaleStep(pitch, pitch > prev.pitch ? 1 : -1, key);
      if (onward !== undefined) resolveTo.push(onward);
      resolveTo.push(prev.pitch);
    };
    const unprepared = approach === 'none' || prev?.pitch === pitch;

    // (A) accompaniment-only clashes, then (B) other clashes.
    const accompanimentOnly =
      partners.length > 0 &&
      partners.every((p) => p.kind === 'accompRoot' || (p.kind === 'accompNonRoot' && p.thinned));
    if (accompanimentOnly) {
      if (partners.some((p) => p.kind === 'accompRoot')) hit('warn', 'accompanimentRootClash');
      else if (partners.every((p) => p.following)) hit('safe', 'accompanimentThinned');
      else hit('warn', 'accompanimentThinnable');
    } else if (partners.length > 0) {
      if (approach === 'same') {
        hit('warn', 'preparedSuspension');
        suspensionTarget();
      } else if (approach === 'step' && !strongBeat) {
        hit('warn', 'steppedNonChordTone');
        passingTargets();
      } else if (approach === 'step') {
        hit(byProfile('ng', 'warn'), 'unpreparedDissonance');
      } else {
        hit('ng', unprepared ? 'unpreparedDissonance' : 'leapIntoDissonance');
      }
    }

    // (C) chord dissonance and avoid notes, silenced while the accompaniment decides.
    if (!accompanimentOnly) {
      // An avoid-note tension is a chord dissonance here, though not in `clashes`.
      const avoid = (flags & ReasonFlag.AvoidNote) !== 0;
      if (chord !== null && (!isHarmonicMember(pitch, ctx) || avoid)) {
        if (approach === 'same') {
          hit('warn', 'preparedSuspension');
          suspensionTarget();
        } else if (approach === 'step') {
          hit('warn', 'steppedNonChordTone');
          passingTargets();
        } else if (strongBeat) {
          hit(byProfile('ng', 'warn'), 'chordDissonance');
        } else {
          hit('warn', 'chordDissonance');
        }
      }
      if (strongBeat && avoid && approach !== 'same') {
        hit(byProfile('ng', 'warn'), 'avoidNote');
      }
    }
    if (chord === null && keySet && (flags & ReasonFlag.NonScale) !== 0) {
      hit('warn', 'nonScaleNoChord');
    }

    // (D) motion, spacing, leaps and range.
    const outers = outersFrom(prev?.beat);
    const motion = motionFindings(
      pitch,
      prev?.pitch,
      outers,
      doublingRunOf(chain, input.voices, pitch, start),
    );
    if (motion.parallelPerfect.length > 0) hit(byProfile('ng', 'warn'), 'parallelPerfect');
    if (motion.hiddenOuter) hit('warn', 'hiddenParallel');
    if (motion.crossing.length > 0) hit('warn', 'voiceCrossing');
    if (wideSpacing(pitch, outersNow)) hit('warn', 'wideSpacing');
    const forbidden =
      (flags & ReasonFlag.MelodicTritone) !== 0 ||
      (keySet && prev !== undefined && spelledLeapForbidden(prev.pitch, pitch, key));
    if (forbidden) hit(byProfile('ng', 'warn'), 'forbiddenLeap');
    else if ((flags & ReasonFlag.LargeLeap) !== 0) hit('warn', 'largeLeap');
    if (input.pitchRange !== undefined && (flags & ReasonFlag.OutOfRange) !== 0) {
      hit('ng', 'outOfRange');
    }

    const verdict = verdictOf(hits, partners, resolveTo);
    const motionPartners = motionPartnersOf(pitch, prev?.pitch, outers, motion);
    if (motionPartners.length > 0) verdict.motionPartners = motionPartners;
    verdicts.push(verdict);
  }
  return verdicts;
}

/**
 * The voices behind `motion`. A hidden fifth names the opposite outer voice,
 * found by asking `motionFindings` of each extreme voice alone.
 */
function motionPartnersOf(
  pitch: number,
  prevPitch: number | undefined,
  outers: ReadonlyArray<OuterVoice>,
  motion: MotionFindings,
): MotionPartner[] {
  const out: MotionPartner[] = [];
  for (const voice of motion.parallelPerfect) {
    out.push({ trackId: voice.trackId, pitch: voice.pitch, kind: 'parallel' });
  }
  if (motion.hiddenOuter) {
    const pitches = [pitch, ...outers.map((voice) => voice.pitch)];
    const lowest = Math.min(...pitches);
    const highest = Math.max(...pitches);
    const opposite = pitch === highest ? lowest : highest;
    for (const voice of outers) {
      if (voice.pitch !== opposite) continue;
      if (motionFindings(pitch, prevPitch, [voice], () => 0).hiddenOuter) {
        out.push({ trackId: voice.trackId, pitch: voice.pitch, kind: 'hidden' });
      }
    }
  }
  for (const voice of motion.crossing) {
    out.push({ trackId: voice.trackId, pitch: voice.pitch, kind: 'crossing' });
  }
  return out;
}

/** Whether the candidate sits more than an octave from an adjacent voice, bottom pair exempt. */
function wideSpacing(pitch: number, outers: ReadonlyArray<OuterVoice>): boolean {
  const sounding = [pitch, ...outers.map((voice) => voice.pitch)].sort((a, b) => a - b);
  for (let index = 1; index + 1 < sounding.length; index++) {
    const lower = sounding[index];
    const upper = sounding[index + 1];
    if (lower !== pitch && upper !== pitch) continue;
    if (exceedsSpacing(upper, lower)) return true;
  }
  return false;
}

function spelledLeapForbidden(prev: number, candidate: number, key: KeyScale): boolean {
  const spelled = spellForLeapCheck(prev, candidate, key);
  if (spelled === undefined) return false;
  return tryEval(() => isForbiddenMelodicLeap(spelled[0], spelled[1])) === true;
}

function verdictOf(
  hits: ReadonlyArray<{ level: PlacementLevel; reason: PlacementReason }>,
  partners: ClashPartner[],
  resolveTo: number[],
): PlacementVerdict {
  const ordered = [...hits].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  const level = ordered[0]?.level ?? 'safe';
  const verdict: PlacementVerdict = {
    level,
    reasons: [...new Set(ordered.map((h) => h.reason))],
    partners,
  };
  if (resolveTo.length > 0) verdict.resolveTo = [...new Set(resolveTo)];
  return verdict;
}
