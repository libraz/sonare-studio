/**
 * Beginner-friendly hover-card text for a note's theory analysis.
 *
 * A small centralized label table turns a {@link NoteAnalysis} into a
 * {@link TheoryCard}; lines whose data is absent are skipped. All text is
 * English — the UI layer localizes later.
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

/** Short display name per harmonic role, appended to the card title. */
const ROLE_NAMES: Readonly<Record<HarmonyRole, string>> = {
  root: 'root',
  third: '3rd',
  fifth: '5th',
  sixth: '6th',
  seventh: '7th',
  tension: 'tension',
  doubling: 'doubling',
};

/** What each lock level means for the composer. */
const LOCK_TEXT: Readonly<Record<LockLevel, string>> = {
  identity: "Sets the chord's root",
  quality: 'Defines major/minor — moving it changes the quality',
  voicing: 'Free voicing tone',
};

/** Display names for harmonic functions. */
const FUNCTION_NAMES: Readonly<Record<string, string>> = {
  tonic: 'Tonic',
  subdominant: 'Subdominant',
  dominant: 'Dominant',
};

/** Fallback safety text when the analysis carries no rationale. */
const SAFETY_TEXT: Readonly<Record<NoteSafety, string>> = {
  [NoteSafety.Safe]: 'Fits here',
  [NoteSafety.Warning]: 'Use with care',
  [NoteSafety.Dissonant]: 'Clashes with the chord',
};

/** Beginner text for one non-chord-tone label, or undefined when unmapped. */
function labelText(label: TheoryLabel): string | undefined {
  switch (label.kind) {
    case 'suspension':
      return 'Suspension: resolve down by step';
    case 'passing':
      return 'Passing tone';
    case 'neighbor':
      return 'Neighbor tone';
    case 'avoid':
      return 'Avoid note here';
    case 'tension':
      return `Usable ${label.degree}th tension`;
    default:
      return undefined;
  }
}

/** The NCT/resolution line: the analyzer's rationale, else a label mapping. */
function nctText(analysis: NoteAnalysis): string | undefined {
  const rationale = analysis.analyzed?.rationale;
  if (rationale !== undefined && rationale !== '') return rationale;
  for (const label of analysis.analyzed?.labels ?? []) {
    const text = labelText(label);
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
 */
export function buildTheoryCard(
  analysis: NoteAnalysis,
  ctx: { pitch: number; keySet: boolean; chordRoman?: string; chordFunction?: string },
): TheoryCard {
  const pc = ((ctx.pitch % 12) + 12) % 12;
  const octave = Math.floor(ctx.pitch / 12) - 1;
  let title = `${PITCH_CLASS_NAMES[pc]}${octave}`;
  if (analysis.role !== undefined) title += ` — ${ROLE_NAMES[analysis.role.role]}`;

  const lines: TheoryCardLine[] = [];
  if (analysis.role !== undefined) {
    lines.push({ label: 'Role', text: LOCK_TEXT[analysis.role.lock] });
  }
  if (ctx.chordRoman !== undefined || ctx.chordFunction !== undefined) {
    const parts: string[] = [];
    if (ctx.chordRoman !== undefined) parts.push(ctx.chordRoman);
    if (ctx.chordFunction !== undefined) {
      parts.push(FUNCTION_NAMES[ctx.chordFunction] ?? ctx.chordFunction);
    }
    lines.push({ label: 'Chord', text: parts.join(' — ') });
  }
  if (ctx.keySet) {
    const text =
      analysis.degree >= 0
        ? `Scale degree ${analysis.degree + 1}${analysis.isScaleTone ? '' : ' (non-scale)'}`
        : 'Non-scale tone';
    lines.push({ label: 'Scale', text });
  }
  const nct = nctText(analysis);
  if (nct !== undefined) lines.push({ label: 'Note', text: nct });
  if (analysis.safety !== undefined) {
    const rationale = analysis.safety.rationale;
    const text =
      rationale !== undefined && rationale !== '' ? rationale : SAFETY_TEXT[analysis.safety.safety];
    lines.push({ label: 'Safety', text });
  }
  return { title, lines };
}
