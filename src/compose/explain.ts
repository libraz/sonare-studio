/**
 * Beginner-friendly hover-card text for a note's theory analysis.
 *
 * This module owns the assembly logic (which lines a card carries and how they
 * are composed from a {@link NoteAnalysis}); the display strings live in the
 * app's i18n message trees and are passed in as a {@link TheoryLabels} bundle,
 * so the same card renders in every locale from one place. Lines whose data is
 * absent are skipped.
 *
 * Pure module.
 */

import type { HarmonyRole, LockLevel, NoteNameSystem, TheoryLabel } from '@libraz/libcantus';
import { NoteSafety, ReasonFlag } from '@libraz/libcantus';
import { formatSpelledPitch, pitchClassNames } from '@/lib/pitch';
import { type SpelledPitch, spellPitchInKeySignature } from '@/notation/pitch-spelling';
import type { NoteAnalysis, VerticalInfo } from './guidance';
import type { CadenceType } from './harmonic-analysis';

/** A glossary term: a short display name and its plain-language definition. */
export interface GlossaryEntry {
  term: string;
  definition: string;
}

/** One labelled line of the hover card. */
export interface TheoryCardLine {
  label: string;
  text: string;
  /**
   * The jargon term this line refers to, when one applies. Surfaces the ⓘ
   * glossary affordance so a reader can expand its definition in place.
   */
  term?: GlossaryEntry;
}

/** The hover card: a title plus zero or more explanation lines. */
export interface TheoryCard {
  title: string;
  lines: TheoryCardLine[];
}

/**
 * Localized string bundle the card is built from. The app supplies this from
 * its i18n `theory` message block (see src/ui/i18n); `{degree}` placeholders in
 * `scaleDegree` and `labels.tension` are substituted at build time.
 */
export interface TheoryLabels {
  /** Short role name appended to the title, per harmonic role. */
  roles: Readonly<Record<HarmonyRole, string>>;
  /** What each lock level means for the composer. */
  lock: Readonly<Record<LockLevel, string>>;
  /** Display names for harmonic functions. */
  functions: Readonly<Record<'tonic' | 'subdominant' | 'dominant', string>>;
  /** Fallback safety text when the analysis carries no rationale. */
  safety: Readonly<Record<'safe' | 'warning' | 'dissonant', string>>;
  /** Beginner text per non-chord-tone label kind. */
  labels: Readonly<
    Record<
      | 'suspension'
      | 'appoggiatura'
      | 'passing'
      | 'neighbor'
      | 'avoid'
      | 'tension'
      | 'anticipation'
      | 'escape'
      | 'needsResolution'
      | 'leadingTone',
      string
    >
  >;
  /** Line labels (left column). */
  lines: Readonly<
    Record<'role' | 'chord' | 'scale' | 'note' | 'safety' | 'chordScale' | 'counterpoint', string>
  >;
  /** Simple interval names keyed by semitone distance "0".."12" (unison..octave). */
  intervalNames: Readonly<Record<string, string>>;
  /** Scale display names keyed by libcantus scale name (e.g. 'dorian'). */
  scaleNames: Readonly<Record<string, string>>;
  /** Suffix marking a scale line whose key was estimated rather than set. */
  estimatedKey: string;
  /** Cadence line label and type names (see {@link CadenceLabels}). */
  cadence: CadenceLabels;
  /** Cadence-arrival line template, with a `{cadence}` placeholder. */
  cadenceArrival: string;
  /** Suffix marking a cadence read from the notes rather than from a chord track. */
  inferredCadence: string;
  /** Scale-degree line template, with a `{degree}` placeholder. */
  scaleDegree: string;
  /** Suffix appended to the scale line for a non-scale tone. */
  nonScaleSuffix: string;
  /** Scale line shown when the degree is unknown. */
  nonScaleTone: string;
  /**
   * Prefixes for the color-tone line's available tensions, passing tones, avoid
   * notes, and runner-up scale fits.
   */
  chordScale: Readonly<Record<'tensions' | 'passing' | 'avoid' | 'alternates', string>>;
  /** Voice-relative (counterpoint) wording. */
  counterpoint: CounterpointLabels;
  /** Glossary of jargon terms, keyed by term id (see {@link GLOSSARY_KEY_FOR_KIND}). */
  glossary: Readonly<Record<string, GlossaryEntry>>;
}

/**
 * The cadence vocabulary, taken from the app's `harmony.cadence` block — the
 * same names the chord lane writes on the progression, so one concept is not
 * named twice. The card supplies its own wording around them (see
 * {@link TheoryLabels.cadenceArrival}), which is what varies by level.
 */
export interface CadenceLabels extends Readonly<Record<CadenceType, string>> {
  /** Line label ("Cadence"). */
  label: string;
}

/** Wording for the voice-relative (counterpoint) card line. */
export interface CounterpointLabels {
  /** Interval-to-bass template, with `{interval}` and `{consonance}` placeholders. */
  toBass: string;
  /** Consonance class names. */
  consonance: Readonly<Record<'perfect' | 'imperfect' | 'dissonant', string>>;
  /** Suspension verdict, with a `{target}` pitch placeholder. */
  suspension: string;
  /** Suspension verdict for when the resolution pitch is not known. */
  suspensionNoTarget: string;
  /** Parallel perfect (fifths/octaves) verdict. */
  parallelPerfect: string;
  /** Hidden/direct parallel verdict. */
  hiddenParallel: string;
  /** Ottava battuta verdict. */
  battuta: string;
  /** Voice-crossing verdict. */
  voiceCrossing: string;
  /** Wide-spacing verdict, against the adjacent voice at that instant. */
  wideSpacing: string;
  /** Forbidden melodic leap verdict, measured against the previous note. */
  forbiddenLeap: string;
  /** Leading-tone resolution — the one observation here that is not a fault. */
  leadingToneResolution: string;
}

/**
 * The counterpoint readings the card can name, in no particular order (the
 * priority the card renders them by lives in {@link counterpointLines}). Each
 * has wording of its own in {@link CounterpointLabels} and a glossary entry
 * through {@link GLOSSARY_KEY_FOR_VERDICT}.
 */
export type CounterpointVerdict =
  | 'suspension'
  | 'parallelPerfect'
  | 'hiddenParallel'
  | 'battuta'
  | 'voiceCrossing'
  | 'wideSpacing'
  | 'forbiddenLeap'
  | 'leadingToneResolution';

/**
 * The per-level wording of the localized theory block: the explanatory strings
 * that change with the explanation level (the line labels, role and function
 * names are shared across levels and live alongside these).
 */
export interface TheoryLevelLabels {
  lock: TheoryLabels['lock'];
  safety: TheoryLabels['safety'];
  labels: TheoryLabels['labels'];
  scaleDegree: string;
  nonScaleSuffix: string;
  nonScaleTone: string;
  cadenceArrival: string;
  chordScale: TheoryLabels['chordScale'];
  counterpoint: CounterpointLabels;
}

/**
 * The localized `theory` message block the card labels are resolved from: the
 * shared labels, the per-level wording, and the glossary. Structurally matches
 * the app's i18n `theory` tree without depending on it.
 */
export interface LocalizedTheory {
  roles: TheoryLabels['roles'];
  functions: TheoryLabels['functions'];
  lines: TheoryLabels['lines'];
  intervalNames: TheoryLabels['intervalNames'];
  scaleNames: TheoryLabels['scaleNames'];
  estimatedKey: TheoryLabels['estimatedKey'];
  inferredCadence: TheoryLabels['inferredCadence'];
  levels: Readonly<Record<string, TheoryLevelLabels>>;
  glossary: TheoryLabels['glossary'];
}

/**
 * Resolves the card's string bundle for one explanation level: the shared role
 * / function / line labels merged with the selected level's wording and the
 * glossary. Pure — the same inputs yield the same bundle.
 *
 * @param theory The localized theory message block.
 * @param level The explanation level whose wording to use.
 * @param cadence The cadence names, from the app's `harmony.cadence` block, so
 *   the card and the chord lane name a cadence the same way.
 */
export function theoryLabelsFor(
  theory: LocalizedTheory,
  level: string,
  cadence: CadenceLabels,
): TheoryLabels {
  const levelLabels = theory.levels[level] ?? theory.levels.normal;
  return {
    roles: theory.roles,
    functions: theory.functions,
    lines: theory.lines,
    intervalNames: theory.intervalNames,
    scaleNames: theory.scaleNames,
    estimatedKey: theory.estimatedKey,
    cadence,
    cadenceArrival: levelLabels.cadenceArrival,
    inferredCadence: theory.inferredCadence,
    lock: levelLabels.lock,
    safety: levelLabels.safety,
    labels: levelLabels.labels,
    scaleDegree: levelLabels.scaleDegree,
    nonScaleSuffix: levelLabels.nonScaleSuffix,
    nonScaleTone: levelLabels.nonScaleTone,
    chordScale: levelLabels.chordScale,
    counterpoint: levelLabels.counterpoint,
    glossary: theory.glossary,
  };
}

/** Maps a safety verdict to its label key. */
const SAFETY_KEY: Readonly<Record<NoteSafety, 'safe' | 'warning' | 'dissonant'>> = {
  [NoteSafety.Safe]: 'safe',
  [NoteSafety.Warning]: 'warning',
  [NoteSafety.Dissonant]: 'dissonant',
};

/**
 * Octave-less name of a pitch class, spelled for the key (e.g. "Eb").
 *
 * Every system writes the octave as trailing digits, so dropping them leaves
 * the bare name whichever system named it.
 */
function pitchClassName(pc: number, keyFifths?: number, system?: NoteNameSystem): string {
  return pitchName(60 + (((pc % 12) + 12) % 12), keyFifths, system).replace(/-?\d+$/, '');
}

/** Joins pitch classes into a name list (e.g. "D, A"). */
function pitchClassList(
  pitchClasses: ReadonlyArray<number>,
  keyFifths?: number,
  system?: NoteNameSystem,
): string {
  return pitchClasses.map((pc) => pitchClassName(pc, keyFifths, system)).join(', ');
}

/** Localized scale name, falling back to the library's raw name when unmapped. */
function scaleDisplayName(scaleName: string, labels: TheoryLabels): string {
  return labels.scaleNames[scaleName] ?? scaleName;
}

/**
 * The color-tone line for the sounding chord: the best-fit scale named on its
 * root, then the non-chord scale tones sorted by what may be done with them,
 * then any runner-up fits. The three groups run from freest to strictest —
 * tensions may be added at will, passing tones only passed through, avoid notes
 * not played at all — so the line reads as descending permission.
 * The scale name alone is worth the line, so it is emitted even when the chord
 * offers none of the three.
 */
function chordScaleText(
  analysis: NoteAnalysis,
  labels: TheoryLabels,
  keyFifths?: number,
  system?: NoteNameSystem,
): string | undefined {
  const chordScale = analysis.chordScale;
  if (chordScale === undefined) return undefined;
  const parts: string[] = [
    `${pitchClassName(chordScale.rootPc, keyFifths, system)} ${scaleDisplayName(chordScale.scaleName, labels)}`,
  ];
  if (chordScale.tensions.length > 0) {
    parts.push(
      `${labels.chordScale.tensions} ${pitchClassList(chordScale.tensions, keyFifths, system)}`,
    );
  }
  if (chordScale.passing.length > 0) {
    parts.push(
      `${labels.chordScale.passing} ${pitchClassList(chordScale.passing, keyFifths, system)}`,
    );
  }
  if (chordScale.avoid.length > 0) {
    parts.push(`${labels.chordScale.avoid} ${pitchClassList(chordScale.avoid, keyFifths, system)}`);
  }
  const alternates = chordScale.alternates ?? [];
  if (alternates.length > 0) {
    const names = alternates.map((name) => scaleDisplayName(name, labels)).join(', ');
    parts.push(`${labels.chordScale.alternates} ${names}`);
  }
  return parts.join(' · ');
}

/** Beginner text for one non-chord-tone label, or undefined when unmapped. */
function labelText(label: TheoryLabel, labels: TheoryLabels): string | undefined {
  switch (label.kind) {
    case 'suspension':
      return labels.labels.suspension;
    case 'appoggiatura':
      return labels.labels.appoggiatura;
    case 'passing':
      return labels.labels.passing;
    case 'neighbor':
      return labels.labels.neighbor;
    case 'avoid':
      return labels.labels.avoid;
    case 'tension':
      return labels.labels.tension.replace('{degree}', String(label.degree));
    case 'anticipation':
      return labels.labels.anticipation;
    case 'escape':
      return labels.labels.escape;
    case 'needsResolution':
      return labels.labels.needsResolution;
    case 'leadingTone':
      return labels.labels.leadingTone;
    default:
      return undefined;
  }
}

/**
 * Glossary key for each theory-label kind that names a jargon term. Chord tones
 * carry no glossary term (they need no definition); every other kind maps to a
 * key of the same name in {@link TheoryLabels.glossary}.
 */
export const GLOSSARY_KEY_FOR_KIND: Readonly<Record<TheoryLabel['kind'], string | undefined>> = {
  chordTone: undefined,
  suspension: 'suspension',
  appoggiatura: 'appoggiatura',
  passing: 'passing',
  neighbor: 'neighbor',
  avoid: 'avoid',
  tension: 'tension',
  anticipation: 'anticipation',
  escape: 'escape',
  needsResolution: 'needsResolution',
  leadingTone: 'leadingTone',
};

/**
 * Glossary key for each counterpoint verdict. Every one of them names a term a
 * reader may not know, so unlike {@link GLOSSARY_KEY_FOR_KIND} there is no
 * "needs no definition" case; the total map over {@link CounterpointVerdict} is
 * what fails the build when a verdict is added without a definition to expand.
 */
export const GLOSSARY_KEY_FOR_VERDICT: Readonly<Record<CounterpointVerdict, string>> = {
  suspension: 'suspension',
  parallelPerfect: 'parallelPerfect',
  hiddenParallel: 'hiddenParallel',
  battuta: 'battuta',
  voiceCrossing: 'voiceCrossing',
  wideSpacing: 'wideSpacing',
  forbiddenLeap: 'forbiddenLeap',
  leadingToneResolution: 'leadingToneResolution',
};

/**
 * The NCT/resolution line, from the localized label table, paired with the
 * glossary term it refers to (for the ⓘ affordance). Returns the first label
 * that maps to localized text; chord tones and notes the analyzer left
 * unlabelled (e.g. no chord covers them) carry no NCT line — the role and scale
 * lines already convey those. The analyzer's raw `rationale` is deliberately
 * not used, since it is English-only and reads "Unclassified note" for every
 * unlabelled note.
 */
function nctLine(
  analysis: NoteAnalysis,
  labels: TheoryLabels,
): { text: string; term?: GlossaryEntry } | undefined {
  for (const label of analysis.analyzed?.labels ?? []) {
    const text = labelText(label, labels);
    if (text === undefined) continue;
    const key = GLOSSARY_KEY_FOR_KIND[label.kind];
    return { text, term: key !== undefined ? labels.glossary[key] : undefined };
  }
  return undefined;
}

/**
 * Writes a spelled pitch in the reader's note-name system. English is spelled
 * out here rather than deferred, because it is the system the score and the
 * MusicXML export write and its accidentals are the step/alter pair itself.
 */
function formatPitch(pitch: SpelledPitch, system: NoteNameSystem): string {
  if (system !== 'english') return formatSpelledPitch(pitch, system);
  return `${pitch.step}${pitch.alter === 0 ? '' : pitch.alter === 1 ? '#' : 'b'}${pitch.octave}`;
}

/**
 * Pitch name with octave, e.g. 63 -> "D#4".
 *
 * A spelling read off the analysis wins, since that is the letter the score
 * engraves the note with and the card must not rename a notehead the reader can
 * see. Without one the key signature alone decides, which is all a pitch the
 * analysis does not cover — a suspension's resolution target, a chord-scale
 * tone — offers; with no key at all the bare pitch class is named.
 */
function pitchName(
  midi: number,
  keyFifths?: number,
  system: NoteNameSystem = 'english',
  spelled?: SpelledPitch,
): string {
  if (spelled !== undefined) return formatPitch(spelled, system);
  if (keyFifths === undefined) {
    const pc = ((midi % 12) + 12) % 12;
    return `${pitchClassNames(system)[pc]}${Math.floor(midi / 12) - 1}`;
  }
  return formatPitch(spellPitchInKeySignature(midi, keyFifths), system);
}

/**
 * The voice-relative (counterpoint) lines for a note: its interval to the bass
 * and its consonance, then the single most salient fault, then the one
 * observation in the set that is not a fault. These are chord-independent, so
 * they describe polyphony that has no chord progression — but the pitch a
 * suspension resolves to is read off the sounding chord, so a chord-free
 * suspension arrives without one and takes the wording that states the
 * resolution without naming a pitch. Vertical dissonance is deliberately not
 * surfaced as its own verdict — the interval line already says "dissonant".
 * Returns an empty array when the note sounds alone or against no other voice.
 *
 * Only one fault is named, because the readings overlap and a stack of them
 * describes one event several times over rather than several events. The chain
 * runs from what the two voices do together down to what the active line does
 * alone:
 *
 * 1. Suspension, because it explains the dissonance the interval line has just
 *    reported and carries the resolution the arrows draw.
 * 2. Parallel, then hidden, then battuta: the three ways of arriving at a
 *    perfect interval, commonest first. They are near-complementary in practice
 *    — the parallel reading dismisses contrary-motion pairs, which is exactly
 *    the motion the battuta is about — so ordering between them rarely bites.
 * 3. Voice crossing, a standing fact about the register rather than about a
 *    motion into it.
 * 4. Forbidden leap, then wide spacing: the two commonest readings by a wide
 *    margin, so putting either first would mask the rarer verdicts that need
 *    pointing out. The leap is at least an event, and one visible in the line
 *    the composer is already looking at; the spacing holds for as long as the
 *    registers do — over the demo toccata a spacing reading runs two notes at
 *    a time and up to seventeen, against the leap's one and a half — which
 *    makes it the least newsworthy thing the card can say about any one note.
 *
 * A leading-tone resolution takes a line of its own instead of a place in that
 * chain. It is the only positive reading here, and a chain can only rank
 * comparable things: letting a correct resolution outrank a parallel octave
 * would hide a fault behind praise, and letting the parallel outrank it would
 * make the card silent about the resolution for no reason. They are answers to
 * different questions, so they are shown on different lines.
 */
function counterpointLines(
  analysis: NoteAnalysis,
  labels: TheoryLabels,
  keyFifths: number | undefined,
  system?: NoteNameSystem,
): TheoryCardLine[] {
  const out: TheoryCardLine[] = [];
  const vertical: VerticalInfo | undefined = analysis.vertical;
  if (vertical !== undefined) {
    // Compound intervals fold to their simple form for naming (a 10th reads as a
    // 3rd), with any exact multiple of an octave named as the octave.
    const simple = vertical.toBass <= 12 ? vertical.toBass : vertical.toBass % 12 || 12;
    const name = labels.intervalNames[String(simple)] ?? '';
    out.push({
      label: labels.lines.counterpoint,
      text: labels.counterpoint.toBass
        .replace('{interval}', name)
        .replace('{consonance}', labels.counterpoint.consonance[vertical.consonance]),
    });
  }
  const reasons = analysis.safety?.reasons ?? 0;
  const found = analysis.counterpoint;
  const cp = labels.counterpoint;
  /** One verdict line, with the glossary term its name refers to. */
  const push = (kind: CounterpointVerdict, text: string): void => {
    const term = labels.glossary[GLOSSARY_KEY_FOR_VERDICT[kind]];
    out.push({
      label: labels.lines.counterpoint,
      text,
      ...(term !== undefined ? { term } : {}),
    });
  };
  if (reasons & ReasonFlag.Suspension) {
    const target = analysis.safety?.resolveTo;
    push(
      'suspension',
      target !== undefined
        ? cp.suspension.replace('{target}', pitchName(target, keyFifths, system))
        : cp.suspensionNoTarget,
    );
  } else if (reasons & ReasonFlag.ParallelPerfect) {
    push('parallelPerfect', cp.parallelPerfect);
  } else if (reasons & ReasonFlag.HiddenParallel) {
    push('hiddenParallel', cp.hiddenParallel);
  } else if (found?.battuta === true) {
    push('battuta', cp.battuta);
  } else if (reasons & ReasonFlag.VoiceCrossing) {
    push('voiceCrossing', cp.voiceCrossing);
  } else if (found?.forbiddenLeap === true) {
    push('forbiddenLeap', cp.forbiddenLeap);
  } else if (found?.wideSpacing === true) {
    push('wideSpacing', cp.wideSpacing);
  }
  if (found?.leadingToneResolution === true) {
    push('leadingToneResolution', cp.leadingToneResolution);
  }
  return out;
}

/**
 * Builds the hover card for one analyzed note.
 *
 * @param analysis The note's theory analysis.
 * @param ctx Display context: the note's MIDI pitch, its velocity (folded into
 *   the title so the card subsumes the canvas hover HUD), whether a key is set
 *   and whether it was estimated, and the sounding chord's Roman numeral /
 *   harmonic function when known.
 * @param labels Localized string bundle (the app's i18n `theory` block).
 */
export function buildTheoryCard(
  analysis: NoteAnalysis,
  ctx: {
    pitch: number;
    velocity?: number;
    keySet: boolean;
    /**
     * Whether the key was estimated from the notes rather than chosen. The
     * scale line hedges when it was, so a reading the app arrived at on its own
     * is not presented as one the composer settled.
     */
    keyEstimated?: boolean;
    /**
     * MusicXML key fifths for the pitches the card names on its own: the
     * chord-scale tones and a resolution target. It has to be the signature the
     * analysis was built under, since the hovered note's own name comes off the
     * analysis and a second key here would spell one card two ways.
     */
    keyFifths?: number;
    /** Note-name system the pitch names are written in; English by default. */
    noteNameSystem?: NoteNameSystem;
    chordRoman?: string;
    chordFunction?: string;
  },
  labels: TheoryLabels,
): TheoryCard {
  let title = pitchName(ctx.pitch, ctx.keyFifths, ctx.noteNameSystem, analysis.engraved);
  if (ctx.velocity !== undefined) title += ` · vel ${ctx.velocity}`;
  if (analysis.role !== undefined) title += ` — ${labels.roles[analysis.role.role]}`;

  const lines: TheoryCardLine[] = [];
  if (analysis.role !== undefined) {
    lines.push({ label: labels.lines.role, text: labels.lock[analysis.role.lock] });
  }
  if (ctx.chordRoman !== undefined || ctx.chordFunction !== undefined) {
    const parts: string[] = [];
    if (ctx.chordRoman !== undefined) parts.push(ctx.chordRoman);
    let functionTerm: GlossaryEntry | undefined;
    if (ctx.chordFunction !== undefined) {
      const key = ctx.chordFunction as 'tonic' | 'subdominant' | 'dominant';
      parts.push(labels.functions[key] ?? ctx.chordFunction);
      functionTerm = labels.glossary[key];
    }
    lines.push({
      label: labels.lines.chord,
      text: parts.join(' — '),
      ...(functionTerm !== undefined ? { term: functionTerm } : {}),
    });
  }
  if (analysis.cadence !== undefined) {
    // A cadence read out of the notes is a reading the app arrived at on its
    // own, so it says so, the way an estimated key does. One stated by a chord
    // track is the composer's own progression and is reported plainly.
    const text = labels.cadenceArrival.replace('{cadence}', labels.cadence[analysis.cadence.type]);
    lines.push({
      label: labels.cadence.label,
      text: analysis.cadence.inferred ? text + labels.inferredCadence : text,
    });
  }
  if (ctx.keySet) {
    const text =
      analysis.degree > 0
        ? labels.scaleDegree.replace('{degree}', String(analysis.degree)) +
          (analysis.isScaleTone ? '' : labels.nonScaleSuffix)
        : labels.nonScaleTone;
    // Every word on this line is measured from the key, so a key nobody chose
    // has to be admitted here rather than left for the reader to discover.
    lines.push({
      label: labels.lines.scale,
      text: ctx.keyEstimated === true ? text + labels.estimatedKey : text,
    });
  }
  const colorTones = chordScaleText(analysis, labels, ctx.keyFifths, ctx.noteNameSystem);
  if (colorTones !== undefined) {
    const term = labels.glossary.chordScale;
    lines.push({
      label: labels.lines.chordScale,
      text: colorTones,
      ...(term !== undefined ? { term } : {}),
    });
  }
  lines.push(...counterpointLines(analysis, labels, ctx.keyFifths, ctx.noteNameSystem));
  const nct = nctLine(analysis, labels);
  if (nct !== undefined) {
    lines.push({
      label: labels.lines.note,
      text: nct.text,
      ...(nct.term !== undefined ? { term: nct.term } : {}),
    });
  }
  // The safety verdict measures the note against the sounding chord, so it is
  // shown only where one sounds: with no chord under the note every reading
  // comes back Warning or Dissonant, and the wording would name a clash with a
  // chord the piece does not have. The verdict is still analyzed — its
  // counterpoint reasons carry the lines above.
  if (analysis.safety !== undefined && analysis.chordSounding) {
    // The localized verdict text is primary; the analyzer's raw rationale is
    // English-only, so it is not shown in the card.
    lines.push({
      label: labels.lines.safety,
      text: labels.safety[SAFETY_KEY[analysis.safety.safety]],
    });
  }
  return { title, lines };
}
