/**
 * Decoration: which notes of a passage are played with a ghost, a flam, a drag,
 * a slide or an accent.
 *
 * A thin adapter over libcantus's {@link ornament}. The library decides which
 * notes are eligible from the style and the meter — ghosts fall on weak
 * positions, drags on the weak position before a strong one, flams and accents
 * on strong ones, slides on notes reached by a leap — and never adds or moves an
 * onset: a decorated note is the same note carrying an articulation. This
 * module's job is to say which editor note each mark lands on, and to answer
 * that question without writing anything, so a caller can show the count before
 * committing:
 *
 *  - notes that never sound are dropped first, because the library drops them
 *    too and the answer has to line up with the editor's own notes;
 *  - the pass is addressed by position, so raising the amount adds marks
 *    without moving the ones already placed;
 *  - a note the editor has already marked by hand is left alone;
 *  - beats map to PPQ with coefficient 1 (1 PPQ = one quarter note).
 *
 * Read-only: nothing here writes to the project. Pure module.
 */

import {
  type NoteEvent,
  type OrnamentStyle,
  ornament,
  type TimeSignature,
} from '@libraz/libcantus';
import type { NoteArticulation } from '@/project/annotations';
import type { EditorNote } from '@/project/types';
import { editorNoteToNoteEvent } from './notes-io';

/**
 * The decorations a pass writes.
 *
 * Every style libcantus can apply names a marking the score also knows, so the
 * style is the articulation. The list is constrained to the intersection of the
 * two vocabularies, so either side losing a name fails to compile here rather
 * than turning into an option that writes nothing.
 */
export const ORNAMENT_MARKS = [
  'ghost',
  'flam',
  'drag',
  'slide',
  'accent',
] as const satisfies ReadonlyArray<NoteArticulation & OrnamentStyle>;

/** One decoration a pass would write. */
export type OrnamentMark = (typeof ORNAMENT_MARKS)[number];

/** What a decoration pass would do, before anything is written. */
export interface OrnamentPlan {
  /** Editor note id of every note the pass marks, and the mark it gets. */
  marks: ReadonlyArray<{ noteId: number; articulation: NoteArticulation }>;
  /** How many notes were offered to the pass. */
  candidateCount: number;
}

/** Options for {@link planOrnaments}. */
export interface OrnamentPlanOptions {
  /** Which decoration to apply. */
  mark: OrnamentMark;
  /** How much of the eligible material is decorated, in [0, 1]. */
  amount: number;
  /** Time signature in force; 4/4 when omitted. */
  ts?: TimeSignature;
  /** Tempo, which the difficulty ceiling needs to reject what is too fast. */
  bpm?: number;
  /**
   * Hardest the result may be to play, 1..5. A passage whose strokes come too
   * fast for the ceiling is left plain; omitted means no ceiling.
   */
  difficulty?: number;
  /** Fixes which notes are decorated; the same seed plans the same marks. */
  seed?: number;
  /** Note ids the pass must not touch, typically ones marked by hand. */
  keep?: ReadonlySet<number>;
}

/** An empty plan that still reports what was on offer. */
function nothing(candidateCount: number): OrnamentPlan {
  return { marks: [], candidateCount };
}

/**
 * Works out which notes a decoration pass would mark, without writing anything.
 *
 * @param notes The clip's notes, in any order; clip-relative timing is fine as
 *   long as it is consistent, since only relative position matters.
 * @param options Style, amount, meter, tempo, ceiling and seed.
 * @returns The marks the pass would write, and how many notes it looked at.
 */
export function planOrnaments(
  notes: ReadonlyArray<EditorNote>,
  options: OrnamentPlanOptions,
): OrnamentPlan {
  // A note that never sounds is dropped by the library, which would shift every
  // later note out of line with its editor id; dropping it here keeps them paired.
  const sounding = notes.filter((note) => note.durationPpq > 0);
  const candidates = sounding.filter((note) => options.keep?.has(note.id) !== true);
  if (candidates.length === 0) return nothing(0);

  const events: NoteEvent[] = candidates.map((note) => editorNoteToNoteEvent(note));
  const decorated = ornament(events, {
    style: options.mark,
    amount: options.amount,
    ...(options.ts !== undefined ? { ts: options.ts } : {}),
    ctx: {
      seed: options.seed ?? 0,
      ...(options.bpm !== undefined ? { bpm: options.bpm } : {}),
      ...(options.difficulty !== undefined
        ? { complexity: { difficulty: options.difficulty } }
        : {}),
    },
  });
  // The result is the sounding notes in input order, so index pairs them with
  // the editor notes. A length that does not match means that no longer holds,
  // and a plan built on a guessed pairing would mark the wrong notes.
  if (decorated.length !== candidates.length) return nothing(candidates.length);

  // The pass applies the one style it was asked for, so a decorated note
  // carries that mark; the event only says whether it was decorated at all.
  const marks: Array<{ noteId: number; articulation: NoteArticulation }> = [];
  decorated.forEach((event, index) => {
    if (event.articulation === undefined) return;
    marks.push({ noteId: candidates[index].id, articulation: options.mark });
  });
  return { marks, candidateCount: candidates.length };
}
