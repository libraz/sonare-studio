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

import type { HarmonyRole, LockLevel, TheoryLabel } from '@libraz/libcantus';
import { NoteSafety } from '@libraz/libcantus';
import type { NoteAnalysis } from './guidance';

/** One labelled line of the hover card. */
export interface TheoryCardLine {
  label: string;
  text: string;
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
  lines: Readonly<Record<'role' | 'chord' | 'scale' | 'note' | 'safety', string>>;
  /** Scale-degree line template, with a `{degree}` placeholder. */
  scaleDegree: string;
  /** Suffix appended to the scale line for a non-scale tone. */
  nonScaleSuffix: string;
  /** Scale line shown when the degree is unknown. */
  nonScaleTone: string;
}

/** Pitch-class names, sharp spelling (index = pitch class). */
const PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

/** Maps a safety verdict to its label key. */
const SAFETY_KEY: Readonly<Record<NoteSafety, 'safe' | 'warning' | 'dissonant'>> = {
  [NoteSafety.Safe]: 'safe',
  [NoteSafety.Warning]: 'warning',
  [NoteSafety.Dissonant]: 'dissonant',
};

/** Beginner text for one non-chord-tone label, or undefined when unmapped. */
function labelText(label: TheoryLabel, labels: TheoryLabels): string | undefined {
  switch (label.kind) {
    case 'suspension':
      return labels.labels.suspension;
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
 * The NCT/resolution line, from the localized label table. Returns the first
 * label that maps to localized text; chord tones and notes the analyzer left
 * unlabelled (e.g. no chord covers them) carry no NCT line — the role and scale
 * lines already convey those. The analyzer's raw `rationale` is deliberately
 * not used, since it is English-only and reads "Unclassified note" for every
 * unlabelled note.
 */
function nctText(analysis: NoteAnalysis, labels: TheoryLabels): string | undefined {
  for (const label of analysis.analyzed?.labels ?? []) {
    const text = labelText(label, labels);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Builds the hover card for one analyzed note.
 *
 * @param analysis The note's theory analysis.
 * @param ctx Display context: the note's MIDI pitch, whether a key is set,
 *   and the sounding chord's Roman numeral / harmonic function when known.
 * @param labels Localized string bundle (the app's i18n `theory` block).
 */
export function buildTheoryCard(
  analysis: NoteAnalysis,
  ctx: { pitch: number; keySet: boolean; chordRoman?: string; chordFunction?: string },
  labels: TheoryLabels,
): TheoryCard {
  const pc = ((ctx.pitch % 12) + 12) % 12;
  const octave = Math.floor(ctx.pitch / 12) - 1;
  let title = `${PITCH_CLASS_NAMES[pc]}${octave}`;
  if (analysis.role !== undefined) title += ` — ${labels.roles[analysis.role.role]}`;

  const lines: TheoryCardLine[] = [];
  if (analysis.role !== undefined) {
    lines.push({ label: labels.lines.role, text: labels.lock[analysis.role.lock] });
  }
  if (ctx.chordRoman !== undefined || ctx.chordFunction !== undefined) {
    const parts: string[] = [];
    if (ctx.chordRoman !== undefined) parts.push(ctx.chordRoman);
    if (ctx.chordFunction !== undefined) {
      const key = ctx.chordFunction as 'tonic' | 'subdominant' | 'dominant';
      parts.push(labels.functions[key] ?? ctx.chordFunction);
    }
    lines.push({ label: labels.lines.chord, text: parts.join(' — ') });
  }
  if (ctx.keySet) {
    const text =
      analysis.degree >= 0
        ? labels.scaleDegree.replace('{degree}', String(analysis.degree + 1)) +
          (analysis.isScaleTone ? '' : labels.nonScaleSuffix)
        : labels.nonScaleTone;
    lines.push({ label: labels.lines.scale, text });
  }
  const nct = nctText(analysis, labels);
  if (nct !== undefined) lines.push({ label: labels.lines.note, text: nct });
  if (analysis.safety !== undefined) {
    // The localized verdict text is primary; the analyzer's raw rationale is
    // English-only, so it is not shown in the card.
    lines.push({
      label: labels.lines.safety,
      text: labels.safety[SAFETY_KEY[analysis.safety.safety]],
    });
  }
  return { title, lines };
}
