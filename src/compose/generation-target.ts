/** Explicit timeline frame shared by melody/chord generation plans. */

import type { ChordData } from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import type { TimeSignatureSegment } from '@/project/types';
import { buildChordTimeline } from './chord-at-tick';

export interface GenerationTargetFrame {
  /** Inclusive absolute project start of the write/analyze target. */
  startPpq: number;
  /** Exclusive absolute project end of the write/analyze target. */
  endPpq: number;
  /** Absolute-PPQ chord query; never silently rebased to song start. */
  chordAt(ppq: number): ChordData | null;
  /** Full project meter map used to validate/derive the plan grid. */
  timeSignatures: ReadonlyArray<TimeSignatureSegment>;
}

export interface GenerationTargetFrameInput {
  startPpq: number;
  endPpq: number;
  chords: ReadonlyArray<EditorChordSymbol>;
  timeSignatures: ReadonlyArray<TimeSignatureSegment>;
}

/** Builds a bounded, absolute timeline frame for a generation plan. */
export function createGenerationTargetFrame(
  input: GenerationTargetFrameInput,
): GenerationTargetFrame {
  if (
    !Number.isFinite(input.startPpq) ||
    !Number.isFinite(input.endPpq) ||
    input.startPpq < 0 ||
    input.endPpq <= input.startPpq
  ) {
    throw new RangeError(
      `Generation target must be a positive absolute PPQ range, got ${input.startPpq}..${input.endPpq}`,
    );
  }
  const timeline = buildChordTimeline(input.chords);
  return {
    startPpq: input.startPpq,
    endPpq: input.endPpq,
    chordAt: (ppq) => (ppq >= input.startPpq && ppq < input.endPpq ? timeline.at(ppq) : null),
    timeSignatures: input.timeSignatures,
  };
}
